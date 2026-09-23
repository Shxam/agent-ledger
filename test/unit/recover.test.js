import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { StorageManager } from '../../src/core/storage.js';
import { LedgerManager } from '../../src/core/ledger.js';
import { BranchManager } from '../../src/core/branch.js';
import { CheckpointManager } from '../../src/core/checkpoint.js';
import { RecoveryEngine } from '../../src/core/recover.js';
import { ExitCode, LedgerError } from '../../src/core/errors.js';
import { canonicalJson } from '../../src/core/canonical_json.js';

describe('Recovery Engine (Unit)', () => {
  let tempDir;
  let storage;
  let ledger;
  let recoveryEngine;
  const runId = 'unit_recover_run';

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-ledger-recover-unit-'));
    storage = new StorageManager(tempDir);
    storage.initLedger(runId);
    ledger = new LedgerManager(storage);
    recoveryEngine = new RecoveryEngine(storage);
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

  it('performs clean recovery when no damage exists (0 bytes truncated)', () => {
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
      payload: { steps: ['init'] },
    });

    const res = recoveryEngine.recover();
    assert.equal(res.preserved_events_count, 2);
    assert.equal(res.truncated_bytes, 0);
  });

  it('detects torn trailing JSON and truncates with ftruncate at descriptor level', () => {
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
      payload: { steps: ['init'] },
    });

    const validSize = fs.statSync(storage.eventsFile).size;

    // Append partial torn JSON bytes
    const tornBytes = '{"event_id":"e3_partial","seq_num":3,"run_id":"unit_recover_run"';
    fs.appendFileSync(storage.eventsFile, tornBytes);

    const damagedSize = fs.statSync(storage.eventsFile).size;
    assert.equal(damagedSize, validSize + tornBytes.length);

    const res = recoveryEngine.recover();
    assert.equal(res.preserved_events_count, 2);
    assert.equal(res.truncated_bytes, tornBytes.length);

    const recoveredSize = fs.statSync(storage.eventsFile).size;
    assert.equal(recoveredSize, validSize);
  });

  it('reconciles branch heads when child branch tail is torn', () => {
    ledger.append({
      event_id: 'e1',
      seq_num: 1,
      run_id: runId,
      branch: 'main',
      type: 'run_started',
      payload: {},
    });

    const chkManager = new CheckpointManager(storage);
    const active = ledger.reconstructActiveBranchState();
    chkManager.createCheckpoint('cp1', runId, 'main', 1, 'e1', active.state_snapshot);

    const branchManager = new BranchManager(storage);
    const cp = chkManager.readCheckpoint('cp1');
    branchManager.createBranch('child_br', 'cp1', cp, active.last_hash);

    // Switch active branch to child_br and append event
    const config = storage.readConfig();
    config.active_branch = 'child_br';
    storage.writeConfig(config);

    ledger.append({
      event_id: 'e2_child',
      seq_num: 2,
      run_id: runId,
      branch: 'child_br',
      type: 'file_changed',
      payload: { file: 'child.js', hash: 'c1' },
    });

    // Append torn trailing bytes
    fs.appendFileSync(storage.eventsFile, '{"event_id":"e3_child_torn"');

    const res = recoveryEngine.recover();
    assert.equal(res.preserved_events_count, 2);

    // Verify branch head is intact at sequence 2
    const bMeta = branchManager.readBranch('child_br');
    assert.equal(bMeta.head_seq_num, 2);
    assert.equal(bMeta.head_event_id, 'e2_child');
  });

  it('rejects historical corruption with ExitCode.UNRECOVERABLE_CORRUPTION (exit 7)', () => {
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
      payload: { steps: ['init'] },
    });
    ledger.append({
      event_id: 'e3',
      seq_num: 3,
      run_id: runId,
      branch: 'main',
      type: 'file_changed',
      payload: { file: 'app.js', hash: 'app1' },
    });

    // Corrupt intermediate event e2
    const content = fs.readFileSync(storage.eventsFile, 'utf8');
    const lines = content.trim().split('\n');
    lines[1] = '{"corrupted_json": true'; // invalid JSON at line 2
    fs.writeFileSync(storage.eventsFile, lines.join('\n') + '\n');

    assert.throws(
      () => recoveryEngine.recover(),
      (err) => err instanceof LedgerError && err.exitCode === ExitCode.UNRECOVERABLE_CORRUPTION
    );
  });

  it('proves recovery idempotence on repeated runs', () => {
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
      payload: { steps: ['idempotent'] },
    });

    // Append torn tail
    fs.appendFileSync(storage.eventsFile, '{"torn":');

    // Run 1: truncates torn bytes
    const res1 = recoveryEngine.recover();
    assert.equal(res1.preserved_events_count, 2);
    assert.ok(res1.truncated_bytes > 0);

    const logAfterFirst = fs.readFileSync(storage.eventsFile, 'utf8');

    // Run 2: already clean
    const res2 = recoveryEngine.recover();
    assert.equal(res2.preserved_events_count, 2);
    assert.equal(res2.truncated_bytes, 0);

    const logAfterSecond = fs.readFileSync(storage.eventsFile, 'utf8');
    assert.equal(logAfterFirst, logAfterSecond);
  });
});
