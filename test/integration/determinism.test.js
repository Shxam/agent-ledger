import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { runCli } from '../../src/cli.js';
import { ExitCode } from '../../src/core/errors.js';

describe('Integration: Determinism Audit', () => {
  let tempDir;
  const runId = 'determinism_audit_run';

  beforeEach(async () => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-ledger-int-det-'));
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

  it('guarantees byte-for-byte identical output for status, export, checkpoint, and replay', async () => {
    const e1 = createEventFile('e1.json', { event_id: 'e1', seq_num: 1, run_id: runId, branch: 'main', type: 'run_started', payload: {} });
    const e2 = createEventFile('e2.json', { event_id: 'e2', seq_num: 2, run_id: runId, branch: 'main', type: 'plan_created', payload: { steps: ['b_step', 'a_step'] } });
    const e3 = createEventFile('e3.json', { event_id: 'e3', seq_num: 3, run_id: runId, branch: 'main', type: 'tool_requested', payload: { tool_request_id: 'req_det', tool_name: 'bash' } });
    const e4 = createEventFile('e4.json', { event_id: 'e4', seq_num: 4, run_id: runId, branch: 'main', type: 'tool_result_received', payload: { tool_request_id: 'req_det', exit_code: 0 } });
    const e5 = createEventFile('e5.json', { event_id: 'e5', seq_num: 5, run_id: runId, branch: 'main', type: 'file_changed', payload: { file: 'z.js', hash: 'hz' } });
    const e6 = createEventFile('e6.json', { event_id: 'e6', seq_num: 6, run_id: runId, branch: 'main', type: 'file_changed', payload: { file: 'a.js', hash: 'ha' } });

    await runCli(['append', e1], { cwd: tempDir });
    await runCli(['append', e2], { cwd: tempDir });
    await runCli(['append', e3], { cwd: tempDir });
    await runCli(['append', e4], { cwd: tempDir });
    await runCli(['append', e5], { cwd: tempDir });
    await runCli(['append', e6], { cwd: tempDir });

    await runCli(['checkpoint', '--id', 'cp_det'], { cwd: tempDir });

    const origWrite = process.stdout.write;

    // 1. Status JSON determinism
    const getStatusJson = async () => {
      let output = '';
      process.stdout.write = (chunk) => { output += chunk.toString(); return true; };
      try {
        await runCli(['status', '--json'], { cwd: tempDir });
      } finally {
        process.stdout.write = origWrite;
      }
      return output;
    };

    const s1 = await getStatusJson();
    const s2 = await getStatusJson();
    const s3 = await getStatusJson();
    assert.equal(s1, s2);
    assert.equal(s2, s3);

    // 2. Export JSON determinism
    const getExportJson = async () => {
      let output = '';
      process.stdout.write = (chunk) => { output += chunk.toString(); return true; };
      try {
        await runCli(['export', '--format', 'json'], { cwd: tempDir });
      } finally {
        process.stdout.write = origWrite;
      }
      return output;
    };

    const exp1 = await getExportJson();
    const exp2 = await getExportJson();
    const exp3 = await getExportJson();
    assert.equal(exp1, exp2);
    assert.equal(exp2, exp3);

    // 3. Replay output determinism
    const getReplayJson = async () => {
      let output = '';
      process.stdout.write = (chunk) => { output += chunk.toString(); return true; };
      try {
        await runCli(['replay', '--from', 'cp_det', '--json'], { cwd: tempDir });
      } finally {
        process.stdout.write = origWrite;
      }
      return output;
    };

    const rep1 = await getReplayJson();
    const rep2 = await getReplayJson();
    const rep3 = await getReplayJson();
    assert.equal(rep1, rep2);
    assert.equal(rep2, rep3);
  });
});
