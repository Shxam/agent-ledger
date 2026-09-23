import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawnSync, spawn } from 'node:child_process';

/**
 * Creates an isolated temporary directory for test execution.
 * @param {string} [prefix='agent-ledger-verify-']
 * @returns {string} Absolute path to temp dir
 */
export function createTempWorkspace(prefix = 'agent-ledger-verify-') {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

/**
 * Cleans up a temporary directory with retry for Windows file locks.
 * @param {string} dirPath
 */
export function cleanTempWorkspace(dirPath) {
  if (dirPath && fs.existsSync(dirPath)) {
    try {
      fs.rmSync(dirPath, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    } catch {
      // ignore cleanup errors on process exit
    }
  }
}

/**
 * Executes a CLI binary with arguments in the specified directory.
 * @param {string} binPath Absolute path to agent-ledger executable
 * @param {string[]} args CLI arguments
 * @param {object} [options]
 * @param {string} [options.cwd] Working directory
 * @param {object} [options.env] Environment variables
 * @param {number} [options.timeout=10000] Execution timeout in ms
 * @returns {{ status: number, stdout: string, stderr: string, error?: Error }}
 */
export function runCli(binPath, args, options = {}) {
  const cwd = options.cwd || process.cwd();
  const env = { ...process.env, ...(options.env || {}) };
  const timeout = options.timeout || 45000;
  const resolvedBin = path.resolve(binPath);

  const res = spawnSync(process.execPath, [resolvedBin, ...args], {
    cwd,
    env,
    encoding: 'utf8',
    timeout,
  });

  const errorMsg = res.error ? ` [Spawn error: ${res.error.message}]` : '';

  return {
    status: res.status !== null ? res.status : 1,
    exitCode: res.status !== null ? res.status : 1,
    stdout: res.stdout || '',
    stderr: (res.stderr || '') + errorMsg,
    error: res.error,
  };
}

/**
 * Helper to write a JSON file to a directory.
 * @param {string} dir
 * @param {string} filename
 * @param {object} data
 * @returns {string} Absolute path of created file
 */
export function writeJsonFile(dir, filename, data) {
  const filePath = path.join(dir, filename);
  fs.writeFileSync(filePath, JSON.stringify(data, null, 2), 'utf8');
  return filePath;
}
