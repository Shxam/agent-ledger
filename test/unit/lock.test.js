import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { LockArbiter, withLock } from '../../src/core/lock.js';
import { ExitCode } from '../../src/core/errors.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const cliPath = path.resolve(__dirname, '../../src/cli.js');
const lockModulePath = path.resolve(__dirname, '../../src/core/lock.js');
const lockModuleUrl = pathToFileURL(lockModulePath).href;

describe('POSIX Advisory Locking (flock)', () => {
  let tempDir;
  let lockFile;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-ledger-flock-test-'));
    lockFile = path.join(tempDir, 'locks', 'ledger.lock');
  });

  afterEach(async () => {
    if (fs.existsSync(tempDir)) {
      try {
        fs.rmSync(tempDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
      } catch {
        // ignore cleanup error if file handle pending release
      }
    }
  });

  it('acquires and releases exclusive POSIX advisory lock and writes lease metadata', async () => {
    const arbiter = new LockArbiter(lockFile);
    await arbiter.acquire('test-cmd');

    assert.ok(fs.existsSync(lockFile));
    const lease = JSON.parse(fs.readFileSync(lockFile, 'utf8'));
    assert.equal(lease.pid, process.pid);
    assert.equal(lease.command, 'test-cmd');
    assert.ok(lease.acquired_at_ms > 0);
    assert.ok(lease.ttl_ms > 0);

    arbiter.release();
    assert.ok(fs.existsSync(lockFile), 'Lock target file remains persistent');
  });

  it('executes callback with withLock helper and auto-releases', async () => {
    let executed = false;
    await withLock(lockFile, 'test-with-lock', async () => {
      assert.ok(fs.existsSync(lockFile));
      executed = true;
    });

    assert.ok(executed);
  });

  it('blocks concurrent process from acquiring lock with exit code 3', async () => {
    // 1. Process A acquires advisory lock
    const arbiter = new LockArbiter(lockFile);
    await arbiter.acquire('process-a');

    // 2. Prepare workspace for CLI append in Process B
    const rootDir = path.join(tempDir, '.agent-ledger');
    fs.mkdirSync(path.join(rootDir, 'locks'), { recursive: true });
    fs.writeFileSync(
      path.join(rootDir, 'config.json'),
      JSON.stringify({ active_branch: 'main', run_id: 'test_run', version: '1.0.0' })
    );

    const wsLockFile = path.join(rootDir, 'locks', 'ledger.lock');
    // Acquire flock on the workspace lock file
    const wsArbiter = new LockArbiter(wsLockFile);
    await wsArbiter.acquire('holder');

    const eventFile = path.join(tempDir, 'event.json');
    fs.writeFileSync(
      eventFile,
      JSON.stringify({
        event_id: 'evt_child',
        seq_num: 1,
        run_id: 'test_run',
        branch: 'main',
        type: 'run_started',
        payload: {},
      })
    );

    // 3. Process B attempts to append while lock is held by Process A
    const child = spawnSync(
      process.execPath,
      [cliPath, 'append', eventFile],
      { cwd: tempDir, encoding: 'utf8' }
    );

    assert.equal(child.status, ExitCode.LOCK_CONTENTION);
    assert.ok(child.stderr.includes('lock contention'));

    // 4. Release lock
    wsArbiter.release();
    arbiter.release();

    // 5. Process B can now acquire lock and append
    const childAfter = spawnSync(
      process.execPath,
      [cliPath, 'append', eventFile],
      { cwd: tempDir, encoding: 'utf8' }
    );
    assert.equal(childAfter.status, ExitCode.SUCCESS);
  });

  it('allows new process to acquire advisory lock after lock holder is terminated with SIGKILL', async () => {
    // Write helper holder script to temp file
    const holderScriptPath = path.join(tempDir, 'holder.js');
    const scriptContent = `
      import { LockArbiter } from ${JSON.stringify(lockModuleUrl)};
      const arbiter = new LockArbiter(${JSON.stringify(lockFile)});
      await arbiter.acquire('kill-target');
      process.stdout.write('READY\\n');
      // Hold open indefinitely
      setInterval(() => {}, 10000);
    `;
    fs.writeFileSync(holderScriptPath, scriptContent);

    const holder = spawn(process.execPath, [holderScriptPath], {
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    await new Promise((resolve, reject) => {
      holder.stdout.on('data', (data) => {
        if (data.toString().includes('READY')) {
          resolve();
        }
      });
      holder.on('error', reject);
      holder.stderr.on('data', (d) => console.error(d.toString()));
    });

    // Verify lock contention while child is alive
    const contender1 = new LockArbiter(lockFile);
    let contentionCaught = false;
    try {
      await contender1.acquire('contender-1');
    } catch (err) {
      if (err.exitCode === ExitCode.LOCK_CONTENTION) {
        contentionCaught = true;
      }
    }
    assert.ok(contentionCaught, 'Must report lock contention while holder is alive');

    // 2. Kill the holder with SIGKILL
    holder.kill('SIGKILL');

    await new Promise((r) => setTimeout(r, 200));

    // 3. Process B must now be able to acquire the advisory lock normally
    const contender2 = new LockArbiter(lockFile);
    await contender2.acquire('contender-2');

    const lease = JSON.parse(fs.readFileSync(lockFile, 'utf8'));
    assert.equal(lease.command, 'contender-2');

    contender2.release();
  });
});
