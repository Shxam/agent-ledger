import fs from 'node:fs';
import path from 'node:path';
import { createTempWorkspace, cleanTempWorkspace, runCli, writeJsonFile } from '../verifier/runner.js';

export const CHECK_ID = 'CHECK-REPLAY-001';
export const CHECK_DESCRIPTION = 'Verify tool result virtualization without live subprocess execution and deterministic replay';

/**
 * Executes CHECK-REPLAY-001 against the target binary.
 * @param {string} binPath
 * @returns {Promise<{ passed: boolean, checkId: string, details: string }>}
 */
export async function runCheck(binPath) {
  const workspace = createTempWorkspace('verify-replay-');
  const canarySideEffectFile = path.join(workspace, 'canary_side_effect.txt');
  const fixturePath = path.resolve('evaluation/fixtures/side_effect_tool.js');

  try {
    // 1. init
    const initRes = runCli(binPath, ['init', 'replay_run'], { cwd: workspace });
    if (initRes.status !== 0) {
      return { passed: false, checkId: CHECK_ID, details: `init failed: ${initRes.stderr}` };
    }

    // 2. Append prefix
    const e1 = writeJsonFile(workspace, 'e1.json', {
      event_id: 'e1',
      seq_num: 1,
      run_id: 'replay_run',
      branch: 'main',
      type: 'run_started',
      payload: {},
    });
    const e2 = writeJsonFile(workspace, 'e2.json', {
      event_id: 'e2',
      seq_num: 2,
      run_id: 'replay_run',
      branch: 'main',
      type: 'plan_created',
      payload: { steps: ['planA'] },
    });
    runCli(binPath, ['append', e1], { cwd: workspace });
    runCli(binPath, ['append', e2], { cwd: workspace });

    // Checkpoint cp_pre at sequence 2
    const cpRes = runCli(binPath, ['checkpoint', '--id', 'cp_pre'], { cwd: workspace });
    if (cpRes.status !== 0) {
      return { passed: false, checkId: CHECK_ID, details: `checkpoint failed: ${cpRes.stderr}` };
    }

    // 3. Tool request containing executable command that would create canarySideEffectFile if live
    const e3 = writeJsonFile(workspace, 'e3.json', {
      event_id: 'e3',
      seq_num: 3,
      run_id: 'replay_run',
      branch: 'main',
      type: 'tool_requested',
      payload: {
        tool_request_id: 'tr_side_effect',
        tool_name: 'bash',
        arguments: {
          command: `node "${fixturePath}" "${canarySideEffectFile}"`,
        },
      },
    });
    runCli(binPath, ['append', e3], { cwd: workspace });

    // 4. Tool result with recorded output
    const e4 = writeJsonFile(workspace, 'e4.json', {
      event_id: 'e4',
      seq_num: 4,
      run_id: 'replay_run',
      branch: 'main',
      type: 'tool_result_received',
      payload: {
        tool_request_id: 'tr_side_effect',
        exit_code: 0,
        result: { recorded: 'virtualized_success' },
      },
    });
    runCli(binPath, ['append', e4], { cwd: workspace });

    // Ensure canary does not exist prior to replay
    if (fs.existsSync(canarySideEffectFile)) {
      fs.unlinkSync(canarySideEffectFile);
    }

    // 5. Run replay
    const replay1 = runCli(binPath, ['replay', '--from', 'cp_pre', '--json'], { cwd: workspace });
    if (replay1.status !== 0) {
      return { passed: false, checkId: CHECK_ID, details: `replay failed with status ${replay1.status}: ${replay1.stderr}` };
    }

    // 6. Verify NO real tool execution occurred (canary file must NOT exist)
    if (fs.existsSync(canarySideEffectFile)) {
      return {
        passed: false,
        checkId: CHECK_ID,
        details: 'Side-effect detected: canary file was created! Replay executed real tool subprocess instead of virtualizing results',
      };
    }

    // 7. Verify replay result structure
    let parsed1;
    try {
      parsed1 = JSON.parse(replay1.stdout);
    } catch {
      return { passed: false, checkId: CHECK_ID, details: 'replay --json produced invalid JSON' };
    }

    if (parsed1.replayed_events_count !== 2) {
      return {
        passed: false,
        checkId: CHECK_ID,
        details: `Expected 2 replayed events, got ${parsed1.replayed_events_count}`,
      };
    }

    // 8. Determinism check: rerun replay and verify byte-for-byte identical output
    const replay2 = runCli(binPath, ['replay', '--from', 'cp_pre', '--json'], { cwd: workspace });
    if (replay1.stdout !== replay2.stdout) {
      return {
        passed: false,
        checkId: CHECK_ID,
        details: 'Replay output is not byte-for-byte deterministic across repeated invocations',
      };
    }

    return { passed: true, checkId: CHECK_ID, details: 'Tool results virtualized cleanly without side-effects, deterministic output verified' };
  } finally {
    cleanTempWorkspace(workspace);
  }
}
