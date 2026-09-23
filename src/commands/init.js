import { ExitCode } from '../core/errors.js';
import { StorageManager } from '../core/storage.js';

/**
 * Handler for `agent-ledger init [run_id]`.
 *
 * @param {string[]} args Positional CLI arguments
 * @param {object} [options]
 * @param {string} [options.cwd]
 * @returns {{ exitCode: number, message: string }}
 */
export function initCommand(args = [], options = {}) {
  const runId = args[0];
  const storage = new StorageManager(options.cwd);

  const config = storage.initLedger(runId);
  return {
    exitCode: ExitCode.SUCCESS,
    message: `Initialized empty agent-ledger repository for run '${config.run_id}' (branch: ${config.active_branch})`,
  };
}
