# Solana Block Ordering & MEV Telemetry Measurement Suite

A high-performance TypeScript measurement and telemetry suite for analyzing Solana block ordering, priority fee dynamics, account lock conflict graphs, and Jito MEV bundles across validator client implementations.

---

## Capabilities

- **Cluster & Leader Discovery**: Connects to Solana RPC (Mainnet/Devnet), queries `getLeaderSchedule` and `getEpochInfo`, and isolates slots assigned to target validators across distinct client implementations (standard Agave, Jito-Solana, Firedancer/Frankendancer).
- **Confirmed Block Fetching**: Retrieves confirmed blocks with `maxSupportedTransactionVersion: 0` (with resilient handling for modern version 1 transaction blocks).
- **Priority Fee per CU Analysis**:
  - Parses binary `ComputeBudget111111111111111111111111111111` instructions (`SetComputeUnitLimit`, `SetComputeUnitPrice`).
  - Computes declared micro-lamports per CU, effective price per consumed CU, and requested price per requested CU.
  - Distinguishes non-vote execution fees from standard vote gossip transactions.
- **Account Write-Lock Conflict Graph**:
  - Reconstructs complete transaction read/write account sets across static keys and Address Lookup Tables (ALTs).
  - Builds the conflict dependency graph where shared write locks mandate sequential execution.
  - Extracts hot account contention rankings (e.g., Raydium, Orca, Pump.fun DEX pools).
- **Parallel Thread Slotting Simulation**:
  - Simulates Solana's banking stage multi-threaded scheduler across $K$ threads (default 4).
  - Evaluates critical path makespan, sequential vs parallel execution speedup, thread utilization, and queue delays.
- **Jito MEV Bundle Detection**:
  - Tracks all 8 canonical Jito tip payment accounts (`96gYZ...`, `HFqU...`, `Cw8C...`, `ADaU...`, `DfXy...`, `ADuU...`, `DttW...`, `3AVi...`).
  - Calculates tip transfers in lamports and SOL, bundles related pre-tip transactions, and measures tip per compute unit.
- **Invariant Testing**:
  - Spearman rank correlation ($\rho$) and Kendall's Tau ($\tau$) between priority fee rate and block index.
  - Conflicting-pair priority inversion rate: measures whether transactions competing for the same write-lock respect fee precedence.
  - Jito top-of-block positioning invariant.
- **Safety Guarantees & Spend Cap**:
  - Safe dry-run mode (`--dry-run`).
  - Strict spend-cap enforcement (`--spend-cap <sol>`) with automated circuit-breakers ensuring 0.0 SOL unexpected spend.
- **Reproducible Telemetry**: Exports machine-readable raw JSON files to `data/telemetry-<slot>.json` and `data/summary.json`.

---

## Installation & Setup

```bash
cd /Users/rishii/Projects/solana-block-ordering
npm install
npm run build
```

Configure environment variables in `.env` (optional, defaults to public Mainnet):
```bash
cp .env.example .env
```

---

## CLI Usage

### 1. Run Verification Suite (End-to-End)
Fetches live Solana mainnet slots, computes all metrics, verifies invariants, and exports telemetry to `data/`:
```bash
npm run verify
```

### 2. Sample Slots from a Specific Validator (e.g. Helius / Jito Client)
```bash
npm start -- --validator HEL1USMZKAL2odpNBj2oCjffnFGaYwmbGmyewGv1e2TU --samples 3
```

### 3. Target Specific Client Implementation
Target Jito-Solana validators:
```bash
npm start -- --client jito --samples 3
```
Target standard Agave validators:
```bash
npm start -- --client agave --samples 3
```

### 4. Analyze a Specific Mainnet Slot Directly
```bash
npm start -- --slot 462550123
```

### 5. Safe Dry-Run Mode & Strict Spend Cap
```bash
npm start -- --dry-run --spend-cap 0.0 --samples 2
```

### 6. Offline Mock Fixture Mode
```bash
npm start -- --mock --samples 3
```

### 7. Output Raw JSON to stdout
```bash
npm start -- --slot 462550123 --json
```

---

## Data Exports Schema

Exported files in `data/`:
- `data/telemetry-<slot>.json`: Comprehensive per-slot telemetry:
  - `slot`, `blockhash`, `leader`, `clientType`
  - `summary`: total transactions, vote vs non-vote, total fees, Jito tips, compute units
  - `transactions`: per-transaction parsed accounts, write locks, priority fee rates
  - `jitoBundles`: detected atomic bundles, tip amounts, bundled signatures
  - `hotAccounts`: write contention rankings and contending transaction indices
  - `conflictGraph`: node degrees, conflict edges, graph density
  - `threadSlotting`: simulated thread assignments, timeline start/end times, speedup
  - `invariants`: Spearman rank correlation, conflicting inversion rates, pass/fail status
- `data/summary.json`: Multi-slot aggregate benchmark and safety audit report.
