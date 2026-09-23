import { ExitCode, LedgerError } from '../core/errors.js';
import { StorageManager } from '../core/storage.js';
import { exportCanonicalJson } from '../core/export.js';

/**
 * Handler for `agent-ledger export --format json`.
 *
 * @param {string[]} args Positional/flag CLI arguments
 * @param {object} [options]
 * @param {string} [options.cwd]
 * @returns {Promise<{ exitCode: number, message: string }>}
 */
export async function exportCommand(args = [], options = {}) {
  let format = null;

  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--format') {
      if (i + 1 < args.length) {
        format = args[i + 1];
        i++;
      }
    }
  }

  if (format !== 'json') {
    throw new LedgerError(
      ExitCode.USAGE_OR_NOT_FOUND,
      'Usage: agent-ledger export --format json'
    );
  }

  const storage = new StorageManager(options.cwd);
  if (!storage.isInitialized()) {
    throw new LedgerError(
      ExitCode.USAGE_OR_NOT_FOUND,
      'Error: Repository not initialized in ' + storage.baseDir
    );
  }

  const jsonString = exportCanonicalJson(storage);

  return {
    exitCode: ExitCode.SUCCESS,
    message: jsonString,
  };
}
