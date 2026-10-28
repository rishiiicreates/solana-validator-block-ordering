/**
 * Targeted 6-Validator Mainnet Telemetry Collector & Benchmark Suite
 * Fetches confirmed blocks across 6 prominent Solana mainnet validators
 * spanning all 3 distinct client software implementations:
 *   - Firedancer (Jump Crypto)
 *   - Jito-Solana (Helius, Chorus One)
 *   - Agave / Solana Labs (Jupiter Validator, Coinbase Cloud, Validator 11AMA)
 */

import fs from 'fs';
import path from 'path';
import chalk from 'chalk';
import { SolanaCollector } from '../src/collector.js';
import { BlockAnalyzer } from '../src/analyzer.js';
import { TerminalVisualizer } from '../src/visualizer.js';
import { lookupValidatorClient } from '../src/constants.js';
import type {
  ClientImplementation,
  MeasurementSuiteResult,
  SafetyReport,
  SlotTelemetry,
  AggregatedMetrics,
} from '../src/types.js';

interface TargetSpec {
  slot: number;
  leader: string;
  name: string;
  client: ClientImplementation;
  notes: string;
}

const TARGETS: TargetSpec[] = [
  {
    slot: 462554210,
    leader: 'Fd7btgySsrjuo25CJCj7oE7VPMyezDhnx7pZkj2v69Nk',
    name: 'Jump Crypto (Firedancer)',
    client: 'firedancer',
    notes: 'Frankendancer / Firedancer high-throughput C engine with knapsack greedy packing',
  },
  {
    slot: 462554176,
    leader: 'HEL1USMZKAL2odpNBj2oCjffnFGaYwmbGmyewGv1e2TU',
    name: 'Helius (Jito-Solana)',
    client: 'jito',
    notes: 'High-stake validator running Jito-Solana bundle preemption engine',
  },
  {
    slot: 462554123,
    leader: 'DRpbCBMxVnDK7maPM5tGv6MvB3v1sRMC86PZ8okm21hy',
    name: 'Chorus One (Jito-Solana)',
    client: 'jito',
    notes: 'Institutional validator running Jito MEV client with bundle locker',
  },
  {
    slot: 462554084,
    leader: 'JUPiTERrZqgf1jUyR7dSkhMx4Kn2qJyekWsg3LT1h4b',
    name: 'Jupiter Validator (Agave)',
    client: 'agave',
    notes: 'Jupiter routing validator running standard Agave BankingStage DAG scheduler',
  },
  {
    slot: 462554159,
    leader: 'CAo1dCGYrB6NhHh5xb1cGjUiu86iyCfMTENxgHumSve4',
    name: 'Coinbase Cloud (Agave)',
    client: 'agave',
    notes: 'Enterprise institutional validator running standard Agave client',
  },
  {
    slot: 462549863,
    leader: '11AMA4mnNbsrPQeuoNN7uiZVJZtqEzQHrTfa5vnbcjk',
    name: 'Validator 11AMA (Agave)',
    client: 'agave',
    notes: 'High-capacity validator running Agave 26.10 consensus engine',
  },
];

async function collectAndAnalyze() {
  TerminalVisualizer.printHeader();
  console.log(chalk.bold.yellow('=== EXECUTING 6-VALIDATOR MAINNET MEASUREMENT SUITE ===\n'));

  const outputDir = path.resolve(process.cwd(), 'data');
  if (!fs.existsSync(outputDir)) {
    fs.mkdirSync(outputDir, { recursive: true });
  }

  const rpcUrl = process.env.SOLANA_RPC_URL || 'https://api.mainnet-beta.solana.com';
  const spendCapSol = 0.0;
  let readQueries = 0;

  console.log(`• RPC URL: ${chalk.cyan(rpcUrl)}`);
  console.log(`• Zero-Spend Guarantee: ${chalk.green(`${spendCapSol} SOL`)}`);
  console.log(`• Target Validators: ${chalk.bold.white(TARGETS.length)} across 3 client architectures:`);
  for (const t of TARGETS) {
    console.log(`    - [${t.client.toUpperCase()}] ${t.name} (Slot: ${t.slot}, Leader: ${t.leader.slice(0, 10)}...)`);
  }
  console.log('');

  const collector = new SolanaCollector({
    rpcUrl,
    commitment: 'confirmed',
    maxRetries: 5,
    initialBackoffMs: 1000,
  });

  const analyzer = new BlockAnalyzer({
    threadCount: 4,
    significanceThresholdMicroLamports: 50,
  });

  const analyzedSlots: SlotTelemetry[] = [];

  for (let i = 0; i < TARGETS.length; i++) {
    const target = TARGETS[i];
    console.log(chalk.cyan(`[${i + 1}/${TARGETS.length}] Fetching confirmed block for ${target.name} (Slot ${target.slot})...`));

    readQueries++;
    const block = await collector.getConfirmedBlock(target.slot);

    if (!block) {
      console.error(chalk.red(`  ✖ Failed to retrieve confirmed block for slot ${target.slot}`));
      continue;
    }

    console.log(chalk.green(`  ✔ Retrieved confirmed block (${block.transactions.length} total txs)`));

    const telemetry = analyzer.analyzeBlock(
      target.slot,
      block,
      target.leader,
      target.client,
      target.name
    );

    analyzedSlots.push(telemetry);
    TerminalVisualizer.printSlotReport(telemetry);

    // Save individual slot file
    const slotFile = path.join(outputDir, `telemetry-${target.slot}.json`);
    fs.writeFileSync(slotFile, JSON.stringify(telemetry, null, 2), 'utf-8');
    console.log(`  ✔ Saved slot telemetry to ${chalk.gray(`data/telemetry-${target.slot}.json`)}\n`);

    // Polite pause between RPC calls to respect public node rate limits
    await new Promise((r) => setTimeout(r, 1200));
  }

  console.log(chalk.cyan('Calculating aggregate multi-client benchmarks...'));

  const slotsByClient: Record<ClientImplementation, number> = {
    agave: 0,
    jito: 0,
    firedancer: 0,
    unknown: 0,
  };
  const sumInversionRateByClient: Record<ClientImplementation, number> = {
    agave: 0,
    jito: 0,
    firedancer: 0,
    unknown: 0,
  };
  const sumSpearmanByClient: Record<ClientImplementation, number> = {
    agave: 0,
    jito: 0,
    firedancer: 0,
    unknown: 0,
  };

  let totalJitoBundles = 0;
  let totalJitoTipsSol = 0;
  let sumSpeedup = 0;

  for (const s of analyzedSlots) {
    const c = s.clientType;
    slotsByClient[c] = (slotsByClient[c] || 0) + 1;
    sumInversionRateByClient[c] = (sumInversionRateByClient[c] || 0) + s.invariants.conflictingInversionRate;
    sumSpearmanByClient[c] = (sumSpearmanByClient[c] || 0) + s.invariants.spearmanRankCorrelation;

    totalJitoBundles += s.jitoBundles.length;
    for (const b of s.jitoBundles) {
      totalJitoTipsSol += b.tipAmountSol;
    }
    sumSpeedup += s.threadSlotting.theoreticalSpeedup;
  }

  const averageInversionRateByClient: Record<ClientImplementation, number> = {
    agave: slotsByClient.agave > 0 ? Math.round((sumInversionRateByClient.agave / slotsByClient.agave) * 100) / 100 : 0,
    jito: slotsByClient.jito > 0 ? Math.round((sumInversionRateByClient.jito / slotsByClient.jito) * 100) / 100 : 0,
    firedancer: slotsByClient.firedancer > 0 ? Math.round((sumInversionRateByClient.firedancer / slotsByClient.firedancer) * 100) / 100 : 0,
    unknown: slotsByClient.unknown > 0 ? Math.round((sumInversionRateByClient.unknown / slotsByClient.unknown) * 100) / 100 : 0,
  };

  const averageSpearmanByClient: Record<ClientImplementation, number> = {
    agave: slotsByClient.agave > 0 ? Math.round((sumSpearmanByClient.agave / slotsByClient.agave) * 1000) / 1000 : 0,
    jito: slotsByClient.jito > 0 ? Math.round((sumSpearmanByClient.jito / slotsByClient.jito) * 1000) / 1000 : 0,
    firedancer: slotsByClient.firedancer > 0 ? Math.round((sumSpearmanByClient.firedancer / slotsByClient.firedancer) * 1000) / 1000 : 0,
    unknown: slotsByClient.unknown > 0 ? Math.round((sumSpearmanByClient.unknown / slotsByClient.unknown) * 1000) / 1000 : 0,
  };

  const aggregated: AggregatedMetrics = {
    totalSlotsAnalyzed: analyzedSlots.length,
    slotsByClient,
    averageInversionRateByClient,
    averageSpearmanByClient,
    totalJitoBundlesDetected: totalJitoBundles,
    totalJitoTipsSol: Math.round(totalJitoTipsSol * 1e6) / 1e6,
    averageParallelSpeedup: analyzedSlots.length > 0 ? Math.round((sumSpeedup / analyzedSlots.length) * 100) / 100 : 1.0,
  };

  const safety: SafetyReport = {
    dryRun: false,
    spendCapSol,
    actualSpendSol: 0,
    spendCapExceeded: false,
    activeProbesDispatched: 0,
    readOnlyQueriesMade: readQueries,
  };

  const suiteResult: MeasurementSuiteResult = {
    timestamp: new Date().toISOString(),
    cluster: 'mainnet-beta',
    rpcUrl,
    slots: analyzedSlots,
    aggregated,
    safety,
  };

  TerminalVisualizer.printSuiteSummary(suiteResult);

  const summaryPath = path.join(outputDir, 'summary.json');
  fs.writeFileSync(summaryPath, JSON.stringify(suiteResult, null, 2), 'utf-8');
  console.log(`✔ Written consolidated benchmark summary to ${chalk.cyan(summaryPath)}`);

  console.log(chalk.bold.green('\n================================================================================'));
  console.log(chalk.bold.green(`  ✔ ALL ${analyzedSlots.length} VALIDATOR BLOCKS ANALYZED AND SAVED SUCCESSFULLY`));
  console.log(chalk.bold.green('================================================================================\n'));
}

collectAndAnalyze().catch((err) => {
  console.error(chalk.red('[Collection Error]:'), err);
  process.exit(1);
});
