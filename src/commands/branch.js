import { ExitCode, LedgerError } from '../core/errors.js';
import { StorageManager } from '../core/storage.js';
import { LedgerManager } from '../core/ledger.js';
import { CheckpointManager } from '../core/checkpoint.js';
import { BranchManager } from '../core/branch.js';
import { withLock } from '../core/lock.js';
import { GENESIS_HASH } from '../core/crypto.js';

/**
 * Handler for `agent-ledger branch --from <checkpoint_id> --name <branch_name>`.
 *
 * @param {string[]} args Positional/flag CLI arguments
 * @param {object} [options]
 * @param {string} [options.cwd]
 * @returns {Promise<{ exitCode: number, message: string }>}
 */
export async function branchCommand(args = [], options = {}) {
  let checkpointId = null;
  let branchName = null;

  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--from' && i + 1 < args.length) {
      checkpointId = args[i + 1];
    } else if (args[i] === '--name' && i + 1 < args.length) {
      branchName = args[i + 1];
    }
  }

  if (!checkpointId || !branchName) {
    throw new LedgerError(
      ExitCode.USAGE_OR_NOT_FOUND,
      'Usage: agent-ledger branch --from <checkpoint_id> --name <branch_name>'
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
  const branchManager = new BranchManager(storage);

  const branchMeta = await withLock(storage.lockFile, 'branch', async () => {
    // 1. Check if checkpoint exists
    if (!checkpointManager.exists(checkpointId)) {
      throw new LedgerError(
        ExitCode.CONFLICT,
        `Error: Checkpoint '${checkpointId}' not found`
      );
    }

    // 2. Check if branch name already exists
    if (branchManager.exists(branchName)) {
      throw new LedgerError(
        ExitCode.CONFLICT,
        `Error: Branch '${branchName}' already exists`
      );
    }

    // 3. Read checkpoint manifest
    const checkpoint = checkpointManager.readCheckpoint(checkpointId);

    // 4. Resolve fork event hash from ledger history
    const ledger = new LedgerManager(storage);
    ledger.loadAndValidateHistory();

    const forkHash = checkpoint.last_event_id
      ? ledger.eventHashMap.get(checkpoint.last_event_id) || GENESIS_HASH
      : GENESIS_HASH;

    // 5. Create branch metadata and update config active_branch
    return branchManager.createBranch(branchName, checkpointId, checkpoint, forkHash);
  });

  return {
    exitCode: ExitCode.SUCCESS,
    message: `Created branch '${branchMeta.branch_name}' from checkpoint '${branchMeta.origin_checkpoint_id}' at sequence ${branchMeta.fork_seq_num}`,
  };
}
