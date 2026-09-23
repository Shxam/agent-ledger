import path from 'node:path';
import { createTempWorkspace, cleanTempWorkspace, runCli, writeJsonFile } from '../verifier/runner.js';

export const CHECK_ID = 'CHECK-SCHEMA-001';
export const CHECK_DESCRIPTION = 'Verify strict event schema, monotonic sequences, event uniqueness, and causal matching by tool_request_id';

/**
 * Executes CHECK-SCHEMA-001 against the target binary.
 * @param {string} binPath
 * @returns {Promise<{ passed: boolean, checkId: string, details: string }>}
 */
export async function runCheck(binPath) {
  const workspace = createTempWorkspace('verify-schema-');

  try {
    // 1. init
    const initRes = runCli(binPath, ['init', 'schema_run'], { cwd: workspace });
    if (initRes.status !== 0) {
      return { passed: false, checkId: CHECK_ID, details: `init failed with exit code ${initRes.status}: ${initRes.stderr}` };
    }

    // 2. Reject unsupported event types with exit 2
    const unsuppEvt = writeJsonFile(workspace, 'unsupported.json', {
      event_id: 'e_unsupp',
      seq_num: 1,
      run_id: 'schema_run',
      branch: 'main',
      type: 'step_executed',
      payload: {},
    });
    const unsuppRes = runCli(binPath, ['append', unsuppEvt], { cwd: workspace });
    if (unsuppRes.status !== 2) {
      return { passed: false, checkId: CHECK_ID, details: `Expected exit 2 for unsupported event type, got ${unsuppRes.status}` };
    }

    const testCompEvt = writeJsonFile(workspace, 'test_comp.json', {
      event_id: 'e_tc',
      seq_num: 1,
      run_id: 'schema_run',
      branch: 'main',
      type: 'test_completed',
      payload: {},
    });
    const testCompRes = runCli(binPath, ['append', testCompEvt], { cwd: workspace });
    if (testCompRes.status !== 2) {
      return { passed: false, checkId: CHECK_ID, details: `Expected exit 2 for test_completed type, got ${testCompRes.status}` };
    }

    // 3. seq_num monotonicity (seq 0 rejected, gap rejected)
    const seqZero = writeJsonFile(workspace, 'seq_zero.json', {
      event_id: 'e_zero',
      seq_num: 0,
      run_id: 'schema_run',
      branch: 'main',
      type: 'run_started',
      payload: {},
    });
    const seqZeroRes = runCli(binPath, ['append', seqZero], { cwd: workspace });
    if (seqZeroRes.status !== 2) {
      return { passed: false, checkId: CHECK_ID, details: `Expected exit 2 for seq_num 0, got ${seqZeroRes.status}` };
    }

    // Append valid event 1
    const evt1 = writeJsonFile(workspace, 'e1.json', {
      event_id: 'evt_001',
      seq_num: 1,
      run_id: 'schema_run',
      branch: 'main',
      type: 'run_started',
      payload: {},
    });
    const e1Res = runCli(binPath, ['append', evt1], { cwd: workspace });
    if (e1Res.status !== 0) {
      return { passed: false, checkId: CHECK_ID, details: `Valid event 1 append failed: ${e1Res.stderr}` };
    }

    // Sequence gap (seq 3 instead of 2)
    const seqGap = writeJsonFile(workspace, 'seq_gap.json', {
      event_id: 'e_gap',
      seq_num: 3,
      run_id: 'schema_run',
      branch: 'main',
      type: 'plan_created',
      payload: { steps: [] },
    });
    const seqGapRes = runCli(binPath, ['append', seqGap], { cwd: workspace });
    if (seqGapRes.status !== 2) {
      return { passed: false, checkId: CHECK_ID, details: `Expected exit 2 for sequence gap, got ${seqGapRes.status}` };
    }

    // 4. Duplicate event_id rejected
    const evt2 = writeJsonFile(workspace, 'e2.json', {
      event_id: 'evt_002',
      seq_num: 2,
      run_id: 'schema_run',
      branch: 'main',
      type: 'plan_created',
      payload: { steps: ['plan1'] },
    });
    const e2Res = runCli(binPath, ['append', evt2], { cwd: workspace });
    if (e2Res.status !== 0) {
      return { passed: false, checkId: CHECK_ID, details: `Valid event 2 append failed: ${e2Res.stderr}` };
    }

    const dupId = writeJsonFile(workspace, 'dup_id.json', {
      event_id: 'evt_002',
      seq_num: 3,
      run_id: 'schema_run',
      branch: 'main',
      type: 'file_changed',
      payload: { file: 'a.js' },
    });
    const dupRes = runCli(binPath, ['append', dupId], { cwd: workspace });
    if (dupRes.status !== 2) {
      return { passed: false, checkId: CHECK_ID, details: `Expected exit 2 for duplicate event_id, got ${dupRes.status}` };
    }

    // 5. Causal validation: tool_request_id matching (interleaved resolution)
    // Request tr_1
    const req1 = writeJsonFile(workspace, 'req1.json', {
      event_id: 'evt_req1',
      seq_num: 3,
      run_id: 'schema_run',
      branch: 'main',
      type: 'tool_requested',
      payload: { tool_request_id: 'tr_alpha', tool_name: 'bash' },
    });
    const req1Res = runCli(binPath, ['append', req1], { cwd: workspace });
    if (req1Res.status !== 0) {
      return { passed: false, checkId: CHECK_ID, details: `tool_requested tr_alpha failed: ${req1Res.stderr}` };
    }

    // Duplicate active tool request
    const dupReq = writeJsonFile(workspace, 'dup_req.json', {
      event_id: 'evt_dup_req',
      seq_num: 4,
      run_id: 'schema_run',
      branch: 'main',
      type: 'tool_requested',
      payload: { tool_request_id: 'tr_alpha', tool_name: 'bash' },
    });
    const dupReqRes = runCli(binPath, ['append', dupReq], { cwd: workspace });
    if (dupReqRes.status !== 2) {
      return { passed: false, checkId: CHECK_ID, details: `Expected exit 2 for duplicate active tool_request_id, got ${dupReqRes.status}` };
    }

    // Request tr_2 (interleaved)
    const req2 = writeJsonFile(workspace, 'req2.json', {
      event_id: 'evt_req2',
      seq_num: 4,
      run_id: 'schema_run',
      branch: 'main',
      type: 'tool_requested',
      payload: { tool_request_id: 'tr_beta', tool_name: 'bash' },
    });
    const req2Res = runCli(binPath, ['append', req2], { cwd: workspace });
    if (req2Res.status !== 0) {
      return { passed: false, checkId: CHECK_ID, details: `tool_requested tr_beta failed: ${req2Res.stderr}` };
    }

    // Unmatched tool result (nonexistent id)
    const unmatchResEvt = writeJsonFile(workspace, 'unmatched.json', {
      event_id: 'evt_unmatched',
      seq_num: 5,
      run_id: 'schema_run',
      branch: 'main',
      type: 'tool_result_received',
      payload: { tool_request_id: 'tr_nonexistent', exit_code: 0 },
    });
    const unmatchRes = runCli(binPath, ['append', unmatchResEvt], { cwd: workspace });
    if (unmatchRes.status !== 2) {
      return { passed: false, checkId: CHECK_ID, details: `Expected exit 2 for unmatched tool_result_received, got ${unmatchRes.status}` };
    }

    // Resolve tr_beta FIRST (out-of-order relative to request order). Must match by ID!
    const resBeta = writeJsonFile(workspace, 'res_beta.json', {
      event_id: 'evt_res_beta',
      seq_num: 5,
      run_id: 'schema_run',
      branch: 'main',
      type: 'tool_result_received',
      payload: { tool_request_id: 'tr_beta', exit_code: 0 },
    });
    const resBetaRes = runCli(binPath, ['append', resBeta], { cwd: workspace });
    if (resBetaRes.status !== 0) {
      return { passed: false, checkId: CHECK_ID, details: `tool_result_received for tr_beta out-of-order resolution failed: ${resBetaRes.stderr}` };
    }

    // 6. Block run_completed while tr_alpha remains open (exit 4)
    const earlyComplete = writeJsonFile(workspace, 'early_complete.json', {
      event_id: 'evt_early_done',
      seq_num: 6,
      run_id: 'schema_run',
      branch: 'main',
      type: 'run_completed',
      payload: {},
    });
    const earlyCompleteRes = runCli(binPath, ['append', earlyComplete], { cwd: workspace });
    if (earlyCompleteRes.status !== 4) {
      return { passed: false, checkId: CHECK_ID, details: `Expected exit 4 for run_completed while tool call in flight, got ${earlyCompleteRes.status}` };
    }

    // Resolve tr_alpha
    const resAlpha = writeJsonFile(workspace, 'res_alpha.json', {
      event_id: 'evt_res_alpha',
      seq_num: 6,
      run_id: 'schema_run',
      branch: 'main',
      type: 'tool_result_received',
      payload: { tool_request_id: 'tr_alpha', exit_code: 0 },
    });
    const resAlphaRes = runCli(binPath, ['append', resAlpha], { cwd: workspace });
    if (resAlphaRes.status !== 0) {
      return { passed: false, checkId: CHECK_ID, details: `tool_result_received for tr_alpha failed: ${resAlphaRes.stderr}` };
    }

    // Now run_completed should succeed
    const validComplete = writeJsonFile(workspace, 'valid_complete.json', {
      event_id: 'evt_done',
      seq_num: 7,
      run_id: 'schema_run',
      branch: 'main',
      type: 'run_completed',
      payload: {},
    });
    const validCompleteRes = runCli(binPath, ['append', validComplete], { cwd: workspace });
    if (validCompleteRes.status !== 0) {
      return { passed: false, checkId: CHECK_ID, details: `run_completed failed after all tools resolved: ${validCompleteRes.stderr}` };
    }

    return { passed: true, checkId: CHECK_ID, details: 'All schema, uniqueness, sequence, and causal checks passed successfully' };
  } finally {
    cleanTempWorkspace(workspace);
  }
}
