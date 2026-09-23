import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { runCli } from '../../src/cli.js';
import { ExitCode } from '../../src/core/errors.js';
import { StorageManager } from '../../src/core/storage.js';

describe('CLI: agent-ledger branch', () => {
  let tempDir;
  const runId = 'test_branch_cli';

  beforeEach(async () => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-ledger-branch-cli-test-'));
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

  it('forks a new branch from an existing checkpoint (exit 0)', async () => {
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

    const code = await runCli(['branch', '--from', 'cp_root', '--name', 'speculative_01'], { cwd: tempDir });
    assert.equal(code, ExitCode.SUCCESS);

    const branchPath = path.join(tempDir, '.agent-ledger', 'branches', 'speculative_01.json');
    assert.ok(fs.existsSync(branchPath));

    const branchMeta = JSON.parse(fs.readFileSync(branchPath, 'utf8'));
    assert.equal(branchMeta.branch_name, 'speculative_01');
    assert.equal(branchMeta.origin_checkpoint_id, 'cp_root');
    assert.equal(branchMeta.fork_seq_num, 1);
    assert.equal(branchMeta.fork_event_id, 'e1');

    // Verify active branch in config
    const storage = new StorageManager(tempDir);
    const config = storage.readConfig();
    assert.equal(config.active_branch, 'speculative_01');
  });

  it('rejects branch from non-existent checkpoint with ExitCode.CONFLICT (exit 6)', async () => {
    const code = await runCli(['branch', '--from', 'cp_nonexistent', '--name', 'feat_bad'], { cwd: tempDir });
    assert.equal(code, ExitCode.CONFLICT);
  });

  it('rejects duplicate branch name with ExitCode.CONFLICT (exit 6)', async () => {
    const e1 = createEventFile('e1.json', {
      event_id: 'e1',
      seq_num: 1,
      run_id: runId,
      branch: 'main',
      type: 'run_started',
      payload: {},
    });
    await runCli(['append', e1], { cwd: tempDir });
    await runCli(['checkpoint', '--id', 'cp_dup_test'], { cwd: tempDir });

    const code1 = await runCli(['branch', '--from', 'cp_dup_test', '--name', 'branch_duplicate'], { cwd: tempDir });
    assert.equal(code1, ExitCode.SUCCESS);

    const code2 = await runCli(['branch', '--from', 'cp_dup_test', '--name', 'branch_duplicate'], { cwd: tempDir });
    assert.equal(code2, ExitCode.CONFLICT);
  });

  it('maintains strict branch isolation and parent history immutability', async () => {
    // 1. Setup parent history on main
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
      payload: { steps: ['init'] },
    });
    await runCli(['append', e1], { cwd: tempDir });
    await runCli(['append', e2], { cwd: tempDir });

    // 2. Take checkpoint on main at seq 2
    await runCli(['checkpoint', '--id', 'cp_fork_point'], { cwd: tempDir });

    // Capture exact byte content of events.ndjson
    const eventsFile = path.join(tempDir, '.agent-ledger', 'events.ndjson');
    const parentLogBefore = fs.readFileSync(eventsFile, 'utf8');

    // 3. Fork branch feature_branch
    await runCli(['branch', '--from', 'cp_fork_point', '--name', 'feature_branch'], { cwd: tempDir });

    // 4. Append event on feature_branch (must start at seq_num 3)
    const e3_branch = createEventFile('e3_branch.json', {
      event_id: 'e3_br',
      seq_num: 3,
      run_id: runId,
      branch: 'feature_branch',
      type: 'file_changed',
      payload: { file: 'feature.js', hash: 'feat123' },
    });
    const appendCode = await runCli(['append', e3_branch], { cwd: tempDir });
    assert.equal(appendCode, ExitCode.SUCCESS);

    // Verify parent history prefix remains byte-for-byte identical
    const fullLogAfter = fs.readFileSync(eventsFile, 'utf8');
    assert.ok(fullLogAfter.startsWith(parentLogBefore), 'Parent events prefix must be unmodified');

    const lines = fullLogAfter.trim().split('\n');
    assert.equal(lines.length, 3);
    const rec3 = JSON.parse(lines[2]);
    assert.equal(rec3.branch, 'feature_branch');
    assert.equal(rec3.seq_num, 3);

    // 5. Switch back to main and append event on main (seq_num 3 on main)
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
    const mainAppendCode = await runCli(['append', e3_main], { cwd: tempDir });
    assert.equal(mainAppendCode, ExitCode.SUCCESS);

    // 6. Switch back to feature_branch and append seq 4
    cfg.active_branch = 'feature_branch';
    storage.writeConfig(cfg);

    const e4_branch = createEventFile('e4_branch.json', {
      event_id: 'e4_br',
      seq_num: 4,
      run_id: runId,
      branch: 'feature_branch',
      type: 'run_completed',
      payload: {},
    });
    const branchAppend4Code = await runCli(['append', e4_branch], { cwd: tempDir });
    assert.equal(branchAppend4Code, ExitCode.SUCCESS);

    // Verify all 5 records persisted cleanly without hash drift
    const finalLines = fs.readFileSync(eventsFile, 'utf8').trim().split('\n');
    assert.equal(finalLines.length, 5);
  });

  it('proves branch test_finished event is observed on branch checkpoint and leaves parent unaffected', async () => {
    // 1. Checkpoint at sequence S on main
    const e1 = createEventFile('e1_parent.json', {
      event_id: 'e1_parent',
      seq_num: 1,
      run_id: runId,
      branch: 'main',
      type: 'run_started',
      payload: {},
    });
    const e2 = createEventFile('e2_parent.json', {
      event_id: 'e2_parent',
      seq_num: 2,
      run_id: runId,
      branch: 'main',
      type: 'plan_created',
      payload: { steps: ['step1'] },
    });
    await runCli(['append', e1], { cwd: tempDir });
    await runCli(['append', e2], { cwd: tempDir });

    const cpCode = await runCli(['checkpoint', '--id', 'cp_parent_s'], { cwd: tempDir });
    assert.equal(cpCode, ExitCode.SUCCESS);

    // 2. Branch from checkpoint cp_parent_s
    const brCode = await runCli(['branch', '--from', 'cp_parent_s', '--name', 'test_branch'], { cwd: tempDir });
    assert.equal(brCode, ExitCode.SUCCESS);

    // 3. Append test_started and test_finished on test_branch
    const e3 = createEventFile('e3_branch_test.json', {
      event_id: 'e3_br_test',
      seq_num: 3,
      run_id: runId,
      branch: 'test_branch',
      type: 'test_started',
      payload: {},
    });
    const e4 = createEventFile('e4_branch_test.json', {
      event_id: 'e4_br_test',
      seq_num: 4,
      run_id: runId,
      branch: 'test_branch',
      type: 'test_finished',
      payload: { passed: 8, failed: 1 },
    });
    await runCli(['append', e3], { cwd: tempDir });
    await runCli(['append', e4], { cwd: tempDir });

    // 4. Create checkpoint on test_branch
    const cpBranchCode = await runCli(['checkpoint', '--id', 'cp_branch_tests'], { cwd: tempDir });
    assert.equal(cpBranchCode, ExitCode.SUCCESS);

    const branchCpPath = path.join(tempDir, '.agent-ledger', 'checkpoints', 'cp_branch_tests.json');
    const branchManifest = JSON.parse(fs.readFileSync(branchCpPath, 'utf8'));

    assert.equal(branchManifest.branch, 'test_branch');
    assert.equal(branchManifest.seq_num, 4);
    assert.equal(branchManifest.state_snapshot.agent_phase, 'TESTS_FINISHED');
    assert.equal(branchManifest.state_snapshot.test_summary.passed, 8);
    assert.equal(branchManifest.state_snapshot.test_summary.failed, 1);

    // 5. Verify parent state remains unaffected
    const parentCpPath = path.join(tempDir, '.agent-ledger', 'checkpoints', 'cp_parent_s.json');
    const parentManifest = JSON.parse(fs.readFileSync(parentCpPath, 'utf8'));

    assert.equal(parentManifest.branch, 'main');
    assert.equal(parentManifest.seq_num, 2);
    assert.equal(parentManifest.state_snapshot.test_summary.passed, 0);
    assert.equal(parentManifest.state_snapshot.test_summary.failed, 0);

    // Switch back to main and create another checkpoint on main to verify live reconstruction
    const storage = new StorageManager(tempDir);
    const cfg = storage.readConfig();
    cfg.active_branch = 'main';
    storage.writeConfig(cfg);

    const cpMainAfterCode = await runCli(['checkpoint', '--id', 'cp_main_after'], { cwd: tempDir });
    assert.equal(cpMainAfterCode, ExitCode.SUCCESS);

    const mainAfterCpPath = path.join(tempDir, '.agent-ledger', 'checkpoints', 'cp_main_after.json');
    const mainAfterManifest = JSON.parse(fs.readFileSync(mainAfterCpPath, 'utf8'));
    assert.equal(mainAfterManifest.branch, 'main');
    assert.equal(mainAfterManifest.seq_num, 2);
    assert.equal(mainAfterManifest.state_snapshot.test_summary.passed, 0);
    assert.equal(mainAfterManifest.state_snapshot.test_summary.failed, 0);
  });
});
