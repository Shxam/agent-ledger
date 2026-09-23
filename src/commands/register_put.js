import { ExitCode, LedgerError } from '../core/errors.js';
import { StorageManager } from '../core/storage.js';
import { RegisterManager } from '../core/registers.js';
import { withLock } from '../core/lock.js';

/**
 * Handler for `agent-ledger register-put --reg <name> <file_path>`.
 *
 * @param {string[]} args Positional/flag CLI arguments
 * @param {object} [options]
 * @param {string} [options.cwd]
 * @returns {Promise<{ exitCode: number, message: string }>}
 */
export async function registerPutCommand(args = [], options = {}) {
  let regName = null;
  let filePath = null;

  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--reg') {
      if (i + 1 < args.length) {
        regName = args[i + 1];
        i++;
      }
    } else if (!args[i].startsWith('--') && !filePath) {
      filePath = args[i];
    }
  }

  if (!regName || !filePath) {
    throw new LedgerError(
      ExitCode.USAGE_OR_NOT_FOUND,
      'Usage: agent-ledger register-put --reg <name> <file_path>'
    );
  }

  const storage = new StorageManager(options.cwd);
  if (!storage.isInitialized()) {
    throw new LedgerError(
      ExitCode.USAGE_OR_NOT_FOUND,
      'Error: Repository not initialized in ' + storage.baseDir
    );
  }

  const registerManager = new RegisterManager(storage);

  const bytesWritten = await withLock(storage.lockFile, 'register-put', async () => {
    return registerManager.put(regName, filePath);
  });

  return {
    exitCode: ExitCode.SUCCESS,
    message: `Updated register '${regName}' from '${filePath}' (${bytesWritten} bytes)`,
  };
}
