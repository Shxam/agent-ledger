import fs from 'node:fs';
import path from 'node:path';
import { createTempWorkspace, cleanTempWorkspace, runCli, writeJsonFile } from '../verifier/runner.js';

export const CHECK_ID = 'CHECK-BRANCH-001';
export const CHECK_DESCRIPTION = 'Verify branch isolation, parent history immutability, distinct replay, and export topology';

/**
 * Executes CHECK-BRANCH-001 against the target binary.
 * @param {string} binPath
 * @returns {Promise<{ passed: boolean, checkId: string, details: string }>}
 */
export async function runCheck(binPath) {
  const workspace = createTempWorkspace('verify-branch-');

  try {
    // 1. init
    const initRes = runCli(binPath, ['init', 'branch_run'], { cwd: workspace });
    if (initRes.status !== 0) {
      return { passed: false, checkId: CHECK_ID, details: `init failed: ${initRes.stderr}` };
    }

    // 2. Parent history: event 1 and event 2
    const e1 = writeJsonFile(workspace, 'e1.json', {
      event_id: 'e1',
      seq_num: 1,
      run_id: 'branch_run',
      branch: 'main',
      type: 'run_started',
      payload: {},
    });
    const e2 = writeJsonFile(workspace, 'e2.json', {
      event_id: 'e2',
      seq_num: 2,
      run_id: 'branch_run',
      branch: 'main',
      type: 'plan_created',
      payload: { steps: ['step1'] },
    });
    runCli(binPath, ['append', e1], { cwd: workspace });
    runCli(binPath, ['append', e2], { cwd: workspace });

    // 3. Checkpoint cp_parent
    const cpRes = runCli(binPath, ['checkpoint', '--id', 'cp_parent'], { cwd: workspace });
    if (cpRes.status !== 0) {
      return { passed: false, checkId: CHECK_ID, details: `checkpoint failed: ${cpRes.stderr}` };
    }

    // 4. Append event 3 on parent branch (main)
    const e3_main = writeJsonFile(workspace, 'e3_main.json', {
      event_id: 'e3_main',
      seq_num: 3,
      run_id: 'branch_run',
      branch: 'main',
      type: 'file_changed',
      payload: { file: 'main.js' },
    });
    runCli(binPath, ['append', e3_main], { cwd: workspace });

    // Snapshot parent event log bytes
    const eventsFile = path.join(workspace, '.agent-ledger', 'events.ndjson');
    const parentLogBeforeBranch = fs.readFileSync(eventsFile, 'utf8');

    // 5. Create branch from cp_parent
    const branchRes = runCli(binPath, ['branch', '--from', 'cp_parent', '--name', 'feature_branch'], { cwd: workspace });
    if (branchRes.status !== 0) {
      return { passed: false, checkId: CHECK_ID, details: `branch failed: ${branchRes.stderr}` };
    }

    // 6. Append child event on feature_branch
    const e3_child = writeJsonFile(workspace, 'e3_child.json', {
      event_id: 'e3_child',
      seq_num: 3,
      run_id: 'branch_run',
      branch: 'feature_branch',
      type: 'file_changed',
      payload: { file: 'feature.js' },
    });
    const childAppendRes = runCli(binPath, ['append', e3_child], { cwd: workspace });
    if (childAppendRes.status !== 0) {
      return { passed: false, checkId: CHECK_ID, details: `child append failed: ${childAppendRes.stderr}` };
    }

    // 7. Verify parent events remain byte-for-byte unchanged
    const currentLog = fs.readFileSync(eventsFile, 'utf8');
    if (!currentLog.startsWith(parentLogBeforeBranch)) {
      return {
        passed: false,
        checkId: CHECK_ID,
        details: 'Parent history was modified or overwritten after child branch activity',
      };
    }

    // 8. Verify child event is correctly tagged and isolated
    const lines = currentLog.trim().split('\n');
    const lastRecord = JSON.parse(lines[lines.length - 1]);
    if (lastRecord.branch !== 'feature_branch' || lastRecord.event_id !== 'e3_child') {
      return {
        passed: false,
        checkId: CHECK_ID,
        details: 'Child event was not properly associated with child branch in log',
      };
    }

    // 9. Replay from cp_parent (which is on main) should replay parent's subsequent event e3_main
    const replayParent = runCli(binPath, ['replay', '--from', 'cp_parent', '--json'], { cwd: workspace });
    if (replayParent.status !== 0) {
      return { passed: false, checkId: CHECK_ID, details: `Replay on parent checkpoint failed: ${replayParent.stderr}` };
    }
    const replayParentData = JSON.parse(replayParent.stdout);
    if (replayParentData.branch !== 'main' || replayParentData.replayed_events_count !== 1) {
      return {
        passed: false,
        checkId: CHECK_ID,
        details: 'Parent replay did not replay the correct main branch lineage',
      };
    }

    // 10. Verify export preserves branch topology
    const exportRes = runCli(binPath, ['export', '--format', 'json'], { cwd: workspace });
    if (exportRes.status !== 0) {
      return { passed: false, checkId: CHECK_ID, details: `export failed: ${exportRes.stderr}` };
    }
    const exportData = JSON.parse(exportRes.stdout);
    if (!exportData.branches || !exportData.branches.main || !exportData.branches.feature_branch) {
      return {
        passed: false,
        checkId: CHECK_ID,
        details: 'Export failed to preserve distinct branch topology for main and feature_branch',
      };
    }
    if (exportData.branches.main.events.length !== 3) {
      return {
        passed: false,
        checkId: CHECK_ID,
        details: `Expected 3 events on main branch in export, got ${exportData.branches.main.events.length}`,
      };
    }
    if (exportData.branches.feature_branch.events.length !== 1) {
      return {
        passed: false,
        checkId: CHECK_ID,
        details: `Expected 1 event on feature_branch in export, got ${exportData.branches.feature_branch.events.length}`,
      };
    }

    return { passed: true, checkId: CHECK_ID, details: 'Branch isolation, parent history immutability, and export topology verified' };
  } finally {
    cleanTempWorkspace(workspace);
  }
}
