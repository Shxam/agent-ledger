import fs from 'node:fs';
import path from 'node:path';
import { createTempWorkspace, cleanTempWorkspace, runCli, writeJsonFile } from '../verifier/runner.js';

export const CHECK_ID = 'CHECK-CRASH-001';
export const CHECK_DESCRIPTION = 'Verify torn-tail recovery and unrecoverable corruption detection on recover';

/**
 * Executes CHECK-CRASH-001 against the target binary.
 * @param {string} binPath
 * @returns {Promise<{ passed: boolean, checkId: string, details: string }>}
 */
export async function runCheck(binPath) {
  const workspace = createTempWorkspace('verify-crash-');

  try {
    // 1. init
    const initRes = runCli(binPath, ['init', 'crash_run'], { cwd: workspace });
    if (initRes.status !== 0) {
      return { passed: false, checkId: CHECK_ID, details: `init failed: ${initRes.stderr}` };
    }

    // 2. Append valid events
    const e1 = writeJsonFile(workspace, 'e1.json', {
      event_id: 'e1',
      seq_num: 1,
      run_id: 'crash_run',
      branch: 'main',
      type: 'run_started',
      payload: {},
    });
    const e2 = writeJsonFile(workspace, 'e2.json', {
      event_id: 'e2',
      seq_num: 2,
      run_id: 'crash_run',
      branch: 'main',
      type: 'plan_created',
      payload: { steps: ['step1'] },
    });
    runCli(binPath, ['append', e1], { cwd: workspace });
    runCli(binPath, ['append', e2], { cwd: workspace });

    const eventsFile = path.join(workspace, '.agent-ledger', 'events.ndjson');
    if (!fs.existsSync(eventsFile)) {
      return { passed: false, checkId: CHECK_ID, details: 'events.ndjson does not exist after appends' };
    }

    const validContent = fs.readFileSync(eventsFile, 'utf8');

    // 3. Append torn JSON tail / incomplete final line
    fs.appendFileSync(eventsFile, '{"event_id":"torn_tail_crash",');

    // 4. Run recover
    const recoverRes = runCli(binPath, ['recover'], { cwd: workspace });
    if (recoverRes.status !== 0) {
      return { passed: false, checkId: CHECK_ID, details: `recover failed with status ${recoverRes.status}: ${recoverRes.stderr}` };
    }

    // 5. Verify valid preceding bytes remain unchanged and damaged tail is removed
    const recoveredContent = fs.readFileSync(eventsFile, 'utf8');
    if (recoveredContent !== validContent) {
      return { passed: false, checkId: CHECK_ID, details: 'Recovered log content does not match valid preceding content exactly' };
    }

    // 6. Verify subsequent integrity validation succeeds by appending event 3
    const e3 = writeJsonFile(workspace, 'e3.json', {
      event_id: 'e3',
      seq_num: 3,
      run_id: 'crash_run',
      branch: 'main',
      type: 'file_changed',
      payload: { file: 'test.js' },
    });
    const e3Res = runCli(binPath, ['append', e3], { cwd: workspace });
    if (e3Res.status !== 0) {
      return { passed: false, checkId: CHECK_ID, details: `Subsequent append after recovery failed: ${e3Res.stderr}` };
    }

    // 7. Verify historical corruption before tail returns exit 7 rather than being repaired
    const currentLines = fs.readFileSync(eventsFile, 'utf8').trim().split('\n');
    // Corrupt line 1 (historical record), while line 2 and 3 are valid
    currentLines[0] = currentLines[0].replace('"run_started"', '"corrupted_type"');
    fs.writeFileSync(eventsFile, currentLines.join('\n') + '\n');

    const corruptRecoverRes = runCli(binPath, ['recover'], { cwd: workspace });
    if (corruptRecoverRes.status !== 7) {
      return {
        passed: false,
        checkId: CHECK_ID,
        details: `Expected exit 7 for unrecoverable historical corruption on recover, got ${corruptRecoverRes.status}`,
      };
    }

    return { passed: true, checkId: CHECK_ID, details: 'Torn-tail recovery and exit 7 historical corruption handling verified' };
  } finally {
    cleanTempWorkspace(workspace);
  }
}
