import fs from 'node:fs';
import path from 'node:path';
import { createTempWorkspace, cleanTempWorkspace, runCli, writeJsonFile } from '../verifier/runner.js';

export const CHECK_ID = 'CHECK-DRIFT-001';
export const CHECK_DESCRIPTION = 'Verify cryptographic hash-chain drift detection on status and export';

/**
 * Executes CHECK-DRIFT-001 against the target binary.
 * @param {string} binPath
 * @returns {Promise<{ passed: boolean, checkId: string, details: string }>}
 */
export async function runCheck(binPath) {
  const workspace = createTempWorkspace('verify-drift-');

  try {
    // 1. init
    const initRes = runCli(binPath, ['init', 'drift_run'], { cwd: workspace });
    if (initRes.status !== 0) {
      return { passed: false, checkId: CHECK_ID, details: `init failed: ${initRes.stderr}` };
    }

    // 2. Append multiple chained events
    const e1 = writeJsonFile(workspace, 'e1.json', {
      event_id: 'e1',
      seq_num: 1,
      run_id: 'drift_run',
      branch: 'main',
      type: 'run_started',
      payload: {},
    });
    const e2 = writeJsonFile(workspace, 'e2.json', {
      event_id: 'e2',
      seq_num: 2,
      run_id: 'drift_run',
      branch: 'main',
      type: 'plan_created',
      payload: { steps: ['stepA'] },
    });
    const e3 = writeJsonFile(workspace, 'e3.json', {
      event_id: 'e3',
      seq_num: 3,
      run_id: 'drift_run',
      branch: 'main',
      type: 'file_changed',
      payload: { file: 'core.js', hash: 'abc123' },
    });

    runCli(binPath, ['append', e1], { cwd: workspace });
    runCli(binPath, ['append', e2], { cwd: workspace });
    runCli(binPath, ['append', e3], { cwd: workspace });

    // Verify valid status before tamper
    const statusBefore = runCli(binPath, ['status', '--json'], { cwd: workspace });
    if (statusBefore.status !== 0) {
      return { passed: false, checkId: CHECK_ID, details: `Status before tamper failed: ${statusBefore.stderr}` };
    }

    // 3. Alter a historical record (event 2 payload) in events.ndjson
    const eventsFile = path.join(workspace, '.agent-ledger', 'events.ndjson');
    const originalContent = fs.readFileSync(eventsFile, 'utf8');
    const tamperedContent = originalContent.replace('"stepA"', '"stepTampered"');
    fs.writeFileSync(eventsFile, tamperedContent, 'utf8');

    // 4. Verify status --json detects drift with exit 5
    const statusAfter = runCli(binPath, ['status', '--json'], { cwd: workspace });
    if (statusAfter.status !== 5) {
      return {
        passed: false,
        checkId: CHECK_ID,
        details: `Expected exit 5 for status --json on tampered ledger, got ${statusAfter.status}`,
      };
    }

    // 5. Verify export --format json detects drift with exit 5
    const exportAfter = runCli(binPath, ['export', '--format', 'json'], { cwd: workspace });
    if (exportAfter.status !== 5) {
      return {
        passed: false,
        checkId: CHECK_ID,
        details: `Expected exit 5 for export --format json on tampered ledger, got ${exportAfter.status}`,
      };
    }

    // 6. Verify recover does not silently rewrite/repair historical corruption (must return exit 7)
    const recoverRes = runCli(binPath, ['recover'], { cwd: workspace });
    if (recoverRes.status !== 7) {
      return {
        passed: false,
        checkId: CHECK_ID,
        details: `Expected exit 7 for recover on historical corruption, got ${recoverRes.status}`,
      };
    }

    return { passed: true, checkId: CHECK_ID, details: 'Cryptographic hash-chain tamper detection verified with exit 5 and exit 7 on recover' };
  } finally {
    cleanTempWorkspace(workspace);
  }
}
