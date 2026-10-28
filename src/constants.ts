/**
 * Solana Block Ordering Constants & Known Entities
 */

import { PublicKey } from '@solana/web3.js';
import type { ClientImplementation } from './types.js';

export const COMPUTE_BUDGET_PROGRAM_ID = 'ComputeBudget111111111111111111111111111111';
export const VOTE_PROGRAM_ID = 'Vote111111111111111111111111111111111111111';
export const SYSTEM_PROGRAM_ID = '11111111111111111111111111111111';

export const BASE_LAMPORTS_PER_SIGNATURE = 5000;
export const DEFAULT_COMPUTE_UNIT_LIMIT = 200_000;
export const MAX_COMPUTE_UNIT_LIMIT = 1_400_000;

/**
 * Canonical Jito Tip payment accounts on Solana Mainnet
 */
export const JITO_TIP_ACCOUNTS: ReadonlySet<string> = new Set([
  '96gYZGLnJYVFmbjzopPSU6QiEV5fGqZNyN9nmNhvrZU5',
  'HFqU5x63VTxvQssQnVTycT2ccFgReUJMQ84DLVg2478S',
  'Cw8CFyM9FkoMi7K7Crf6HNQqf4uEMzpKw6QNghXLvLkY',
  'ADaUMid9yfUytqMBgopwjb2DTLSokTSzL1zt6iGPaS49',
  'DfXygSm4jCyNCybVYYK6DwvWqjKee8pbDmJGcLWNDXjh',
  'ADuUkR4vqLUMWXxW9gh6D6L8pWHLHzqdGh6UZZDYg4wp',
  'DttWaMuVvTiduZRnguLF7jNxTgiMBZ1hyAumKUiL2KRL',
  '3AVi9Tg9Uo68tJfuvoKvqKNWKkC5wPdSSdeBnizKZ6jT',
]);

/**
 * Directory of prominent validators and their client implementations
 */
export interface KnownValidatorMetadata {
  identity: string;
  name: string;
  client: ClientImplementation;
  notes?: string;
}

export const KNOWN_VALIDATORS: KnownValidatorMetadata[] = [
  // Firedancer / Frankendancer validators
  {
    identity: 'Fd7btgySsrjuo25CJCj7oE7VPMyezDhnx7pZkj2v69Nk',
    name: 'Jump Crypto (Firedancer)',
    client: 'firedancer',
    notes: 'Frankendancer / Firedancer high-throughput engine by Jump Crypto',
  },

  // Jito-Solana validators
  {
    identity: 'HEL1USMZKAL2odpNBj2oCjffnFGaYwmbGmyewGv1e2TU',
    name: 'Helius (Jito-Solana)',
    client: 'jito',
    notes: 'Major RPC & validator running Jito MEV client with bundle engine',
  },
  {
    identity: 'DRpbCBMxVnDK7maPM5tGv6MvB3v1sRMC86PZ8okm21hy',
    name: 'Chorus One (Jito-Solana)',
    client: 'jito',
    notes: 'Institutional validator running Jito-Solana bundle architecture',
  },
  {
    identity: 'C8Bey3LKVJHVqN6xPTeW8WJfUgFQAeGNBpT4Rp99JP1k',
    name: 'Staking Validator C8Bey (Jito-Solana)',
    client: 'jito',
    notes: 'Tier-1 validator running Jito-Solana MEV',
  },
  {
    identity: 'Certusm1daqq8eBNV8MD5n6Q56nUbVp4f6qM8u5d8rB5',
    name: 'Shinobi Systems (Jito-Solana)',
    client: 'jito',
    notes: 'High-performance validator running Jito MEV',
  },
  {
    identity: 'J1tovipLqq93cEw3f9u9zB4f2tYJk139k9xT9n5N8d1',
    name: 'Jito Foundation (Jito-Solana)',
    client: 'jito',
    notes: 'Official Jito Foundation validator node',
  },

  // Agave (Solana Labs) validators
  {
    identity: 'JUPiTERrZqgf1jUyR7dSkhMx4Kn2qJyekWsg3LT1h4b',
    name: 'Jupiter Validator (Agave)',
    client: 'agave',
    notes: 'Official Jupiter routing validator running Agave client',
  },
  {
    identity: 'CAo1dCGYrB6NhHh5xb1cGjUiu86iyCfMTENxgHumSve4',
    name: 'Coinbase Cloud (Agave)',
    client: 'agave',
    notes: 'Enterprise validator running Agave consensus client',
  },
  {
    identity: '11AMA4mnNbsrPQeuoNN7uiZVJZtqEzQHrTfa5vnbcjk',
    name: 'Validator 11AMA (Agave)',
    client: 'agave',
    notes: 'High-stake validator running Agave 26.10.x',
  },
  {
    identity: '7Np41oeYqPefeNQEHSv1UDhYrehxin3NStELsSKCT4K2',
    name: 'Everstake (Agave)',
    client: 'agave',
    notes: 'Standard Agave validator client',
  },
  {
    identity: 'E1r4Psq84tHfQ6aPTvvDka4U3u8zPVD7gEUrH25RdxHL',
    name: 'Validator E1r4 (Agave)',
    client: 'agave',
    notes: 'Standard Agave validator node',
  },
];

export function lookupValidatorClient(identity: string): {
  client: ClientImplementation;
  name?: string;
} {
  const match = KNOWN_VALIDATORS.find((v) => v.identity === identity);
  if (match) {
    return { client: match.client, name: match.name };
  }
  return { client: 'unknown' };
}
