/**
 * Solana Block Ordering & Telemetry Type Definitions
 */

export type ClientImplementation = 'agave' | 'jito' | 'firedancer' | 'unknown';

export interface ValidatorInfo {
  identity: string;
  votePubkey?: string;
  name?: string;
  client: ClientImplementation;
  commission?: number;
}

export interface ComputeBudgetDetails {
  unitsRequested: number;
  unitsConsumed: number;
  declaredPriceMicroLamports: number;
  loadedAccountsDataSizeLimit?: number;
}

export interface ParsedTxAnalysis {
  signature: string;
  slotIndex: number;
  isVote: boolean;
  status: 'success' | 'failed';
  feeLamports: number;
  baseFeeLamports: number;
  priorityFeeLamports: number;
  computeUnitsConsumed: number;
  computeUnitsRequested: number;
  declaredPriceMicroLamports: number;
  effectivePriceMicroLamports: number;
  requestedPriceMicroLamports: number;
  writeAccounts: string[];
  readAccounts: string[];
  allAccounts: string[];
  isJitoTipTx: boolean;
  jitoTipAccount?: string;
  jitoTipAmountLamports: number;
  jitoBundleId?: string;
  programIds: string[];
}

export interface JitoBundle {
  bundleId: string;
  signatures: string[];
  tipAccount: string;
  tipAmountLamports: number;
  tipAmountSol: number;
  startSlotIndex: number;
  endSlotIndex: number;
  transactionCount: number;
  totalComputeUnits: number;
  tipPerComputeUnit: number;
}

export interface ConflictEdge {
  fromTxIndex: number;
  toTxIndex: number;
  conflictingAccounts: string[];
}

export interface ConflictGraph {
  nodes: {
    txIndex: number;
    signature: string;
    degree: number;
    conflictsWith: number[];
    writeCount: number;
  }[];
  edges: ConflictEdge[];
  maxDegree: number;
  averageDegree: number;
  density: number;
}

export interface AccountContention {
  account: string;
  writeCount: number;
  readCount: number;
  totalAccessCount: number;
  contendingTxIndices: number[];
  isProgram: boolean;
}

export interface ThreadAssignment {
  txIndex: number;
  signature: string;
  threadId: number;
  startTime: number;
  endTime: number;
  waveIndex: number;
  duration: number;
}

export interface ThreadSlotting {
  threadCount: number;
  assignments: ThreadAssignment[];
  totalMakespan: number;
  sequentialDuration: number;
  theoreticalSpeedup: number;
  threadUtilizationPercent: number;
  maxParallelConcurrency: number;
}

export interface InvariantMetrics {
  totalTransactions: number;
  nonVoteTransactions: number;
  spearmanRankCorrelation: number; // Correlation between priority fee per CU and block index
  kendallTau: number;
  conflictingPairsCount: number;
  conflictingInversionsCount: number;
  conflictingInversionRate: number; // % of conflicting tx pairs where higher fee executed later
  globalInversionRate: number; // % of all non-vote pairs inverted
  topOfBlockJitoCount: number;
  topOfBlockJitoRatio: number;
  invariantsPassed: {
    feeOrderingMonotonic: boolean;
    lockConflictsRespected: boolean;
    jitoPrioritized: boolean;
  };
}

export interface SlotTelemetry {
  slot: number;
  blockhash: string;
  parentSlot: number;
  blockTime: number | null;
  leader: string;
  clientType: ClientImplementation;
  summary: {
    totalTransactions: number;
    successfulTransactions: number;
    failedTransactions: number;
    voteTransactions: number;
    nonVoteTransactions: number;
    totalFeesLamports: number;
    priorityFeesLamports: number;
    jitoTipsLamports: number;
    totalComputeUnits: number;
    averageComputeUnitsPerTx: number;
    averagePriorityFeePerCU: number;
  };
  transactions: ParsedTxAnalysis[];
  jitoBundles: JitoBundle[];
  hotAccounts: AccountContention[];
  conflictGraph: ConflictGraph;
  threadSlotting: ThreadSlotting;
  invariants: InvariantMetrics;
}

export interface AggregatedMetrics {
  totalSlotsAnalyzed: number;
  slotsByClient: Record<ClientImplementation, number>;
  averageInversionRateByClient: Record<ClientImplementation, number>;
  averageSpearmanByClient: Record<ClientImplementation, number>;
  totalJitoBundlesDetected: number;
  totalJitoTipsSol: number;
  averageParallelSpeedup: number;
}

export interface SafetyReport {
  dryRun: boolean;
  spendCapSol: number;
  actualSpendSol: number;
  spendCapExceeded: boolean;
  activeProbesDispatched: number;
  readOnlyQueriesMade: number;
}

export interface MeasurementSuiteResult {
  timestamp: string;
  cluster: string;
  rpcUrl: string;
  slots: SlotTelemetry[];
  aggregated: AggregatedMetrics;
  safety: SafetyReport;
}
