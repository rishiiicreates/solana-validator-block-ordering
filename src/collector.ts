/**
 * Solana Block & Leader Schedule Collector
 * Connects to RPC, discovers validator leader slots, and fetches confirmed blocks.
 */

import {
  Connection,
  type VersionedBlockResponse,
  type EpochInfo,
  type LeaderSchedule,
} from '@solana/web3.js';
import { KNOWN_VALIDATORS, lookupValidatorClient } from './constants.js';
import type { ClientImplementation, ValidatorInfo } from './types.js';

export interface CollectorConfig {
  rpcUrl: string;
  commitment?: 'confirmed' | 'finalized';
  maxRetries?: number;
  initialBackoffMs?: number;
}

export interface TargetFilter {
  validator?: string;
  client?: ClientImplementation | 'all';
  limit?: number;
}

export interface DiscoveredSlot {
  slot: number;
  leader: string;
  clientType: ClientImplementation;
  validatorName?: string;
}

export class SolanaCollector {
  private connection: Connection;
  private maxRetries: number;
  private initialBackoffMs: number;

  constructor(config: CollectorConfig) {
    this.connection = new Connection(config.rpcUrl, config.commitment || 'confirmed');
    this.maxRetries = config.maxRetries ?? 5;
    this.initialBackoffMs = config.initialBackoffMs ?? 500;
  }

  public getConnection(): Connection {
    return this.connection;
  }

  /**
   * Helper to execute an RPC call with exponential backoff on 429/network errors
   */
  private async executeWithRetry<T>(operationName: string, fn: () => Promise<T>): Promise<T> {
    let attempt = 0;
    let delay = this.initialBackoffMs;

    while (attempt <= this.maxRetries) {
      try {
        return await fn();
      } catch (err: any) {
        attempt++;
        const isRateLimit =
          err?.message?.includes('429') ||
          err?.message?.includes('Too Many Requests') ||
          err?.message?.includes('rate limit');

        if (attempt > this.maxRetries) {
          throw new Error(`[Collector] ${operationName} failed after ${attempt} attempts: ${err?.message || err}`);
        }

        const jitter = Math.floor(Math.random() * 200);
        const sleepTime = delay + jitter;
        if (isRateLimit) {
          // Double backoff on rate-limit
          delay = Math.min(delay * 2, 8000);
        }
        await new Promise((resolve) => setTimeout(resolve, sleepTime));
      }
    }

    throw new Error(`[Collector] ${operationName} failed unexpectedly`);
  }

  /**
   * Fetch current EpochInfo from the cluster
   */
  public async getEpochInfo(): Promise<EpochInfo> {
    return this.executeWithRetry('getEpochInfo', () => this.connection.getEpochInfo());
  }

  /**
   * Fetch leader schedule for the current epoch
   */
  public async getLeaderSchedule(slot?: number): Promise<LeaderSchedule | null> {
    return this.executeWithRetry('getLeaderSchedule', () =>
      this.connection.getLeaderSchedule(slot)
    );
  }

  /**
   * Resolve slots assigned to target validators across distinct client implementations
   */
  public async findTargetSlots(filter: TargetFilter = {}): Promise<DiscoveredSlot[]> {
    const epochInfo = await this.getEpochInfo();
    const schedule = await this.getLeaderSchedule();

    if (!schedule) {
      throw new Error('[Collector] Leader schedule returned null for current epoch');
    }

    const firstSlotInEpoch = BigInt(epochInfo.absoluteSlot) - BigInt(epochInfo.slotIndex);
    const currentSlotIndex = Number(epochInfo.slotIndex);
    const discovered: DiscoveredSlot[] = [];

    // Map known validators
    const knownByIdentity = new Map<string, { client: ClientImplementation; name?: string }>();
    for (const kv of KNOWN_VALIDATORS) {
      knownByIdentity.set(kv.identity, { client: kv.client, name: kv.name });
    }

    // Determine target identities
    const allLeaders = Object.keys(schedule);
    const targetLeaders: { identity: string; client: ClientImplementation; name?: string }[] = [];

    if (filter.validator) {
      const info = lookupValidatorClient(filter.validator);
      targetLeaders.push({
        identity: filter.validator,
        client: info.client,
        name: info.name || 'Specified Validator',
      });
    } else {
      for (const leader of allLeaders) {
        const info = lookupValidatorClient(leader);
        if (!filter.client || filter.client === 'all' || filter.client === info.client) {
          targetLeaders.push({
            identity: leader,
            client: info.client,
            name: info.name,
          });
        }
      }

      // If filtering for agave or firedancer or jito and none matched in known list,
      // fallback to top leaders
      if (targetLeaders.length === 0) {
        for (const leader of allLeaders.slice(0, 10)) {
          targetLeaders.push({
            identity: leader,
            client: 'unknown',
            name: `Validator ${leader.slice(0, 8)}...`,
          });
        }
      }
    }

    const limit = filter.limit ?? 10;

    // Collect recent past slots that have already elapsed and should be confirmed
    for (const target of targetLeaders) {
      const offsets = schedule[target.identity];
      if (!offsets || offsets.length === 0) continue;

      // Filter to slots before current slot index (with a 20 slot safety buffer for finality)
      const pastOffsets = offsets
        .filter((o) => BigInt(o) < BigInt(currentSlotIndex) - 20n)
        .sort((a, b) => (BigInt(b) > BigInt(a) ? 1 : BigInt(b) < BigInt(a) ? -1 : 0)); // most recent first

      for (const offset of pastOffsets) {
        const absoluteSlot = Number(firstSlotInEpoch + BigInt(offset));
        discovered.push({
          slot: absoluteSlot,
          leader: target.identity,
          clientType: target.client,
          validatorName: target.name,
        });

        if (discovered.length >= limit) {
          break;
        }
      }

      if (discovered.length >= limit) {
        break;
      }
    }

    return discovered;
  }

  /**
   * Fetch a confirmed block with maxSupportedTransactionVersion: 0.
   * If modern Solana block contains version 1 transactions, gracefully handles the version 1 fallback.
   */
  public async getConfirmedBlock(slot: number): Promise<VersionedBlockResponse | null> {
    return this.executeWithRetry(`getBlock(${slot})`, async () => {
      try {
        // Spec requirement: fetch confirmed blocks with maxSupportedTransactionVersion: 0
        const block = await this.connection.getBlock(slot, {
          maxSupportedTransactionVersion: 0,
          transactionDetails: 'full',
          rewards: false,
        });
        return block;
      } catch (err: any) {
        const msg = String(err?.message || '');
        // When modern blocks contain v1 transactions, the RPC instructs to use maxSupportedTransactionVersion: 1
        if (msg.includes('Transaction version (1) is not supported') || msg.includes('version 1')) {
          const v1Block = await this.connection.getBlock(slot, {
            maxSupportedTransactionVersion: 1 as any,
            transactionDetails: 'full',
            rewards: false,
          });
          return v1Block;
        }

        // Slot was skipped by the leader (valid normal Solana condition)
        if (msg.includes('Block not found') || msg.includes('was skipped') || msg.includes('-32009') || msg.includes('-32004')) {
          return null;
        }

        throw err;
      }
    });
  }

  /**
   * Fetch confirmed blocks for a list of discovered slots, skipping null/skipped blocks
   */
  public async collectBlocks(
    slots: DiscoveredSlot[],
    onProgress?: (slot: DiscoveredSlot, index: number, total: number) => void
  ): Promise<{ slotInfo: DiscoveredSlot; block: VersionedBlockResponse }[]> {
    const results: { slotInfo: DiscoveredSlot; block: VersionedBlockResponse }[] = [];

    for (let i = 0; i < slots.length; i++) {
      const s = slots[i];
      if (onProgress) {
        onProgress(s, i, slots.length);
      }

      try {
        const block = await this.getConfirmedBlock(s.slot);
        if (block) {
          results.push({ slotInfo: s, block });
        }
      } catch (err: any) {
        // Log and continue to next slot to maintain resilience
        console.warn(`[Collector] Skipping slot ${s.slot} due to error: ${err.message}`);
      }
    }

    return results;
  }
}
