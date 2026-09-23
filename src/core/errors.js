/**
 * Centralized exit code definitions and domain errors for agent-ledger.
 */

export const ExitCode = Object.freeze({
  SUCCESS: 0,
  USAGE_OR_NOT_FOUND: 1,
  VALIDATION_ERROR: 2,
  LOCK_CONTENTION: 3,
  STATE_BLOCKED: 4,
  TAMPER_DETECTED: 5,
  CONFLICT: 6,
  UNRECOVERABLE_CORRUPTION: 7,
});

export class LedgerError extends Error {
  /**
   * @param {number} exitCode
   * @param {string} message
   */
  constructor(exitCode, message) {
    super(message);
    this.name = 'LedgerError';
    this.exitCode = exitCode;
  }
}
