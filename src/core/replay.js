import { ExitCode, LedgerError } from './errors.js';
import { StorageManager } from './storage.js';
import { CheckpointManager } from './checkpoint.js';
import { LedgerManager } from './ledger.js';

/**
 * Replays execution deterministically from a checkpoint manifest up to a given step limit.
 */
export class ReplayEngine {
  /**
   * @param {StorageManager} [storage]
   */
  constructor(storage = new StorageManager()) {
    this.storage = storage;
    this.checkpointManager = new CheckpointManager(storage);
    this.ledgerManager = new LedgerManager(storage);
  }

  /**
   * Executes deterministic replay from a specified checkpoint.
   *
   * @param {string} checkpointId Checkpoint identifier
   * @param {object} [options]
   * @param {number} [options.stepCount=Infinity] Maximum number of subsequent events to replay
   * @returns {{
   *   checkpoint_id: string,
   *   run_id: string,
   *   branch: string,
   *   from_seq_num: number,
   *   replayed_events_count: number,
   *   target_seq_num: number,
   *   state: object,
   *   replayed_events: Array<object>
   * }}
   */
  replay(checkpointId, options = {}) {
    if (!checkpointId || typeof checkpointId !== 'string' || checkpointId.trim().length === 0) {
      throw new LedgerError(
        ExitCode.USAGE_OR_NOT_FOUND,
        'Error: Checkpoint ID must be specified'
      );
    }

    // 1. Verify checkpoint exists (Exit 1 if not found)
    if (!this.checkpointManager.exists(checkpointId)) {
      throw new LedgerError(
        ExitCode.USAGE_OR_NOT_FOUND,
        `Error: Checkpoint '${checkpointId}' not found`
      );
    }

    // 2. Load checkpoint manifest
    const manifest = this.checkpointManager.readCheckpoint(checkpointId);
    if (!manifest || !manifest.state_snapshot) {
      throw new LedgerError(
        ExitCode.TAMPER_DETECTED,
        `Error: Checkpoint manifest '${checkpointId}' is corrupted or missing state_snapshot`
      );
    }

    // 3. Verify ledger integrity and hash-chain across all events (Exit 5 on drift)
    this.ledgerManager.loadAndValidateHistory();

    // 4. Filter events belonging to the checkpoint's branch that occurred AFTER the checkpoint
    const targetBranch = manifest.branch;
    const fromSeqNum = manifest.seq_num;

    const allEventsOnBranch = this.ledgerManager.allRecords.filter(
      (evt) => evt.branch === targetBranch && evt.seq_num > fromSeqNum
    );

    // Sort ascending by sequence number
    allEventsOnBranch.sort((a, b) => a.seq_num - b.seq_num);

    // 5. Determine step count limit
    const maxSteps =
      typeof options.stepCount === 'number' && Number.isFinite(options.stepCount)
        ? options.stepCount
        : Infinity;

    const eventsToReplay = allEventsOnBranch.slice(0, maxSteps);

    // 6. Initialize replay state from checkpoint's state_snapshot (avoiding double-counting)
    const snapshot = manifest.state_snapshot;
    const replayState = {
      agent_phase: snapshot.agent_phase || 'INITIALIZED',
      active_tool_calls: Array.isArray(snapshot.active_tool_calls)
        ? [...snapshot.active_tool_calls]
        : [],
      modified_files: { ...(snapshot.modified_files || {}) },
      test_summary: {
        passed: snapshot.test_summary?.passed || 0,
        failed: snapshot.test_summary?.failed || 0,
      },
      plan_steps: Array.isArray(snapshot.plan_steps)
        ? [...snapshot.plan_steps]
        : [],
    };

    // 7. Deterministically process subsequent events using recorded payloads (pure virtualized replay)
    for (const event of eventsToReplay) {
      if (!event || !event.payload) continue;

      switch (event.type) {
        case 'run_started':
          replayState.agent_phase = 'INITIALIZED';
          break;

        case 'plan_created':
          replayState.agent_phase = 'PLANNING';
          if (Array.isArray(event.payload.steps)) {
            replayState.plan_steps.push(...event.payload.steps);
          } else if (event.payload.plan) {
            replayState.plan_steps.push(event.payload.plan);
          }
          break;

        case 'tool_requested':
          replayState.agent_phase = 'EXECUTING_TOOLS';
          replayState.active_tool_calls.push({
            tool_request_id: event.payload.tool_request_id,
            tool_name: event.payload.tool_name,
            tool_input: event.payload.tool_input,
          });
          break;

        case 'tool_result_received': {
          replayState.agent_phase = 'TOOLS_RESOLVED';
          const reqId = event.payload.tool_request_id;
          // Match by tool_request_id, never by array index
          const foundIdx = replayState.active_tool_calls.findIndex(
            (call) => call.tool_request_id === reqId
          );
          if (foundIdx !== -1) {
            replayState.active_tool_calls.splice(foundIdx, 1);
          }
          break;
        }

        case 'file_changed': {
          replayState.agent_phase = 'EDITING_FILES';
          const filePath = event.payload.file || event.payload.path;
          if (filePath) {
            replayState.modified_files[filePath] =
              event.payload.hash || event.payload.content || 'modified';
          }
          break;
        }

        case 'test_started':
          replayState.agent_phase = 'RUNNING_TESTS';
          break;

        case 'test_finished':
          replayState.agent_phase = 'TESTS_FINISHED';
          if (typeof event.payload.passed === 'number') {
            replayState.test_summary.passed += event.payload.passed;
          }
          if (typeof event.payload.failed === 'number') {
            replayState.test_summary.failed += event.payload.failed;
          }
          break;

        case 'checkpoint_created':
          // Logical phase remains as is
          break;

        case 'run_completed':
          replayState.agent_phase = 'COMPLETED';
          break;
      }
    }

    const targetSeqNum =
      eventsToReplay.length > 0
        ? eventsToReplay[eventsToReplay.length - 1].seq_num
        : fromSeqNum;

    return {
      checkpoint_id: manifest.checkpoint_id,
      run_id: manifest.run_id,
      branch: manifest.branch,
      from_seq_num: fromSeqNum,
      replayed_events_count: eventsToReplay.length,
      target_seq_num: targetSeqNum,
      state: replayState,
      replayed_events: eventsToReplay,
    };
  }
}
