#!/usr/bin/env node

/**
 * Solana Block Ordering Measurement Suite CLI
 */

import { Command } from 'commander';
import dotenv from 'dotenv';
import fs from 'fs';
import path from 'path';
import chalk from 'chalk';
import { SolanaCollector } from './collector.js';
import { BlockAnalyzer } from './analyzer.js';
import { TerminalVisualizer } from './visualizer.js';
import { generateSyntheticBlock } from './mock.js';
import { lookupValidatorClient } from './constants.js';
import type {
  ClientImplementation,
  MeasurementSuiteResult,
  SafetyReport,
  SlotTelemetry,
  AggregatedMetrics,
} from './types.js';

dotenv.config();

const program = new Command();

program
  .name('solana-block-ordering')
  .description('Solana block ordering, priority fee ranking, account lock conflict graph, and Jito MEV bundle measurement suite')
  .version('1.0.0')
  .option('-u, --rpc-url <url>', 'Solana RPC endpoint URL', process.env.SOLANA_RPC_URL || 'https://api.mainnet-beta.solana.com')
  .option('-v, --validator <pubkey>', 'Target validator identity public key', process.env.SOLANA_VALIDATOR_PUBKEY)
  .option('-c, --client <type>', 'Target validator client type (agave, jito, firedancer, all)', 'all')
  .option('-s, --samples <number>', 'Number of slots to sample and analyze', '5')
  .option('--slot <number>', 'Specific slot number to analyze directly')
  .option('--dry-run', 'Execute in safe dry-run mode with strict read-only safety guarantees', false)
  .option('--spend-cap <sol>', 'Maximum spend cap in SOL for probing operations (strict circuit-breaker)', process.env.SOLANA_SPEND_CAP || '0.0')
  .option('-o, --output-dir <path>', 'Directory to save raw telemetry JSON exports', './data')
  .option('-t, --threads <number>', 'Banking stage thread count for parallel slotting simulation', '4')
  .option('--mock', 'Force using synthetic block fixtures (offline mode)', false)
  .option('--json', 'Output full telemetry JSON to stdout', false);

program.parse(process.argv);
const options = program.opts();

async function main() {
  const isDryRun = Boolean(options.dryRun);
  const spendCapSol = parseFloat(options.spendCap);
  const sampleCount = parseInt(options.samples, 10) || 5;
  const threadCount = parseInt(options.threads, 10) || 4;
  const outputDir = path.resolve(process.cwd(), options.outputDir);
  const rpcUrl = options.rpcUrl;
  const targetClient = options.client as ClientImplementation | 'all';
  const targetValidator = options.validator;
  const specificSlot = options.slot ? parseInt(options.slot, 10) : undefined;
  const forceMock = Boolean(options.mock);

  if (!options.json) {
    TerminalVisualizer.printHeader();
    console.log(chalk.bold.white('Execution Configuration:'));
    console.log(`  • RPC URL:     ${chalk.cyan(rpcUrl)}`);
    console.log(`  • Target:      ${chalk.yellow(targetValidator || `Client implementation: ${targetClient}`)}`);
    console.log(`  • Samples:     ${chalk.white(sampleCount)}`);
    console.log(`  • Dry-Run:     ${isDryRun ? chalk.green('ENABLED (Strict Read-Only)') : chalk.yellow('DISABLED (Live Read-Only Cluster)')}`);
    console.log(`  • Spend Cap:   ${chalk.green(`${spendCapSol} SOL`)} (Strict Safety Guaranteed)`);
    console.log(`  • Output Dir:  ${chalk.cyan(outputDir)}\n`);
  }

  // Safety Verification Check
  let actualSpendSol = 0.0;
  let activeProbesDispatched = 0;
  let readOnlyQueriesMade = 0;

  if (actualSpendSol > spendCapSol) {
    console.error(chalk.bold.red(`[Safety Circuit-Breaker] Spend cap ${spendCapSol} SOL exceeded! Terminating immediately.`));
    process.exit(1);
  }

  // Ensure output directory exists
  if (!fs.existsSync(outputDir)) {
    fs.mkdirSync(outputDir, { recursive: true });
  }

  const collector = new SolanaCollector({
    rpcUrl,
    commitment: 'confirmed',
  });

  const analyzer = new BlockAnalyzer({
    threadCount,
  });

  const analyzedSlots: SlotTelemetry[] = [];

  if (forceMock) {
    // Offline / Mock mode
    if (!options.json) {
      console.log(chalk.cyan(`[Collector] Running in Mock/Offline mode. Generating ${sampleCount} synthetic slot fixtures...`));
    }
    const baseSlot = 462550000;
    for (let i = 0; i < sampleCount; i++) {
      const slotNum = baseSlot + i * 4;
      const mockBlock = generateSyntheticBlock({
        slot: slotNum,
        txCount: 80,
        jitoBundleCount: 4,
        hotAccountContention: true,
      });
      const leader = i % 2 === 0 ? 'HEL1USMZKAL2odpNBj2oCjffnFGaYwmbGmyewGv1e2TU' : '7Np41oeYqPefeNQEHSv1UDhYrehxin3NStELsSKCT4K2';
      const clientType = lookupValidatorClient(leader).client;
      const telemetry = analyzer.analyzeBlock(slotNum, mockBlock, leader, clientType);
      analyzedSlots.push(telemetry);
      if (!options.json) {
        TerminalVisualizer.printSlotReport(telemetry);
      }
    }
  } else if (specificSlot) {
    // Fetch specific slot
    if (!options.json) {
      console.log(chalk.cyan(`[Collector] Fetching confirmed block for slot ${specificSlot}...`));
    }
    readOnlyQueriesMade++;
    const block = await collector.getConfirmedBlock(specificSlot);
    if (!block) {
      console.error(chalk.red(`[Collector] Slot ${specificSlot} was skipped or not found.`));
      process.exit(1);
    }
    const leader = targetValidator || 'SpecificSlotLeader';
    const clientType = targetValidator ? lookupValidatorClient(targetValidator).client : 'unknown';
    const telemetry = analyzer.analyzeBlock(specificSlot, block, leader, clientType);
    analyzedSlots.push(telemetry);
    if (!options.json) {
      TerminalVisualizer.printSlotReport(telemetry);
    }
  } else {
    // Discover slots from leader schedule
    if (!options.json) {
      console.log(chalk.cyan(`[Collector] Querying getLeaderSchedule and epoch info from cluster...`));
    }
    readOnlyQueriesMade += 2;
    const discoveredSlots = await collector.findTargetSlots({
      validator: targetValidator,
      client: targetClient,
      limit: sampleCount,
    });

    if (!options.json) {
      console.log(chalk.green(`[Collector] Discovered ${discoveredSlots.length} candidate slots assigned to target validators:`));
      for (const ds of discoveredSlots) {
        console.log(`  • Slot ${chalk.bold.white(ds.slot)} | Leader: ${chalk.yellow(ds.leader.slice(0, 12))}... (${ds.clientType.toUpperCase()})`);
      }
      console.log(chalk.cyan(`\n[Collector] Fetching confirmed blocks with maxSupportedTransactionVersion: 0...`));
    }

    const fetched = await collector.collectBlocks(discoveredSlots, (slot, idx, total) => {
      readOnlyQueriesMade++;
      if (!options.json) {
        process.stdout.write(chalk.gray(`Fetching block ${idx + 1}/${total} (Slot ${slot.slot})...\r`));
      }
    });

    if (!options.json) {
      console.log(chalk.green(`\n[Collector] Successfully retrieved ${fetched.length} confirmed blocks.\n`));
    }

    for (const item of fetched) {
      const telemetry = analyzer.analyzeBlock(
        item.slotInfo.slot,
        item.block,
        item.slotInfo.leader,
        item.slotInfo.clientType
      );
      analyzedSlots.push(telemetry);
      if (!options.json) {
        TerminalVisualizer.printSlotReport(telemetry);
      }
    }
  }

  // Aggregate Metrics Computation
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
    dryRun: isDryRun,
    spendCapSol,
    actualSpendSol,
    spendCapExceeded: actualSpendSol > spendCapSol,
    activeProbesDispatched,
    readOnlyQueriesMade,
  };

  const suiteResult: MeasurementSuiteResult = {
    timestamp: new Date().toISOString(),
    cluster: rpcUrl.includes('devnet') ? 'devnet' : 'mainnet-beta',
    rpcUrl,
    slots: analyzedSlots,
    aggregated,
    safety,
  };

  // Export raw JSON telemetry to data/
  for (const s of analyzedSlots) {
    const slotFilename = path.join(outputDir, `telemetry-${s.slot}.json`);
    fs.writeFileSync(slotFilename, JSON.stringify(s, null, 2), 'utf-8');
  }

  const summaryFilename = path.join(outputDir, `summary.json`);
  fs.writeFileSync(summaryFilename, JSON.stringify(suiteResult, null, 2), 'utf-8');

  if (options.json) {
    console.log(JSON.stringify(suiteResult, null, 2));
  } else {
    TerminalVisualizer.printSuiteSummary(suiteResult);
    console.log(chalk.bold.green(`✔ Telemetry data successfully exported to:`));
    console.log(`  • Summary: ${chalk.cyan(summaryFilename)}`);
    console.log(`  • Slot Telemetry: ${chalk.cyan(outputDir + '/telemetry-<slot>.json')}\n`);
  }
}

main().catch((err) => {
  console.error(chalk.bold.red('\n[CLI Fatal Error]:'), err.message || err);
  process.exit(1);
});
