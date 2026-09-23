import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { createProviderAdapter, MalformedResponseError } from '../providers/index.js';
import { redactSecrets } from '../security/redact.js';
import { runCli, createTempWorkspace, cleanTempWorkspace } from '../verifier/runner.js';

/**
 * Runs a single model evaluation trial:
 * 1. Prepares an isolated workspace.
 * 2. Initializes agent-ledger in the workspace.
 * 3. Appends audit events tracking model execution using ONLY the 9 permitted event types.
 * 4. Dispatches the request via the configured provider adapter.
 * 5. Returns deterministic attempt metadata with redacted error and payload details.
 *
 * @param {object} request Evaluation request contract
 * @param {object} [options]
 * @param {string} [options.agentLedgerBin] Path to agent-ledger binary (defaults to bin/agent-ledger)
 * @param {boolean} [options.keepWorkspace=false] Whether to preserve the workspace after execution
 * @returns {Promise<{
 *   success: boolean,
 *   classification: 'PASS' | 'CONFIGURATION_ERROR' | 'AUTHENTICATION_ERROR' | 'PROVIDER_ERROR',
 *   provider: string,
 *   model_id: string,
 *   task_id: string,
 *   repetition: number,
 *   prompt_hash: string,
 *   response_hash: string | null,
 *   latency_ms: number,
 *   error: string | null,
 *   ledger_verified: boolean,
 *   workspace_dir: string
 * }>}
 */
export async function runModelEvaluation(request, options = {}) {
  const binPath = path.resolve(options.agentLedgerBin || 'bin/agent-ledger');
  const workspace = options.workspaceDir || createTempWorkspace('eval-run');

  const promptHash = crypto
    .createHash('sha256')
    .update(request.task_text || '', 'utf8')
    .digest('hex');

  let adapter;
  let adapterError = null;

  try {
    adapter = createProviderAdapter({
      provider: request.provider,
      modelId: request.model_id,
      baseUrl: request.baseUrl,
      timeoutMs: request.limits?.timeout_ms,
      maxRetries: request.limits?.max_retries,
      maxOutputBytes: request.limits?.max_output_bytes,
      maxOutputTokens: request.limits?.max_output_tokens,
    });
  } catch (err) {
    adapterError = err;
  }

  // If adapter creation failed due to configuration (e.g. unknown provider)
  if (adapterError) {
    if (!options.keepWorkspace && !options.workspaceDir) {
      cleanTempWorkspace(workspace);
    }
    return {
      success: false,
      classification: adapterError.code || 'CONFIGURATION_ERROR',
      provider: request.provider,
      model_id: request.model_id,
      task_id: request.task_id,
      repetition: request.repetition,
      prompt_hash: promptHash,
      response_hash: null,
      latency_ms: 0,
      error: redactSecrets(adapterError.message),
      ledger_verified: false,
      workspace_dir: workspace,
    };
  }

  // 1. Initialize agent-ledger repository in workspace
  const runId = `eval_${request.provider}_${Date.now()}`;
  const initRes = await runCli(binPath, ['init', runId], { cwd: workspace });
  const ledgerInitialized = initRes.exitCode === 0;

  // Helper to append event via CLI
  let currentSeq = 0;
  const appendAuditRecord = async (type, payload) => {
    if (!ledgerInitialized) return false;
    currentSeq++;
    const evt = {
      event_id: `evt_${Date.now()}_${currentSeq}_${Math.random().toString(36).substring(2, 7)}`,
      seq_num: currentSeq,
      run_id: runId,
      branch: 'main',
      timestamp: new Date().toISOString(),
      type,
      payload: redactSecrets(payload),
    };

    const evtFile = path.join(workspace, `evt_append_${currentSeq}.json`);
    fs.writeFileSync(evtFile, JSON.stringify(evt), 'utf8');
    const res = await runCli(binPath, ['append', evtFile], { cwd: workspace });
    try {
      fs.unlinkSync(evtFile);
    } catch {}
    return res.exitCode === 0;
  };

  // Record run_started and plan_created
  await appendAuditRecord('run_started', {
    run_id: runId,
    task_id: request.task_id,
    provider: request.provider,
    model_id: request.model_id,
    repetition: request.repetition,
  });

  await appendAuditRecord('plan_created', {
    objective: 'Autonomous model execution against benchmark specification',
    prompt_hash: promptHash,
  });

  const toolReqId = `req_${Date.now()}_001`;
  await appendAuditRecord('tool_requested', {
    tool_request_id: toolReqId,
    tool_name: 'llm_generate',
    arguments: {
      provider: request.provider,
      model_id: request.model_id,
      prompt_hash: promptHash,
    },
  });

  // 2. Dispatch model execution
  let executionResult = null;
  let executionError = null;
  const startTime = Date.now();

  try {
    executionResult = await adapter.execute({ taskText: request.task_text });
  } catch (err) {
    executionError = err;
  }

  const latency = Date.now() - startTime;

  // Validate non-empty model response content
  const hasValidContent =
    executionResult &&
    typeof executionResult.content === 'string' &&
    executionResult.content.trim().length > 0;

  if (hasValidContent) {
    const rawContent = executionResult.content;
    const responseHash = crypto
      .createHash('sha256')
      .update(rawContent, 'utf8')
      .digest('hex');

    await appendAuditRecord('tool_result_received', {
      tool_request_id: toolReqId,
      status: 'success',
      result: {
        response_hash: responseHash,
        input_tokens: executionResult.input_tokens,
        output_tokens: executionResult.output_tokens,
      },
    });

    await appendAuditRecord('run_completed', {
      status: 'success',
      exit_code: 0,
    });

    // Verify ledger integrity
    const statusRes = await runCli(binPath, ['status', '--json'], { cwd: workspace });
    const ledgerVerified = statusRes.exitCode === 0;

    if (!options.keepWorkspace && !options.workspaceDir) {
      cleanTempWorkspace(workspace);
    }

    return {
      success: true,
      classification: 'PASS',
      provider: request.provider,
      model_id: request.model_id,
      task_id: request.task_id,
      repetition: request.repetition,
      prompt_hash: promptHash,
      response_hash: responseHash,
      latency_ms: latency,
      error: null,
      ledger_verified: ledgerVerified,
      workspace_dir: workspace,
    };
  }

  // Model execution failed (either provider/network error or empty/missing content)
  if (!executionError) {
    executionError = new MalformedResponseError('Provider returned empty or missing model content');
  }
  const errorClassification = executionError?.code || 'PROVIDER_ERROR';

  await appendAuditRecord('tool_result_received', {
    tool_request_id: toolReqId,
    status: 'error',
    error: {
      classification: errorClassification,
      message: redactSecrets(executionError?.message || 'Execution error'),
    },
  });

  await appendAuditRecord('run_completed', {
    status: 'failed',
    exit_code: 1,
  });

  const statusRes = await runCli(binPath, ['status', '--json'], { cwd: workspace });
  const ledgerVerified = statusRes.exitCode === 0;

  if (!options.keepWorkspace && !options.workspaceDir) {
    cleanTempWorkspace(workspace);
  }

  return {
    success: false,
    classification: errorClassification,
    provider: request.provider,
    model_id: request.model_id,
    task_id: request.task_id,
    repetition: request.repetition,
    prompt_hash: promptHash,
    response_hash: null,
    latency_ms: latency,
    error: redactSecrets(executionError?.message || 'Unknown provider error'),
    ledger_verified: ledgerVerified,
    workspace_dir: workspace,
  };
}
