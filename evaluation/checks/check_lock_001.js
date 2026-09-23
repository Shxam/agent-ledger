import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { LockArbiter, toPosixPath } from '../../src/core/lock.js';
import { createTempWorkspace, cleanTempWorkspace, runCli, writeJsonFile } from '../verifier/runner.js';

export const CHECK_ID = 'CHECK-LOCK-001';
export const CHECK_DESCRIPTION = 'Verify genuine OS-level advisory locking across processes and recovery from killed holders';

/**
 * Executes CHECK-LOCK-001 against the target binary.
 * @param {string} binPath
 * @returns {Promise<{ passed: boolean, checkId: string, details: string }>}
 */
export async function runCheck(binPath) {
  const workspace = createTempWorkspace('verify-lock-');

  try {
    // 1. init
    const initRes = runCli(binPath, ['init', 'lock_run'], { cwd: workspace });
    if (initRes.status !== 0) {
      return { passed: false, checkId: CHECK_ID, details: `init failed: ${initRes.stderr}` };
    }

    const lockFile = path.join(workspace, '.agent-ledger', 'locks', 'ledger.lock');

    // 2. Process A (current process) acquires the genuine OS-level POSIX advisory lock
    const arbiter = new LockArbiter(lockFile);
    await arbiter.acquire('verifier-lock-holder');

    const e1 = writeJsonFile(workspace, 'e1.json', {
      event_id: 'e1',
      seq_num: 1,
      run_id: 'lock_run',
      branch: 'main',
      type: 'run_started',
      payload: {},
    });

    try {
      // 3. Process B attempts mutating append while lock is held by Process A
      const contestedRes = runCli(binPath, ['append', e1], { cwd: workspace });

      // Contention must exit with code 3 (LOCK_CONTENTION)
      if (contestedRes.status !== 3) {
        return {
          passed: false,
          checkId: CHECK_ID,
          details: `Expected exit 3 on POSIX lock contention, got ${contestedRes.status}. (Stdout: ${contestedRes.stdout}, Stderr: ${contestedRes.stderr})`,
        };
      }

      // Verify no partial append / write
      const eventsFile = path.join(workspace, '.agent-ledger', 'events.ndjson');
      if (fs.existsSync(eventsFile)) {
        const content = fs.readFileSync(eventsFile, 'utf8').trim();
        if (content.length > 0) {
          return {
            passed: false,
            checkId: CHECK_ID,
            details: 'Partial write detected: events.ndjson was modified despite lock contention failure',
          };
        }
      }
    } finally {
      // Release lock
      arbiter.release();
    }

    // 4. Verify release allows subsequent append to succeed
    const afterReleaseRes = runCli(binPath, ['append', e1], { cwd: workspace });
    if (afterReleaseRes.status !== 0) {
      return {
        passed: false,
        checkId: CHECK_ID,
        details: `Append failed after lock was released: ${afterReleaseRes.stderr}`,
      };
    }

    // 5. Test killed holder: spawn child process holding kernel flock, kill it, verify kernel auto-release
    const isWin = process.platform === 'win32';
    const targetPath = isWin ? toPosixPath(lockFile) : lockFile;
    const flockChild = spawn(
      isWin ? 'bash' : 'flock',
      isWin
        ? ['-c', `flock -n -E 3 "${targetPath}" sh -c "echo READY; exec cat"`]
        : ['-n', '-E', '3', targetPath, 'sh', '-c', 'echo READY; exec cat'],
      { stdio: ['pipe', 'pipe', 'pipe'] }
    );

    await new Promise((resolve, reject) => {
      let settled = false;
      const timeout = setTimeout(() => {
        if (!settled) {
          settled = true;
          flockChild.kill('SIGKILL');
          reject(new Error('Timeout waiting for flock child process'));
        }
      }, 5000);

      flockChild.stdout.on('data', (d) => {
        if (d.toString().includes('READY') && !settled) {
          settled = true;
          clearTimeout(timeout);
          resolve();
        }
      });

      flockChild.on('error', (err) => {
        if (!settled) {
          settled = true;
          clearTimeout(timeout);
          reject(err);
        }
      });
    });

    // Kill the flock process abruptly
    flockChild.kill('SIGKILL');
    await new Promise((r) => setTimeout(r, 400));

    // Subsequent operation must succeed because the kernel released the advisory lock
    const e2 = writeJsonFile(workspace, 'e2.json', {
      event_id: 'e2',
      seq_num: 2,
      run_id: 'lock_run',
      branch: 'main',
      type: 'plan_created',
      payload: { steps: [] },
    });
    const afterKillRes = runCli(binPath, ['append', e2], { cwd: workspace });
    if (afterKillRes.status !== 0) {
      return {
        passed: false,
        checkId: CHECK_ID,
        details: `Subsequent append failed after lock holder was killed with SIGKILL: ${afterKillRes.stderr}`,
      };
    }

    // 6. Test fake metadata: fake lease with invalid PID must not block when no real flock is held
    fs.writeFileSync(
      lockFile,
      JSON.stringify({ pid: 999999, command: 'fake_holder', acquired_at_ms: Date.now(), ttl_ms: 60000 }),
      'utf8'
    );

    const e3 = writeJsonFile(workspace, 'e3.json', {
      event_id: 'e3',
      seq_num: 3,
      run_id: 'lock_run',
      branch: 'main',
      type: 'file_changed',
      payload: { file: 'fake.js' },
    });

    const fakeMetaRes = runCli(binPath, ['append', e3], { cwd: workspace });
    if (fakeMetaRes.status !== 0) {
      return {
        passed: false,
        checkId: CHECK_ID,
        details: `Metadata alone must not block lock acquisition when kernel lock is free; got exit ${fakeMetaRes.status}: ${fakeMetaRes.stderr}`,
      };
    }

    return { passed: true, checkId: CHECK_ID, details: 'Genuine OS-level advisory locking, contention exit 3, and release verified' };
  } finally {
    cleanTempWorkspace(workspace);
  }
}
