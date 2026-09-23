import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { CheckpointManager, reconstructStateSnapshot } from '../../src/core/checkpoint.js';
import { StorageManager } from '../../src/core/storage.js';
import { ExitCode, LedgerError } from '../../src/core/errors.js';

describe('Checkpoint Manager & State Reconstruction', () => {
  let tempDir;
  let storage;
  let checkpointManager;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-ledger-chk-unit-test-'));
    storage = new StorageManager(tempDir);
    storage.initLedger('run_alpha');
    checkpointManager = new CheckpointManager(storage);
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

  it('correctly reconstructs state snapshot from heterogeneous events', () => {
    const events = [
      { type: 'run_started', payload: {} },
      { type: 'plan_created', payload: { steps: ['step1', 'step2'] } },
      { type: 'file_changed', payload: { file: 'src/main.js', hash: 'abc1234' } },
      { type: 'test_started', payload: {} },
      { type: 'test_finished', payload: { passed: 5, failed: 0 } },
    ];

    const snapshot = reconstructStateSnapshot(events);
    assert.equal(snapshot.agent_phase, 'TESTS_FINISHED');
    assert.deepEqual(snapshot.active_tool_calls, []);
    assert.equal(snapshot.modified_files['src/main.js'], 'abc1234');
    assert.equal(snapshot.test_summary.passed, 5);
    assert.equal(snapshot.test_summary.failed, 0);
    assert.deepEqual(snapshot.plan_steps, ['step1', 'step2']);
  });

  it('aggregates multiple test_finished events into test_summary', () => {
    const events = [
      { type: 'run_started', payload: {} },
      { type: 'test_started', payload: {} },
      { type: 'test_finished', payload: { passed: 4, failed: 1 } },
      { type: 'test_started', payload: {} },
      { type: 'test_finished', payload: { passed: 6, failed: 2 } },
    ];

    const snapshot = reconstructStateSnapshot(events);
    assert.equal(snapshot.test_summary.passed, 10);
    assert.equal(snapshot.test_summary.failed, 3);
  });

  it('verifies manifest has exact required state_snapshot fields', () => {
    const snapshot = reconstructStateSnapshot([
      { type: 'run_started', payload: {} },
    ]);

    const manifest = checkpointManager.createCheckpoint(
      'chk_schema_test',
      'run_alpha',
      'main',
      1,
      'evt_1',
      snapshot
    );

    assert.ok(manifest.state_snapshot);
    assert.equal(typeof manifest.state_snapshot.agent_phase, 'string');
    assert.ok(Array.isArray(manifest.state_snapshot.active_tool_calls));
    assert.equal(typeof manifest.state_snapshot.modified_files, 'object');
    assert.equal(typeof manifest.state_snapshot.test_summary, 'object');
    assert.ok(Array.isArray(manifest.state_snapshot.plan_steps));
  });

  it('atomically creates and reads checkpoint manifest', () => {
    const snapshot = {
      agent_phase: 'IDLE',
      active_tool_calls: [],
      modified_files: { 'config.py': 'hash_xyz' },
      test_summary: { passed: 10, failed: 1 },
      plan_steps: ['init'],
    };

    const manifest = checkpointManager.createCheckpoint(
      'chk_001',
      'run_alpha',
      'main',
      42,
      'evt_last_42',
      snapshot
    );

    assert.equal(manifest.checkpoint_id, 'chk_001');
    assert.equal(manifest.seq_num, 42);
    assert.equal(manifest.last_event_id, 'evt_last_42');

    assert.ok(checkpointManager.exists('chk_001'));

    const readBack = checkpointManager.readCheckpoint('chk_001');
    assert.deepEqual(readBack, manifest);
  });

  it('rejects duplicate checkpoint ID with ExitCode.CONFLICT (exit 6)', () => {
    checkpointManager.createCheckpoint(
      'chk_dup',
      'run_alpha',
      'main',
      1,
      'evt_1',
      { agent_phase: 'IDLE', active_tool_calls: [], modified_files: {}, test_summary: { passed: 0, failed: 0 }, plan_steps: [] }
    );

    assert.throws(
      () => checkpointManager.createCheckpoint(
        'chk_dup',
        'run_alpha',
        'main',
        2,
        'evt_2',
        { agent_phase: 'IDLE', active_tool_calls: [], modified_files: {}, test_summary: { passed: 0, failed: 0 }, plan_steps: [] }
      ),
      (err) => err instanceof LedgerError && err.exitCode === ExitCode.CONFLICT
    );
  });

  it('throws ExitCode.CONFLICT when reading nonexistent checkpoint', () => {
    assert.throws(
      () => checkpointManager.readCheckpoint('chk_missing'),
      (err) => err instanceof LedgerError && err.exitCode === ExitCode.CONFLICT
    );
  });
});
