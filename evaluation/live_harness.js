import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { checkCredentials, redactSecrets } from './security/redact.js';
import { createEvaluationRequest } from './contracts/request.js';
import { runModelEvaluation } from './runner/model_runner.js';
import { canonicalJson } from '../src/core/canonical_json.js';

export const LIVE_TARGETS = [
  {
    provider: 'anthropic',
    modelId: 'claude-opus-5',
    label: 'LIVE CLAUDE OPUS 5',
    api: 'EvoLink /chat/completions',
  },
  {
    provider: 'openai',
    modelId: 'gpt-5.6-sol',
    label: 'LIVE GPT-5.6-SOL',
    api: 'OpenAI /responses',
  },
];

/**
 * Runs the live LLM benchmark evaluation for configured targets:
 * - Claude Opus 5 via EvoLink (POST https://direct.evolink.ai/v1/chat/completions)
 * - GPT-5.6 Sol via OpenAI (POST https://api.openai.com/v1/responses)
 * Ensures non-zero exit code if credentials are missing or evaluation fails.
 *
 * @param {object} [options]
 * @param {boolean} [options.verbose=true]
 * @returns {Promise<{
 *   success: boolean,
 *   summary: object,
 *   results: Array<object>
 * }>}
 */
export async function runLiveEvaluation(options = {}) {
  const verbose = options.verbose !== false;

  if (verbose) {
    console.log('============================================================');
    console.log('         AGENT-LEDGER LIVE MODEL EVALUATION HARNESS         ');
    console.log('============================================================\n');
  }

  const results = [];
  let allTargetsPassed = true;

  for (const target of LIVE_TARGETS) {
    if (verbose) {
      console.log(`[Target] ${target.label} (Model: ${target.modelId}) [API: ${target.api}]`);
    }

    // 1. Safe credential check prior to any network call
    const cred = checkCredentials(target.provider);
    if (cred.status === 'missing') {
      allTargetsPassed = false;
      const skippedRecord = {
        label: target.label,
        provider: target.provider,
        model_id: target.modelId,
        task_id: 'agent-ledger-specification',
        attempt: 1,
        status: 'CONFIGURATION_ERROR',
        error_category: 'CONFIGURATION_ERROR',
        latency: 0,
        latency_ms: 0,
        api: target.api,
        exercised: false,
        classification: 'CONFIGURATION_ERROR',
        details: `Missing credential: ${cred.env_var} is not configured in the environment`,
        prompt_hash: null,
        response_hash: null,
        ledger_verified: false,
      };
      results.push(skippedRecord);

      if (verbose) {
        console.log(`  - Status: CONFIGURATION_ERROR (${cred.env_var} missing; live call skipped)\n`);
      }
      continue;
    }

    // 2. Execute live model evaluation
    if (verbose) {
      console.log(`  - Credentials configured (${cred.env_var}). Initiating ${target.api} request...`);
    }

    let request;
    try {
      request = createEvaluationRequest({
        provider: target.provider,
        modelId: target.modelId,
        repetition: 1,
        limits: {
          timeout_ms: Number(process.env.TIMEOUT_MS) || 60000,
          max_retries: 2,
          max_output_tokens: Number(process.env.MAX_OUTPUT_TOKENS) || 4096,
        },
      });
    } catch (err) {
      allTargetsPassed = false;
      const reqErr = {
        label: target.label,
        provider: target.provider,
        model_id: target.modelId,
        api: target.api,
        exercised: false,
        classification: 'CONFIGURATION_ERROR',
        details: redactSecrets(err.message),
        prompt_hash: null,
        response_hash: null,
        latency_ms: 0,
        ledger_verified: false,
      };
      results.push(reqErr);
      if (verbose) {
        console.log(`  - Status: CONFIGURATION_ERROR (${err.message})\n`);
      }
      continue;
    }

    const evalRes = await runModelEvaluation(request);
    const passed = evalRes.success && evalRes.classification === 'PASS';
    if (!passed) {
      allTargetsPassed = false;
    }

    const resultRecord = {
      label: target.label,
      provider: target.provider,
      model_id: target.modelId,
      task_id: request.task_id,
      attempt: 1,
      status: evalRes.classification,
      error_category: evalRes.classification === 'PASS' ? null : evalRes.classification,
      latency: evalRes.latency_ms,
      latency_ms: evalRes.latency_ms,
      prompt_hash: evalRes.prompt_hash,
      response_hash: evalRes.response_hash,
      api: target.api,
      exercised: true,
      classification: evalRes.classification,
      details: evalRes.error ? redactSecrets(evalRes.error) : 'Evaluation executed successfully',
      ledger_verified: evalRes.ledger_verified,
    };
    results.push(resultRecord);

    if (verbose) {
      console.log(`  - Status: ${evalRes.classification}`);
      console.log(`  - Latency: ${evalRes.latency_ms}ms`);
      if (evalRes.response_hash) {
        console.log(`  - Output Digest: ${evalRes.response_hash}`);
      }
      if (evalRes.error) {
        console.log(`  - Error Detail: ${evalRes.error}`);
      }
      console.log(`  - Ledger Verified: ${evalRes.ledger_verified}\n`);
    }
  }

  // 3. Persist Non-Secret Live Evidence Artifact
  const evidenceDir = path.resolve('evaluation/evidence');
  if (!fs.existsSync(evidenceDir)) {
    fs.mkdirSync(evidenceDir, { recursive: true });
  }

  const liveEvidence = {
    benchmark_version: '1.0.0',
    gateway: 'Claude: EvoLink (/chat/completions) | GPT: OpenAI (/responses)',
    timestamp: new Date().toISOString(),
    overall_status: allTargetsPassed ? 'PASS' : 'FAIL',
    total_targets: LIVE_TARGETS.length,
    targets_exercised: results.filter((r) => r.exercised).length,
    targets_passed: results.filter((r) => r.classification === 'PASS').length,
    results: results.map((r) => redactSecrets(r)),
  };

  const canonicalEvidence = canonicalJson(liveEvidence);
  const evidenceDigest = crypto.createHash('sha256').update(canonicalEvidence).digest('hex');
  liveEvidence.evidence_digest = evidenceDigest;

  const liveEvidencePath = path.join(evidenceDir, 'live_evaluation.json');
  fs.writeFileSync(liveEvidencePath, JSON.stringify(liveEvidence, null, 2), 'utf8');

  if (verbose) {
    console.log('============================================================');
    console.log('                 FINAL LIVE EVALUATION SUMMARY              ');
    console.log('============================================================');
    for (const r of results) {
      console.log(`${r.label}: ${r.classification}`);
    }
    console.log(`OVERALL: ${allTargetsPassed ? 'PASS' : 'FAIL'}`);
    console.log('============================================================');
    console.log(`EVIDENCE SAVED: ${liveEvidencePath}`);
    console.log(`EVIDENCE DIGEST: ${evidenceDigest}`);
    console.log('============================================================\n');
  }

  return {
    success: allTargetsPassed,
    summary: liveEvidence,
    results,
  };
}

// Allow direct CLI execution: node evaluation/live_harness.js
if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve('evaluation/live_harness.js')) {
  runLiveEvaluation()
    .then((res) => {
      process.exit(res.success ? 0 : 1);
    })
    .catch((err) => {
      console.error(redactSecrets(err.message));
      process.exit(1);
    });
}
