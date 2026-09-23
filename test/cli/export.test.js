import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { runCli } from '../../src/cli.js';
import { ExitCode } from '../../src/core/errors.js';
import { StorageManager } from '../../src/core/storage.js';

describe('CLI: agent-ledger export', () => {
  let tempDir;
  const runId = 'test_export_cli';

  beforeEach(async () => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-ledger-export-cli-'));
    await runCli(['init', runId], { cwd: tempDir });
  });

  afterEach(() => {
    if (fs.existsSync(tempDir)) {
      try {
        fs.rmSync(tempDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
      } catch {}
    }
  });

  function createEventFile(filename, data) {
    const filePath = path.join(tempDir, filename);
    fs.writeFileSync(filePath, JSON.stringify(data));
    return filePath;
  }

  it('exports valid execution trace with canonical JSON and preserves branch topology', async () => {
    const e1 = createEventFile('e1.json', {
      event_id: 'e1',
      seq_num: 1,
      run_id: runId,
      branch: 'main',
      type: 'run_started',
      payload: {},
    });
    const e2 = createEventFile('e2.json', {
      event_id: 'e2',
      seq_num: 2,
      run_id: runId,
      branch: 'main',
      type: 'plan_created',
      payload: { steps: ['step1', 'step2'] },
    });
    await runCli(['append', e1], { cwd: tempDir });
    await runCli(['append', e2], { cwd: tempDir });

    await runCli(['checkpoint', '--id', 'cp1'], { cwd: tempDir });

    // Fork branch
    await runCli(['branch', '--from', 'cp1', '--name', 'feature_a'], { cwd: tempDir });

    // Append on feature_a
    const e3_a = createEventFile('e3_a.json', {
      event_id: 'e3_a',
      seq_num: 3,
      run_id: runId,
      branch: 'feature_a',
      type: 'file_changed',
      payload: { file: 'feature.js', hash: 'hash_feat' },
    });
    await runCli(['append', e3_a], { cwd: tempDir });

    // Switch back to main and append divergent event
    const storage = new StorageManager(tempDir);
    const cfg = storage.readConfig();
    cfg.active_branch = 'main';
    storage.writeConfig(cfg);

    const e3_main = createEventFile('e3_main.json', {
      event_id: 'e3_main',
      seq_num: 3,
      run_id: runId,
      branch: 'main',
      type: 'test_started',
      payload: {},
    });
    await runCli(['append', e3_main], { cwd: tempDir });

    let captured = '';
    const origWrite = process.stdout.write;
    process.stdout.write = (chunk) => {
      captured += chunk.toString();
      return true;
    };

    try {
      const code = await runCli(['export', '--format', 'json'], { cwd: tempDir });
      assert.equal(code, ExitCode.SUCCESS);

      const parsed = JSON.parse(captured.trim());
      assert.equal(parsed.run_id, runId);
      assert.ok(parsed.branches.main);
      assert.ok(parsed.branches.feature_a);
      assert.equal(parsed.branches.main.events.length, 3);
      assert.equal(parsed.branches.feature_a.events.length, 1);
      assert.equal(parsed.checkpoints.length, 1);
      assert.equal(parsed.checkpoints[0].checkpoint_id, 'cp1');
    } finally {
      process.stdout.write = origWrite;
    }
  });

  it('rejects invalid or missing format argument with ExitCode.USAGE_OR_NOT_FOUND (exit 1)', async () => {
    const code1 = await runCli(['export'], { cwd: tempDir });
    assert.equal(code1, ExitCode.USAGE_OR_NOT_FOUND);

    const code2 = await runCli(['export', '--format', 'yaml'], { cwd: tempDir });
    assert.equal(code2, ExitCode.USAGE_OR_NOT_FOUND);
  });

  it('detects tampering and exits with ExitCode.TAMPER_DETECTED (exit 5)', async () => {
    const e1 = createEventFile('e1.json', {
      event_id: 'e1',
      seq_num: 1,
      run_id: runId,
      branch: 'main',
      type: 'run_started',
      payload: {},
    });
    const e2 = createEventFile('e2.json', {
      event_id: 'e2',
      seq_num: 2,
      run_id: runId,
      branch: 'main',
      type: 'plan_created',
      payload: { steps: ['step1'] },
    });
    const e3 = createEventFile('e3.json', {
      event_id: 'e3',
      seq_num: 3,
      run_id: runId,
      branch: 'main',
      type: 'file_changed',
      payload: { file: 'a.js', hash: '1' },
    });
    await runCli(['append', e1], { cwd: tempDir });
    await runCli(['append', e2], { cwd: tempDir });
    await runCli(['append', e3], { cwd: tempDir });

    const eventsFile = path.join(tempDir, '.agent-ledger', 'events.ndjson');
    const lines = fs.readFileSync(eventsFile, 'utf8').trim().split('\n');
    const corrupted = JSON.parse(lines[1]);
    corrupted.payload = { steps: ['corrupt'] };
    lines[1] = JSON.stringify(corrupted);
    fs.writeFileSync(eventsFile, lines.join('\n') + '\n');

    const code = await runCli(['export', '--format', 'json'], { cwd: tempDir });
    assert.equal(code, ExitCode.TAMPER_DETECTED);
  });
});
