import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { runCli } from '../../src/cli.js';
import { ExitCode } from '../../src/core/errors.js';
import { GENESIS_HASH } from '../../src/core/crypto.js';

describe('CLI: agent-ledger append', () => {
  let tempDir;
  let runId = 'test_run_alpha';

  beforeEach(async () => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-ledger-append-test-'));
    // Initialize repository
    const initCode = await runCli(['init', runId], { cwd: tempDir });
    assert.equal(initCode, ExitCode.SUCCESS);
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

  it('successfully appends the first event with seq_num 1 (exit 0)', async () => {
    const eventFile = createEventFile('evt1.json', {
      event_id: 'evt_001',
      seq_num: 1,
      run_id: runId,
      branch: 'main',
      type: 'run_started',
      payload: { goal: 'test' },
    });

    const code = await runCli(['append', eventFile], { cwd: tempDir });
    assert.equal(code, ExitCode.SUCCESS);

    const eventsNdjson = path.join(tempDir, '.agent-ledger', 'events.ndjson');
    const content = fs.readFileSync(eventsNdjson, 'utf8');
    const lines = content.trim().split('\n');
    assert.equal(lines.length, 1);

    const record = JSON.parse(lines[0]);
    assert.equal(record.event_id, 'evt_001');
    assert.equal(record.seq_num, 1);
    assert.equal(record.prev_hash, GENESIS_HASH);
  });

  it('rejects first event with seq_num 0 with ExitCode.VALIDATION_ERROR (exit 2)', async () => {
    const eventFile = createEventFile('evt_seq0.json', {
      event_id: 'evt_000',
      seq_num: 0,
      run_id: runId,
      branch: 'main',
      type: 'run_started',
      payload: {},
    });

    const code = await runCli(['append', eventFile], { cwd: tempDir });
    assert.equal(code, ExitCode.VALIDATION_ERROR);
  });

  it('rejects sequence gaps with ExitCode.VALIDATION_ERROR (exit 2)', async () => {
    // 1. Append seq 1
    const evt1 = createEventFile('evt1.json', {
      event_id: 'evt_001',
      seq_num: 1,
      run_id: runId,
      branch: 'main',
      type: 'run_started',
      payload: {},
    });
    assert.equal(await runCli(['append', evt1], { cwd: tempDir }), ExitCode.SUCCESS);

    // 2. Attempt seq 3 (gap)
    const evt3 = createEventFile('evt3.json', {
      event_id: 'evt_003',
      seq_num: 3,
      run_id: runId,
      branch: 'main',
      type: 'plan_created',
      payload: {},
    });
    assert.equal(await runCli(['append', evt3], { cwd: tempDir }), ExitCode.VALIDATION_ERROR);
  });

  it('rejects duplicate event_id with ExitCode.VALIDATION_ERROR (exit 2)', async () => {
    // 1. Append evt_001
    const evt1 = createEventFile('evt1.json', {
      event_id: 'evt_001',
      seq_num: 1,
      run_id: runId,
      branch: 'main',
      type: 'run_started',
      payload: {},
    });
    assert.equal(await runCli(['append', evt1], { cwd: tempDir }), ExitCode.SUCCESS);

    // 2. Attempt duplicate evt_001 with seq 2
    const evtDuplicate = createEventFile('evt_dup.json', {
      event_id: 'evt_001',
      seq_num: 2,
      run_id: runId,
      branch: 'main',
      type: 'plan_created',
      payload: {},
    });
    assert.equal(await runCli(['append', evtDuplicate], { cwd: tempDir }), ExitCode.VALIDATION_ERROR);
  });

  it('chains cryptographic hashes across multiple sequential events', async () => {
    const evt1 = createEventFile('evt1.json', {
      event_id: 'evt_001',
      seq_num: 1,
      run_id: runId,
      branch: 'main',
      type: 'run_started',
      payload: {},
    });
    const evt2 = createEventFile('evt2.json', {
      event_id: 'evt_002',
      seq_num: 2,
      run_id: runId,
      branch: 'main',
      type: 'plan_created',
      payload: { steps: ['build', 'test'] },
    });

    assert.equal(await runCli(['append', evt1], { cwd: tempDir }), ExitCode.SUCCESS);
    assert.equal(await runCli(['append', evt2], { cwd: tempDir }), ExitCode.SUCCESS);

    const eventsNdjson = path.join(tempDir, '.agent-ledger', 'events.ndjson');
    const lines = fs.readFileSync(eventsNdjson, 'utf8').trim().split('\n');
    assert.equal(lines.length, 2);

    const rec1 = JSON.parse(lines[0]);
    const rec2 = JSON.parse(lines[1]);

    assert.equal(rec1.prev_hash, GENESIS_HASH);
    assert.notEqual(rec2.prev_hash, GENESIS_HASH);
    assert.equal(typeof rec2.prev_hash, 'string');
    assert.equal(rec2.prev_hash.length, 64);
  });

  it('detects historical tampering and rejects subsequent appends with ExitCode.TAMPER_DETECTED (exit 5)', async () => {
    const evt1 = createEventFile('evt1.json', {
      event_id: 'evt_001',
      seq_num: 1,
      run_id: runId,
      branch: 'main',
      type: 'run_started',
      payload: {},
    });
    const evt2 = createEventFile('evt2.json', {
      event_id: 'evt_002',
      seq_num: 2,
      run_id: runId,
      branch: 'main',
      type: 'plan_created',
      payload: {},
    });

    assert.equal(await runCli(['append', evt1], { cwd: tempDir }), ExitCode.SUCCESS);
    assert.equal(await runCli(['append', evt2], { cwd: tempDir }), ExitCode.SUCCESS);

    // Tamper with historical event 1 in events.ndjson
    const eventsNdjson = path.join(tempDir, '.agent-ledger', 'events.ndjson');
    const raw = fs.readFileSync(eventsNdjson, 'utf8');
    const tampered = raw.replace('"type":"run_started"', '"type":"file_changed"');
    fs.writeFileSync(eventsNdjson, tampered);

    // Attempt append of evt3 on tampered log
    const evt3 = createEventFile('evt3.json', {
      event_id: 'evt_003',
      seq_num: 3,
      run_id: runId,
      branch: 'main',
      type: 'tool_requested',
      payload: { tool_request_id: 'req_1', tool_name: 'shell' },
    });

    const code = await runCli(['append', evt3], { cwd: tempDir });
    assert.equal(code, ExitCode.TAMPER_DETECTED);

    // Verify tampered file was not altered by the failed append
    assert.equal(fs.readFileSync(eventsNdjson, 'utf8'), tampered);
  });

  it('detects corrupted prev_hash on genesis event (exit 5)', async () => {
    const evt1 = createEventFile('evt1.json', {
      event_id: 'evt_001',
      seq_num: 1,
      run_id: runId,
      branch: 'main',
      type: 'run_started',
      payload: {},
    });
    assert.equal(await runCli(['append', evt1], { cwd: tempDir }), ExitCode.SUCCESS);

    // Corrupt genesis prev_hash
    const eventsNdjson = path.join(tempDir, '.agent-ledger', 'events.ndjson');
    const raw = fs.readFileSync(eventsNdjson, 'utf8');
    const corrupted = raw.replace(GENESIS_HASH, 'ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff');
    fs.writeFileSync(eventsNdjson, corrupted);

    const evt2 = createEventFile('evt2.json', {
      event_id: 'evt_002',
      seq_num: 2,
      run_id: runId,
      branch: 'main',
      type: 'plan_created',
      payload: {},
    });

    const code = await runCli(['append', evt2], { cwd: tempDir });
    assert.equal(code, ExitCode.TAMPER_DETECTED);
  });

  it('enforces full tool causal lifecycle and run completion seal', async () => {
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
      payload: { tool_request_id: 'tool_cmd_1', tool_name: 'shell' },
    });
    const e3 = createEventFile('e3.json', {
      event_id: 'e3',
      seq_num: 3,
      run_id: runId,
      branch: 'main',
      type: 'tool_result_received',
      payload: { tool_request_id: 'tool_cmd_1', stdout: 'success' },
    });
    const e4 = createEventFile('e4.json', {
      event_id: 'e4',
      seq_num: 4,
      run_id: runId,
      branch: 'main',
      type: 'run_completed',
      payload: {},
    });
    const e5 = createEventFile('e5.json', {
      event_id: 'e5',
      seq_num: 5,
      run_id: runId,
      branch: 'main',
      type: 'plan_created',
      payload: {},
    });

    assert.equal(await runCli(['append', e1], { cwd: tempDir }), ExitCode.SUCCESS);
    assert.equal(await runCli(['append', e2], { cwd: tempDir }), ExitCode.SUCCESS);
    assert.equal(await runCli(['append', e3], { cwd: tempDir }), ExitCode.SUCCESS);
    assert.equal(await runCli(['append', e4], { cwd: tempDir }), ExitCode.SUCCESS);

    // Attempting e5 after completion must return ExitCode.STATE_BLOCKED (exit 4)
    assert.equal(await runCli(['append', e5], { cwd: tempDir }), ExitCode.STATE_BLOCKED);
  });
});
