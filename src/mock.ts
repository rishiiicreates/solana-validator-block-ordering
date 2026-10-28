/**
 * High-Fidelity Synthetic Solana Block Generator for Dry-Run & Offline Invariant Testing
 */

import crypto from 'crypto';
import { PublicKey } from '@solana/web3.js';
import type { VersionedBlockResponse } from '@solana/web3.js';
import {
  COMPUTE_BUDGET_PROGRAM_ID,
  VOTE_PROGRAM_ID,
  SYSTEM_PROGRAM_ID,
  JITO_TIP_ACCOUNTS,
} from './constants.js';

export interface SyntheticBlockOptions {
  slot: number;
  txCount?: number;
  jitoBundleCount?: number;
  hotAccountContention?: boolean;
}

export function generateSyntheticBlock(options: SyntheticBlockOptions): VersionedBlockResponse {
  const slot = options.slot;
  const txCount = options.txCount ?? 60;
  const jitoBundleCount = options.jitoBundleCount ?? 3;
  const tipAccountList = Array.from(JITO_TIP_ACCOUNTS);

  // Common DEX pools
  const RAYDIUM_POOL = '58oQChx4yWmvKdwLLZzBi4ChoCc2fqCUWBkwMihLYQo2';
  const ORCA_WHIRLPOOL = '7qbRF6YsyGuLUVs6Y1q64bdVrfe4ZcUUz1JRdoVNUJnm';
  const PUMP_BONDING = '6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P';

  const transactions: any[] = [];

  for (let i = 0; i < txCount; i++) {
    const isVote = i % 4 === 0;
    const isJitoBundle = !isVote && i < jitoBundleCount * 5 && i % 4 === 1;

    const payer = new PublicKey(crypto.randomBytes(32));
    const staticKeys: PublicKey[] = [payer];

    let fee = 5000;
    let computeUnits = 25000;
    const preBalances = [10_000_000_000, 1_000_000_000];
    const postBalances = [10_000_000_000 - fee, 1_000_000_000];

    const instructions: any[] = [];

    if (isVote) {
      staticKeys.push(new PublicKey(VOTE_PROGRAM_ID));
      instructions.push({
        programIdIndex: 1,
        accountKeyIndexes: [0],
        data: Buffer.from([0x01]),
      });
    } else {
      // Add Compute Budget instruction
      staticKeys.push(new PublicKey(COMPUTE_BUDGET_PROGRAM_ID));
      const progIndex = 1;

      // Opcode 2: limit
      const limitBuf = Buffer.alloc(5);
      limitBuf[0] = 0x02;
      const requestedLimit = 100_000 + (i % 5) * 50_000;
      limitBuf.writeUInt32LE(requestedLimit, 1);
      instructions.push({
        programIdIndex: progIndex,
        accountKeyIndexes: [],
        data: limitBuf,
      });

      // Opcode 3: price (in micro-lamports per CU)
      // Earlier transactions get higher priority fee if monotonic
      const priceBuf = Buffer.alloc(9);
      priceBuf[0] = 0x03;
      const microLamports = isJitoBundle
        ? 500_000 + (txCount - i) * 10_000
        : Math.max(1_000, (txCount - i) * 5_000 + (i % 3 === 0 ? 50_000 : 0));
      priceBuf.writeBigUInt64LE(BigInt(microLamports), 1);
      instructions.push({
        programIdIndex: progIndex,
        accountKeyIndexes: [],
        data: priceBuf,
      });

      computeUnits = Math.min(requestedLimit - 1000, 30_000 + (i % 7) * 10_000);
      const priorityFeeLamports = Math.round((microLamports * requestedLimit) / 1_000_000);
      fee = 5000 + priorityFeeLamports;
      postBalances[0] = preBalances[0] - fee;

      // Add target DEX or hot account
      if (options.hotAccountContention) {
        if (i % 3 === 0) staticKeys.push(new PublicKey(RAYDIUM_POOL));
        else if (i % 5 === 0) staticKeys.push(new PublicKey(ORCA_WHIRLPOOL));
        else staticKeys.push(new PublicKey(PUMP_BONDING));
      }

      // If Jito tip tx
      if (isJitoBundle) {
        const tipAcc = new PublicKey(tipAccountList[i % tipAccountList.length]);
        staticKeys.push(tipAcc);
        const tipIdx = staticKeys.length - 1;
        preBalances.push(5_000_000_000);
        const tipLamports = 100_000 + i * 50_000;
        postBalances.push(5_000_000_000 + tipLamports);
      }
    }

    transactions.push({
      version: 0,
      transaction: {
        signatures: [`mock-sig-${slot}-${i}-${Math.random().toString(36).substring(2, 8)}`],
        message: {
          header: {
            numRequiredSignatures: 1,
            numReadonlySignedAccounts: 0,
            numReadonlyUnsignedAccounts: isVote ? 1 : 2,
          },
          staticAccountKeys: staticKeys,
          compiledInstructions: instructions,
          addressTableLookups: [],
        },
      },
      meta: {
        err: i % 15 === 0 ? { InstructionError: [0, 'Custom'] } : null,
        fee,
        preBalances,
        postBalances,
        computeUnitsConsumed: computeUnits,
        loadedAddresses: {
          writable: [],
          readonly: [],
        },
      },
    });
  }

  return {
    blockhash: `mock-blockhash-${slot}-xyz`,
    previousBlockhash: `mock-prev-blockhash-${slot - 1}`,
    parentSlot: slot - 1,
    blockTime: Math.floor(Date.now() / 1000) - 60,
    blockHeight: slot - 1000,
    transactions,
  } as unknown as VersionedBlockResponse;
}
