import fs from 'node:fs';
import path from 'node:path';

/**
 * Loads the canonical model-facing task text strictly from task/instruction.md.
 * Ensures hidden verification checks, mutants, and evidence tokens are never included.
 *
 * @param {string} [instructionPath]
 * @returns {string}
 */
export function loadModelTaskText(instructionPath) {
  const filePath = instructionPath || path.resolve('task/instruction.md');
  if (!fs.existsSync(filePath)) {
    throw new Error(`Model task instruction file not found at: ${filePath}`);
  }

  const content = fs.readFileSync(filePath, 'utf8');

  // Verify that the task text contains no private verifier or mutant tokens
  const forbiddenPatterns = [
    'CHECK-SCHEMA-001',
    'CHECK-CRASH-001',
    'CHECK-REPLAY-001',
    'CHECK-DRIFT-001',
    'CHECK-BRANCH-001',
    'CHECK-LOCK-001',
    'MUTANT-CAUSAL-ORDER',
    'MUTANT-TAIL-CRASH',
    'MUTANT-LIVE-REPLAY',
    'MUTANT-DRIFT-BLIND',
    'MUTANT-BRANCH-OVERWRITE',
    'MUTANT-LOCK-OMISSION',
    'hidden verification',
    'mutant-kill',
  ];

  for (const forbidden of forbiddenPatterns) {
    if (content.includes(forbidden)) {
      throw new Error(
        `Security violation: task instruction file contains private benchmark token: '${forbidden}'`
      );
    }
  }

  return content;
}

/**
 * Creates and validates a deterministic evaluation request contract.
 *
 * @param {object} params
 * @param {string} [params.taskId='agent-ledger-specification']
 * @param {string} [params.taskText]
 * @param {'anthropic'|'openai'} params.provider
 * @param {string} params.modelId
 * @param {number} [params.repetition=1]
 * @param {string} [params.workspaceDir]
 * @param {object} [params.limits]
 * @returns {object}
 */
export function createEvaluationRequest(params) {
  if (!params.provider || !['anthropic', 'openai'].includes(params.provider)) {
    throw new Error(`Invalid provider: ${params.provider}`);
  }

  if (!params.modelId || typeof params.modelId !== 'string') {
    throw new Error(`Invalid or missing modelId: ${params.modelId}`);
  }

  const taskText = params.taskText || loadModelTaskText();

  return {
    task_id: params.taskId || 'agent-ledger-specification',
    task_text: taskText,
    provider: params.provider,
    model_id: params.modelId,
    repetition: Number(params.repetition) || 1,
    workspace_dir: params.workspaceDir || null,
    limits: {
      timeout_ms: params.limits?.timeout_ms ?? (Number(process.env.TIMEOUT_MS) || 60000),
      max_retries: params.limits?.max_retries ?? 2,
      max_output_tokens: params.limits?.max_output_tokens ?? (Number(process.env.MAX_OUTPUT_TOKENS) || 4096),
      max_output_bytes: params.limits?.max_output_bytes ?? 1048576,
    },
  };
}
