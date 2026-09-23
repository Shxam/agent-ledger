import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { runCli } from '../../src/cli.js';
import { ExitCode } from '../../src/core/errors.js';

describe('CLI: agent-ledger checkpoint', () => {
  let tempDir;
  const runId = 'test_chk_cli';

  beforeEach(async () => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-ledger-chk-cli-test-'));
    await runCli(['init', runId], { cwd: tempDir });
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

  function createEventFile(filename, data) {
    const filePath = path.join(tempDir, filename);
    fs.writeFileSync(filePath, JSON.stringify(data));
    return filePath;
  }

  it('creates an immutable state checkpoint when all tool calls are resolved (exit 0)', async () => {
    // Append events
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
      payload: { steps: ['implement', 'test'] },
    });
    const e3 = createEventFile('e3.json', {
      event_id: 'e3',
      seq_num: 3,
      run_id: runId,
      branch: 'main',
      type: 'tool_requested',
      payload: { tool_request_id: 'req_1', tool_name: 'shell' },
    });
    const e4 = createEventFile('e4.json', {
      event_id: 'e4',
      seq_num: 4,
      run_id: runId,
      branch: 'main',
      type: 'tool_result_received',
      payload: { tool_request_id: 'req_1', exit_code: 0 },
    });

    await runCli(['append', e1], { cwd: tempDir });
    await runCli(['append', e2], { cwd: tempDir });
    await runCli(['append', e3], { cwd: tempDir });
    await runCli(['append', e4], { cwd: tempDir });

    const code = await runCli(['checkpoint', '--id', 'chk_step_04'], { cwd: tempDir });
    assert.equal(code, ExitCode.SUCCESS);

    const manifestPath = path.join(tempDir, '.agent-ledger', 'checkpoints', 'chk_step_04.json');
    assert.ok(fs.existsSync(manifestPath));

    const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
    assert.equal(manifest.checkpoint_id, 'chk_step_04');
    assert.equal(manifest.run_id, runId);
    assert.equal(manifest.branch, 'main');
    assert.equal(manifest.seq_num, 4);
    assert.equal(manifest.last_event_id, 'e4');
    assert.deepEqual(manifest.state_snapshot.plan_steps, ['implement', 'test']);
    assert.deepEqual(manifest.state_snapshot.active_tool_calls, []);
  });

  it('blocks checkpoint creation when an in-flight tool call is active (exit 4)', async () => {
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
      payload: { tool_request_id: 'req_pending_1', tool_name: 'shell' },
    });

    await runCli(['append', e1], { cwd: tempDir });
    await runCli(['append', e2], { cwd: tempDir });

    // Attempt checkpoint while req_pending_1 is unresolved
    const code = await runCli(['checkpoint', '--id', 'chk_in_flight'], { cwd: tempDir });
    assert.equal(code, ExitCode.STATE_BLOCKED);

    const manifestPath = path.join(tempDir, '.agent-ledger', 'checkpoints', 'chk_in_flight.json');
    assert.ok(!fs.existsSync(manifestPath), 'Blocked checkpoint manifest must not exist');
  });

  it('rejects duplicate checkpoint ID with ExitCode.CONFLICT (exit 6)', async () => {
    const e1 = createEventFile('e1.json', {
      event_id: 'e1',
      seq_num: 1,
      run_id: runId,
      branch: 'main',
      type: 'run_started',
      payload: {},
    });
    await runCli(['append', e1], { cwd: tempDir });

    const code1 = await runCli(['checkpoint', '--id', 'chk_dup_test'], { cwd: tempDir });
    assert.equal(code1, ExitCode.SUCCESS);

    // Attempt second checkpoint with same ID
    const code2 = await runCli(['checkpoint', '--id', 'chk_dup_test'], { cwd: tempDir });
    assert.equal(code2, ExitCode.CONFLICT);
  });

  it('rejects missing --id flag with ExitCode.USAGE_OR_NOT_FOUND (exit 1)', async () => {
    const code = await runCli(['checkpoint'], { cwd: tempDir });
    assert.equal(code, ExitCode.USAGE_OR_NOT_FOUND);
  });
});
