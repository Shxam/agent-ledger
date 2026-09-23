import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { runCli } from '../../src/cli.js';
import { ExitCode } from '../../src/core/errors.js';
import { StorageManager } from '../../src/core/storage.js';

describe('CLI: agent-ledger init', () => {
  let tempDir;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-ledger-init-test-'));
  });

  afterEach(() => {
    if (fs.existsSync(tempDir)) {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it('initializes a fresh workspace with custom run_id, returning exit code 0', async () => {
    const code = await runCli(['init', 'run_agent_007'], { cwd: tempDir });
    assert.equal(code, ExitCode.SUCCESS);

    const storage = new StorageManager(tempDir);
    assert.ok(storage.isInitialized());
    assert.ok(fs.existsSync(storage.rootDir));
    assert.ok(fs.existsSync(storage.checkpointsDir));
    assert.ok(fs.existsSync(storage.branchesDir));
    assert.ok(fs.existsSync(storage.registersDir));
    assert.ok(fs.existsSync(storage.locksDir));
    assert.ok(fs.existsSync(storage.eventsFile));
    assert.ok(fs.existsSync(storage.configFile));

    // Verify events.ndjson is empty
    const eventsStat = fs.statSync(storage.eventsFile);
    assert.equal(eventsStat.size, 0);

    // Verify config.json content
    const config = storage.readConfig();
    assert.equal(config.run_id, 'run_agent_007');
    assert.equal(config.active_branch, 'main');
    assert.equal(config.version, '1.0.0');
  });

  it('uses frozen default "run_default" when run_id is omitted', async () => {
    const code = await runCli(['init'], { cwd: tempDir });
    assert.equal(code, ExitCode.SUCCESS);

    const storage = new StorageManager(tempDir);
    const config = storage.readConfig();
    assert.equal(config.run_id, 'run_default');
    assert.equal(config.active_branch, 'main');
  });

  it('returns exit code 1 when workspace is already initialized', async () => {
    const codeFirst = await runCli(['init', 'run_first'], { cwd: tempDir });
    assert.equal(codeFirst, ExitCode.SUCCESS);

    // Attempt second init in same workspace
    const codeSecond = await runCli(['init', 'run_second'], { cwd: tempDir });
    assert.equal(codeSecond, ExitCode.USAGE_OR_NOT_FOUND);

    // Verify config was not overwritten
    const storage = new StorageManager(tempDir);
    const config = storage.readConfig();
    assert.equal(config.run_id, 'run_first');
  });
});
