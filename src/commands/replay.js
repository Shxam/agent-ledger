import { ExitCode, LedgerError } from '../core/errors.js';
import { StorageManager } from '../core/storage.js';
import { ReplayEngine } from '../core/replay.js';
import { withLock } from '../core/lock.js';
import { canonicalJson } from '../core/canonical_json.js';

/**
 * Handler for `agent-ledger replay --from <checkpoint_id> [--step <count>]`.
 *
 * @param {string[]} args Positional/flag CLI arguments
 * @param {object} [options]
 * @param {string} [options.cwd]
 * @returns {Promise<{ exitCode: number, message: string, result?: object }>}
 */
export async function replayCommand(args = [], options = {}) {
  let checkpointId = null;
  let stepCount = Infinity;
  let isJson = false;

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];

    if (arg === '--from') {
      if (i + 1 >= args.length || args[i + 1].startsWith('--')) {
        throw new LedgerError(
          ExitCode.USAGE_OR_NOT_FOUND,
          'Usage: agent-ledger replay --from <checkpoint_id> [--step <count>]'
        );
      }
      checkpointId = args[i + 1];
      i++;
    } else if (arg === '--step') {
      if (i + 1 >= args.length || args[i + 1].startsWith('--')) {
        throw new LedgerError(
          ExitCode.USAGE_OR_NOT_FOUND,
          'Error: Missing value for --step'
        );
      }
      const stepStr = args[i + 1];
      if (!/^\d+$/.test(stepStr)) {
        throw new LedgerError(
          ExitCode.USAGE_OR_NOT_FOUND,
          `Error: --step must be a non-negative integer (got: '${stepStr}')`
        );
      }
      stepCount = parseInt(stepStr, 10);
      i++;
    } else if (arg === '--json') {
      isJson = true;
    }
  }

  if (!checkpointId || checkpointId.trim().length === 0) {
    throw new LedgerError(
      ExitCode.USAGE_OR_NOT_FOUND,
      'Usage: agent-ledger replay --from <checkpoint_id> [--step <count>]'
    );
  }

  const storage = new StorageManager(options.cwd);
  if (!storage.isInitialized()) {
    throw new LedgerError(
      ExitCode.USAGE_OR_NOT_FOUND,
      'Error: Repository not initialized in ' + storage.baseDir
    );
  }

  const replayEngine = new ReplayEngine(storage);

  const replayResult = await withLock(storage.lockFile, 'replay', async () => {
    return replayEngine.replay(checkpointId, { stepCount });
  });

  const message = isJson
    ? canonicalJson({
        checkpoint_id: replayResult.checkpoint_id,
        run_id: replayResult.run_id,
        branch: replayResult.branch,
        from_seq_num: replayResult.from_seq_num,
        replayed_events_count: replayResult.replayed_events_count,
        target_seq_num: replayResult.target_seq_num,
        state: replayResult.state,
      })
    : `Replayed ${replayResult.replayed_events_count} event(s) from checkpoint '${replayResult.checkpoint_id}' (branch: ${replayResult.branch}, target_seq: ${replayResult.target_seq_num})`;

  return {
    exitCode: ExitCode.SUCCESS,
    message,
    result: replayResult,
  };
}
