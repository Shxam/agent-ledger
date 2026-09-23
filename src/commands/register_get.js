import { ExitCode, LedgerError } from '../core/errors.js';
import { StorageManager } from '../core/storage.js';
import { RegisterManager } from '../core/registers.js';

/**
 * Handler for `agent-ledger register-get --reg <name>`.
 *
 * Streams raw binary content of the named register directly to stdout.
 *
 * @param {string[]} args Positional/flag CLI arguments
 * @param {object} [options]
 * @param {string} [options.cwd]
 * @returns {Promise<{ exitCode: number }>}
 */
export async function registerGetCommand(args = [], options = {}) {
  let regName = null;

  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--reg') {
      if (i + 1 < args.length) {
        regName = args[i + 1];
        i++;
      }
    }
  }

  if (!regName) {
    throw new LedgerError(
      ExitCode.USAGE_OR_NOT_FOUND,
      'Usage: agent-ledger register-get --reg <name>'
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
  const buffer = registerManager.get(regName);

  process.stdout.write(buffer);

  return {
    exitCode: ExitCode.SUCCESS,
  };
}
