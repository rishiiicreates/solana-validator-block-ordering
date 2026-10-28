# Solana Block Transaction Ordering Mechanics & Empirical Measurement Engine Specification

## 1. Executive Summary & Problem Formulation

### 1.1 The Solana Block Construction Problem
In high-throughput, multithreaded blockchain networks, transaction ordering within a block is not merely an architectural detail—it is the foundational mechanism governing network fairness, MEV (Maximal Extractable Value) distribution, censorship resistance, and validator profitability. 

Unlike Ethereum, which features a single-threaded execution runtime (EVM) with an explicit, global mempool sorted linearly by priority gas auction (PGA) bids or EIP-1559 priority fees, the Solana Virtual Machine (SVM) is a state-parallel, multithreaded runtime. Solana blocks contain up to 48,000,000 compute units (CU) of execution space per slot (~400 milliseconds), divided across thousands of transactions executing concurrently across multiple CPU threads.

A Solana validator acting as the designated slot leader faces a multi-dimensional scheduling and packing problem:
1. **Concurrency Constraints:** Two transactions cannot execute concurrently if they request conflicting locks (i.e. at least one requests write access to an account that the other reads or writes).
2. **Resource Constraints:** Total block compute units cannot exceed 48M CU; individual accounts are restricted to an account-write compute unit ceiling of 12M CU per block.
3. **Economic Objectives:** Validators seek to maximize total fee revenue (base transaction fees + priority fees + MEV tip payments) while minimizing processing latency and transaction dropping.
4. **Ingress Topologies:** Inflow reaches validators via distinct network vectors—public QUIC TPU sockets, UDP/QUIC TPU forward sockets, private RPC fast-lanes, and out-of-band gRPC bundle streams (Jito Block Engine).

```
                      SOLANA INGRESS TOPOLOGIES & SCHEDULER PIPELINE
                      
  Public Internet (QUIC)       Staking Relays (TPU-Fwd)      Searchers (Out-of-Band)
         │                               │                             │
         ▼                               ▼                             ▼
  ┌──────────────┐               ┌──────────────┐              ┌──────────────┐
  │ TPU Receiver │               │ TPU-Fwd Rcvr │              │  Jito Block  │
  └──────┬───────┘               └──────┬───────┘              │    Engine    │
         │                              │                      └──────┬───────┘
         ▼                              ▼                             │ (gRPC)
  ┌─────────────────────────────────────────────┐                     ▼
  │         SigVerify Stage (Parallel ED25519)  │              ┌──────────────┐
  └──────────────────────┬──────────────────────┘              │ BundleStage  │
                         │                                     │  (Atomic 1-5)│
                         ▼                                     └──────┬───────┘
              ┌─────────────────────┐                                 │
              │  BankingStage /     │◄────────────────────────────────┘
              │  Transaction        │  Bundle Priority / Lock Reservation
              │  Scheduler          │
              └──────────┬──────────┘
                         │
                         ▼
        ┌──────────────────────────────────┐
        │ SVM Execution Threads (Parallel) │
        └────────────────┬─────────────────┘
                         │ (PoH Serialization)
                         ▼
        ┌──────────────────────────────────┐
        │  Entry Recorder / Shredder Stage │
        └──────────────────────────────────┘
```

### 1.2 The Multi-Client Landscape
The Solana validator ecosystem does not run a single monolithic codebase. As of 2024–2026, the network operates across several distinct validator implementations, forks, and specialized patches:
- **Agave (Anza, formerly Solana Labs):** The reference client. Features the transition from the legacy multi-iterator `BankingStage` to the modern `central_scheduler` powered by `prio-graph` (a directed acyclic dependency graph).
- **Jito-Solana (Jito Foundation):** The dominant validator client fork (>80% network stake). Extends Agave with a dedicated `BundleStage` and `bundle_account_locker`, allowing out-of-band atomic bundles from the Jito Block Engine to preempt standard mempool transactions at the head of slots.
- **Firedancer / Frankendancer (Jump Crypto):** A ground-up C-based rewrite. Frankendancer couples Firedancer's C networking/packing stack (`fd_pack`) with Agave's Rust SVM. `fd_pack` replaces Agave's scheduler with an explicit knapsack-optimizing packing algorithm with dynamic consumed-CU feedback.
- **Private Staking Pool & Validator Cartel Forks:** Proprietary modifications run by institutional staking pools and MEV operators that implement private mempool fast-lanes, custom tip contracts, or non-standard priority fee heuristics.

### 1.3 Purpose of this Specification
This document provides:
1. An exhaustive architectural breakdown of the transaction scheduling mechanics inside Agave, Jito-Solana, Firedancer, and private forks.
2. A formal mathematical and empirical methodology to reverse-engineer and attribute which client implementation or scheduling rule produced any given historical Solana block using exclusively on-chain data retrieved via the `getBlock` RPC endpoint.
3. A complete technical specification and data blueprint for a high-performance Solana Block Measurement Engine.

---

## 2. Agave Transaction Scheduling Architecture

The reference Agave validator client processes incoming transactions through the Transaction Processing Unit (TPU). The TPU consists of packet fetch stages, signature verification (`sigverify`), transaction scheduling and execution (`banking_stage`), and Proof of History entry recording (`poh_recorder`).

### 2.1 The TPU Pipeline: Ingest to BankingStage

```
┌──────────────┐     ┌──────────────┐     ┌──────────────┐     ┌──────────────┐
│  QUIC Packet │ ──► │  SigVerify   │ ──► │ Channel /    │ ──► │ BankingStage │
│  Receiver    │     │  Stage       │     │ Queue Buffer │     │ Execution    │
└──────────────┘     └──────────────┘     └──────────────┘     └──────────────┘
```

1. **QUIC Ingestion:** Packets are received over QUIC streams on the validator's TPU port. Network rate limiting and stake-weighted quality of service (SWQoS) prioritize packets originating from validators holding larger delegated stake.
2. **SigVerify Stage:** ED25519 signature checks are batched and validated using AVX-512 or GPU accelerators. Packets with invalid signatures or malformed message headers are dropped before consuming scheduler resources.
3. **Packet Queues:** Validated packets are converted into sanitized transactions and pushed into incoming scheduling buffers.

### 2.2 The Legacy BankingStage (Pre-v1.18 Multi-Iterator Scheduler)
To understand modern Agave scheduling, one must understand the failure modes of the legacy architecture it replaced.

#### Architecture
The legacy `BankingStage` spawned multiple worker threads (typically 6 to 12 threads depending on CPU core count). Incoming packet batches from `sigverify` were distributed across worker threads using a round-robin or packet hash distribution scheme:
- Each worker thread maintained its own local priority queue of transactions.
- Each thread independently sorted its local buffer by priority fee.
- Each thread attempted to acquire write- and read-locks directly on the `Bank` for its top transaction.

#### Failure Modes: Lock Contention and Priority Inversion
Because packets were partitioned across threads before conflict analysis:
1. **Lock Contention:** If Thread A held a write-lock on Account $X$, and Thread B had a transaction needing Account $X$, Thread B was completely blocked or forced to drop/retry the transaction, even if Thread B's transaction paid a much higher priority fee than Thread A's other work.
2. **Artificial Priority Inversions:** A high-fee transaction assigned to Thread A could be delayed behind a stalled lock, while a zero-fee transaction on Thread C executed immediately because Thread C's accounts were uncontentious.
3. **Mempool Thrashing:** Worker threads spent up to 70% of their execution cycles repeatedly acquiring and releasing lock guards rather than executing SVM bytecode.

---

### 2.3 The Modern Central Scheduler & `prio-graph` (Agave v1.18+)
To resolve the bottlenecks of the multi-iterator design, Agave introduced the **Central Scheduler** (implemented under `core/src/banking_stage/transaction_scheduler/`), which decouples transaction prioritization and dependency tracking from thread execution.

#### Core Components
- **Scheduler Controller (`scheduler_controller.rs`):** A centralized orchestrator thread that ingests verified transactions from `sigverify`, calculates priority metrics, inserts transactions into a dependency graph, and dispatches ready batches to idle worker threads.
- **Priority Dependency Graph (`prio-graph`):** A specialized directed acyclic graph (DAG) where nodes represent transactions and directed edges represent read/write and write/write lock conflicts between accounts.
- **Execution Workers:** Stateless SVM execution worker threads that receive non-conflicting transaction batches from the scheduler, execute them against the `Bank`, and send results to the `PohRecorder`.

```
                    AGAVE CENTRAL SCHEDULER ARCHITECTURE
                    
                         Incoming Sanitized Packets
                                     │
                                     ▼
                    ┌─────────────────────────────────┐
                    │    Priority Queue (Min-Heap)    │
                    │ Sorted by µ-lamports per CU     │
                    └────────────────┬────────────────┘
                                     │ (Look-Ahead Window)
                                     ▼
                    ┌─────────────────────────────────┐
                    │  prio-graph: Dependency DAG     │
                    │ Nodes: Transactions             │
                    │ Edges: Account Lock Conflicts   │
                    └────────────────┬────────────────┘
                                     │
                       Dispatch Non-Conflicting Batches
                       ┌─────────────┼─────────────┐
                       ▼             ▼             ▼
                 ┌──────────┐  ┌──────────┐  ┌──────────┐
                 │ Worker 1 │  │ Worker 2 │  │ Worker 3 │
                 └────┬─────┘  └────┬─────┘  └────┬─────┘
                      │             │             │
                      └─────────────┼─────────────┘
                                    ▼
                         ┌────────────────────┐
                         │   PoH Recorder     │
                         │ (Serialization)    │
                         └────────────────────┘
```

#### The Priority Metric: Micro-Lamports per Compute Unit
Solana allows transactions to specify compute resource parameters via the `ComputeBudget` program (`ComputeBudget111111111111111111111111111111`):
1. `SetComputeUnitLimit(limit)`: Declares the maximum Compute Units the transaction may consume (default: 200,000; maximum: 1,400,000).
2. `SetComputeUnitPrice(micro_lamports)`: Declares the priority fee rate in micro-lamports per requested compute unit ($1 \text{ lamport} = 10^6 \text{ micro-lamports}$).

The total fee paid by a transaction is calculated as:
$$\text{TotalFee} = (\text{BaseFeePerSignature} \times N_{\text{signatures}}) + \text{PriorityFeeLamports}$$

$$\text{PriorityFeeLamports} = \left\lfloor \frac{\text{SetComputeUnitPrice} \times \text{ComputeUnitLimit}}{1\,000\,000} \right\rfloor$$

The Agave Central Scheduler sorts candidate transactions primarily by **unit price** ($\mu\text{-lamports per CU}$), NOT by total fee:
$$\text{PriorityRank} = \text{SetComputeUnitPrice} = \frac{\text{PriorityFeeLamports} \times 1\,000\,000}{\text{ComputeUnitLimit}}$$

**Rationale:** Prioritizing by unit price maximizes the validator's revenue per unit of block space (the economic density of the 48M CU block budget). A transaction paying 10,000 lamports for 50,000 CU ($0.2 \text{ lamports/CU}$) is prioritized ahead of a transaction paying 50,000 lamports for 1,000,000 CU ($0.05 \text{ lamports/CU}$).

#### Write-Lock Conflict Isolation via `prio-graph`
Every Solana transaction explicitly declares all accounts it accesses in its message header, partitioned into:
- Writable Signers ($W_{sig}$)
- Read-only Signers ($R_{sig}$)
- Writable Non-Signers ($W_{non}$)
- Read-only Non-Signers ($R_{non}$)
- Address Lookup Table (ALT) loaded writable addresses ($W_{alt}$)
- Address Lookup Table (ALT) loaded read-only addresses ($R_{alt}$)

The complete write-lock set $W_i$ and read-lock set $R_i$ for transaction $T_i$ are:
$$W_i = W_{sig} \cup W_{non} \cup W_{alt}$$
$$R_i = R_{sig} \cup R_{non} \cup R_{alt}$$

Two transactions $T_a$ and $T_b$ conflict if and only if they share an account and at least one transaction requires write access:
$$\text{Conflict}(T_a, T_b) \iff (W_a \cap (W_b \cup R_b) \neq \emptyset) \lor (W_b \cap (W_a \cup R_a) \neq \emptyset)$$

In `prio-graph`:
1. The scheduler maintains a look-ahead window of the highest-priority pending transactions.
2. For each transaction $T_i$ added to the graph, directed edges $(T_j \to T_i)$ are created from any currently pending or executing transaction $T_j$ that conflicts with $T_i$ and has higher priority or earlier arrival.
3. Transactions with an in-degree of 0 (no uncompleted conflicting dependencies) are deemed "ready".
4. As worker threads become available, the scheduler pulls ready transactions and dispatches them in non-conflicting batches.

#### Thread Concurrency & Completion Interleaving
A critical empirical consequence of multithreaded scheduling is **completion interleaving**:
- Even if $T_1$ has a higher unit price than $T_2$, if $\text{Conflict}(T_1, T_2) = \text{false}$, they may be dispatched simultaneously to Worker Thread 1 and Worker Thread 2.
- If $T_1$ requests 1,400,000 CU and performs complex math, while $T_2$ requests 50,000 CU and performs a simple token transfer, Worker Thread 2 will finish before Worker Thread 1.
- Transactions are appended to the Proof of History (PoH) log in the order their execution finishes.
- **Therefore, in the final block, $T_2$ may appear at a lower transaction index than $T_1$, despite $T_1$ having a higher priority fee!**
- **Crucial Invariant:** If $T_a$ and $T_b$ **conflict** ($W_a \cap W_b \neq \emptyset$), they CANNOT execute concurrently. Under a pure priority DAG scheduler, $T_a$ must complete before $T_b$ is dispatched. Thus, within any single write-lock dependency chain, priority ordering is strictly preserved.

#### FIFO Fallback Mechanics
When multiple transactions exhibit identical unit prices (e.g. 0 micro-lamports per CU, or common round fee numbers like 1,000 $\mu\text{-lamports/CU}$):
1. Agave resolves ties using insertion order into the scheduler queue (arrival sequence).
2. For transactions with no priority fee, execution degenerates into a **FIFO (First-In, First-Out)** order bounded by arrival time at the `sigverify` channel.
3. In periods of high congestion with zero priority fees, arrival time at the validator's network card dominates block position.

#### Buffer Limits, Eviction & TPU Forwarding
The scheduler buffer is finite (typically bounded to a maximum number of pending packets, e.g. 100,000 packets):
- When the buffer reaches capacity, incoming lower-priority transactions are dropped.
- Transactions that cannot be scheduled during the current slot because their referenced accounts exceed the 12M CU per-account limit or the 48M CU slot limit may be held over or forwarded via the TPU forward socket (`tpu_forward`) to the validator scheduled to lead the subsequent slot.

---

## 3. Jito-Solana Architecture & Bundle Mechanics

Jito-Solana is an open-source validator client fork maintained by the Jito Foundation. It introduces an out-of-band auction mechanism designed to eliminate network spam caused by searchers racing to capture MEV.

```
                         JITO MEV AUCTION ARCHITECTURE
                         
  ┌─────────────────────────────────────────────────────────────┐
  │                        SEARCHERS                            │
  │     (Arbitrageurs, Liquidators, Sandwich Bots, Algos)       │
  └──────────────────────────────┬──────────────────────────────┘
                                 │ Private Bundles (1-5 Txs)
                                 ▼
  ┌─────────────────────────────────────────────────────────────┐
  │                       JITO RELAYER                          │
  │ - Ingress verification                                      │
  │ - Signature checking & DDoS mitigation                      │
  │ - Nonce & expiration validation                             │
  └──────────────────────────────┬──────────────────────────────┘
                                 │
                                 ▼
  ┌─────────────────────────────────────────────────────────────┐
  │                    JITO BLOCK ENGINE                        │
  │ - Real-time sealed-bid first-price auction                  │
  │ - Bundle simulation against current chain state             │
  │ - Conflict checking & tip ranking                           │
  │ - Winning bundle dispatch via gRPC                          │
  └──────────────────────────────┬──────────────────────────────┘
                                 │
                                 │ Winning Bundles Stream (gRPC)
                                 ▼
  ┌─────────────────────────────────────────────────────────────┐
  │                     JITO-SOLANA VALIDATOR                   │
  │                                                             │
  │  ┌──────────────────────┐         ┌──────────────────────┐  │
  │  │     BundleStage      │         │     BankingStage     │  │
  │  │  (Atomic execution;  │         │  (Standard TPU flow; │  │
  │  │   multi-tx lock)     │         │   prio-graph DAG)    │  │
  │  └──────────┬───────────┘         └──────────┬───────────┘  │
  │             │                                │              │
  │             └───────────────┬────────────────┘              │
  │                             ▼                               │
  │                    ┌──────────────────┐                     │
  │                    │   PoH Recorder   │                     │
  │                    └──────────────────┘                     │
  └─────────────────────────────────────────────────────────────┘
```

### 3.1 The Out-of-Band Pipeline: Relayer to Block Engine
1. **Searchers:** Construct atomic sequences of transactions (bundles) targeting state opportunities (e.g. AMM liquidations, cross-DEX arbitrage).
2. **Jito Relayer:** Serves as a gateway proxy that receives bundles from searchers, validates basic parameters (transaction sizes, valid signatures), and routes them to the Block Engine.
3. **Block Engine:** 
   - Simulates bundles against the validator's projected state.
   - Evaluates the total tip offered.
   - Conducts a continuous first-price sealed-bid auction for block space during the current and upcoming leader slots.
   - Drops any bundle where simulation fails, state reverts, or the tip transfer instruction is missing or insufficient.
   - Streams winning bundles directly to the validator's private gRPC bundle receiver.

### 3.2 Bundle Anatomy & Execution Invariants
A Jito bundle is defined by strict operational constraints:
- **Batch Size:** Exactly 1 to 5 transactions ($1 \le N \le 5$).
- **Strict Sequential Order:** Transactions in the bundle must execute sequentially: $T_0, T_1, \dots, T_k$.
- **All-or-Nothing Atomicity:** If any transaction $T_i$ fails simulation or halts during on-chain execution with an unhandled error, the entire bundle is discarded. None of its state changes commit, and no transactions from the bundle enter the block.
- **Tip Payment Requirement:** At least one transaction in the bundle (almost universally the final transaction, $T_k$) must execute a lamport transfer to one of the 8 canonical Jito Tip Payment accounts.

#### The 8 Canonical Jito Tip Accounts
Tips must be paid via standard lamport transfer to one of the following public keys:

| Account Index | Canonical Jito Tip Address |
|:---:|:---|
| 0 | `96gYZGLnJYVFmbjzopPSU6QiEV5fGqZNyN9nmNhvrZU5` |
| 1 | `HFqU5x63VTqvQss8hp11i4wVV8bD44PvwucfZ2bU7gRe` |
| 2 | `Cw8CFyM9FkoMi7K7Crf6HNQqf4uEMzpKw6QNghXLvLkY` |
| 3 | `ADaUMid9yfUytqMBgopwjb2DTLSokTSzL1zt6iGPaS49` |
| 4 | `DfXygSm4jCyNCybVYYK6DwvWqjKee8pbDmJGcLWNDXjh` |
| 5 | `ADuUkR4vqLUMWXxW9gh6D6L8pMSawimctcNZ5pGwDcEt` |
| 6 | `DttWaMuVvTiduZRnguLF7jNxTgiMBZ1hyAumKUiL2KRL` |
| 7 | `3AVi9Tg9Uo68tJfuvoKvqKNWKkC5wPdSSdeBnizKZ6jT` |

Tips are aggregated by the **Tip Payment Program** and subsequently cranked by the **Tip Distribution Program** (or Jito TipRouter) to distribute rewards proportionally between the validator operator and delegating stakers according to the validator's declared MEV commission rate.

### 3.3 Inside Jito-Solana: `BundleStage` & `bundle_account_locker`
In standard Agave, the runtime acquires locks for a single transaction at a time. This is insufficient for atomic bundles: if $T_0$ executes and releases locks on Account $A$, a standard mempool transaction $T_{mempool}$ could execute and modify Account $A$ before $T_1$ executes, breaking bundle atomicity.

Jito-Solana resolves this by introducing two key modules:
1. **`bundle_account_locker.rs`:**
   - Computes the union of all write-locks and read-locks across ALL transactions within the bundle:
     $$W_{\text{bundle}} = \bigcup_{i=0}^{k} W_i, \quad R_{\text{bundle}} = \bigcup_{i=0}^{k} R_i$$
   - Locks every account in $W_{\text{bundle}}$ and $R_{\text{bundle}}$ simultaneously across the validator's `Bank` before $T_0$ begins execution.
   - Holds these locks continuously throughout the sequential execution of $T_0, T_1, \dots, T_k$.
   - Releases the locks only after the final transaction commits to the PoH recorder.
2. **`bundle_stage.rs`:**
   - Runs in parallel with the standard `BankingStage`.
   - Maintains an incoming priority queue of validated bundles from the Block Engine, sorted by total tip value (or tip per cumulative CU).
   - Coordinates with `BankingStage` worker threads to yield or reserve account locks.

### 3.4 Slot Allocation & PoH Tick Reserving: The "Front of Slot" Rule
A defining characteristic of Jito-Solana is how it balances block space between bundles and standard transactions:
- **PoH Tick Allocation Window:** Jito validators reserve block space for bundles during the initial portion of the slot—historically configured to the **first 80% of Proof-of-History ticks** (or up to a configured CU cap).
- **Head-of-Block Injection:** Because searchers compete aggressively to execute state changes at the very beginning of a leader's slot (e.g. capturing price discrepancies from the preceding slot), the Block Engine delivers winning bundles before or at the immediate start of slot generation.
- **Preemption:** If a winning bundle arrives, `BundleStage` claims the necessary account locks, preempting pending transactions in `BankingStage`.
- **Tail Behavior:** After the PoH tick allocation threshold is reached (e.g. the final 20% of the slot), or when the bundle queue is depleted, the validator reverts exclusively to standard `BankingStage` processing to saturate the remaining block capacity with mempool transactions.

### 3.5 The Priority Fee vs Tip Economic Disconnect
A fundamental observation of Jito bundle transactions is the complete disconnect between on-chain priority fees and actual economic payment:
- Transactions inside Jito bundles frequently specify **`SetComputeUnitPrice(0)`** (0 $\mu\text{-lamports/CU}$).
- The validator accepts and prioritizes them because the bundle pays an out-of-band tip of millions or billions of lamports (e.g. 0.05 SOL = 50,000,000 lamports) directly to a Jito tip account.
- **Empirical Implication:** In an on-chain block, transactions at index 0, 1, 2 with 0 priority fee executing ahead of public transactions with 100,000 $\mu\text{-lamports/CU}$ are unequivocal signatures of Jito bundles.

---

## 4. Alternative Validator Schedulers & Custom Forks

Beyond standard Agave and Jito-Solana, other validator implementations and private modifications operate on Solana mainnet.

```
┌──────────────────────────────────────────────────────────────────────────────────┐
│                           VALIDATOR SCHEDULER LANDSCAPE                          │
├──────────────────────┬────────────────────────┬──────────────────────────────────┤
│ Client / Fork        │ Ingress Mechanism      │ Scheduling / Packing Logic       │
├──────────────────────┼────────────────────────┼──────────────────────────────────┤
│ Agave (Reference)    │ Public QUIC TPU        │ prio-graph DAG scheduler;        │
│                      │                        │ Sorts by µ-lamports/CU;          │
│                      │                        │ Concurrent non-conflicting dispatch│
├──────────────────────┼────────────────────────┼──────────────────────────────────┤
│ Jito-Solana          │ Public QUIC +          │ BundleStage preempts BankingStage;│
│                      │ Block Engine gRPC      │ Multi-tx atomic account lock;    │
│                      │                        │ Front-of-slot PoH tick reserving  │
├──────────────────────┼────────────────────────┼──────────────────────────────────┤
│ Frankendancer /      │ C-based fd_quic +      │ fd_pack knapsack algorithm;       │
│ Firedancer           │ fd_verify ring buffers │ Dynamic consumed-CU feedback;    │
│                      │                        │ Strict 12M CU account ceiling    │
├──────────────────────┼────────────────────────┼──────────────────────────────────┤
│ Private MEV /        │ Custom RPC fast-lanes; │ Non-canonical tip contracts;     │
│ Cartel Forks         │ Direct searcher bypass │ Raw lamport sorting;             │
│                      │                        │ Proprietary backrun placement    │
└──────────────────────┴────────────────────────┴──────────────────────────────────┘
```

### 4.1 Firedancer & Frankendancer (`fd_pack`)
Firedancer (Jump Crypto) re-architects the validator as a pipeline of hardware-pinned, isolated C processes ("tiles") communicating via lock-free shared-memory ring buffers (`dcache` and `fseq`).

Frankendancer is the hybrid client deploying Firedancer's networking and packing pipeline (`fd_quic`, `fd_verify`, `fd_dedup`, `fd_pack`) upstream of Agave's Rust runtime.

#### The `fd_pack` Architecture
In Firedancer, transaction scheduling is executed by the **`pack` tile** (`fd_pack`):
1. **Queue Capacity:** Maintains a pending candidate pool of up to 65,524 verified, deduplicated transactions.
2. **Knapsack Optimization:** Rather than lazily constructing an ad-hoc dependency graph, `fd_pack` formulates block building as a bounded multi-dimensional knapsack optimization problem:
   - Maximize: $\sum \text{Fee}_i$
   - Subject to:
     - $\sum \text{CU}_i \le 48\,000\,000$ (Total Block CU Limit)
     - $\sum_{T_i \in \text{Writes}(A)} \text{CU}_i \le 12\,000\,000 \quad \forall A$ (Per-Account Write Limit)
     - Cumulative serialized byte length $\le$ Max Block Size
3. **Consumed-CU Dynamic Feedback (`use_consumed_cus = true`):**
   - Agave schedules transactions based on their *requested* compute unit limit ($L_i$). If a transaction requests 1,400,000 CU but only uses 30,000 CU, Agave's scheduler accounts for 1,400,000 CU against the 12M CU account ceiling until execution finishes.
   - `fd_pack` coordinates dynamically with the execution tile (`bank`). When a transaction completes using fewer CUs than requested, `fd_pack` immediately reclaims the unused compute budget and packs additional pending transactions that write to the same account.
   - **Empirical Signature:** Frankendancer/Firedancer blocks achieve significantly higher transaction density and higher average CU saturation (>40M CU in congested slots) with near-zero headroom wasted on oversized CU limits.
4. **Packing Policies:**
   - `"perf"` Mode: Focuses purely on greedy fee-density packing, minimizing block assembly latency.

### 4.2 Private Validator Forks & Staking Pool Cartels
Several high-stake validators run proprietary modifications designed to capture MEV or offer privileged access:
1. **Private RPC Fast-Lanes:**
   - Validators expose private, authenticated endpoints to select market makers or institutional trading firms.
   - Transactions bypass the public QUIC TPU receiver and SigVerify rate-limiting queues, injecting directly into the scheduling buffer.
   - **Empirical Signature:** Transactions appear at early block indices with standard or zero priority fees, with no Jito tip, but executing ahead of high-fee public transactions on the same contentious DEX accounts.
2. **Custom / Alternative Tip Programs:**
   - Some searchers and private relays use proprietary tip contracts (e.g. direct SPL token transfers or alternative tip escrow accounts) to bypass Jito's 3-8% validator commission or avoid Jito's public tip distribution tracking.
3. **Raw Lamport Fee Sorting:**
   - Simple custom forks alter Agave's `TransactionPriorityDetails` to sort by `total_priority_fee_lamports` instead of `micro_lamports_per_cu`.
   - **Empirical Signature:** Systematic priority inversions where transactions with low unit prices but massive total requested CUs (e.g. 1.4M CU limit) execute ahead of transactions with 10x higher unit price but lower CU limits.

---

## 5. Empirical Methodology: Reverse-Engineering Schedulers from `getBlock`

Given any historical slot number, can we definitively determine which scheduling rules, client implementation, and MEV mechanisms were utilized to order its transactions using exclusively the public `getBlock` RPC method?

Yes. By systematically extracting transaction metadata, constructing the account conflict graph, and computing statistical ordering metrics, we can reverse-engineer the leader's scheduling behavior.

### 5.1 The `getBlock` Data Surface

We invoke the RPC method:
```json
{
  "jsonrpc": "2.0",
  "id": 1,
  "method": "getBlock",
  "params": [
    slot_number,
    {
      "encoding": "json",
      "transactionDetails": "full",
      "rewards": true,
      "maxSupportedTransactionVersion": 0
    }
  ]
}
```

#### Extracted Properties per Transaction $T_i$ (Index $i \in [0, N-1]$):

```
       TRANSACTION METADATA EXTRACTION FROM getBlock
       
  ┌─────────────────────────────────────────────────────────────┐
  │ transaction.signatures[0]                                   │ ──► Transaction Hash
  ├─────────────────────────────────────────────────────────────┤
  │ transaction.message.header                                  │ ──► Signer / Writable Counts
  ├─────────────────────────────────────────────────────────────┤
  │ transaction.message.accountKeys                             │ ──► Base Account Addresses
  ├─────────────────────────────────────────────────────────────┤
  │ meta.loadedAddresses.writable / readonly                    │ ──► ALT Dynamic Addresses
  ├─────────────────────────────────────────────────────────────┤
  │ transaction.message.instructions                            │ ──► ComputeBudget & Transfers
  ├─────────────────────────────────────────────────────────────┤
  │ meta.fee                                                    │ ──► Total Fee Paid (lamports)
  ├─────────────────────────────────────────────────────────────┤
  │ meta.computeUnitsConsumed                                   │ ──► Actual CU Used ($C_i$)
  ├─────────────────────────────────────────────────────────────┤
  │ meta.preBalances / meta.postBalances                        │ ──► Balance Deltas (Tips)
  ├─────────────────────────────────────────────────────────────┤
  │ meta.err                                                    │ ──► Success / Error Status
  └─────────────────────────────────────────────────────────────┘
```

1. **Transaction Index ($i$):** Integer position in the block array ($0 \le i < N$).
2. **Account Access Sets:**
   - Reconstruct full write-lock set $W_i$ and read-lock set $R_i$ by merging `transaction.message.accountKeys` with `meta.loadedAddresses.writable` and `meta.loadedAddresses.readonly`.
3. **Compute Budget Parameters:**
   - Parse instructions for Program ID `ComputeBudget111111111111111111111111111111`.
   - Instruction Index `0x02` (`SetComputeUnitLimit`): yields Requested Compute Limit $L_i$. If omitted, default $L_i = 200\,000$.
   - Instruction Index `0x03` (`SetComputeUnitPrice`): yields Unit Price $U_i$ in $\mu\text{-lamports/CU}$.
4. **Calculated Priority Fee:**
   - Number of signatures $S_i = \text{len}(\text{signatures})$.
   - Base Signature Fee: $\text{BaseFee}_i = S_i \times 5\,000 \text{ lamports}$.
   - Priority Fee: $P_i = \text{meta.fee} - \text{BaseFee}_i$.
   - Derived Unit Price: If not explicitly set via instruction:
     $$U_i = \frac{P_i \times 1\,000\,000}{L_i}$$
5. **Tip Detection:**
   - Check if any account in $W_i$ matches one of the 8 canonical Jito tip addresses.
   - If present, calculate the balance increase:
     $$\Delta \text{Balance}_{\text{tip}} = \text{postBalances}[\text{tip\_idx}] - \text{preBalances}[\text{tip\_idx}]$$
   - If $\Delta \text{Balance}_{\text{tip}} > 0$, record $Tip_i = \Delta \text{Balance}_{\text{tip}}$ and $TipAccount_i = \text{address}$.

---

### 5.2 The Write-Lock Chain Projection Method

#### The Core Measurement Challenge
A naive analysis would compare $U_i$ against $U_{i+1}$ globally across the block. However, in a multithreaded scheduler, **global priority sorting is expected to be broken** due to non-conflicting thread concurrency.

If Transaction A ($U = 10\,000$) touches Account $X$, and Transaction B ($U = 50\,000$) touches Account $Y$, they execute on separate threads. Transaction A may finish and be recorded at Index 42, while Transaction B finishes at Index 45. This is NOT a scheduler failure or an intentional priority inversion; it is an artifact of parallel runtime completion.

#### The Mathematical Solution: Account-Level Projection
To isolate scheduling intent from thread concurrency jitter, we project the block's transaction sequence onto individual write-locked accounts.

**Definition (Write-Lock Sequence):**
For any account $A$, let the write-lock sequence $Seq(A)$ be the ordered subsequence of transactions in the block that declare $A$ as writable:
$$Seq(A) = \big[ T_{i_1}, T_{i_2}, \dots, T_{i_m} \big] \quad \text{where } i_1 < i_2 < \dots < i_m \text{ and } A \in W_{i_k} \, \forall k$$

**Theorem (Concurrency Invariance of Conflicting Transactions):**
*Because the Solana runtime enforces mutual exclusion on write-locks, no two transactions in $Seq(A)$ can execute concurrently. Therefore, the relative order of transactions in $Seq(A)$ must strictly reflect the scheduler's serial dispatch and execution order, independent of thread count.*

```
                 WRITE-LOCK PROJECTION ELIMINATES THREAD JITTER
                 
  Global Block: [ T0(A, $10) | T1(B, $500) | T2(A, $5) | T3(C, $2) | T4(A, $1) ]
  
  Thread 1 (Account A):  T0 ($10)  ───────►  T2 ($5)  ───────►  T4 ($1)
  Thread 2 (Account B):  T1 ($500)
  Thread 3 (Account C):  T3 ($2)
  
  Projected on Account A:  [ T0 ($10), T2 ($5), T4 ($1) ]
  Monotonic Priority Fee Gradient: Strictly Decreasing ( Kendall's Tau = +1.0 )
```

---

### 5.3 Formal Quantitative Metrics

We define five rigorous metrics evaluated across each block:

#### 1. Intra-Account Monotonicity Score ($\mathcal{M}_{acc}$)
For every hot account $A$ with $|Seq(A)| \ge 5$, we evaluate the monotonic decay of unit prices $U$ along the sequence using **Kendall's Rank Correlation Coefficient ($\tau$)**:

$$\tau(Seq(A)) = \frac{C - D}{\frac{1}{2} m (m - 1)}$$
Where:
- $C$ is the number of concordant pairs: $(j < k) \land (U_{i_j} \ge U_{i_k})$
- $D$ is the number of discordant pairs: $(j < k) \land (U_{i_j} < U_{i_k})$

The aggregate account monotonicity score for the block is the weighted average across all hot accounts:
$$\mathcal{M}_{acc} = \frac{\sum_{A} |Seq(A)| \cdot \tau(Seq(A))}{\sum_{A} |Seq(A)|}$$

- **$\mathcal{M}_{acc} \approx +1.0$:** Perfect priority fee ordering. Conflicting transactions are strictly ordered from highest unit price to lowest.
- **$\mathcal{M}_{acc} \approx 0.0$:** Random priority ordering (indicative of Legacy multi-iterator lock collisions or FIFO).

#### 2. Concurrency-Aware Priority Inversion Index ($\mathcal{I}_{prio}$)
A priority inversion occurs when a transaction with a lower priority fee executes ahead of a conflicting transaction that paid a higher priority fee.

We identify all pairs $(T_a, T_b)$ such that:
1. $a < b$ (Transaction $a$ appears earlier in the block than $b$)
2. $\text{Conflict}(T_a, T_b) = \text{true}$
3. $U_a < U_b$ (Transaction $a$ paid a lower unit price than $b$)
4. Neither $T_a$ nor $T_b$ is a Jito bundle transaction.

The Priority Inversion Index is normalized by the total number of conflicting pairs:
$$\mathcal{I}_{prio} = \frac{\sum_{a < b} \mathbb{I}\big(\text{Conflict}(T_a, T_b) \land (U_a < U_b)\big)}{\sum_{a < b} \mathbb{I}\big(\text{Conflict}(T_a, T_b)\big)}$$

*Note on Dynamic Arrival:* In a live slot lasting 400ms, a transaction arriving at $t = 250\text{ms}$ with $U = 100\,000$ cannot precede a transaction that already executed at $t = 50\text{ms}$ with $U = 1\,000$. Thus, a normal Agave block exhibits a small, steady background rate of inversions due to dynamic arrival, typically appearing as step-wise "sawtooth" resets in priority fee over time.

#### 3. Jito Bundle Detection Metric ($\mathcal{B}$)
A sequence of transactions $[T_k, T_{k+1}, \dots, T_{k+m}]$ is classified as a **Jito Bundle** if and only if it satisfies all of the following empirical conditions:
1. **Length Bound:** $1 \le (m + 1) \le 5$.
2. **Tip Destination:** The terminal transaction $T_{k+m}$ transfers $\ge 10\,000$ lamports to one of the 8 canonical Jito tip accounts.
3. **Sequential Contiguity:** The transactions appear consecutively at indices $k, k+1, \dots, k+m$ with no non-bundle transactions interleaved that conflict with the bundle's write-lock set.
4. **Economic Discrepancy:** The effective tip rate exceeds the base priority fee rate:
   $$\text{EffectiveTipRate} = \frac{\Delta \text{Balance}_{\text{tip}} \times 1\,000\,000}{\sum_{j=k}^{k+m} L_j} \gg \max_{j}(U_j)$$

#### 4. Block-Head Bundle Density ($\mathcal{D}_{head}$)
Measures the proportion of block space in the first 20% of the block occupied by detected Jito bundles:
$$\mathcal{D}_{head} = \frac{\sum_{i=0}^{\lfloor 0.2 N \rfloor} \mathbb{I}(T_i \in \text{Bundle})}{0.2 N}$$
High $\mathcal{D}_{head}$ (>0.15) strongly indicates Jito-Solana running head-of-slot bundle prioritization.

#### 5. Account CU Ceiling Saturation ($\mathcal{S}_{cu}$)
For each account $A$, compute cumulative consumed CU and requested CU:
$$\text{ConsumedCU}(A) = \sum_{T_i \in Seq(A)} C_i, \quad \text{RequestedCU}(A) = \sum_{T_i \in Seq(A)} L_i$$

- Standard Agave enforces $\text{RequestedCU}(A) \le 12\,000\,000$.
- Firedancer (`fd_pack`) with `use_consumed_cus = true` allows $\text{RequestedCU}(A) > 12\,000\,000$ provided that $\text{ConsumedCU}(A) \le 12\,000\,000$.
- **Detection Test:** If $\text{RequestedCU}(A) > 12\,000\,000$ but the block is valid, the validator is running a client with consumed-CU scheduling (Firedancer/Frankendancer or specialized Agave fork).

---

### 5.4 Validator Classification Decision Tree

Using these formal metrics, the measurement engine classifies the leader validator into one of five categories:

```
                          BLOCK CLASSIFICATION DECISION TREE
                          
                             Start: Inspect Block Data
                                         │
                                         ▼
                         Does Block contain transactions
                        transferring to Jito Tip Accounts?
                                   │           │
                              YES  │           │  NO
                                   ▼           ▼
                      Are tip txs clustered     Are there zero-fee inversions
                      at block head with        on conflicting DEX accounts
                      atomic contiguous chunks? without Jito tips?
                         │            │            │            │
                    YES  │       NO   │       YES  │       NO   │
                         ▼            ▼            ▼            ▼
                    Jito-Solana   Anomalous     Private     Check Write-Lock
                    (Confirmed)   Tip / MEV     Fast-Lane / Monotonicity (M_acc)
                                  Spam          Cartel Fork      │
                                                                 ▼
                                                  ┌──────────────────────────────┐
                                                  │ Is M_acc > 0.65?             │
                                                  ├──────────────┬───────────────┤
                                                  │ YES          │ NO            │
                                                  ▼              ▼               ▼
                                            Agave Central    Agave Legacy   Firedancer
                                            Scheduler        Multi-Iterator Check S_cu
                                            (prio-graph)     (Thread Clash)
```

#### Classification Rules:

1. **Jito-Solana:**
   - $\mathcal{B} > 0$ (at least one valid Jito bundle detected).
   - $\mathcal{D}_{head} > 0.05$ (bundles concentrated in the top 20% of block positions).
   - Bundle transactions exhibit priority inversion relative to public TPU transactions ($U_{\text{bundle}} < U_{\text{public}}$), justified by out-of-band tip payments.

2. **Agave Central Scheduler (`prio-graph`):**
   - $\mathcal{B} = 0$ (no Jito bundles present).
   - High Account Monotonicity: $\mathcal{M}_{acc} \ge 0.60$.
   - Low Concurrency-Aware Priority Inversion Index: $\mathcal{I}_{prio} < 0.20$.
   - Sawtooth pattern: periodic priority resets corresponding to new dynamic packet batch arrivals.
   - Strict adherence: $\text{RequestedCU}(A) \le 12\,000\,000$ across all accounts.

3. **Agave Legacy Multi-Iterator Scheduler:**
   - Low Account Monotonicity: $\mathcal{M}_{acc} < 0.35$.
   - High Inversion Index: $\mathcal{I}_{prio} \ge 0.40$ on contentious write-locks.
   - Significant lock collision footprint: high-fee transactions delayed behind low-fee transactions on the same account across disparate thread execution blocks.

4. **Frankendancer / Firedancer (`fd_pack`):**
   - High Account Monotonicity: $\mathcal{M}_{acc} \ge 0.75$.
   - Consumed CU efficiency: $\text{RequestedCU}(A) > 12\,000\,000$ with $\text{ConsumedCU}(A) \le 12\,000\,000$.
   - Exceptionally dense CU utilization: Total Block $\text{ConsumedCU} > 38\,000\,000$ during network congestion.
   - Distinctive knapsack packing signature: selection maximizing $\frac{\text{Fee}}{\text{RequestedCU}}$ or $\frac{\text{Fee}}{\text{ConsumedCU}}$.

5. **Private MEV / Cartel Fork:**
   - Systematic, persistent priority inversions favoring specific fee-payer public keys or specific AMM pools.
   - Transactions with $U = 0$ consistently occupying index positions $0 \le i \le 10$ on contentious write-locks without paying canonical Jito tips.
   - Non-canonical tip contracts receiving lamports or SPL tokens at the block head.

---

## 6. Technical Specification for the Measurement Engine

This section specifies the architecture, data schemas, algorithms, and implementation interfaces for the Solana Block Measurement Engine.

### 6.1 Engine Architecture Overview

```
┌────────────────────────────────────────────────────────────────────────────────┐
│                          MEASUREMENT ENGINE PIPELINE                           │
├───────────────────┬────────────────────────────────────────────────────────────┤
│ Pipeline Stage    │ Operational Responsibility                                 │
├───────────────────┼────────────────────────────────────────────────────────────┤
│ 1. Block Ingest   │ Async RPC fetcher with exponential backoff and rate-limit  │
│                   │ management. Pulls full blocks via getBlock.                │
├───────────────────┼────────────────────────────────────────────────────────────┤
│ 2. Normalization  │ Decodes ALT lookup tables, extracts ComputeBudget params,  │
│    & Enrichment   │ resolves full read/write sets, and calculates fees.        │
├───────────────────┼────────────────────────────────────────────────────────────┤
│ 3. Graph Engine   │ Constructs account write-lock sequences Seq(A) and builds  │
│                   │ the bipartite transaction-account conflict graph.          │
├───────────────────┼────────────────────────────────────────────────────────────┤
│ 4. Bundle Parser  │ Scans for the 8 canonical tip accounts, identifies chunk   │
│                   │ boundaries, verifies atomicity, and extracts tip amounts.  │
├───────────────────┼────────────────────────────────────────────────────────────┤
│ 5. Metric Engine  │ Computes Kendall's tau, Inversion Index, Head Density, and │
│                   │ CU saturation metrics.                                     │
├───────────────────┼────────────────────────────────────────────────────────────┤
│ 6. Classifier     │ Applies the multi-class decision tree and outputs a typed  │
│                   │ classification with statistical confidence intervals.      │
├───────────────────┼────────────────────────────────────────────────────────────┤
│ 7. Persistence    │ Writes structured analytical records into DuckDB / Parquet │
│                   │ for high-speed OLAP analytics.                             │
└───────────────────┴────────────────────────────────────────────────────────────┘
```

---

### 6.2 Relational & Analytical Data Schema (DuckDB / PostgreSQL)

```sql
-- Schema Definition for Solana Block Ordering Measurement Engine

-- 1. Blocks Table: Slot-level metadata and validator classification
CREATE TABLE blocks (
    slot BIGINT PRIMARY KEY,
    blockhash VARCHAR(88) NOT NULL,
    parent_slot BIGINT NOT NULL,
    block_time TIMESTAMP WITH TIME ZONE,
    block_height BIGINT,
    leader_identity VARCHAR(44),
    transaction_count INTEGER NOT NULL,
    successful_tx_count INTEGER NOT NULL,
    failed_tx_count INTEGER NOT NULL,
    total_compute_units_consumed BIGINT NOT NULL,
    total_compute_units_requested BIGINT NOT NULL,
    total_base_fees_lamports BIGINT NOT NULL,
    total_priority_fees_lamports BIGINT NOT NULL,
    total_jito_tips_lamports BIGINT NOT NULL,
    bundle_count INTEGER NOT NULL,
    account_monotonicity_score DOUBLE PRECISION,
    priority_inversion_index DOUBLE PRECISION,
    block_head_bundle_density DOUBLE PRECISION,
    classified_scheduler VARCHAR(32) NOT NULL, -- 'AGAVE_CENTRAL', 'AGAVE_LEGACY', 'JITO_SOLANA', 'FIREDANCER', 'CUSTOM_PRIVATE'
    classification_confidence DOUBLE PRECISION NOT NULL
);

-- 2. Transactions Table: Normalized per-transaction metrics
CREATE TABLE transactions (
    slot BIGINT NOT NULL,
    tx_index INTEGER NOT NULL,
    signature VARCHAR(88) NOT NULL,
    fee_payer VARCHAR(44) NOT NULL,
    is_successful BOOLEAN NOT NULL,
    error_code VARCHAR(64),
    num_signatures INTEGER NOT NULL,
    base_fee_lamports BIGINT NOT NULL,
    priority_fee_lamports BIGINT NOT NULL,
    compute_unit_limit BIGINT NOT NULL,
    compute_unit_price_micro_lamports BIGINT NOT NULL,
    compute_units_consumed BIGINT NOT NULL,
    effective_unit_price_micro_lamports BIGINT NOT NULL,
    is_jito_tip BOOLEAN NOT NULL,
    jito_tip_account VARCHAR(44),
    jito_tip_amount_lamports BIGINT DEFAULT 0,
    bundle_id VARCHAR(64),
    bundle_index INTEGER,
    writable_account_count INTEGER NOT NULL,
    readonly_account_count INTEGER NOT NULL,
    PRIMARY KEY (slot, tx_index),
    FOREIGN KEY (slot) REFERENCES blocks(slot)
);

-- 3. Account Locks Table: Flattened bipartite graph of account accesses
CREATE TABLE transaction_account_locks (
    slot BIGINT NOT NULL,
    tx_index INTEGER NOT NULL,
    account_address VARCHAR(44) NOT NULL,
    is_writable BOOLEAN NOT NULL,
    is_signer BOOLEAN NOT NULL,
    is_alt_loaded BOOLEAN NOT NULL,
    PRIMARY KEY (slot, tx_index, account_address),
    FOREIGN KEY (slot, tx_index) REFERENCES transactions(slot, tx_index)
);

-- 4. Jito Bundles Table: Detected atomic bundle sequences
CREATE TABLE jito_bundles (
    bundle_id VARCHAR(64) PRIMARY KEY,
    slot BIGINT NOT NULL,
    start_tx_index INTEGER NOT NULL,
    end_tx_index INTEGER NOT NULL,
    transaction_count INTEGER NOT NULL,
    total_tip_lamports BIGINT NOT NULL,
    tip_recipient VARCHAR(44) NOT NULL,
    cumulative_cu_consumed BIGINT NOT NULL,
    cumulative_cu_requested BIGINT NOT NULL,
    effective_tip_per_cu_micro_lamports DOUBLE PRECISION NOT NULL,
    shares_internal_locks BOOLEAN NOT NULL,
    FOREIGN KEY (slot) REFERENCES blocks(slot)
);

-- 5. Priority Inversions Table: Specific detected ordering anomalies
CREATE TABLE priority_inversions (
    slot BIGINT NOT NULL,
    earlier_tx_index INTEGER NOT NULL,
    later_tx_index INTEGER NOT NULL,
    conflicting_account VARCHAR(44) NOT NULL,
    earlier_unit_price BIGINT NOT NULL,
    later_unit_price BIGINT NOT NULL,
    price_delta_micro_lamports BIGINT NOT NULL,
    earlier_is_bundle BOOLEAN NOT NULL,
    later_is_bundle BOOLEAN NOT NULL,
    inversion_type VARCHAR(32) NOT NULL, -- 'CONCURRENT_THREAD_CANDIDATE', 'PROVABLE_CONFLICT_INVERSION', 'BUNDLE_PREEMPTION'
    PRIMARY KEY (slot, earlier_tx_index, later_tx_index, conflicting_account)
);

CREATE INDEX idx_blocks_classified ON blocks(classified_scheduler);
CREATE INDEX idx_tx_signature ON transactions(signature);
CREATE INDEX idx_tx_account ON transaction_account_locks(account_address, slot);
```

---

### 6.3 Core Algorithms (Formal Specification)

#### Algorithm 1: Account Write-Lock Conflict Graph & Chain Extraction

```
Input: Parsed block transactions T = [T_0, T_1, ..., T_{N-1}]
Output: Map of Account Address -> Ordered Sequence of Conflicting Transactions Seq(A)

1. Initialize map Chains: AccountAddress -> List of (Index, UnitPrice, CULimit, CUConsumed)
2. For index i from 0 to N-1:
3.     Let tx = T[i]
4.     For each account addr in tx.WritableAccounts:
5.         Append (i, tx.UnitPrice, tx.CULimit, tx.CUConsumed) to Chains[addr]
6. Return Chains
```

#### Algorithm 2: Jito Bundle Boundary & Atomicity Extractor

```
Input: Block transactions T = [T_0, T_1, ..., T_{N-1}]
Input: Set of canonical Jito Tip Accounts JITO_TIPS
Output: List of detected Bundles B

1. Initialize B = []
2. For i from 0 to N-1:
3.     Let tx = T[i]
4.     If tx transfers lamports to any addr in JITO_TIPS:
5.         Let tip_amount = balance increase of addr in tx
6.         If tip_amount == 0: continue
7.         
8.         // Terminal transaction found at index i. Backtrack to find bundle start.
9.         Let bundle_txs = [i]
10.        Let lookback_limit = min(5, i + 1)
11.        
12.        // Check predecessors for write-lock coupling and zero/low priority fees
13.        For offset from 1 to lookback_limit - 1:
14.            Let prev_idx = i - offset
15.            Let prev_tx = T[prev_idx]
16.            
17.            // Invariant: Bundles execute without third-party interleaved write conflicts
18.            If prev_tx conflicts with bundle_txs:
19.                Prepend prev_idx to bundle_txs
20.            Else if prev_tx has ComputeUnitPrice == 0 and prev_tx touches common DEX:
21.                Prepend prev_idx to bundle_txs
22.            Else:
23.                // Break boundary if transaction has distinct independent origin
24.                Break
25.                
26.        Let bundle_record = CreateBundle(
27.            Start = bundle_txs[0],
28.            End = i,
29.            Transactions = bundle_txs,
30.            TipAmount = tip_amount,
31.            TipRecipient = addr
32.        )
33.        Append bundle_record to B
34. Return B
```

#### Algorithm 3: Kendall's Tau Write-Lock Monotonicity Calculator

```
Input: Ordered list of transactions in write sequence Seq(A) = [T_0, ..., T_{m-1}]
Output: Kendall's Tau Score tau in [-1.0, 1.0]

1. Let m = len(Seq(A))
2. If m < 3: return null // Insufficient sample size
3. Let concordant = 0
4. Let discordant = 0
5. For j from 0 to m - 2:
6.     For k from j + 1 to m - 1:
7.         Let price_j = Seq(A)[j].UnitPrice
8.         Let price_k = Seq(A)[k].UnitPrice
9.         
10.        // In monotonic descending order, earlier transaction should have >= price
11.        If price_j > price_k:
12.            concordant += 1
13.        Else if price_j < price_k:
14.            discordant += 1
15.        Else:
16.            concordant += 0.5 // Treat ties neutrally
17. Let total_pairs = (m * (m - 1)) / 2
18. Return (concordant - discordant) / total_pairs
```

#### Algorithm 4: Validator Client Classifier

```
Input: Block metrics (M_acc, I_prio, Bundles, D_head, S_cu, LeaderIdentity)
Output: Classification Result (ClientType, ConfidenceScore, DiagnosticReasons)

1. Let num_bundles = len(Bundles)
2. If num_bundles > 0 and D_head >= 0.05:
3.     Let confidence = min(1.0, 0.70 + (0.05 * num_bundles) + (D_head * 0.5))
4.     Return ("JITO_SOLANA", confidence, ["Canonical tip transactions detected", "Head-of-block bundle concentration"])

5. If S_cu.ExceedsRequested12MCeiling and S_cu.ConsumedWithin12MLimit:
6.     Return ("FIREDANCER_FRANKENDANCER", 0.95, ["Dynamic consumed-CU scheduling detected", "Account ceiling packed on actual usage"])

7. If I_prio >= 0.40 and M_acc < 0.35:
8.     Return ("AGAVE_LEGACY", 0.85, ["Low write-lock monotonicity", "High conflicting priority inversion index"])

8. If M_acc >= 0.60 and I_prio < 0.20:
9.     Return ("AGAVE_CENTRAL", 0.90, ["High intra-account priority monotonicity", "Low write-conflict inversions", "Prio-graph signature"])

10. If num_bundles == 0 and PriorityInversionsOnDEXAtBlockHead > 5:
11.    Return ("CUSTOM_PRIVATE_FORK", 0.80, ["Zero-fee head-of-block transactions on contested write-locks without Jito tips"])

12. Return ("AGAVE_CENTRAL", 0.55, ["Default fallback; moderate monotonicity without distinct anomalies"])
```

---

### 6.4 Edge Cases, Protocol Nuances & Detection Pitfalls

The measurement engine must explicitly account for several Solana protocol subtleties:

#### 1. Address Lookup Tables (ALTs) and Versioned Transactions (v0)
- Legacy transactions contain explicit account keys in `message.accountKeys`.
- Versioned transactions (v0) resolve additional addresses dynamically from on-chain Address Lookup Tables.
- **Critical Requirement:** The measurement engine MUST parse `meta.loadedAddresses.writable` and `meta.loadedAddresses.readonly`. Failing to do so causes up to 40% of write-locks to be omitted, completely corrupting the conflict graph.

#### 2. Failed Transactions and Fee Mechanics
- Unlike Ethereum, where an out-of-gas transaction reverts state changes but still pays gas, Solana transactions that fail during execution (`meta.err != null`) STILL consume compute units up to the point of failure and STILL pay full base fees and priority fees.
- However, searcher bots intentionally submit revertible transactions when probing state.
- **Nuance in Jito Bundles:** If a transaction inside a Jito bundle fails simulation, Jito drops it entirely off-chain. If a bundle commits on-chain, all transactions succeeded, OR the user deliberately designed a transaction to handle errors internally. A failed transaction that pays a Jito tip is extremely rare and indicates an on-chain condition evaluation failure.

#### 3. Vote Transactions (`Vote111111111111111111111111111111111111111`)
- Validator consensus votes are submitted as standard Solana transactions referencing the Vote Program.
- In Agave, votes are received on a dedicated TPU vote port and processed through a prioritized vote path to prevent consensus starvation.
- **Filter Invariant:** The measurement engine MUST filter out or segregate Vote transactions from application transaction ordering analysis; otherwise, vote prioritization will register as artificial priority inversions.

#### 4. The Arrival Time Latency Gap
- A transaction arriving 350ms into the slot cannot preempt a transaction that completed at 20ms, even if the later transaction pays 10,000x higher priority fees.
- **False Inversion Mitigation:** The measurement engine segments the block into chronological sub-windows (approximated via transaction index deciles and cumulative CU) to avoid comparing transactions submitted during distinct phases of the slot.

---

## 7. Verification Test Suite & Synthetic Validation

To guarantee the measurement engine's accuracy, synthetic block test vectors are specified below.

### Test Vector A: Pure Agave Central Scheduler
- **Parameters:** 1,000 transactions; 0 Jito tips; 50 contentious transactions on Raydium AMM Account `675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8`.
- **Expected Metrics:**
  - $\mathcal{B} = 0$
  - $\mathcal{M}_{acc} \ge 0.85$ on Raydium AMM account
  - $\mathcal{I}_{prio} < 0.10$
- **Expected Classification:** `AGAVE_CENTRAL` (Confidence $\ge 0.90$).

### Test Vector B: Standard Jito-Solana Block
- **Parameters:** 800 transactions; 3 Jito bundles at indices `0..2`, `3..4`, and `5..7`; terminal transactions tip `96gYZGLnJYVFmbjzopPSU6QiEV5fGqZNyN9nmNhvrZU5` 0.01 SOL each; all bundle transactions have $U = 0$; public transactions at indices `8..800` have $U \in [10\,000, 500\,000]$.
- **Expected Metrics:**
  - $\mathcal{B} = 3$
  - $\mathcal{D}_{head} = 8 / (0.2 \times 800) = 0.05$
  - Apparent priority inversions at indices $0..7$ fully resolved by Jito tip attribution.
- **Expected Classification:** `JITO_SOLANA` (Confidence $\ge 0.95$).

### Test Vector C: Frankendancer / Firedancer Dynamic Packing
- **Parameters:** Contentious Account $X$ has 15 transactions; each requested 1,000,000 CU (Total Requested = 15,000,000 CU > 12M ceiling); each consumed only 100,000 CU (Total Consumed = 1,500,000 CU); block accepted.
- **Expected Metrics:**
  - $\text{RequestedCU}(X) = 15\,000\,000 > 12\,000\,000$
  - $\text{ConsumedCU}(X) \le 12\,000\,000$
- **Expected Classification:** `FIREDANCER_FRANKENDANCER` (Confidence $\ge 0.95$).

---

## 8. Conclusion

By shifting analysis from global block index sorting to **account-projected write-lock sequences**, the measurement engine circumvents the confounding effects of multithreaded completion jitter. Coupling this write-lock projection with canonical Jito tip account tracking and CU ceiling saturation checks provides a deterministic, mathematically rigorous framework to classify Solana validator block construction behavior with high empirical fidelity.
