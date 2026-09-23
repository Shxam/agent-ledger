import fs from 'node:fs';
import path from 'node:path';
import { StorageManager } from './storage.js';
import { LedgerManager } from './ledger.js';
import { canonicalJson } from './canonical_json.js';

/**
 * Computes deterministic status metrics for the agent ledger workspace.
 *
 * @param {StorageManager} [storage]
 * @returns {{
 *   run_id: string,
 *   branch: string,
 *   total_events: number,
 *   last_checkpoint_id: string,
 *   open_tool_calls: number
 * }}
 */
export function getStatus(storage = new StorageManager()) {
  const ledger = new LedgerManager(storage);

  // 1. Verify ledger integrity and reconstruct causal state (throws ExitCode.TAMPER_DETECTED (5) on drift)
  ledger.loadAndValidateHistory();

  const config = storage.readConfig();
  const activeBranch = config.active_branch;
  const runId = config.run_id;
  const totalEvents = ledger.allRecords.length;
  const openToolCalls = ledger.causalEngine.getOpenToolCount();

  // 2. Determine latest checkpoint for active branch
  let lastCheckpointId = 'none';

  if (fs.existsSync(storage.checkpointsDir)) {
    const checkpointFiles = fs.readdirSync(storage.checkpointsDir);
    const checkpoints = [];

    for (const file of checkpointFiles) {
      if (!file.endsWith('.json')) continue;
      try {
        const raw = fs.readFileSync(path.join(storage.checkpointsDir, file), 'utf8');
        checkpoints.push(JSON.parse(raw));
      } catch {
        // ignore unparseable checkpoint file
      }
    }

    if (activeBranch === 'main') {
      const mainCheckpoints = checkpoints.filter((c) => c.branch === 'main');
      mainCheckpoints.sort((a, b) => b.seq_num - a.seq_num);
      if (mainCheckpoints.length > 0) {
        lastCheckpointId = mainCheckpoints[0].checkpoint_id;
      }
    } else {
      // Child branch: find checkpoints created on this branch
      const branchCheckpoints = checkpoints.filter((c) => c.branch === activeBranch);
      branchCheckpoints.sort((a, b) => b.seq_num - a.seq_num);

      if (branchCheckpoints.length > 0) {
        lastCheckpointId = branchCheckpoints[0].checkpoint_id;
      } else {
        // Fall back to origin checkpoint if recorded in branch metadata
        const branchFile = path.join(storage.branchesDir, `${activeBranch}.json`);
        if (fs.existsSync(branchFile)) {
          try {
            const bMeta = JSON.parse(fs.readFileSync(branchFile, 'utf8'));
            if (bMeta.origin_checkpoint_id) {
              lastCheckpointId = bMeta.origin_checkpoint_id;
            }
          } catch {
            // ignore
          }
        }
      }
    }
  }

  return {
    run_id: runId,
    branch: activeBranch,
    total_events: totalEvents,
    last_checkpoint_id: lastCheckpointId,
    open_tool_calls: openToolCalls,
  };
}

/**
 * Formats status data as deterministic plaintext.
 *
 * @param {object} status
 * @returns {string}
 */
export function formatStatusPlaintext(status) {
  return [
    `Run ID: ${status.run_id}`,
    `Branch: ${status.branch}`,
    `Total Events: ${status.total_events}`,
    `Last Checkpoint: ${status.last_checkpoint_id}`,
    `Open Tool Calls: ${status.open_tool_calls}`,
  ].join('\n');
}

/**
 * Formats status data as canonical deterministic JSON.
 *
 * @param {object} status
 * @returns {string}
 */
export function formatStatusJson(status) {
  return canonicalJson({
    branch: status.branch,
    last_checkpoint_id: status.last_checkpoint_id,
    open_tool_calls: status.open_tool_calls,
    run_id: status.run_id,
    total_events: status.total_events,
  });
}
