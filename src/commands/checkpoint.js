import { ExitCode, LedgerError } from '../core/errors.js';
import { StorageManager } from '../core/storage.js';
import { LedgerManager } from '../core/ledger.js';
import { CheckpointManager } from '../core/checkpoint.js';
import { withLock } from '../core/lock.js';

/**
 * Handler for `agent-ledger checkpoint --id <checkpoint_id>`.
 *
 * @param {string[]} args Positional/flag CLI arguments
 * @param {object} [options]
 * @param {string} [options.cwd]
 * @returns {Promise<{ exitCode: number, message: string }>}
 */
export async function checkpointCommand(args = [], options = {}) {
  let checkpointId = null;

  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--id' && i + 1 < args.length) {
      checkpointId = args[i + 1];
      break;
    }
  }

  if (!checkpointId || checkpointId.trim().length === 0) {
    throw new LedgerError(
      ExitCode.USAGE_OR_NOT_FOUND,
      'Usage: agent-ledger checkpoint --id <checkpoint_id>'
    );
  }

  const storage = new StorageManager(options.cwd);
  if (!storage.isInitialized()) {
    throw new LedgerError(
      ExitCode.USAGE_OR_NOT_FOUND,
      'Error: Repository not initialized in ' + storage.baseDir
    );
  }

  const checkpointManager = new CheckpointManager(storage);

  const manifest = await withLock(storage.lockFile, 'checkpoint', async () => {
    // 1. Check if checkpoint ID already exists
    if (checkpointManager.exists(checkpointId)) {
      throw new LedgerError(
        ExitCode.CONFLICT,
        `Error: Checkpoint '${checkpointId}' already exists`
      );
    }

    // 2. Reconstruct active branch state and verify log integrity
    const ledger = new LedgerManager(storage);
    const activeState = ledger.reconstructActiveBranchState();

    // 3. Verify zero in-flight tool calls
    if (activeState.open_tool_count > 0) {
      throw new LedgerError(
        ExitCode.STATE_BLOCKED,
        `Error: Active in-flight tool call detected (${activeState.open_tool_count} unresolved); checkpoint blocked`
      );
    }

    // 4. Atomically write checkpoint manifest
    return checkpointManager.createCheckpoint(
      checkpointId,
      activeState.runId,
      activeState.branch,
      activeState.seq_num,
      activeState.last_event_id,
      activeState.state_snapshot
    );
  });

  return {
    exitCode: ExitCode.SUCCESS,
    message: `Created checkpoint '${manifest.checkpoint_id}' at sequence ${manifest.seq_num} (branch: ${manifest.branch})`,
  };
}
