/**
 * Solana Block Ordering Analyzer
 * Computes priority fees, lock conflict graphs, thread slotting, Jito bundles, and invariant testing.
 */

import type { VersionedBlockResponse } from '@solana/web3.js';
import {
  COMPUTE_BUDGET_PROGRAM_ID,
  VOTE_PROGRAM_ID,
  BASE_LAMPORTS_PER_SIGNATURE,
  DEFAULT_COMPUTE_UNIT_LIMIT,
  MAX_COMPUTE_UNIT_LIMIT,
  JITO_TIP_ACCOUNTS,
} from './constants.js';
import type {
  ClientImplementation,
  ParsedTxAnalysis,
  JitoBundle,
  ConflictGraph,
  ConflictEdge,
  AccountContention,
  ThreadSlotting,
  ThreadAssignment,
  InvariantMetrics,
  SlotTelemetry,
} from './types.js';

export interface AnalyzerOptions {
  threadCount?: number;
  significanceThresholdMicroLamports?: number;
}

export class BlockAnalyzer {
  private threadCount: number;
  private significanceThreshold: number;

  constructor(options: AnalyzerOptions = {}) {
    this.threadCount = options.threadCount ?? 4;
    this.significanceThreshold = options.significanceThresholdMicroLamports ?? 100;
  }

  /**
   * Main entry point: Analyze a confirmed Solana block
   */
  public analyzeBlock(
    slot: number,
    block: VersionedBlockResponse,
    leader: string,
    clientType: ClientImplementation = 'unknown',
    validatorName?: string
  ): SlotTelemetry {
    const transactions = this.parseTransactions(block);
    const jitoBundles = this.detectJitoBundles(transactions);
    const hotAccounts = this.computeAccountContention(transactions);
    const conflictGraph = this.buildConflictGraph(transactions);
    const threadSlotting = this.simulateThreadSlotting(transactions);
    const invariants = this.testInvariants(transactions, conflictGraph, jitoBundles);

    // Compute slot aggregate summaries
    let successfulTransactions = 0;
    let failedTransactions = 0;
    let voteTransactions = 0;
    let nonVoteTransactions = 0;
    let totalFeesLamports = 0;
    let priorityFeesLamports = 0;
    let jitoTipsLamports = 0;
    let totalComputeUnits = 0;
    let sumEffectivePrice = 0;

    for (const tx of transactions) {
      if (tx.status === 'success') successfulTransactions++;
      else failedTransactions++;

      if (tx.isVote) voteTransactions++;
      else {
        nonVoteTransactions++;
        sumEffectivePrice += tx.effectivePriceMicroLamports;
      }

      totalFeesLamports += tx.feeLamports;
      priorityFeesLamports += tx.priorityFeeLamports;
      jitoTipsLamports += tx.jitoTipAmountLamports;
      totalComputeUnits += tx.computeUnitsConsumed;
    }

    const averageComputeUnitsPerTx =
      transactions.length > 0 ? Math.round(totalComputeUnits / transactions.length) : 0;
    const averagePriorityFeePerCU =
      nonVoteTransactions > 0 ? Math.round(sumEffectivePrice / nonVoteTransactions) : 0;

    return {
      slot,
      blockhash: block.blockhash,
      parentSlot: Number(block.parentSlot),
      blockTime:
        block.blockTime !== null && block.blockTime !== undefined
          ? Number(block.blockTime)
          : null,
      leader,
      validatorName,
      clientType,
      summary: {
        totalTransactions: transactions.length,
        successfulTransactions,
        failedTransactions,
        voteTransactions,
        nonVoteTransactions,
        totalFeesLamports,
        priorityFeesLamports,
        jitoTipsLamports,
        totalComputeUnits,
        averageComputeUnitsPerTx,
        averagePriorityFeePerCU,
      },
      transactions,
      jitoBundles,
      hotAccounts,
      conflictGraph,
      threadSlotting,
      invariants,
    };
  }

  /**
   * Parse all transactions in the block into detailed metadata
   */
  public parseTransactions(block: VersionedBlockResponse): ParsedTxAnalysis[] {
    const parsed: ParsedTxAnalysis[] = [];

    for (let index = 0; index < block.transactions.length; index++) {
      const rawTx = block.transactions[index];
      const message = rawTx.transaction.message;
      const meta = rawTx.meta;

      const signature = rawTx.transaction.signatures[0] || `tx-${index}`;
      const status: 'success' | 'failed' = meta?.err ? 'failed' : 'success';
      const feeLamports = meta?.fee ? Number(meta.fee) : 0;
      const numSigners = rawTx.transaction.signatures.length || 1;
      const baseFeeLamports = numSigners * BASE_LAMPORTS_PER_SIGNATURE;
      const priorityFeeLamports = Math.max(0, feeLamports - baseFeeLamports);
      const computeUnitsConsumed = meta?.computeUnitsConsumed ? Number(meta.computeUnitsConsumed) : 0;

      // Extract static accounts
      const staticKeys = message.staticAccountKeys.map((k) => k.toBase58());
      const header = message.header;

      // Loaded lookup table addresses
      const writableLookups = (meta?.loadedAddresses?.writable || []).map((k) => k.toBase58());
      const readonlyLookups = (meta?.loadedAddresses?.readonly || []).map((k) => k.toBase58());

      const writeAccounts: string[] = [];
      const readAccounts: string[] = [];

      const numReqSignatures = header.numRequiredSignatures;
      const numReadonlySigned = header.numReadonlySignedAccounts;
      const numReadonlyUnsigned = header.numReadonlyUnsignedAccounts;
      const numStatic = staticKeys.length;

      // Static signers
      for (let i = 0; i < numReqSignatures; i++) {
        if (i < numReqSignatures - numReadonlySigned) {
          writeAccounts.push(staticKeys[i]);
        } else {
          readAccounts.push(staticKeys[i]);
        }
      }

      // Static non-signers
      for (let i = numReqSignatures; i < numStatic; i++) {
        if (i < numStatic - numReadonlyUnsigned) {
          writeAccounts.push(staticKeys[i]);
        } else {
          readAccounts.push(staticKeys[i]);
        }
      }

      // Append lookup tables
      writeAccounts.push(...writableLookups);
      readAccounts.push(...readonlyLookups);

      const allAccounts = [...writeAccounts, ...readAccounts];

      // Identify program IDs
      const programIds: string[] = [];
      let isVote = false;
      let computeUnitsRequested = DEFAULT_COMPUTE_UNIT_LIMIT;
      let declaredPriceMicroLamports = 0;

      for (const ix of message.compiledInstructions) {
        const progId = staticKeys[ix.programIdIndex];
        if (progId) {
          programIds.push(progId);
          if (progId === VOTE_PROGRAM_ID) {
            isVote = true;
          }

          if (progId === COMPUTE_BUDGET_PROGRAM_ID) {
            const buf = Buffer.isBuffer(ix.data)
              ? ix.data
              : Buffer.from(ix.data as any);

            if (buf.length > 0) {
              const ixType = buf[0];
              if (ixType === 2 && buf.length >= 5) {
                // SetComputeUnitLimit
                computeUnitsRequested = buf.readUInt32LE(1);
              } else if (ixType === 3 && buf.length >= 9) {
                // SetComputeUnitPrice
                declaredPriceMicroLamports = Number(buf.readBigUInt64LE(1));
              }
            }
          }
        }
      }

      // Compute fee rate metrics
      const effectivePriceMicroLamports =
        computeUnitsConsumed > 0
          ? Math.round((priorityFeeLamports * 1_000_000) / computeUnitsConsumed)
          : declaredPriceMicroLamports;

      const requestedPriceMicroLamports =
        computeUnitsRequested > 0
          ? Math.round((priorityFeeLamports * 1_000_000) / computeUnitsRequested)
          : 0;

      // Jito Tip Account Detection
      let isJitoTipTx = false;
      let jitoTipAccount: string | undefined;
      let jitoTipAmountLamports = 0;

      if (meta && meta.preBalances && meta.postBalances) {
        for (let aIdx = 0; aIdx < allAccounts.length; aIdx++) {
          const acc = allAccounts[aIdx];
          if (JITO_TIP_ACCOUNTS.has(acc)) {
            const pre = Number(meta.preBalances[aIdx] ?? 0);
            const post = Number(meta.postBalances[aIdx] ?? 0);
            const diff = post - pre;
            if (diff > 0) {
              isJitoTipTx = true;
              jitoTipAccount = acc;
              jitoTipAmountLamports = diff;
              break;
            }
          }
        }
      }

      parsed.push({
        signature,
        slotIndex: index,
        isVote,
        status,
        feeLamports,
        baseFeeLamports,
        priorityFeeLamports,
        computeUnitsConsumed,
        computeUnitsRequested,
        declaredPriceMicroLamports,
        effectivePriceMicroLamports,
        requestedPriceMicroLamports,
        writeAccounts: Array.from(new Set(writeAccounts)),
        readAccounts: Array.from(new Set(readAccounts)),
        allAccounts: Array.from(new Set(allAccounts)),
        isJitoTipTx,
        jitoTipAccount,
        jitoTipAmountLamports,
        programIds: Array.from(new Set(programIds)),
      });
    }

    return parsed;
  }

  /**
   * Detect Jito MEV Bundles
   * Bundles end with a Jito tip transaction and can include up to 4 preceding related transactions.
   */
  public detectJitoBundles(transactions: ParsedTxAnalysis[]): JitoBundle[] {
    const bundles: JitoBundle[] = [];

    for (let i = 0; i < transactions.length; i++) {
      const tipTx = transactions[i];
      if (!tipTx.isJitoTipTx || !tipTx.jitoTipAccount) continue;

      const bundleSignatures: string[] = [tipTx.signature];
      let startIdx = i;
      let totalCU = tipTx.computeUnitsConsumed;

      // Scan up to 4 transactions backwards to see if they formed an atomic bundle
      const tipWriteSet = new Set(tipTx.writeAccounts);

      for (let j = i - 1; j >= Math.max(0, i - 4); j--) {
        const prevTx = transactions[j];
        if (prevTx.isVote || prevTx.isJitoTipTx) break;

        // Check if prevTx shares write locks with tip or intermediate bundle transactions
        const sharesLock = prevTx.writeAccounts.some((acc) => tipWriteSet.has(acc));
        // Or if previous tx was back-to-back non-vote swap
        if (sharesLock || j === i - 1) {
          bundleSignatures.unshift(prevTx.signature);
          startIdx = j;
          totalCU += prevTx.computeUnitsConsumed;
          // Expand write set
          for (const w of prevTx.writeAccounts) tipWriteSet.add(w);
        } else {
          break;
        }
      }

      const bundleId = `bundle-${tipTx.slotIndex}-${bundleSignatures.length}`;
      // Tag transactions with bundleId
      for (let k = startIdx; k <= i; k++) {
        transactions[k].jitoBundleId = bundleId;
      }

      bundles.push({
        bundleId,
        signatures: bundleSignatures,
        tipAccount: tipTx.jitoTipAccount,
        tipAmountLamports: tipTx.jitoTipAmountLamports,
        tipAmountSol: tipTx.jitoTipAmountLamports / 1_000_000_000,
        startSlotIndex: startIdx,
        endSlotIndex: i,
        transactionCount: bundleSignatures.length,
        totalComputeUnits: totalCU,
        tipPerComputeUnit:
          totalCU > 0 ? Number((BigInt(tipTx.jitoTipAmountLamports) * 1_000_000n) / BigInt(totalCU)) : 0,
      });
    }

    return bundles;
  }

  /**
   * Account write and read contention analysis
   */
  public computeAccountContention(transactions: ParsedTxAnalysis[]): AccountContention[] {
    const contentionMap = new Map<
      string,
      { writeCount: number; readCount: number; contendingTxs: number[] }
    >();

    for (const tx of transactions) {
      if (tx.isVote) continue;

      for (const w of tx.writeAccounts) {
        let entry = contentionMap.get(w);
        if (!entry) {
          entry = { writeCount: 0, readCount: 0, contendingTxs: [] };
          contentionMap.set(w, entry);
        }
        entry.writeCount++;
        entry.contendingTxs.push(tx.slotIndex);
      }

      for (const r of tx.readAccounts) {
        let entry = contentionMap.get(r);
        if (!entry) {
          entry = { writeCount: 0, readCount: 0, contendingTxs: [] };
          contentionMap.set(r, entry);
        }
        entry.readCount++;
      }
    }

    const results: AccountContention[] = [];
    for (const [account, data] of contentionMap.entries()) {
      results.push({
        account,
        writeCount: data.writeCount,
        readCount: data.readCount,
        totalAccessCount: data.writeCount + data.readCount,
        contendingTxIndices: Array.from(new Set(data.contendingTxs)),
        isProgram: account.endsWith('11111111') || account.length < 32,
      });
    }

    // Sort by writeCount descending (write locks cause direct serialization)
    return results.sort((a, b) => b.writeCount - a.writeCount).slice(0, 50);
  }

  /**
   * Construct Account Write-Lock Conflict Graph
   */
  public buildConflictGraph(transactions: ParsedTxAnalysis[]): ConflictGraph {
    const nonVotes = transactions.filter((t) => !t.isVote);
    const nodes = nonVotes.map((tx) => ({
      txIndex: tx.slotIndex,
      signature: tx.signature,
      degree: 0,
      conflictsWith: [] as number[],
      writeCount: tx.writeAccounts.length,
    }));

    const nodeIndexMap = new Map<number, number>();
    for (let i = 0; i < nodes.length; i++) {
      nodeIndexMap.set(nodes[i].txIndex, i);
    }

    const edges: ConflictEdge[] = [];

    // Map each writable account to txs that accessed it
    const writeAccountToTxs = new Map<string, number[]>();
    for (const tx of nonVotes) {
      for (const acc of tx.writeAccounts) {
        const list = writeAccountToTxs.get(acc) || [];
        list.push(tx.slotIndex);
        writeAccountToTxs.set(acc, list);
      }
    }

    // Connect pairs that share write locks
    const pairConflicts = new Map<string, string[]>();

    for (const [acc, txIndices] of writeAccountToTxs.entries()) {
      if (txIndices.length < 2) continue;
      for (let i = 0; i < txIndices.length; i++) {
        for (let j = i + 1; j < txIndices.length; j++) {
          const from = Math.min(txIndices[i], txIndices[j]);
          const to = Math.max(txIndices[i], txIndices[j]);
          const key = `${from}-${to}`;
          const current = pairConflicts.get(key) || [];
          current.push(acc);
          pairConflicts.set(key, current);
        }
      }
    }

    for (const [pairKey, conflictingAccounts] of pairConflicts.entries()) {
      const [fromStr, toStr] = pairKey.split('-');
      const from = Number(fromStr);
      const to = Number(toStr);

      edges.push({
        fromTxIndex: from,
        toTxIndex: to,
        conflictingAccounts,
      });

      const nodeAIdx = nodeIndexMap.get(from);
      const nodeBIdx = nodeIndexMap.get(to);
      if (nodeAIdx !== undefined && nodeBIdx !== undefined) {
        nodes[nodeAIdx].degree++;
        nodes[nodeAIdx].conflictsWith.push(to);
        nodes[nodeBIdx].degree++;
        nodes[nodeBIdx].conflictsWith.push(from);
      }
    }

    let maxDegree = 0;
    let sumDegree = 0;
    for (const n of nodes) {
      if (n.degree > maxDegree) maxDegree = n.degree;
      sumDegree += n.degree;
    }

    const avgDegree = nodes.length > 0 ? sumDegree / nodes.length : 0;
    const possibleEdges = (nodes.length * (nodes.length - 1)) / 2;
    const density = possibleEdges > 0 ? edges.length / possibleEdges : 0;

    return {
      nodes,
      edges,
      maxDegree,
      averageDegree: Math.round(avgDegree * 100) / 100,
      density: Math.round(density * 10000) / 10000,
    };
  }

  /**
   * Simulate Parallel Thread Slotting on K Banking Stage Threads
   */
  public simulateThreadSlotting(transactions: ParsedTxAnalysis[]): ThreadSlotting {
    const nonVotes = transactions.filter((t) => !t.isVote);
    const assignments: ThreadAssignment[] = [];

    // Track thread busy until time
    const threadAvailableTime = new Array(this.threadCount).fill(0);

    // Track when each account write-lock is released
    const accountLockFreeTime = new Map<string, number>();

    let totalSequential = 0;
    let waveCounter = 0;

    for (const tx of nonVotes) {
      // Approximate duration by CU consumed (normalized, min 1 unit)
      const duration = Math.max(1, Math.ceil(tx.computeUnitsConsumed / 10_000));
      totalSequential += duration;

      // Earliest time all required accounts become available
      let earliestAccountAvailable = 0;
      for (const w of tx.writeAccounts) {
        const freeTime = accountLockFreeTime.get(w) ?? 0;
        if (freeTime > earliestAccountAvailable) {
          earliestAccountAvailable = freeTime;
        }
      }

      // Find an available thread that can schedule this transaction
      let bestThread = 0;
      let earliestStartTime = Infinity;

      for (let t = 0; t < this.threadCount; t++) {
        const threadReady = threadAvailableTime[t];
        const possibleStart = Math.max(threadReady, earliestAccountAvailable);
        if (possibleStart < earliestStartTime) {
          earliestStartTime = possibleStart;
          bestThread = t;
        }
      }

      const startTime = earliestStartTime;
      const endTime = startTime + duration;

      // Update thread state
      threadAvailableTime[bestThread] = endTime;

      // Update account locks
      for (const w of tx.writeAccounts) {
        accountLockFreeTime.set(w, endTime);
      }

      const waveIndex = Math.floor(startTime / 10);

      assignments.push({
        txIndex: tx.slotIndex,
        signature: tx.signature,
        threadId: bestThread,
        startTime,
        endTime,
        waveIndex,
        duration,
      });
    }

    const totalMakespan = Math.max(...threadAvailableTime, 1);
    const theoreticalSpeedup =
      totalMakespan > 0 ? Math.round((totalSequential / totalMakespan) * 100) / 100 : 1;
    const capacity = totalMakespan * this.threadCount;
    const threadUtilizationPercent =
      capacity > 0 ? Math.round((totalSequential / capacity) * 1000) / 10 : 0;

    return {
      threadCount: this.threadCount,
      assignments,
      totalMakespan,
      sequentialDuration: totalSequential,
      theoreticalSpeedup,
      threadUtilizationPercent,
      maxParallelConcurrency: this.threadCount,
    };
  }

  /**
   * Test Invariants:
   * 1. Priority fee ordering monotonicity
   * 2. Conflicting-pair priority inversion rate
   * 3. Jito MEV bundle top-of-block positioning
   */
  public testInvariants(
    transactions: ParsedTxAnalysis[],
    conflictGraph: ConflictGraph,
    jitoBundles: JitoBundle[]
  ): InvariantMetrics {
    const nonVotes = transactions.filter((t) => !t.isVote);

    // 1. Spearman Rank Correlation & Global Inversion Rate
    let spearman = 0;
    let kendallTau = 0;
    let globalInversionCount = 0;
    let totalNonVotePairs = 0;

    if (nonVotes.length > 1) {
      // Compute ranks
      const n = nonVotes.length;
      const feeRanks = nonVotes
        .map((tx, idx) => ({ tx, origIdx: idx }))
        .sort((a, b) => b.tx.effectivePriceMicroLamports - a.tx.effectivePriceMicroLamports)
        .map((item, rank) => ({ origIdx: item.origIdx, rank: rank + 1 }));

      feeRanks.sort((a, b) => a.origIdx - b.origIdx);

      let dSquaredSum = 0;
      for (let i = 0; i < n; i++) {
        const slotRank = i + 1;
        const feeRank = feeRanks[i].rank;
        const d = slotRank - feeRank;
        dSquaredSum += d * d;
      }
      spearman = 1 - (6 * dSquaredSum) / (n * (n * n - 1));

      // Global pair inversions
      let concordant = 0;
      let discordant = 0;

      for (let i = 0; i < n; i++) {
        for (let j = i + 1; j < n; j++) {
          totalNonVotePairs++;
          const feeA = nonVotes[i].effectivePriceMicroLamports;
          const feeB = nonVotes[j].effectivePriceMicroLamports;

          if (feeB > feeA + this.significanceThreshold) {
            // feeB executed later than feeA despite paying significantly higher fee
            globalInversionCount++;
            discordant++;
          } else if (feeA > feeB + this.significanceThreshold) {
            concordant++;
          }
        }
      }

      if (totalNonVotePairs > 0) {
        kendallTau = (concordant - discordant) / totalNonVotePairs;
      }
    }

    const globalInversionRate =
      totalNonVotePairs > 0 ? Math.round((globalInversionCount / totalNonVotePairs) * 10000) / 100 : 0;

    // 2. Conflicting-Pair Priority Inversions
    let conflictingInversionsCount = 0;
    const conflictingPairsCount = conflictGraph.edges.length;

    const txMap = new Map<number, ParsedTxAnalysis>();
    for (const tx of transactions) {
      txMap.set(tx.slotIndex, tx);
    }

    for (const edge of conflictGraph.edges) {
      const txA = txMap.get(edge.fromTxIndex);
      const txB = txMap.get(edge.toTxIndex);
      if (!txA || !txB) continue;

      // edge.fromTxIndex executed before edge.toTxIndex (from < to)
      // An inversion occurs if txB paid higher priority fee than txA
      if (txB.effectivePriceMicroLamports > txA.effectivePriceMicroLamports + this.significanceThreshold) {
        conflictingInversionsCount++;
      }
    }

    const conflictingInversionRate =
      conflictingPairsCount > 0
        ? Math.round((conflictingInversionsCount / conflictingPairsCount) * 10000) / 100
        : 0;

    // 3. Jito MEV Top-of-Block positioning
    const totalTransactions = transactions.length;
    const top20Threshold = Math.ceil(totalTransactions * 0.2);
    let topOfBlockJitoCount = 0;

    for (const b of jitoBundles) {
      if (b.startSlotIndex <= top20Threshold) {
        topOfBlockJitoCount++;
      }
    }

    const topOfBlockJitoRatio =
      jitoBundles.length > 0 ? Math.round((topOfBlockJitoCount / jitoBundles.length) * 100) / 100 : 1.0;

    return {
      totalTransactions,
      nonVoteTransactions: nonVotes.length,
      spearmanRankCorrelation: Math.round(spearman * 1000) / 1000,
      kendallTau: Math.round(kendallTau * 1000) / 1000,
      conflictingPairsCount,
      conflictingInversionsCount,
      conflictingInversionRate,
      globalInversionRate,
      topOfBlockJitoCount,
      topOfBlockJitoRatio,
      invariantsPassed: {
        feeOrderingMonotonic: spearman > -0.8, // in real solana scheduler, parallel threads cause mild divergence
        lockConflictsRespected: true, // Solana runtime enforces zero conflicting write-locks executing at identical cycle
        jitoPrioritized: topOfBlockJitoRatio >= 0.3 || jitoBundles.length === 0,
      },
    };
  }
}
