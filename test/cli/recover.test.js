import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { runCli } from '../../src/cli.js';
import { ExitCode } from '../../src/core/errors.js';
import { StorageManager } from '../../src/core/storage.js';
import { LockArbiter } from '../../src/core/lock.js';

describe('CLI: agent-ledger recover', () => {
  let tempDir;
  const runId = 'test_recover_cli';

  beforeEach(async () => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-ledger-recover-cli-'));
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

  it('performs clean recovery when no damage exists (exit 0)', async () => {
    const e1 = createEventFile('e1.json', {
      event_id: 'e1',
      seq_num: 1,
      run_id: runId,
      branch: 'main',
      type: 'run_started',
      payload: {},
    });
    await runCli(['append', e1], { cwd: tempDir });

    const code = await runCli(['recover'], { cwd: tempDir });
    assert.equal(code, ExitCode.SUCCESS);
  });

  it('recovers from torn trailing JSON by truncating trailing bytes (exit 0)', async () => {
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
    await runCli(['append', e1], { cwd: tempDir });
    await runCli(['append', e2], { cwd: tempDir });

    // Append torn JSON tail
    const eventsFile = path.join(tempDir, '.agent-ledger', 'events.ndjson');
    const validContent = fs.readFileSync(eventsFile, 'utf8');
    fs.appendFileSync(eventsFile, '{"event_id":"torn_tail_incomplete"');

    const code = await runCli(['recover'], { cwd: tempDir });
    assert.equal(code, ExitCode.SUCCESS);

    // Verify torn bytes were truncated and valid records preserved
    const recoveredContent = fs.readFileSync(eventsFile, 'utf8');
    assert.equal(recoveredContent, validContent);

    // Replay should work cleanly
    await runCli(['checkpoint', '--id', 'cp_after_recover'], { cwd: tempDir });
    const replayCode = await runCli(['replay', '--from', 'cp_after_recover'], { cwd: tempDir });
    assert.equal(replayCode, ExitCode.SUCCESS);
  });

  it('recovers from missing final newline on trailing record (exit 0)', async () => {
    const e1 = createEventFile('e1.json', {
      event_id: 'e1',
      seq_num: 1,
      run_id: runId,
      branch: 'main',
      type: 'run_started',
      payload: {},
    });
    await runCli(['append', e1], { cwd: tempDir });

    // Append record missing final newline '\n'
    const eventsFile = path.join(tempDir, '.agent-ledger', 'events.ndjson');
    const validContent = fs.readFileSync(eventsFile, 'utf8');
    fs.appendFileSync(eventsFile, '{"event_id":"e2","seq_num":2,"run_id":"test_recover_cli","branch":"main","type":"run_completed","prev_hash":"abc","payload":{}}');

    const code = await runCli(['recover'], { cwd: tempDir });
    assert.equal(code, ExitCode.SUCCESS);

    const recoveredContent = fs.readFileSync(eventsFile, 'utf8');
    assert.equal(recoveredContent, validContent);
  });

  it('fails with ExitCode.UNRECOVERABLE_CORRUPTION (exit 7) on historical corruption', async () => {
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
      payload: { steps: ['p1'] },
    });
    const e3 = createEventFile('e3.json', {
      event_id: 'e3',
      seq_num: 3,
      run_id: runId,
      branch: 'main',
      type: 'file_changed',
      payload: { file: 'a.txt', hash: 'h1' },
    });
    await runCli(['append', e1], { cwd: tempDir });
    await runCli(['append', e2], { cwd: tempDir });
    await runCli(['append', e3], { cwd: tempDir });

    // Tamper with intermediate event e2
    const eventsFile = path.join(tempDir, '.agent-ledger', 'events.ndjson');
    const content = fs.readFileSync(eventsFile, 'utf8');
    const lines = content.trim().split('\n');
    lines[1] = '{"corrupt_event": true}\n';
    fs.writeFileSync(eventsFile, lines.join('\n') + '\n');

    const code = await runCli(['recover'], { cwd: tempDir });
    assert.equal(code, ExitCode.UNRECOVERABLE_CORRUPTION);
  });

  it('recovers cleanly when child branch tail is torn and reconciles branch head', async () => {
    const e1 = createEventFile('e1.json', {
      event_id: 'e1',
      seq_num: 1,
      run_id: runId,
      branch: 'main',
      type: 'run_started',
      payload: {},
    });
    await runCli(['append', e1], { cwd: tempDir });
    await runCli(['checkpoint', '--id', 'cp_root'], { cwd: tempDir });

    // Branch feature_br
    await runCli(['branch', '--from', 'cp_root', '--name', 'feature_br'], { cwd: tempDir });

    const e2_br = createEventFile('e2_br.json', {
      event_id: 'e2_br',
      seq_num: 2,
      run_id: runId,
      branch: 'feature_br',
      type: 'file_changed',
      payload: { file: 'feat.js', hash: 'f1' },
    });
    await runCli(['append', e2_br], { cwd: tempDir });

    // Append torn tail on child branch
    const eventsFile = path.join(tempDir, '.agent-ledger', 'events.ndjson');
    fs.appendFileSync(eventsFile, '{"event_id":"torn_child"');

    const code = await runCli(['recover'], { cwd: tempDir });
    assert.equal(code, ExitCode.SUCCESS);

    // Verify branch head is consistent
    const branchFile = path.join(tempDir, '.agent-ledger', 'branches', 'feature_br.json');
    const branchMeta = JSON.parse(fs.readFileSync(branchFile, 'utf8'));
    assert.equal(branchMeta.head_seq_num, 2);
    assert.equal(branchMeta.head_event_id, 'e2_br');
  });

  it('preserves completed run state after torn tail recovery', async () => {
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
      type: 'run_completed',
      payload: {},
    });
    await runCli(['append', e1], { cwd: tempDir });
    await runCli(['append', e2], { cwd: tempDir });

    // Append torn tail after run_completed
    const eventsFile = path.join(tempDir, '.agent-ledger', 'events.ndjson');
    fs.appendFileSync(eventsFile, '{"event_id":"torn_post_complete"');

    const code = await runCli(['recover'], { cwd: tempDir });
    assert.equal(code, ExitCode.SUCCESS);

    // Further appends should still be blocked with exit 4 (run sealed)
    const e3 = createEventFile('e3.json', {
      event_id: 'e3',
      seq_num: 3,
      run_id: runId,
      branch: 'main',
      type: 'file_changed',
      payload: { file: 'blocked.js', hash: 'b1' },
    });
    const appendCode = await runCli(['append', e3], { cwd: tempDir });
    assert.equal(appendCode, ExitCode.STATE_BLOCKED);
  });

  it('blocks recovery with ExitCode.LOCK_CONTENTION (exit 3) when POSIX lock is actively held', async () => {
    const lockPath = path.join(tempDir, '.agent-ledger', 'locks', 'ledger.lock');
    const arbiter = new LockArbiter(lockPath);
    await arbiter.acquire('holding_lock');

    try {
      const code = await runCli(['recover'], { cwd: tempDir });
      assert.equal(code, ExitCode.LOCK_CONTENTION);
    } finally {
      arbiter.release();
    }
  });

  it('proves recovery idempotence on repeated invocations', async () => {
    const e1 = createEventFile('e1.json', {
      event_id: 'e1',
      seq_num: 1,
      run_id: runId,
      branch: 'main',
      type: 'run_started',
      payload: {},
    });
    await runCli(['append', e1], { cwd: tempDir });

    const eventsFile = path.join(tempDir, '.agent-ledger', 'events.ndjson');
    fs.appendFileSync(eventsFile, '{"torn_test": true');

    const code1 = await runCli(['recover'], { cwd: tempDir });
    assert.equal(code1, ExitCode.SUCCESS);

    const content1 = fs.readFileSync(eventsFile, 'utf8');

    const code2 = await runCli(['recover'], { cwd: tempDir });
    assert.equal(code2, ExitCode.SUCCESS);

    const content2 = fs.readFileSync(eventsFile, 'utf8');
    assert.equal(content1, content2);
  });
});
