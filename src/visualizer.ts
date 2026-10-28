/**
 * Solana Block Ordering Terminal Visualizer
 * Formatted analytical tables, ASCII distribution bars, and invariant scorecard using chalk.
 */

import chalk from 'chalk';
import type { SlotTelemetry, MeasurementSuiteResult, ParsedTxAnalysis, ClientImplementation } from './types.js';

export class TerminalVisualizer {
  public static printHeader(): void {
    console.log(chalk.bold.cyan('\n================================================================================'));
    console.log(chalk.bold.cyan('  SOLANA BLOCK ORDERING & MEV TELEMETRY MEASUREMENT SUITE'));
    console.log(chalk.gray('  High-Precision Analysis of Priority Fees, Lock Contention, and Jito Bundles'));
    console.log(chalk.bold.cyan('================================================================================\n'));
  }

  public static printSlotReport(telemetry: SlotTelemetry): void {
    const s = telemetry.summary;
    const inv = telemetry.invariants;

    // Header banner
    const clientColor =
      telemetry.clientType === 'jito'
        ? chalk.bold.green
        : telemetry.clientType === 'agave'
        ? chalk.bold.blue
        : telemetry.clientType === 'firedancer'
        ? chalk.bold.magenta
        : chalk.bold.yellow;

    console.log(chalk.bold.white(`\n┌─ [SLOT ${telemetry.slot}] ─────────────────────────────────────────────────────────`));
    console.log(
      `│  ${chalk.gray('Leader:')}     ${chalk.yellow(telemetry.leader)}  (${clientColor(
        telemetry.clientType.toUpperCase()
      )})`
    );
    console.log(`│  ${chalk.gray('Blockhash:')}  ${chalk.white(telemetry.blockhash)}`);
    if (telemetry.blockTime) {
      console.log(`│  ${chalk.gray('Timestamp:')}  ${chalk.white(new Date(telemetry.blockTime * 1000).toISOString())}`);
    }
    console.log('├─────────────────────────────────────────────────────────────────────────────');

    // Slot Metrics
    console.log(
      `│  ${chalk.gray('Total Txs:')}   ${chalk.bold.white(s.totalTransactions)}   │  ` +
        `${chalk.gray('Non-Vote Txs:')}  ${chalk.bold.cyan(s.nonVoteTransactions)}   │  ` +
        `${chalk.gray('Vote Txs:')}      ${chalk.gray(s.voteTransactions)}`
    );
    console.log(
      `│  ${chalk.gray('Successful:')}  ${chalk.green(s.successfulTransactions)}   │  ` +
        `${chalk.gray('Failed:')}        ${chalk.red(s.failedTransactions)}   │  ` +
        `${chalk.gray('Success Rate:')}  ${chalk.bold.green(
          s.totalTransactions > 0
            ? `${Math.round((s.successfulTransactions / s.totalTransactions) * 100)}%`
            : '0%'
        )}`
    );
    console.log(
      `│  ${chalk.gray('Total Fees:')}  ${chalk.white((s.totalFeesLamports / 1e9).toFixed(5))} SOL │  ` +
        `${chalk.gray('Priority Fees:')} ${chalk.yellow((s.priorityFeesLamports / 1e9).toFixed(5))} SOL │  ` +
        `${chalk.gray('Jito Tips:')}     ${chalk.green((s.jitoTipsLamports / 1e9).toFixed(5))} SOL`
    );
    console.log(
      `│  ${chalk.gray('Total CU:')}    ${chalk.white(s.totalComputeUnits.toLocaleString())} │  ` +
        `${chalk.gray('Avg CU/Tx:')}     ${chalk.white(s.averageComputeUnitsPerTx.toLocaleString())} │  ` +
        `${chalk.gray('Avg Fee/CU:')}    ${chalk.yellow(s.averagePriorityFeePerCU.toLocaleString())} µ-lam`
    );
    console.log('├─────────────────────────────────────────────────────────────────────────────');

    // Jito MEV Bundles Section
    if (telemetry.jitoBundles.length > 0) {
      console.log(chalk.bold.green(`│  ▶ JITO MEV BUNDLES DETECTED (${telemetry.jitoBundles.length} Bundles)`));
      console.log(
        chalk.gray(
          '│    #   Bundle ID        Slot Range   Txs   Tip (SOL)      Tip/CU (µ-lam)  Tip Account'
        )
      );
      telemetry.jitoBundles.slice(0, 5).forEach((b, idx) => {
        const id = b.bundleId.padEnd(16).slice(0, 16);
        const range = `[${b.startSlotIndex}..${b.endSlotIndex}]`.padEnd(11);
        const txs = String(b.transactionCount).padStart(3);
        const tipSol = b.tipAmountSol.toFixed(6).padStart(11);
        const tipCu = b.tipPerComputeUnit.toLocaleString().padStart(12);
        const account = `${b.tipAccount.slice(0, 4)}...${b.tipAccount.slice(-4)}`;
        console.log(`│    ${idx + 1}   ${id} ${range} ${txs}   ${chalk.green(tipSol)}   ${tipCu}   ${account}`);
      });
      if (telemetry.jitoBundles.length > 5) {
        console.log(chalk.gray(`│    ... and ${telemetry.jitoBundles.length - 5} more bundles`));
      }
    } else {
      console.log(chalk.gray('│  ▶ JITO MEV BUNDLES: None detected in this slot'));
    }
    console.log('├─────────────────────────────────────────────────────────────────────────────');

    // Hot Accounts Write Contention
    if (telemetry.hotAccounts.length > 0) {
      console.log(chalk.bold.yellow(`│  ▶ HIGH-CONTENTION WRITE ACCOUNTS (Top Serialization Bottlenecks)`));
      console.log(chalk.gray('│    Rank  Account Address                                  Writes  Total Accesses'));
      telemetry.hotAccounts.slice(0, 5).forEach((acc, idx) => {
        const rank = String(idx + 1).padStart(3);
        const address = acc.account.padEnd(46);
        const writes = chalk.bold.red(String(acc.writeCount).padStart(6));
        const total = String(acc.totalAccessCount).padStart(10);
        console.log(`│    ${rank}   ${address} ${writes}    ${total}`);
      });
    }
    console.log('├─────────────────────────────────────────────────────────────────────────────');

    // Parallel Thread Slotting Simulation
    const ts = telemetry.threadSlotting;
    console.log(chalk.bold.magenta(`│  ▶ PARALLEL THREAD SLOTTING (Banking Stage Simulation, ${ts.threadCount} Threads)`));
    console.log(
      `│    Sequential Units: ${chalk.white(ts.sequentialDuration.toLocaleString())}   │  ` +
        `Parallel Makespan: ${chalk.cyan(ts.totalMakespan.toLocaleString())}   │  ` +
        `Speedup: ${chalk.bold.green(`${ts.theoreticalSpeedup}x`)}   │  ` +
        `Utilization: ${chalk.yellow(`${ts.threadUtilizationPercent}%`)}`
    );
    console.log('├─────────────────────────────────────────────────────────────────────────────');

    // Invariant Verification Scorecard
    console.log(chalk.bold.cyan('│  ▶ INVARIANT VERIFICATION SCORECARD'));
    const spearmanStr = `${inv.spearmanRankCorrelation.toFixed(3)}`;
    const spearmanFmt =
      inv.spearmanRankCorrelation < -0.1
        ? chalk.green(`${spearmanStr} (Strict Fee Precedence)`)
        : inv.spearmanRankCorrelation < 0.2
        ? chalk.yellow(`${spearmanStr} (Mild Parallel Jitter)`)
        : chalk.red(`${spearmanStr} (Significant Head-of-Line Inversion)`);

    console.log(`│    • Spearman Rank Correlation (Fee vs Index): ${spearmanFmt}`);
    console.log(
      `│    • Conflicting-Pair Inversion Rate:          ${
        inv.conflictingInversionRate < 15
          ? chalk.green(`${inv.conflictingInversionRate}%`)
          : chalk.yellow(`${inv.conflictingInversionRate}%`)
      }  (${inv.conflictingInversionsCount}/${inv.conflictingPairsCount} pairs)`
    );
    console.log(
      `│    • Global Non-Vote Inversion Rate:           ${chalk.yellow(`${inv.globalInversionRate}%`)}`
    );
    console.log(
      `│    • Jito Top-of-Block Bundle Concentration:   ${chalk.green(
        `${Math.round(inv.topOfBlockJitoRatio * 100)}%`
      )}`
    );

    const checkFee = inv.invariantsPassed.feeOrderingMonotonic
      ? chalk.bold.green('✔ PASS')
      : chalk.bold.yellow('⚠ JITTER');
    const checkLock = inv.invariantsPassed.lockConflictsRespected
      ? chalk.bold.green('✔ PASS')
      : chalk.bold.red('✘ FAIL');
    const checkJito = inv.invariantsPassed.jitoPrioritized
      ? chalk.bold.green('✔ PASS')
      : chalk.bold.yellow('⚠ UNVERIFIED');

    console.log(
      `│    • Invariants: Fee Monotonicity [${checkFee}]  Lock DAG [${checkLock}]  Jito Priority [${checkJito}]`
    );
    console.log(chalk.bold.white('└─────────────────────────────────────────────────────────────────────────────\n'));
  }

  public static printSuiteSummary(suite: MeasurementSuiteResult): void {
    const agg = suite.aggregated;
    console.log(chalk.bold.cyan('\n================================================================================'));
    console.log(chalk.bold.cyan('  AGGREGATED BENCHMARK SUMMARY & SAFETY VERIFICATION'));
    console.log(chalk.bold.cyan('================================================================================\n'));

    console.log(`  ${chalk.gray('Total Slots Analyzed:')}  ${chalk.bold.white(agg.totalSlotsAnalyzed)}`);
    console.log(`  ${chalk.gray('Total Jito Bundles:')}    ${chalk.bold.green(agg.totalJitoBundlesDetected)}`);
    console.log(`  ${chalk.gray('Total Jito Tips SOL:')}   ${chalk.bold.green(agg.totalJitoTipsSol.toFixed(6))} SOL`);
    console.log(`  ${chalk.gray('Avg Parallel Speedup:')}  ${chalk.bold.cyan(`${agg.averageParallelSpeedup}x`)}`);

    console.log(chalk.bold.white('\n  [Client Implementation Breakdown]'));
    for (const [client, count] of Object.entries(agg.slotsByClient)) {
      if (count > 0) {
        const invRate = agg.averageInversionRateByClient[client as ClientImplementation] || 0;
        const spearman = agg.averageSpearmanByClient[client as ClientImplementation] || 0;
        console.log(
          `   • ${chalk.bold.yellow(client.toUpperCase())}: ${chalk.white(
            count
          )} slots | Avg Inversion Rate: ${chalk.cyan(`${invRate}%`)} | Spearman: ${chalk.white(spearman)}`
        );
      }
    }

    console.log(chalk.bold.white('\n  [Safety & Spend Cap Verification]'));
    const safety = suite.safety;
    const dryRunBadge = safety.dryRun ? chalk.bold.green('ACTIVE (READ-ONLY)') : chalk.bold.yellow('LIVE RPC');
    const capStatus = safety.spendCapExceeded
      ? chalk.bold.red('EXCEEDED (CIRCUIT BREAKER TRIGGERED)')
      : chalk.bold.green('COMPLIANT');

    console.log(`   • Dry-Run Mode:          ${dryRunBadge}`);
    console.log(`   • Spend Cap:             ${chalk.white(safety.spendCapSol)} SOL`);
    console.log(`   • Actual Spend:          ${chalk.bold.green(safety.actualSpendSol)} SOL`);
    console.log(`   • Spend Invariant:       [${capStatus}]`);
    console.log(`   • Read Queries Made:     ${chalk.cyan(safety.readOnlyQueriesMade)}`);
    console.log(`   • Active Probes Sent:    ${chalk.cyan(safety.activeProbesDispatched)}`);

    console.log(chalk.bold.cyan('\n================================================================================\n'));
  }
}
