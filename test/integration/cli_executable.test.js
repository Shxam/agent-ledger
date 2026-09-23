import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawnSync } from 'node:child_process';
import { ExitCode } from '../../src/core/errors.js';
import { LockArbiter } from '../../src/core/lock.js';

describe('Integration: CLI Executable Contract Audit', () => {
  let tempDir;
  const projectRoot = path.resolve('.');
  const binPath = path.join(projectRoot, 'bin', 'agent-ledger');

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-ledger-int-bin-'));
  });

  afterEach(() => {
    if (fs.existsSync(tempDir)) {
      try {
        fs.rmSync(tempDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
      } catch {}
    }
  });

  function runExecutable(args, options = {}) {
    return spawnSync(process.execPath, [binPath, ...args], {
      cwd: tempDir,
      encoding: 'utf8',
      ...options,
    });
  }

  function createEventFile(filename, data) {
    const filePath = path.join(tempDir, filename);
    fs.writeFileSync(filePath, JSON.stringify(data));
    return filePath;
  }

  // --- Exit Code 0: SUCCESS ---
  it('verifies ExitCode.SUCCESS (0) on happy path execution', () => {
    // 1. init
    const resInit = runExecutable(['init', 'bin_run']);
    assert.equal(resInit.status, ExitCode.SUCCESS);
    assert.ok(resInit.stdout.includes("Initialized empty agent-ledger repository for run 'bin_run'"));

    // 2. append
    const evt1 = createEventFile('e1.json', {
      event_id: 'e1',
      seq_num: 1,
      run_id: 'bin_run',
      branch: 'main',
      type: 'run_started',
      payload: {},
    });
    const resAppend = runExecutable(['append', evt1]);
    assert.equal(resAppend.status, ExitCode.SUCCESS);
    assert.ok(resAppend.stdout.includes("Appended event 'e1'"));

    // 3. checkpoint
    const resCp = runExecutable(['checkpoint', '--id', 'cp_bin']);
    assert.equal(resCp.status, ExitCode.SUCCESS);
    assert.ok(resCp.stdout.includes("Created checkpoint 'cp_bin'"));

    // 4. branch
    const resBranch = runExecutable(['branch', '--from', 'cp_bin', '--name', 'feature_bin']);
    assert.equal(resBranch.status, ExitCode.SUCCESS);

    // 5. registers
    const binFile = path.join(tempDir, 'sample.bin');
    fs.writeFileSync(binFile, Buffer.from([0x01, 0x02, 0x03, 0xff]));
    const resPut = runExecutable(['register-put', '--reg', 'x', binFile]);
    assert.equal(resPut.status, ExitCode.SUCCESS);

    const resGet = runExecutable(['register-get', '--reg', 'x'], { encoding: 'buffer' });
    assert.equal(resGet.status, ExitCode.SUCCESS);
    assert.equal(Buffer.compare(resGet.stdout, Buffer.from([0x01, 0x02, 0x03, 0xff])), 0);

    // 6. status
    const resStatus = runExecutable(['status']);
    assert.equal(resStatus.status, ExitCode.SUCCESS);
    assert.ok(resStatus.stdout.includes('Run ID: bin_run'));

    // 7. export
    const resExport = runExecutable(['export', '--format', 'json']);
    assert.equal(resExport.status, ExitCode.SUCCESS);
    const parsed = JSON.parse(resExport.stdout.trim());
    assert.equal(parsed.run_id, 'bin_run');
    assert.equal(parsed.checkpoints.length, 1);
  });

  // --- Exit Code 1: USAGE_OR_NOT_FOUND ---
  it('verifies ExitCode.USAGE_OR_NOT_FOUND (1) for invalid usage and missing entities', () => {
    // No args
    const resNoArgs = runExecutable([]);
    assert.equal(resNoArgs.status, ExitCode.USAGE_OR_NOT_FOUND);
    assert.ok(resNoArgs.stderr.includes('Usage: agent-ledger'));

    // Unknown command
    const resUnknown = runExecutable(['nonexistent-command']);
    assert.equal(resUnknown.status, ExitCode.USAGE_OR_NOT_FOUND);
    assert.ok(resUnknown.stderr.includes("Error: Unknown command 'nonexistent-command'"));

    // Uninitialized repository operations
    const resUninit = runExecutable(['status']);
    assert.equal(resUninit.status, ExitCode.USAGE_OR_NOT_FOUND);

    // Initialize to test missing target entities
    runExecutable(['init', 'run_usage']);

    // Checkpoint missing --id
    const resCpNoId = runExecutable(['checkpoint']);
    assert.equal(resCpNoId.status, ExitCode.USAGE_OR_NOT_FOUND);

    // Replay nonexistent checkpoint
    const resReplayNotFound = runExecutable(['replay', '--from', 'cp_nonexistent']);
    assert.equal(resReplayNotFound.status, ExitCode.USAGE_OR_NOT_FOUND);

    // Register get nonexistent register
    const resRegNotFound = runExecutable(['register-get', '--reg', 'z']);
    assert.equal(resRegNotFound.status, ExitCode.USAGE_OR_NOT_FOUND);

    // Register put invalid register name
    const dummyFile = path.join(tempDir, 'dummy.txt');
    fs.writeFileSync(dummyFile, 'data');
    const resRegBadName = runExecutable(['register-put', '--reg', 'invalid_name', dummyFile]);
    assert.equal(resRegBadName.status, ExitCode.USAGE_OR_NOT_FOUND);
  });

  // --- Exit Code 2: VALIDATION_ERROR ---
  it('verifies ExitCode.VALIDATION_ERROR (2) for schema and sequence violations', () => {
    runExecutable(['init', 'run_val']);

    // 1. Schema violation: non-permitted event type
    const badTypeFile = createEventFile('bad_type.json', {
      event_id: 'e_bad',
      seq_num: 1,
      run_id: 'run_val',
      branch: 'main',
      type: 'invalid_type',
      payload: {},
    });
    const resBadType = runExecutable(['append', badTypeFile]);
    assert.equal(resBadType.status, ExitCode.VALIDATION_ERROR);
    assert.ok(resBadType.stderr.includes('is not a permitted event type'));

    // 2. Sequence gap: starting with sequence 2 instead of 1
    const gapFile = createEventFile('gap.json', {
      event_id: 'e_gap',
      seq_num: 2,
      run_id: 'run_val',
      branch: 'main',
      type: 'run_started',
      payload: {},
    });
    const resGap = runExecutable(['append', gapFile]);
    assert.equal(resGap.status, ExitCode.VALIDATION_ERROR);
    assert.ok(resGap.stderr.includes('Invalid sequence number 2 on branch \'main\''));

    // 3. Duplicate event ID
    const validFile = createEventFile('valid.json', {
      event_id: 'e_dup',
      seq_num: 1,
      run_id: 'run_val',
      branch: 'main',
      type: 'run_started',
      payload: {},
    });
    runExecutable(['append', validFile]);

    const dupFile = createEventFile('dup.json', {
      event_id: 'e_dup',
      seq_num: 2,
      run_id: 'run_val',
      branch: 'main',
      type: 'plan_created',
      payload: {},
    });
    const resDup = runExecutable(['append', dupFile]);
    assert.equal(resDup.status, ExitCode.VALIDATION_ERROR);
    assert.ok(resDup.stderr.includes("Duplicate event_id 'e_dup'"));
  });

  // --- Exit Code 3: LOCK_CONTENTION ---
  it('verifies ExitCode.LOCK_CONTENTION (3) under genuine OS-level POSIX advisory lock contention', async () => {
    runExecutable(['init', 'run_lock']);

    const lockFile = path.join(tempDir, '.agent-ledger', 'locks', 'ledger.lock');
    const arbiter = new LockArbiter(lockFile);

    // Process A acquires the genuine POSIX advisory lock
    await arbiter.acquire('test-lock-holder');

    try {
      // Process B executes append while lock is held by Process A
      const evtFile = createEventFile('e_lock.json', {
        event_id: 'e_lock',
        seq_num: 1,
        run_id: 'run_lock',
        branch: 'main',
        type: 'run_started',
        payload: {},
      });
      const resLocked = runExecutable(['append', evtFile]);
      assert.equal(resLocked.status, ExitCode.LOCK_CONTENTION);
      assert.ok(resLocked.stderr.includes('POSIX advisory lock contention'));
    } finally {
      // Release lock
      arbiter.release();
    }

    // After release, operations succeed immediately
    const evtFileAfter = createEventFile('e_lock2.json', {
      event_id: 'e_lock2',
      seq_num: 1,
      run_id: 'run_lock',
      branch: 'main',
      type: 'run_started',
      payload: {},
    });
    const resUnlocked = runExecutable(['append', evtFileAfter]);
    assert.equal(resUnlocked.status, ExitCode.SUCCESS);
  });

  // --- Exit Code 4: STATE_BLOCKED ---
  it('verifies ExitCode.STATE_BLOCKED (4) for in-flight tools and sealed run append', () => {
    runExecutable(['init', 'run_blocked']);

    // 1. In-flight tool call blocking checkpoint
    const e1 = createEventFile('e1.json', {
      event_id: 'e1',
      seq_num: 1,
      run_id: 'run_blocked',
      branch: 'main',
      type: 'run_started',
      payload: {},
    });
    const e2 = createEventFile('e2.json', {
      event_id: 'e2',
      seq_num: 2,
      run_id: 'run_blocked',
      branch: 'main',
      type: 'tool_requested',
      payload: { tool_request_id: 'tr_block', tool_name: 'bash' },
    });
    runExecutable(['append', e1]);
    runExecutable(['append', e2]);

    const resBlockedCp = runExecutable(['checkpoint', '--id', 'cp_fail']);
    assert.equal(resBlockedCp.status, ExitCode.STATE_BLOCKED);
    assert.ok(resBlockedCp.stderr.includes('Active in-flight tool call detected'));

    // 2. Resolve tool call, seal run with run_completed, then verify append blocked
    const e3 = createEventFile('e3.json', {
      event_id: 'e3',
      seq_num: 3,
      run_id: 'run_blocked',
      branch: 'main',
      type: 'tool_result_received',
      payload: { tool_request_id: 'tr_block', exit_code: 0 },
    });
    const e4 = createEventFile('e4.json', {
      event_id: 'e4',
      seq_num: 4,
      run_id: 'run_blocked',
      branch: 'main',
      type: 'run_completed',
      payload: {},
    });
    runExecutable(['append', e3]);
    runExecutable(['append', e4]);

    const e5 = createEventFile('e5.json', {
      event_id: 'e5',
      seq_num: 5,
      run_id: 'run_blocked',
      branch: 'main',
      type: 'file_changed',
      payload: { file: 'foo.js', hash: 'h' },
    });
    const resBlockedAppend = runExecutable(['append', e5]);
    assert.equal(resBlockedAppend.status, ExitCode.STATE_BLOCKED);
    assert.ok(resBlockedAppend.stderr.includes('Cannot append event after run_completed has been logged'));
  });

  // --- Exit Code 5: TAMPER_DETECTED ---
  it('verifies ExitCode.TAMPER_DETECTED (5) when cryptographic hash-chain drift is detected', () => {
    runExecutable(['init', 'run_tamper']);

    const e1 = createEventFile('e1.json', {
      event_id: 'e1',
      seq_num: 1,
      run_id: 'run_tamper',
      branch: 'main',
      type: 'run_started',
      payload: {},
    });
    const e2 = createEventFile('e2.json', {
      event_id: 'e2',
      seq_num: 2,
      run_id: 'run_tamper',
      branch: 'main',
      type: 'plan_created',
      payload: {},
    });
    runExecutable(['append', e1]);
    runExecutable(['append', e2]);

    // Mutate historical event 1 so event 2's prev_hash no longer matches event 1's hash
    const eventsFile = path.join(tempDir, '.agent-ledger', 'events.ndjson');
    const originalContent = fs.readFileSync(eventsFile, 'utf8');
    const tampered = originalContent.replace('"run_started"', '"file_changed"');
    fs.writeFileSync(eventsFile, tampered);

    // Status detects tamper
    const resStatus = runExecutable(['status']);
    assert.equal(resStatus.status, ExitCode.TAMPER_DETECTED);
    assert.ok(resStatus.stderr.includes('tamper') || resStatus.stderr.includes('drift'));

    // Export detects tamper
    const resExport = runExecutable(['export', '--format', 'json']);
    assert.equal(resExport.status, ExitCode.TAMPER_DETECTED);
    assert.ok(resExport.stderr.includes('tamper') || resExport.stderr.includes('drift'));
  });

  // --- Exit Code 6: CONFLICT ---
  it('verifies ExitCode.CONFLICT (6) for duplicate checkpoint ID and duplicate branch name', () => {
    runExecutable(['init', 'run_conflict']);

    const e1 = createEventFile('e1.json', {
      event_id: 'e1',
      seq_num: 1,
      run_id: 'run_conflict',
      branch: 'main',
      type: 'run_started',
      payload: {},
    });
    runExecutable(['append', e1]);

    // 1. Duplicate checkpoint ID
    const resCp1 = runExecutable(['checkpoint', '--id', 'cp_dup']);
    assert.equal(resCp1.status, ExitCode.SUCCESS);

    const resCpDup = runExecutable(['checkpoint', '--id', 'cp_dup']);
    assert.equal(resCpDup.status, ExitCode.CONFLICT);
    assert.ok(resCpDup.stderr.includes("Checkpoint 'cp_dup' already exists"));

    // 2. Duplicate branch name
    const resBr1 = runExecutable(['branch', '--from', 'cp_dup', '--name', 'dup_branch']);
    assert.equal(resBr1.status, ExitCode.SUCCESS);

    const resBrDup = runExecutable(['branch', '--from', 'cp_dup', '--name', 'dup_branch']);
    assert.equal(resBrDup.status, ExitCode.CONFLICT);
    assert.ok(resBrDup.stderr.includes("Branch 'dup_branch' already exists"));
  });

  // --- Exit Code 7: UNRECOVERABLE_CORRUPTION ---
  it('verifies ExitCode.UNRECOVERABLE_CORRUPTION (7) when historical records before tail are corrupted', () => {
    runExecutable(['init', 'run_corrupt']);

    const e1 = createEventFile('e1.json', {
      event_id: 'e1',
      seq_num: 1,
      run_id: 'run_corrupt',
      branch: 'main',
      type: 'run_started',
      payload: {},
    });
    const e2 = createEventFile('e2.json', {
      event_id: 'e2',
      seq_num: 2,
      run_id: 'run_corrupt',
      branch: 'main',
      type: 'plan_created',
      payload: { plan: 'step 1' },
    });
    runExecutable(['append', e1]);
    runExecutable(['append', e2]);

    // Corrupt the historical record (line 1), leaving line 2 intact
    const eventsFile = path.join(tempDir, '.agent-ledger', 'events.ndjson');
    const lines = fs.readFileSync(eventsFile, 'utf8').trim().split('\n');
    lines[0] = lines[0].replace('"run_started"', '"corrupted_type"');
    fs.writeFileSync(eventsFile, lines.join('\n') + '\n');

    // Run recover: unrecoverable historical corruption must return exit 7
    const resRecover = runExecutable(['recover']);
    assert.equal(resRecover.status, ExitCode.UNRECOVERABLE_CORRUPTION);
    assert.ok(resRecover.stderr.includes('Unrecoverable corruption'));
  });
});
