import fs from 'node:fs';
import path from 'node:path';
import { ExitCode, LedgerError } from './errors.js';
import { writeJsonAtomicSync } from './fs_atomic.js';
import { StorageManager } from './storage.js';

/**
 * Reconstructs the agent state snapshot from a sequence of events.
 *
 * @param {Array<object>} events Chronological list of events
 * @returns {object} Reconstructed state snapshot
 */
export function reconstructStateSnapshot(events = []) {
  const modifiedFiles = {};
  const testSummary = { passed: 0, failed: 0 };
  const planSteps = [];
  let agentPhase = 'INITIALIZED';

  for (const event of events) {
    if (!event || !event.payload) continue;

    switch (event.type) {
      case 'run_started':
        agentPhase = 'INITIALIZED';
        break;

      case 'plan_created':
        agentPhase = 'PLANNING';
        if (Array.isArray(event.payload.steps)) {
          planSteps.push(...event.payload.steps);
        } else if (event.payload.plan) {
          planSteps.push(event.payload.plan);
        }
        break;

      case 'tool_requested':
        agentPhase = 'EXECUTING_TOOLS';
        break;

      case 'tool_result_received':
        agentPhase = 'TOOLS_RESOLVED';
        break;

      case 'file_changed':
        agentPhase = 'EDITING_FILES';
        if (event.payload.file || event.payload.path) {
          const filePath = event.payload.file || event.payload.path;
          modifiedFiles[filePath] = event.payload.hash || event.payload.content || 'modified';
        }
        break;

      case 'test_started':
        agentPhase = 'RUNNING_TESTS';
        break;

      case 'test_finished':
        agentPhase = 'TESTS_FINISHED';
        if (typeof event.payload.passed === 'number') {
          testSummary.passed += event.payload.passed;
        }
        if (typeof event.payload.failed === 'number') {
          testSummary.failed += event.payload.failed;
        }
        break;

      case 'run_completed':
        agentPhase = 'COMPLETED';
        break;
    }
  }

  return {
    agent_phase: agentPhase,
    active_tool_calls: [],
    modified_files: modifiedFiles,
    test_summary: testSummary,
    plan_steps: planSteps,
  };
}

/**
 * Checkpoint manifest manager.
 */
export class CheckpointManager {
  /**
   * @param {StorageManager} [storage]
   */
  constructor(storage = new StorageManager()) {
    this.storage = storage;
  }

  /**
   * Resolves the manifest file path for a checkpoint ID.
   *
   * @param {string} checkpointId
   * @returns {string}
   */
  getCheckpointPath(checkpointId) {
    return path.join(this.storage.checkpointsDir, `${checkpointId}.json`);
  }

  /**
   * Checks whether a checkpoint manifest exists.
   *
   * @param {string} checkpointId
   * @returns {boolean}
   */
  exists(checkpointId) {
    return fs.existsSync(this.getCheckpointPath(checkpointId));
  }

  /**
   * Reads and parses a checkpoint manifest.
   *
   * @param {string} checkpointId
   * @returns {object}
   */
  readCheckpoint(checkpointId) {
    const filePath = this.getCheckpointPath(checkpointId);
    if (!fs.existsSync(filePath)) {
      throw new LedgerError(
        ExitCode.CONFLICT,
        `Error: Checkpoint '${checkpointId}' does not exist`
      );
    }

    try {
      const raw = fs.readFileSync(filePath, 'utf8');
      return JSON.parse(raw);
    } catch (err) {
      throw new LedgerError(
        ExitCode.CONFLICT,
        `Error: Failed to read checkpoint manifest '${checkpointId}': ${err.message}`
      );
    }
  }

  /**
   * Atomically writes a new checkpoint manifest file.
   *
   * @param {string} checkpointId Alphanumeric checkpoint identifier
   * @param {string} runId
   * @param {string} branch
   * @param {number} seqNum Event sequence position
   * @param {string} lastEventId Last event ID
   * @param {object} stateSnapshot Reconstructed state vector
   * @returns {object} The created manifest object
   */
  createCheckpoint(checkpointId, runId, branch, seqNum, lastEventId, stateSnapshot) {
    if (!checkpointId || typeof checkpointId !== 'string' || checkpointId.trim().length === 0) {
      throw new LedgerError(
        ExitCode.USAGE_OR_NOT_FOUND,
        'Error: Checkpoint ID must be a non-empty string'
      );
    }

    if (this.exists(checkpointId)) {
      throw new LedgerError(
        ExitCode.CONFLICT,
        `Error: Checkpoint '${checkpointId}' already exists`
      );
    }

    const manifest = {
      checkpoint_id: checkpointId,
      run_id: runId,
      branch,
      seq_num: seqNum,
      last_event_id: lastEventId,
      state_snapshot: stateSnapshot,
    };

    const targetPath = this.getCheckpointPath(checkpointId);
    writeJsonAtomicSync(targetPath, manifest);

    return manifest;
  }
}
