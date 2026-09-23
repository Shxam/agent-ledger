import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { BranchManager } from '../../src/core/branch.js';
import { StorageManager } from '../../src/core/storage.js';
import { ExitCode, LedgerError } from '../../src/core/errors.js';

describe('Branch Manager', () => {
  let tempDir;
  let storage;
  let branchManager;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-ledger-branch-unit-test-'));
    storage = new StorageManager(tempDir);
    storage.initLedger('run_branch_test');
    branchManager = new BranchManager(storage);
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

  it('creates branch and updates active_branch in config.json', () => {
    const checkpointManifest = {
      checkpoint_id: 'cp_10',
      run_id: 'run_branch_test',
      branch: 'main',
      seq_num: 10,
      last_event_id: 'evt_10',
    };

    const branchMeta = branchManager.createBranch(
      'experiment_x',
      'cp_10',
      checkpointManifest,
      'hash_at_cp_10'
    );

    assert.equal(branchMeta.branch_name, 'experiment_x');
    assert.equal(branchMeta.origin_checkpoint_id, 'cp_10');
    assert.equal(branchMeta.fork_seq_num, 10);
    assert.equal(branchMeta.fork_event_id, 'evt_10');
    assert.equal(branchMeta.fork_hash, 'hash_at_cp_10');
    assert.equal(branchMeta.head_seq_num, 10);

    // Verify active_branch is updated in config
    const updatedConfig = storage.readConfig();
    assert.equal(updatedConfig.active_branch, 'experiment_x');

    // Verify branch can be read back
    const readBack = branchManager.readBranch('experiment_x');
    assert.deepEqual(readBack, branchMeta);
  });

  it('rejects duplicate branch creation with ExitCode.CONFLICT (exit 6)', () => {
    const checkpointManifest = {
      checkpoint_id: 'cp_1',
      run_id: 'run_branch_test',
      branch: 'main',
      seq_num: 1,
      last_event_id: 'evt_1',
    };

    branchManager.createBranch('branch_dup', 'cp_1', checkpointManifest, 'h1');

    assert.throws(
      () => branchManager.createBranch('branch_dup', 'cp_1', checkpointManifest, 'h1'),
      (err) => err instanceof LedgerError && err.exitCode === ExitCode.CONFLICT
    );
  });

  it('rejects creating branch named "main" with ExitCode.CONFLICT (exit 6)', () => {
    const checkpointManifest = {
      checkpoint_id: 'cp_1',
      run_id: 'run_branch_test',
      branch: 'main',
      seq_num: 1,
      last_event_id: 'evt_1',
    };

    assert.throws(
      () => branchManager.createBranch('main', 'cp_1', checkpointManifest, 'h1'),
      (err) => err instanceof LedgerError && err.exitCode === ExitCode.CONFLICT
    );
  });
});
