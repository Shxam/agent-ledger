import { ExitCode, LedgerError } from '../core/errors.js';
import { StorageManager } from '../core/storage.js';
import { RecoveryEngine } from '../core/recover.js';
import { withLock } from '../core/lock.js';

/**
 * Handler for `agent-ledger recover`.
 *
 * @param {string[]} args Positional/flag CLI arguments
 * @param {object} [options]
 * @param {string} [options.cwd]
 * @returns {Promise<{ exitCode: number, message: string }>}
 */
export async function recoverCommand(args = [], options = {}) {
  const storage = new StorageManager(options.cwd);
  if (!storage.isInitialized()) {
    throw new LedgerError(
      ExitCode.USAGE_OR_NOT_FOUND,
      'Error: Repository not initialized in ' + storage.baseDir
    );
  }

  const recoveryEngine = new RecoveryEngine(storage);

  const res = await withLock(storage.lockFile, 'recover', async () => {
    return recoveryEngine.recover();
  });

  return {
    exitCode: ExitCode.SUCCESS,
    message: `Recovery completed successfully: preserved ${res.preserved_events_count} event(s) (truncated ${res.truncated_bytes} damaged trailing bytes)`,
  };
}
