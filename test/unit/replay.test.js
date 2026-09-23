import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { StorageManager } from '../../src/core/storage.js';
import { LedgerManager } from '../../src/core/ledger.js';
import { CheckpointManager, reconstructStateSnapshot } from '../../src/core/checkpoint.js';
import { ReplayEngine } from '../../src/core/replay.js';
import { ExitCode, LedgerError } from '../../src/core/errors.js';
import { canonicalJson } from '../../src/core/canonical_json.js';

describe('Replay Engine (Unit)', () => {
  let tempDir;
  let storage;
  let ledger;
  let checkpointManager;
  let replayEngine;
  const runId = 'unit_run_replay';

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-ledger-replay-unit-'));
    storage = new StorageManager(tempDir);
    storage.initLedger(runId);
    ledger = new LedgerManager(storage);
    checkpointManager = new CheckpointManager(storage);
    replayEngine = new ReplayEngine(storage);
  });

  afterEach(() => {
    if (fs.existsSync(tempDir)) {
      try {
        fs.rmSync(tempDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
      } catch {
        // ignore
      }
    }
  });

  it('replays subsequent events from a checkpoint correctly', () => {
    ledger.append({
      event_id: 'e1',
      seq_num: 1,
      run_id: runId,
      branch: 'main',
      type: 'run_started',
      payload: {},
    });
    ledger.append({
      event_id: 'e2',
      seq_num: 2,
      run_id: runId,
      branch: 'main',
      type: 'plan_created',
      payload: { steps: ['step1', 'step2'] },
    });

    // Create checkpoint at seq 2
    const active = ledger.reconstructActiveBranchState();
    checkpointManager.createCheckpoint('cp1', runId, 'main', 2, 'e2', active.state_snapshot);

    // Append more events after checkpoint
    ledger.append({
      event_id: 'e3',
      seq_num: 3,
      run_id: runId,
      branch: 'main',
      type: 'file_changed',
      payload: { file: 'index.js', hash: 'hash_v1' },
    });
    ledger.append({
      event_id: 'e4',
      seq_num: 4,
      run_id: runId,
      branch: 'main',
      type: 'test_started',
      payload: {},
    });
    ledger.append({
      event_id: 'e5',
      seq_num: 5,
      run_id: runId,
      branch: 'main',
      type: 'test_finished',
      payload: { passed: 10, failed: 0 },
    });

    const result = replayEngine.replay('cp1');
    assert.equal(result.checkpoint_id, 'cp1');
    assert.equal(result.from_seq_num, 2);
    assert.equal(result.replayed_events_count, 3);
    assert.equal(result.target_seq_num, 5);
    assert.equal(result.state.agent_phase, 'TESTS_FINISHED');
    assert.equal(result.state.modified_files['index.js'], 'hash_v1');
    assert.equal(result.state.test_summary.passed, 10);
    assert.equal(result.state.test_summary.failed, 0);
    assert.deepEqual(result.state.plan_steps, ['step1', 'step2']);
  });

  it('virtualizes tool calls matching by tool_request_id', () => {
    ledger.append({
      event_id: 'e1',
      seq_num: 1,
      run_id: runId,
      branch: 'main',
      type: 'run_started',
      payload: {},
    });

    const active = ledger.reconstructActiveBranchState();
    checkpointManager.createCheckpoint('cp_init', runId, 'main', 1, 'e1', active.state_snapshot);

    ledger.append({
      event_id: 'e2',
      seq_num: 2,
      run_id: runId,
      branch: 'main',
      type: 'tool_requested',
      payload: { tool_request_id: 'tool_req_999', tool_name: 'bash', tool_input: 'echo hello' },
    });

    // Replay with step 1: tool call remains open in active_tool_calls
    const partial = replayEngine.replay('cp_init', { stepCount: 1 });
    assert.equal(partial.replayed_events_count, 1);
    assert.equal(partial.state.agent_phase, 'EXECUTING_TOOLS');
    assert.equal(partial.state.active_tool_calls.length, 1);
    assert.equal(partial.state.active_tool_calls[0].tool_request_id, 'tool_req_999');

    // Append tool_result_received
    ledger.append({
      event_id: 'e3',
      seq_num: 3,
      run_id: runId,
      branch: 'main',
      type: 'tool_result_received',
      payload: { tool_request_id: 'tool_req_999', output: 'hello', exit_code: 0 },
    });

    // Full replay: tool call resolved
    const full = replayEngine.replay('cp_init');
    assert.equal(full.replayed_events_count, 2);
    assert.equal(full.state.agent_phase, 'TOOLS_RESOLVED');
    assert.equal(full.state.active_tool_calls.length, 0);
  });

  it('step limiting obeys exact step bounds (0, 1, partial, large)', () => {
    ledger.append({
      event_id: 'e1',
      seq_num: 1,
      run_id: runId,
      branch: 'main',
      type: 'run_started',
      payload: {},
    });
    const active = ledger.reconstructActiveBranchState();
    checkpointManager.createCheckpoint('cp_step', runId, 'main', 1, 'e1', active.state_snapshot);

    ledger.append({
      event_id: 'e2',
      seq_num: 2,
      run_id: runId,
      branch: 'main',
      type: 'plan_created',
      payload: { steps: ['alpha'] },
    });
    ledger.append({
      event_id: 'e3',
      seq_num: 3,
      run_id: runId,
      branch: 'main',
      type: 'plan_created',
      payload: { steps: ['beta'] },
    });
    ledger.append({
      event_id: 'e4',
      seq_num: 4,
      run_id: runId,
      branch: 'main',
      type: 'plan_created',
      payload: { steps: ['gamma'] },
    });

    // Step 0
    const res0 = replayEngine.replay('cp_step', { stepCount: 0 });
    assert.equal(res0.replayed_events_count, 0);
    assert.equal(res0.target_seq_num, 1);
    assert.deepEqual(res0.state.plan_steps, []);

    // Step 1
    const res1 = replayEngine.replay('cp_step', { stepCount: 1 });
    assert.equal(res1.replayed_events_count, 1);
    assert.equal(res1.target_seq_num, 2);
    assert.deepEqual(res1.state.plan_steps, ['alpha']);

    // Step 2
    const res2 = replayEngine.replay('cp_step', { stepCount: 2 });
    assert.equal(res2.replayed_events_count, 2);
    assert.equal(res2.target_seq_num, 3);
    assert.deepEqual(res2.state.plan_steps, ['alpha', 'beta']);

    // Step 100 (larger than remaining)
    const resLarge = replayEngine.replay('cp_step', { stepCount: 100 });
    assert.equal(resLarge.replayed_events_count, 3);
    assert.equal(resLarge.target_seq_num, 4);
    assert.deepEqual(resLarge.state.plan_steps, ['alpha', 'beta', 'gamma']);
  });

  it('produces byte-for-byte deterministic output on repeated runs', () => {
    ledger.append({
      event_id: 'e1',
      seq_num: 1,
      run_id: runId,
      branch: 'main',
      type: 'run_started',
      payload: {},
    });
    ledger.append({
      event_id: 'e2',
      seq_num: 2,
      run_id: runId,
      branch: 'main',
      type: 'file_changed',
      payload: { file: 'a.js', hash: '123' },
    });
    const active = ledger.reconstructActiveBranchState();
    checkpointManager.createCheckpoint('cp_det', runId, 'main', 2, 'e2', active.state_snapshot);

    ledger.append({
      event_id: 'e3',
      seq_num: 3,
      run_id: runId,
      branch: 'main',
      type: 'file_changed',
      payload: { file: 'b.js', hash: '456' },
    });

    const out1 = canonicalJson(replayEngine.replay('cp_det'));
    const out2 = canonicalJson(replayEngine.replay('cp_det'));
    const out3 = canonicalJson(replayEngine.replay('cp_det'));

    assert.equal(out1, out2);
    assert.equal(out2, out3);
  });
});
