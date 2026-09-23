import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { runCli } from '../../src/cli.js';
import { ExitCode } from '../../src/core/errors.js';
import { StorageManager } from '../../src/core/storage.js';

describe('Integration: Full Multi-Subsystem Lifecycle', () => {
  let tempDir;
  const runId = 'integration_lifecycle_run';

  beforeEach(async () => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-ledger-int-full-'));
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

  it('executes full realistic lifecycle from init through export and run sealing', async () => {
    // 1. Init
    const initCode = await runCli(['init', runId], { cwd: tempDir });
    assert.equal(initCode, ExitCode.SUCCESS);

    // Initial status
    let captured = '';
    const origWrite = process.stdout.write;
    process.stdout.write = (chunk) => { captured += chunk.toString(); return true; };
    try {
      await runCli(['status', '--json'], { cwd: tempDir });
      const s0 = JSON.parse(captured.trim());
      assert.equal(s0.total_events, 0);
      assert.equal(s0.open_tool_calls, 0);
      assert.equal(s0.last_checkpoint_id, 'none');
    } finally {
      process.stdout.write = origWrite;
    }

    // 2. Append events with tool request/result
    const e1 = createEventFile('e1.json', { event_id: 'e1', seq_num: 1, run_id: runId, branch: 'main', type: 'run_started', payload: {} });
    const e2 = createEventFile('e2.json', { event_id: 'e2', seq_num: 2, run_id: runId, branch: 'main', type: 'plan_created', payload: { steps: ['stepA', 'stepB'] } });
    const e3 = createEventFile('e3.json', { event_id: 'e3', seq_num: 3, run_id: runId, branch: 'main', type: 'tool_requested', payload: { tool_request_id: 'tr_1', tool_name: 'bash', tool_input: 'git status' } });

    await runCli(['append', e1], { cwd: tempDir });
    await runCli(['append', e2], { cwd: tempDir });
    await runCli(['append', e3], { cwd: tempDir });

    // Checkpoint must be blocked while tool call is in-flight (Exit 4)
    const blockedCpCode = await runCli(['checkpoint', '--id', 'cp_blocked'], { cwd: tempDir });
    assert.equal(blockedCpCode, ExitCode.STATE_BLOCKED);

    // Resolve tool call
    const e4 = createEventFile('e4.json', { event_id: 'e4', seq_num: 4, run_id: runId, branch: 'main', type: 'tool_result_received', payload: { tool_request_id: 'tr_1', exit_code: 0, output: 'clean' } });
    const e5 = createEventFile('e5.json', { event_id: 'e5', seq_num: 5, run_id: runId, branch: 'main', type: 'file_changed', payload: { file: 'src/main.js', hash: 'h1' } });
    const e6 = createEventFile('e6.json', { event_id: 'e6', seq_num: 6, run_id: runId, branch: 'main', type: 'test_started', payload: {} });
    const e7 = createEventFile('e7.json', { event_id: 'e7', seq_num: 7, run_id: runId, branch: 'main', type: 'test_finished', payload: { passed: 10, failed: 0 } });

    await runCli(['append', e4], { cwd: tempDir });
    await runCli(['append', e5], { cwd: tempDir });
    await runCli(['append', e6], { cwd: tempDir });
    await runCli(['append', e7], { cwd: tempDir });

    // 3. Create checkpoint
    const cpCode = await runCli(['checkpoint', '--id', 'cp1'], { cwd: tempDir });
    assert.equal(cpCode, ExitCode.SUCCESS);

    // Snapshot parent event history before branching
    const eventsFile = path.join(tempDir, '.agent-ledger', 'events.ndjson');
    const parentEventsBeforeBranch = fs.readFileSync(eventsFile, 'utf8');

    // 4. Branch from checkpoint
    const brCode = await runCli(['branch', '--from', 'cp1', '--name', 'speculative_branch'], { cwd: tempDir });
    assert.equal(brCode, ExitCode.SUCCESS);

    // 5. Append on child branch
    const e8_child = createEventFile('e8_child.json', { event_id: 'e8_c', seq_num: 8, run_id: runId, branch: 'speculative_branch', type: 'file_changed', payload: { file: 'spec.js', hash: 's1' } });
    await runCli(['append', e8_child], { cwd: tempDir });

    // Verify parent event records remain byte-for-byte unchanged after child branch activity
    const eventsAfterChildAppend = fs.readFileSync(eventsFile, 'utf8');
    assert.ok(
      eventsAfterChildAppend.startsWith(parentEventsBeforeBranch),
      'Parent events must remain byte-for-byte unchanged after child branch append'
    );

    // 6. Switch back to main and append divergent event
    const storage = new StorageManager(tempDir);
    const cfg = storage.readConfig();
    cfg.active_branch = 'main';
    storage.writeConfig(cfg);

    const e8_main = createEventFile('e8_main.json', { event_id: 'e8_m', seq_num: 8, run_id: runId, branch: 'main', type: 'file_changed', payload: { file: 'main_fix.js', hash: 'm1' } });
    await runCli(['append', e8_main], { cwd: tempDir });

    // 7. Replay
    const replayMain = await runCli(['replay', '--from', 'cp1'], { cwd: tempDir });
    assert.equal(replayMain, ExitCode.SUCCESS);

    // 8. Introduce torn tail on events log
    const validEventsBeforeTorn = fs.readFileSync(eventsFile, 'utf8');
    fs.appendFileSync(eventsFile, '{"event_id":"torn_tail_crash",');

    // 9. Recover torn tail
    const recoverCode = await runCli(['recover'], { cwd: tempDir });
    assert.equal(recoverCode, ExitCode.SUCCESS);

    const validEventsAfterRecover = fs.readFileSync(eventsFile, 'utf8');
    assert.equal(validEventsAfterRecover, validEventsBeforeTorn);

    // 10. Named Registers
    const binData = Buffer.from([0x00, 0x11, 0x22, 0x33, 0xff, 0xee, 0xdd]);
    const binFile = path.join(tempDir, 'payload.bin');
    fs.writeFileSync(binFile, binData);

    const putCode = await runCli(['register-put', '--reg', 'x', binFile], { cwd: tempDir });
    assert.equal(putCode, ExitCode.SUCCESS);

    let regCaptured = [];
    process.stdout.write = (chunk) => { regCaptured.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)); return true; };
    try {
      const getCode = await runCli(['register-get', '--reg', 'x'], { cwd: tempDir });
      assert.equal(getCode, ExitCode.SUCCESS);
      const combined = Buffer.concat(regCaptured);
      assert.equal(Buffer.compare(combined, binData), 0);
    } finally {
      process.stdout.write = origWrite;
    }

    // 11. Status
    captured = '';
    process.stdout.write = (chunk) => { captured += chunk.toString(); return true; };
    try {
      const statusCode = await runCli(['status', '--json'], { cwd: tempDir });
      assert.equal(statusCode, ExitCode.SUCCESS);
      const st = JSON.parse(captured.trim());
      assert.equal(st.total_events, 9); // 7 prefix + 1 child + 1 main
      assert.equal(st.last_checkpoint_id, 'cp1');
      assert.equal(st.open_tool_calls, 0);
    } finally {
      process.stdout.write = origWrite;
    }

    // 12. Export
    captured = '';
    process.stdout.write = (chunk) => { captured += chunk.toString(); return true; };
    try {
      const exportCode = await runCli(['export', '--format', 'json'], { cwd: tempDir });
      assert.equal(exportCode, ExitCode.SUCCESS);
      const exp = JSON.parse(captured.trim());
      assert.equal(exp.run_id, runId);
      assert.ok(exp.branches.main);
      assert.ok(exp.branches.speculative_branch);
      assert.equal(exp.branches.main.events.length, 8);
      assert.equal(exp.branches.speculative_branch.events.length, 1);
      assert.equal(exp.checkpoints.length, 1);
      assert.equal(exp.tool_interactions.length, 1);
      assert.equal(exp.tool_interactions[0].resolved, true);
    } finally {
      process.stdout.write = origWrite;
    }

    // 13. Complete the run and verify sealing
    const e9_complete = createEventFile('e9_complete.json', { event_id: 'e9_done', seq_num: 9, run_id: runId, branch: 'main', type: 'run_completed', payload: {} });
    const completeAppendCode = await runCli(['append', e9_complete], { cwd: tempDir });
    assert.equal(completeAppendCode, ExitCode.SUCCESS);

    // Subsequent append must be blocked (Exit 4)
    const e10_post = createEventFile('e10_post.json', { event_id: 'e10_bad', seq_num: 10, run_id: runId, branch: 'main', type: 'file_changed', payload: { file: 'bad.js', hash: 'bad' } });
    const postCode = await runCli(['append', e10_post], { cwd: tempDir });
    assert.equal(postCode, ExitCode.STATE_BLOCKED);

    // 14. Historical corruption returns ExitCode.UNRECOVERABLE_CORRUPTION (Exit 7) on recover
    // Corrupt an event in the historical prefix (line 2)
    const allLines = fs.readFileSync(eventsFile, 'utf8').split('\n');
    const tamperedHistorical = allLines[1].replace('"steps"', '"tampered_steps"');
    allLines[1] = tamperedHistorical;
    fs.writeFileSync(eventsFile, allLines.join('\n'));

    const unrecoverableCode = await runCli(['recover'], { cwd: tempDir });
    assert.equal(unrecoverableCode, ExitCode.UNRECOVERABLE_CORRUPTION);

    // 15. Status and export detect hash tampering with ExitCode.TAMPER_DETECTED (Exit 5)
    const tamperedStatusCode = await runCli(['status'], { cwd: tempDir });
    assert.equal(tamperedStatusCode, ExitCode.TAMPER_DETECTED);

    const tamperedExportCode = await runCli(['export', '--format', 'json'], { cwd: tempDir });
    assert.equal(tamperedExportCode, ExitCode.TAMPER_DETECTED);
  });
});
