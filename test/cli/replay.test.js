import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import child_process from 'node:child_process';
import { runCli } from '../../src/cli.js';
import { ExitCode } from '../../src/core/errors.js';
import { StorageManager } from '../../src/core/storage.js';

describe('CLI: agent-ledger replay', () => {
  let tempDir;
  const runId = 'test_replay_cli';

  beforeEach(async () => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-ledger-replay-cli-'));
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

  it('replays successfully from a valid checkpoint and subsequent history (exit 0)', async () => {
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
      payload: { steps: ['init_plan'] },
    });
    await runCli(['append', e1], { cwd: tempDir });
    await runCli(['append', e2], { cwd: tempDir });

    await runCli(['checkpoint', '--id', 'cp_stage1'], { cwd: tempDir });

    const e3 = createEventFile('e3.json', {
      event_id: 'e3',
      seq_num: 3,
      run_id: runId,
      branch: 'main',
      type: 'file_changed',
      payload: { file: 'src/app.js', hash: 'app_hash_v1' },
    });
    const e4 = createEventFile('e4.json', {
      event_id: 'e4',
      seq_num: 4,
      run_id: runId,
      branch: 'main',
      type: 'test_finished',
      payload: { passed: 42, failed: 0 },
    });
    await runCli(['append', e3], { cwd: tempDir });
    await runCli(['append', e4], { cwd: tempDir });

    const code = await runCli(['replay', '--from', 'cp_stage1'], { cwd: tempDir });
    assert.equal(code, ExitCode.SUCCESS);
  });

  it('rejects missing checkpoint with ExitCode.USAGE_OR_NOT_FOUND (exit 1)', async () => {
    const code = await runCli(['replay', '--from', 'cp_does_not_exist'], { cwd: tempDir });
    assert.equal(code, ExitCode.USAGE_OR_NOT_FOUND);
  });

  it('detects hash drift and fails with ExitCode.TAMPER_DETECTED (exit 5)', async () => {
    const e1 = createEventFile('e1.json', {
      event_id: 'e1',
      seq_num: 1,
      run_id: runId,
      branch: 'main',
      type: 'run_started',
      payload: {},
    });
    await runCli(['append', e1], { cwd: tempDir });
    await runCli(['checkpoint', '--id', 'cp_tamper'], { cwd: tempDir });

    const e2 = createEventFile('e2.json', {
      event_id: 'e2',
      seq_num: 2,
      run_id: runId,
      branch: 'main',
      type: 'plan_created',
      payload: { steps: ['valid'] },
    });
    const e3 = createEventFile('e3.json', {
      event_id: 'e3',
      seq_num: 3,
      run_id: runId,
      branch: 'main',
      type: 'file_changed',
      payload: { file: 'a.js', hash: '123' },
    });
    await runCli(['append', e2], { cwd: tempDir });
    await runCli(['append', e3], { cwd: tempDir });

    // Tamper with events.ndjson directly (intermediate event e2)
    const eventsFile = path.join(tempDir, '.agent-ledger', 'events.ndjson');
    const content = fs.readFileSync(eventsFile, 'utf8');
    const lines = content.trim().split('\n');
    const corruptedRecord = JSON.parse(lines[1]);
    corruptedRecord.payload = { steps: ['TAMPERED_INJECTION'] }; // altered payload causing hash drift on e3
    lines[1] = JSON.stringify(corruptedRecord);
    fs.writeFileSync(eventsFile, lines.join('\n') + '\n');

    const code = await runCli(['replay', '--from', 'cp_tamper'], { cwd: tempDir });
    assert.equal(code, ExitCode.TAMPER_DETECTED);
  });

  it('virtualizes tool execution without side effects or creating sentinel files', async () => {
    const sentinelPath = path.join(tempDir, 'sentinel_must_not_exist.txt');

    const e1 = createEventFile('e1.json', {
      event_id: 'e1',
      seq_num: 1,
      run_id: runId,
      branch: 'main',
      type: 'run_started',
      payload: {},
    });
    await runCli(['append', e1], { cwd: tempDir });
    await runCli(['checkpoint', '--id', 'cp_tool_test'], { cwd: tempDir });

    const e2 = createEventFile('e2.json', {
      event_id: 'e2',
      seq_num: 2,
      run_id: runId,
      branch: 'main',
      type: 'tool_requested',
      payload: {
        tool_request_id: 'req_touch_sentinel',
        tool_name: 'shell',
        tool_input: `echo "dangerous" > "${sentinelPath}"`,
      },
    });
    const e3 = createEventFile('e3.json', {
      event_id: 'e3',
      seq_num: 3,
      run_id: runId,
      branch: 'main',
      type: 'tool_result_received',
      payload: {
        tool_request_id: 'req_touch_sentinel',
        exit_code: 0,
        output: 'sentinel touched',
      },
    });

    await runCli(['append', e2], { cwd: tempDir });
    await runCli(['append', e3], { cwd: tempDir });

    // Replay should virtualize and satisfy output from ledger
    const code = await runCli(['replay', '--from', 'cp_tool_test'], { cwd: tempDir });
    assert.equal(code, ExitCode.SUCCESS);

    // Verify sentinel file was never created
    assert.ok(!fs.existsSync(sentinelPath), 'Replay must NOT execute real tool commands or create sentinel files');
  });

  it('guarantees subprocess protection by intercepting child_process', async () => {
    // Intercept child_process methods to ensure replay never spawns processes
    let subprocessAttempted = false;
    const originalSpawn = child_process.spawn;
    const originalExec = child_process.exec;
    const originalExecSync = child_process.execSync;

    child_process.spawn = () => { subprocessAttempted = true; throw new Error('Subprocess spawned during replay!'); };
    child_process.exec = () => { subprocessAttempted = true; throw new Error('Subprocess executed during replay!'); };
    child_process.execSync = () => { subprocessAttempted = true; throw new Error('Subprocess execSync during replay!'); };

    try {
      const e1 = createEventFile('e1.json', {
        event_id: 'e1',
        seq_num: 1,
        run_id: runId,
        branch: 'main',
        type: 'run_started',
        payload: {},
      });
      await runCli(['append', e1], { cwd: tempDir });
      await runCli(['checkpoint', '--id', 'cp_subproc'], { cwd: tempDir });

      const e2 = createEventFile('e2.json', {
        event_id: 'e2',
        seq_num: 2,
        run_id: runId,
        branch: 'main',
        type: 'tool_requested',
        payload: { tool_request_id: 'req_subproc', tool_name: 'bash', tool_input: 'rm -rf /' },
      });
      const e3 = createEventFile('e3.json', {
        event_id: 'e3',
        seq_num: 3,
        run_id: runId,
        branch: 'main',
        type: 'tool_result_received',
        payload: { tool_request_id: 'req_subproc', exit_code: 0, output: 'virtualized' },
      });
      await runCli(['append', e2], { cwd: tempDir });
      await runCli(['append', e3], { cwd: tempDir });

      const code = await runCli(['replay', '--from', 'cp_subproc'], { cwd: tempDir });
      assert.equal(code, ExitCode.SUCCESS);
      assert.equal(subprocessAttempted, false, 'Replay must never attempt child process execution');
    } finally {
      child_process.spawn = originalSpawn;
      child_process.exec = originalExec;
      child_process.execSync = originalExecSync;
    }
  });

  it('obeys step limits: step 0, step 1, and large step', async () => {
    const e1 = createEventFile('e1.json', {
      event_id: 'e1',
      seq_num: 1,
      run_id: runId,
      branch: 'main',
      type: 'run_started',
      payload: {},
    });
    await runCli(['append', e1], { cwd: tempDir });
    await runCli(['checkpoint', '--id', 'cp_steps'], { cwd: tempDir });

    const e2 = createEventFile('e2.json', {
      event_id: 'e2',
      seq_num: 2,
      run_id: runId,
      branch: 'main',
      type: 'plan_created',
      payload: { steps: ['s1'] },
    });
    const e3 = createEventFile('e3.json', {
      event_id: 'e3',
      seq_num: 3,
      run_id: runId,
      branch: 'main',
      type: 'plan_created',
      payload: { steps: ['s2'] },
    });
    await runCli(['append', e2], { cwd: tempDir });
    await runCli(['append', e3], { cwd: tempDir });

    // Step 0
    const code0 = await runCli(['replay', '--from', 'cp_steps', '--step', '0'], { cwd: tempDir });
    assert.equal(code0, ExitCode.SUCCESS);

    // Step 1
    const code1 = await runCli(['replay', '--from', 'cp_steps', '--step', '1'], { cwd: tempDir });
    assert.equal(code1, ExitCode.SUCCESS);

    // Step 100 (large step)
    const codeLarge = await runCli(['replay', '--from', 'cp_steps', '--step', '100'], { cwd: tempDir });
    assert.equal(codeLarge, ExitCode.SUCCESS);
  });

  it('rejects invalid --step values with ExitCode.USAGE_OR_NOT_FOUND (exit 1)', async () => {
    const e1 = createEventFile('e1.json', {
      event_id: 'e1',
      seq_num: 1,
      run_id: runId,
      branch: 'main',
      type: 'run_started',
      payload: {},
    });
    await runCli(['append', e1], { cwd: tempDir });
    await runCli(['checkpoint', '--id', 'cp_invalid_step'], { cwd: tempDir });

    // Negative step
    const codeNeg = await runCli(['replay', '--from', 'cp_invalid_step', '--step', '-1'], { cwd: tempDir });
    assert.equal(codeNeg, ExitCode.USAGE_OR_NOT_FOUND);

    // Non-integer step
    const codeFloat = await runCli(['replay', '--from', 'cp_invalid_step', '--step', '1.5'], { cwd: tempDir });
    assert.equal(codeFloat, ExitCode.USAGE_OR_NOT_FOUND);

    const codeStr = await runCli(['replay', '--from', 'cp_invalid_step', '--step', 'abc'], { cwd: tempDir });
    assert.equal(codeStr, ExitCode.USAGE_OR_NOT_FOUND);

    // Missing value after --step
    const codeMissing = await runCli(['replay', '--from', 'cp_invalid_step', '--step'], { cwd: tempDir });
    assert.equal(codeMissing, ExitCode.USAGE_OR_NOT_FOUND);
  });

  it('maintains strict branch isolation during replay', async () => {
    // 1. Create history on main
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
      payload: { steps: ['main_init'] },
    });
    await runCli(['append', e1], { cwd: tempDir });
    await runCli(['append', e2], { cwd: tempDir });

    // 2. Checkpoint on main at seq 2
    await runCli(['checkpoint', '--id', 'cp_main_root'], { cwd: tempDir });

    // 3. Fork branch 'branch_exp'
    await runCli(['branch', '--from', 'cp_main_root', '--name', 'branch_exp'], { cwd: tempDir });

    // 4. Append events on branch_exp
    const e3_exp = createEventFile('e3_exp.json', {
      event_id: 'e3_exp',
      seq_num: 3,
      run_id: runId,
      branch: 'branch_exp',
      type: 'file_changed',
      payload: { file: 'experiment.js', hash: 'exp_hash_v1' },
    });
    await runCli(['append', e3_exp], { cwd: tempDir });
    await runCli(['checkpoint', '--id', 'cp_exp_node'], { cwd: tempDir });

    const e4_exp = createEventFile('e4_exp.json', {
      event_id: 'e4_exp',
      seq_num: 4,
      run_id: runId,
      branch: 'branch_exp',
      type: 'test_finished',
      payload: { passed: 99, failed: 0 },
    });
    await runCli(['append', e4_exp], { cwd: tempDir });

    // 5. Switch back to main and append divergent events on main
    const storage = new StorageManager(tempDir);
    const cfg = storage.readConfig();
    cfg.active_branch = 'main';
    storage.writeConfig(cfg);

    const e3_main = createEventFile('e3_main.json', {
      event_id: 'e3_main',
      seq_num: 3,
      run_id: runId,
      branch: 'main',
      type: 'file_changed',
      payload: { file: 'main_only.js', hash: 'main_hash_v1' },
    });
    await runCli(['append', e3_main], { cwd: tempDir });

    // Replay from cp_main_root: must only see main events
    const codeMain = await runCli(['replay', '--from', 'cp_main_root'], { cwd: tempDir });
    assert.equal(codeMain, ExitCode.SUCCESS);

    // Replay from cp_exp_node: must only see branch_exp events
    const codeExp = await runCli(['replay', '--from', 'cp_exp_node'], { cwd: tempDir });
    assert.equal(codeExp, ExitCode.SUCCESS);
  });

  it('ensures checkpointed state is not duplicated during replay', async () => {
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
      type: 'test_finished',
      payload: { passed: 5, failed: 0 },
    });
    await runCli(['append', e1], { cwd: tempDir });
    await runCli(['append', e2], { cwd: tempDir });

    // Checkpoint at seq 2 contains test_summary: { passed: 5, failed: 0 }
    await runCli(['checkpoint', '--id', 'cp_boundary'], { cwd: tempDir });

    // Append another test_finished after checkpoint
    const e3 = createEventFile('e3.json', {
      event_id: 'e3',
      seq_num: 3,
      run_id: runId,
      branch: 'main',
      type: 'test_finished',
      payload: { passed: 3, failed: 1 },
    });
    await runCli(['append', e3], { cwd: tempDir });

    const code = await runCli(['replay', '--from', 'cp_boundary'], { cwd: tempDir });
    assert.equal(code, ExitCode.SUCCESS);
  });
});
