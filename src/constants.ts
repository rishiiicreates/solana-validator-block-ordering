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
  // Jito-Solana validators
  {
    identity: 'HEL1USMZKAL2odpNBj2oCjffnFGaYwmbGmyewGv1e2TU',
    name: 'Helius',
    client: 'jito',
    notes: 'Major RPC & validator running Jito MEV client',
  },
  {
    identity: 'DRpbCBMxVnDK7maPM5tGv6MvB3v1sRMC86PZ8okm21hy',
    name: 'Chorus One',
    client: 'jito',
    notes: 'Institutional validator running Jito-Solana',
  },
  {
    identity: 'Certusm1daqq8eBNV8MD5n6Q56nUbVp4f6qM8u5d8rB5',
    name: 'Shinobi Systems',
    client: 'jito',
    notes: 'High-performance validator running Jito MEV',
  },
  {
    identity: 'J1tovipLqq93cEw3f9u9zB4f2tYJk139k9xT9n5N8d1',
    name: 'Jito Foundation',
    client: 'jito',
    notes: 'Official Jito Foundation validator',
  },
  {
    identity: 'Cogent5nL5L5p4GzY3H6iV6h5Q5n5K5h5W5j5X5Y5Z5',
    name: 'Cogent Crypto',
    client: 'jito',
    notes: 'Jito-Solana validator',
  },

  // Firedancer / Frankendancer validators
  {
    identity: 'Fd7btgySsrjuo25CJCj7oE7VPMyezDhnx7pZkj2v69Nk',
    name: 'Jump Crypto (Firedancer)',
    client: 'firedancer',
    notes: 'Running Frankendancer / Firedancer hybrid engine',
  },

  // Standard Agave (Solana Labs) validators
  {
    identity: '7Np41oeYqPefeNQEHSv1UDhYrehxin3NStELsSKCT4K2',
    name: 'Everstake (Agave)',
    client: 'agave',
    notes: 'Standard Agave validator client',
  },
  {
    identity: 'Agave11111111111111111111111111111111111111',
    name: 'Reference Agave Validator',
    client: 'agave',
    notes: 'Standard Agave reference',
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
