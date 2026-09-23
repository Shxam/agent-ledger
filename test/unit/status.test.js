import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { StorageManager } from '../../src/core/storage.js';
import { LedgerManager } from '../../src/core/ledger.js';
import { CheckpointManager } from '../../src/core/checkpoint.js';
import { BranchManager } from '../../src/core/branch.js';
import { getStatus, formatStatusPlaintext, formatStatusJson } from '../../src/core/status.js';
import { ExitCode, LedgerError } from '../../src/core/errors.js';

describe('Status Engine (Unit)', () => {
  let tempDir;
  let storage;
  let ledger;
  const runId = 'status_unit_run';

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-ledger-status-unit-'));
    storage = new StorageManager(tempDir);
    storage.initLedger(runId);
    ledger = new LedgerManager(storage);
  });

  afterEach(() => {
    if (fs.existsSync(tempDir)) {
      try {
        fs.rmSync(tempDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
      } catch {}
    }
  });

  it('reports accurate status on fresh ledger', () => {
    const status = getStatus(storage);
    assert.equal(status.run_id, runId);
    assert.equal(status.branch, 'main');
    assert.equal(status.total_events, 0);
    assert.equal(status.last_checkpoint_id, 'none');
    assert.equal(status.open_tool_calls, 0);

    const txt = formatStatusPlaintext(status);
    assert.ok(txt.includes('Total Events: 0'));
    assert.ok(txt.includes('Last Checkpoint: none'));
    assert.ok(txt.includes('Open Tool Calls: 0'));

    const json = JSON.parse(formatStatusJson(status));
    assert.equal(json.total_events, 0);
    assert.equal(json.last_checkpoint_id, 'none');
  });

  it('tracks events, checkpoints, and open tool calls dynamically', () => {
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
      type: 'tool_requested',
      payload: { tool_request_id: 'tr_alpha', tool_name: 'bash' },
    });

    let status = getStatus(storage);
    assert.equal(status.total_events, 2);
    assert.equal(status.open_tool_calls, 1);
    assert.equal(status.last_checkpoint_id, 'none');

    // Resolve tool call
    ledger.append({
      event_id: 'e3',
      seq_num: 3,
      run_id: runId,
      branch: 'main',
      type: 'tool_result_received',
      payload: { tool_request_id: 'tr_alpha', exit_code: 0 },
    });

    status = getStatus(storage);
    assert.equal(status.total_events, 3);
    assert.equal(status.open_tool_calls, 0);

    // Take checkpoint
    const chkManager = new CheckpointManager(storage);
    const active = ledger.reconstructActiveBranchState();
    chkManager.createCheckpoint('cp_alpha', runId, 'main', 3, 'e3', active.state_snapshot);

    status = getStatus(storage);
    assert.equal(status.last_checkpoint_id, 'cp_alpha');
  });

  it('throws ExitCode.TAMPER_DETECTED (exit 5) if ledger history was tampered with', () => {
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
      payload: { steps: ['valid'] },
    });
    ledger.append({
      event_id: 'e3',
      seq_num: 3,
      run_id: runId,
      branch: 'main',
      type: 'file_changed',
      payload: { file: 'a.js', hash: '1' },
    });

    // Tamper with intermediate record in events.ndjson
    const lines = fs.readFileSync(storage.eventsFile, 'utf8').trim().split('\n');
    const corrupted = JSON.parse(lines[1]);
    corrupted.payload = { steps: ['tampered'] };
    lines[1] = JSON.stringify(corrupted);
    fs.writeFileSync(storage.eventsFile, lines.join('\n') + '\n');

    assert.throws(
      () => getStatus(storage),
      (err) => err instanceof LedgerError && err.exitCode === ExitCode.TAMPER_DETECTED
    );
  });
});
