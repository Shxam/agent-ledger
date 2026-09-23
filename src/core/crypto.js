import { createHash } from 'node:crypto';

/**
 * Computes a SHA-256 hexadecimal digest for string or binary data.
 *
 * @param {string | Buffer | Uint8Array} data
 * @returns {string} 64-character lowercase hex digest
 */
export function sha256(data) {
  return createHash('sha256').update(data).digest('hex');
}

/**
 * Cryptographic seed hash for the ledger genesis.
 * H0 = SHA-256("GENESIS")
 */
export const GENESIS_HASH = sha256('GENESIS');
