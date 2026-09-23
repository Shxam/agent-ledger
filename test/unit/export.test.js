import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { StorageManager } from '../../src/core/storage.js';
import { LedgerManager } from '../../src/core/ledger.js';
import { CheckpointManager } from '../../src/core/checkpoint.js';
import { BranchManager } from '../../src/core/branch.js';
import { buildExportData, exportCanonicalJson } from '../../src/core/export.js';
import { ExitCode, LedgerError } from '../../src/core/errors.js';

describe('Export Engine (Unit)', () => {
  let tempDir;
  let storage;
  let ledger;
  const runId = 'export_unit_run';

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-ledger-export-unit-'));
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

  it('builds comprehensive export including tools, files, tests, checkpoints, and branches', () => {
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
      payload: { steps: ['init_env', 'run_tests'] },
    });
    ledger.append({
      event_id: 'e3',
      seq_num: 3,
      run_id: runId,
      branch: 'main',
      type: 'tool_requested',
      payload: { tool_request_id: 'tr_100', tool_name: 'bash', tool_input: 'echo hello' },
    });
    ledger.append({
      event_id: 'e4',
      seq_num: 4,
      run_id: runId,
      branch: 'main',
      type: 'tool_result_received',
      payload: { tool_request_id: 'tr_100', exit_code: 0, output: 'hello' },
    });
    ledger.append({
      event_id: 'e5',
      seq_num: 5,
      run_id: runId,
      branch: 'main',
      type: 'file_changed',
      payload: { file: 'main.py', hash: 'hash_py1' },
    });
    ledger.append({
      event_id: 'e6',
      seq_num: 6,
      run_id: runId,
      branch: 'main',
      type: 'test_started',
      payload: {},
    });
    ledger.append({
      event_id: 'e7',
      seq_num: 7,
      run_id: runId,
      branch: 'main',
      type: 'test_finished',
      payload: { passed: 15, failed: 0 },
    });

    // Checkpoint
    const chkManager = new CheckpointManager(storage);
    const active = ledger.reconstructActiveBranchState();
    chkManager.createCheckpoint('cp_mid', runId, 'main', 7, 'e7', active.state_snapshot);

    // Branch
    const branchManager = new BranchManager(storage);
    const cp = chkManager.readCheckpoint('cp_mid');
    branchManager.createBranch('child_feature', 'cp_mid', cp, active.last_hash);

    const config = storage.readConfig();
    config.active_branch = 'child_feature';
    storage.writeConfig(config);

    ledger.append({
      event_id: 'e8_br',
      seq_num: 8,
      run_id: runId,
      branch: 'child_feature',
      type: 'file_changed',
      payload: { file: 'feature.py', hash: 'hash_feat' },
    });

    const exportData = buildExportData(storage);

    assert.equal(exportData.run_id, runId);
    assert.equal(exportData.active_branch, 'child_feature');
    assert.ok(exportData.branches.main);
    assert.ok(exportData.branches.child_feature);
    assert.equal(exportData.branches.main.events.length, 7);
    assert.equal(exportData.branches.child_feature.events.length, 1);
    assert.equal(exportData.checkpoints.length, 1);
    assert.equal(exportData.checkpoints[0].checkpoint_id, 'cp_mid');

    // Tool interaction
    assert.equal(exportData.tool_interactions.length, 1);
    assert.equal(exportData.tool_interactions[0].tool_request_id, 'tr_100');
    assert.equal(exportData.tool_interactions[0].resolved, true);

    // Files
    assert.ok(exportData.modified_files['main.py']);
    assert.ok(exportData.modified_files['feature.py']);

    // Test records
    assert.equal(exportData.test_records.summary.passed, 15);
  });

  it('produces byte-for-byte identical canonical JSON on repeated calls', () => {
    ledger.append({
      event_id: 'e1',
      seq_num: 1,
      run_id: runId,
      branch: 'main',
      type: 'run_started',
      payload: {},
    });

    const json1 = exportCanonicalJson(storage);
    const json2 = exportCanonicalJson(storage);
    const json3 = exportCanonicalJson(storage);

    assert.equal(json1, json2);
    assert.equal(json2, json3);
  });

  it('throws ExitCode.TAMPER_DETECTED (exit 5) if history is tampered', () => {
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
      payload: { steps: ['ok'] },
    });
    ledger.append({
      event_id: 'e3',
      seq_num: 3,
      run_id: runId,
      branch: 'main',
      type: 'file_changed',
      payload: { file: 'a.js', hash: '1' },
    });

    const lines = fs.readFileSync(storage.eventsFile, 'utf8').trim().split('\n');
    const corrupted = JSON.parse(lines[1]);
    corrupted.payload = { steps: ['tampered'] };
    lines[1] = JSON.stringify(corrupted);
    fs.writeFileSync(storage.eventsFile, lines.join('\n') + '\n');

    assert.throws(
      () => exportCanonicalJson(storage),
      (err) => err instanceof LedgerError && err.exitCode === ExitCode.TAMPER_DETECTED
    );
  });
});
