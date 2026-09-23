import { ExitCode, LedgerError } from '../core/errors.js';
import { StorageManager } from '../core/storage.js';
import { getStatus, formatStatusPlaintext, formatStatusJson } from '../core/status.js';

/**
 * Handler for `agent-ledger status [--json]`.
 *
 * @param {string[]} args Positional/flag CLI arguments
 * @param {object} [options]
 * @param {string} [options.cwd]
 * @returns {Promise<{ exitCode: number, message: string }>}
 */
export async function statusCommand(args = [], options = {}) {
  const isJson = args.includes('--json');

  const storage = new StorageManager(options.cwd);
  if (!storage.isInitialized()) {
    throw new LedgerError(
      ExitCode.USAGE_OR_NOT_FOUND,
      'Error: Repository not initialized in ' + storage.baseDir
    );
  }

  const status = getStatus(storage);
  const message = isJson ? formatStatusJson(status) : formatStatusPlaintext(status);

  return {
    exitCode: ExitCode.SUCCESS,
    message,
  };
}
