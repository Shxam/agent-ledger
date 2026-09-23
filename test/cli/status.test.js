import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { runCli } from '../../src/cli.js';
import { ExitCode } from '../../src/core/errors.js';
import { StorageManager } from '../../src/core/storage.js';

describe('CLI: agent-ledger status', () => {
  let tempDir;
  const runId = 'test_status_cli';

  beforeEach(async () => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-ledger-status-cli-'));
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

  it('outputs accurate plaintext status', async () => {
    let captured = '';
    const origWrite = process.stdout.write;
    process.stdout.write = (chunk) => {
      captured += chunk.toString();
      return true;
    };

    try {
      const code = await runCli(['status'], { cwd: tempDir });
      assert.equal(code, ExitCode.SUCCESS);
      assert.ok(captured.includes(`Run ID: ${runId}`));
      assert.ok(captured.includes('Branch: main'));
      assert.ok(captured.includes('Total Events: 0'));
      assert.ok(captured.includes('Last Checkpoint: none'));
      assert.ok(captured.includes('Open Tool Calls: 0'));
    } finally {
      process.stdout.write = origWrite;
    }
  });

  it('outputs canonical JSON status with exact required keys', async () => {
    let captured = '';
    const origWrite = process.stdout.write;
    process.stdout.write = (chunk) => {
      captured += chunk.toString();
      return true;
    };

    try {
      const code = await runCli(['status', '--json'], { cwd: tempDir });
      assert.equal(code, ExitCode.SUCCESS);
      const parsed = JSON.parse(captured.trim());
      assert.equal(parsed.run_id, runId);
      assert.equal(parsed.branch, 'main');
      assert.equal(parsed.total_events, 0);
      assert.equal(parsed.last_checkpoint_id, 'none');
      assert.equal(parsed.open_tool_calls, 0);
    } finally {
      process.stdout.write = origWrite;
    }
  });

  it('updates status after events, open tool calls, and checkpoints', async () => {
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
      type: 'tool_requested',
      payload: { tool_request_id: 'tool_1', tool_name: 'bash' },
    });
    await runCli(['append', e1], { cwd: tempDir });
    await runCli(['append', e2], { cwd: tempDir });

    let captured = '';
    const origWrite = process.stdout.write;
    process.stdout.write = (chunk) => {
      captured += chunk.toString();
      return true;
    };

    try {
      await runCli(['status', '--json'], { cwd: tempDir });
      const status1 = JSON.parse(captured.trim());
      assert.equal(status1.total_events, 2);
      assert.equal(status1.open_tool_calls, 1);
      assert.equal(status1.last_checkpoint_id, 'none');
    } finally {
      process.stdout.write = origWrite;
    }

    // Resolve tool call and checkpoint
    const e3 = createEventFile('e3.json', {
      event_id: 'e3',
      seq_num: 3,
      run_id: runId,
      branch: 'main',
      type: 'tool_result_received',
      payload: { tool_request_id: 'tool_1', exit_code: 0 },
    });
    await runCli(['append', e3], { cwd: tempDir });
    await runCli(['checkpoint', '--id', 'cp_final'], { cwd: tempDir });

    captured = '';
    process.stdout.write = (chunk) => {
      captured += chunk.toString();
      return true;
    };

    try {
      await runCli(['status', '--json'], { cwd: tempDir });
      const status2 = JSON.parse(captured.trim());
      assert.equal(status2.total_events, 3);
      assert.equal(status2.open_tool_calls, 0);
      assert.equal(status2.last_checkpoint_id, 'cp_final');
    } finally {
      process.stdout.write = origWrite;
    }
  });

  it('fails with ExitCode.TAMPER_DETECTED (exit 5) if history is tampered', async () => {
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
    corrupted.payload = { steps: ['tampered'] };
    lines[1] = JSON.stringify(corrupted);
    fs.writeFileSync(eventsFile, lines.join('\n') + '\n');

    const code = await runCli(['status'], { cwd: tempDir });
    assert.equal(code, ExitCode.TAMPER_DETECTED);
  });
});
