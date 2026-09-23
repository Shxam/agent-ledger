import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { ExitCode, LedgerError } from './errors.js';

export const DEFAULT_LOCK_TTL_MS = 10000; // 10 seconds

/**
 * Converts a Windows path (e.g. C:\...) to a WSL/POSIX path (/mnt/c/...) if on Windows.
 *
 * @param {string} filePath
 * @returns {string}
 */
export function toPosixPath(filePath) {
  let normalized = filePath.replace(/\\/g, '/');
  if (/^[a-zA-Z]:\//.test(normalized)) {
    normalized = '/mnt/' + normalized[0].toLowerCase() + normalized.slice(2);
  }
  return normalized;
}

/**
 * POSIX Advisory Lock Arbiter for .agent-ledger/locks/ledger.lock.
 *
 * Implements genuine OS-level non-blocking exclusive advisory locking (flock(fd, LOCK_EX | LOCK_NB)).
 */
export class LockArbiter {
  /**
   * @param {string} lockFile Absolute path to ledger.lock
   */
  constructor(lockFile) {
    this.lockFile = path.resolve(lockFile);
    this.locksDir = path.dirname(this.lockFile);
    this.holderChild = null;
    this.heldByThisProcess = false;
    this._exitHook = null;
  }

  /**
   * Acquires a genuine OS-level POSIX exclusive advisory lock on the target file.
   * If another process holds the advisory lock, immediately throws LedgerError with ExitCode.LOCK_CONTENTION (3).
   *
   * @param {string} [command='operation'] Name of command acquiring the lock
   * @param {number} [ttlMs=DEFAULT_LOCK_TTL_MS] Lease TTL in milliseconds
   * @returns {Promise<void>}
   */
  async acquire(command = 'operation', ttlMs = DEFAULT_LOCK_TTL_MS) {
    if (this.heldByThisProcess) {
      return;
    }

    if (!fs.existsSync(this.locksDir)) {
      fs.mkdirSync(this.locksDir, { recursive: true });
    }

    // Ensure the persistent lock file exists
    if (!fs.existsSync(this.lockFile)) {
      try {
        fs.writeFileSync(this.lockFile, '', { flag: 'a' });
      } catch {
        // ignore concurrent creation
      }
    }

    // Spawn flock holder process to acquire OS-level POSIX advisory lock
    const isWindows = process.platform === 'win32';
    const targetPath = isWindows ? toPosixPath(this.lockFile) : this.lockFile;

    const spawnCmd = isWindows ? 'bash' : 'flock';
    const spawnArgs = isWindows
      ? ['-c', `flock -n -E 3 "${targetPath}" sh -c "echo LOCKED; exec cat"`]
      : ['-n', '-E', '3', targetPath, 'sh', '-c', 'echo LOCKED; exec cat'];

    await new Promise((resolve, reject) => {
      let child;
      try {
        child = spawn(spawnCmd, spawnArgs, {
          stdio: ['pipe', 'pipe', 'pipe'],
        });
      } catch (err) {
        return reject(
          new LedgerError(
            ExitCode.USAGE_OR_NOT_FOUND,
            `Error: Unable to invoke flock: ${err.message}`
          )
        );
      }

      let settled = false;
      let stdoutBuffer = '';

      child.stdout.on('data', (chunk) => {
        stdoutBuffer += chunk.toString();
        if (stdoutBuffer.includes('LOCKED') && !settled) {
          settled = true;
          this.holderChild = child;
          this.heldByThisProcess = true;
          resolve();
        }
      });

      child.on('exit', (code) => {
        if (!settled) {
          settled = true;
          if (code === 3 || code === 1) {
            // Lock contention: another live process holds the POSIX advisory lock
            let holderInfo = '';
            try {
              if (fs.existsSync(this.lockFile)) {
                const raw = fs.readFileSync(this.lockFile, 'utf8');
                if (raw.trim().length > 0) {
                  const lease = JSON.parse(raw);
                  if (lease.pid) {
                    holderInfo = ` (held by active PID ${lease.pid})`;
                  }
                }
              }
            } catch {
              // ignore lease read failure
            }

            reject(
              new LedgerError(
                ExitCode.LOCK_CONTENTION,
                `Error: POSIX advisory lock contention on ${this.lockFile}${holderInfo}`
              )
            );
          } else {
            reject(
              new LedgerError(
                ExitCode.LOCK_CONTENTION,
                `Error: Failed to acquire advisory lock on ${this.lockFile} (exit code ${code})`
              )
            );
          }
        }
      });

      child.on('error', (err) => {
        if (!settled) {
          settled = true;
          reject(
            new LedgerError(
              ExitCode.USAGE_OR_NOT_FOUND,
              `Error: Failed to spawn flock process: ${err.message}`
            )
          );
        }
      });
    });

    // Write auxiliary lease metadata to the locked file
    const leasePayload = {
      pid: process.pid,
      acquired_at_ms: Date.now(),
      ttl_ms: ttlMs,
      command,
    };

    try {
      fs.writeFileSync(this.lockFile, JSON.stringify(leasePayload, null, 2) + '\n');
    } catch {
      // auxiliary metadata write is secondary to the OS lock
    }

    // Register process cleanup handler
    this._exitHook = () => {
      this.release();
    };
    process.once('exit', this._exitHook);
  }

  /**
   * Releases the OS advisory lock.
   */
  release() {
    if (!this.heldByThisProcess) {
      return;
    }

    if (this._exitHook) {
      process.removeListener('exit', this._exitHook);
      this._exitHook = null;
    }

    if (this.holderChild) {
      try {
        if (this.holderChild.stdin && !this.holderChild.stdin.destroyed) {
          this.holderChild.stdin.end();
        }
        this.holderChild.kill('SIGTERM');
      } catch {
        // ignore kill error
      }
      this.holderChild = null;
    }

    this.heldByThisProcess = false;
  }
}

/**
 * Helper to run an async callback within an acquired POSIX advisory lock.
 *
 * @template T
 * @param {string} lockFile
 * @param {string} command
 * @param {() => Promise<T> | T} fn
 * @returns {Promise<T>}
 */
export async function withLock(lockFile, command, fn) {
  const arbiter = new LockArbiter(lockFile);
  await arbiter.acquire(command);
  try {
    return await fn();
  } finally {
    arbiter.release();
  }
}
