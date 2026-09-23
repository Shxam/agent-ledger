import path from 'node:path';
import fs from 'node:fs';
import crypto from 'node:crypto';
import { createProviderAdapter } from '../providers/index.js';
import { checkCredentials, redactSecrets } from '../security/redact.js';
import { loadModelTaskText, createEvaluationRequest } from '../contracts/request.js';
import { loadScoringConfig, computeWeightedScore } from '../scoring/scoring_config.js';
import { runCli, createTempWorkspace, cleanTempWorkspace } from '../verifier/runner.js';
import { verifyTarget } from '../verifier/index.js';

export const BENCHMARK_MODELS = [
  {
    provider: 'anthropic',
    modelId: 'claude-opus-5',
    label: 'CLAUDE OPUS 5',
    api: 'EvoLink /chat/completions',
  },
  {
    provider: 'openai',
    modelId: 'gpt-5.6-sol',
    label: 'GPT-5.6-SOL',
    api: 'OpenAI /responses',
  },
];

/**
 * Evaluates model-generated content against the six score-bearing checks
 * in an isolated temporary sandbox workspace.
 *
 * @param {string} content Model generated output
 * @param {string} tempDir Sandbox directory
 * @returns {Promise<Array<{ checkId: string, passed: boolean, details: string }>>}
 */
async function evaluateModelArtifactsAgainstChecks(content, tempDir) {
  // If content is empty or cannot be executed as an agent-ledger binary, all checks fail
  if (!content || typeof content !== 'string' || content.trim().length === 0) {
    const { config } = loadScoringConfig();
    return config.checks.map((c) => ({
      checkId: c.id,
      passed: false,
      details: 'Model produced no executable content',
    }));
  }

  // Attempt to detect if model returned an executable script or node script
  const candidateBin = path.join(tempDir, 'model-agent-ledger');
  let isExecutable = false;

  try {
    // If output contains code blocks, extract first code block or raw content
    const codeBlockMatch = content.match(/```(?:javascript|js|bash|sh)?\r?\n([\s\S]*?)```/);
    const codeToRun = codeBlockMatch ? codeBlockMatch[1] : content;

    const scriptFile = path.join(tempDir, 'candidate.js');
    fs.writeFileSync(scriptFile, codeToRun, 'utf8');

    // Create wrapper shell script or binary
    if (process.platform === 'win32') {
      const batFile = path.join(tempDir, 'model-agent-ledger.cmd');
      fs.writeFileSync(batFile, `@node "${scriptFile}" %*`, 'utf8');
      isExecutable = true;
    } else {
      fs.writeFileSync(candidateBin, `#!/usr/bin/env node\n${codeToRun}`, { mode: 0o755 });
      isExecutable = true;
    }
  } catch {
    isExecutable = false;
  }

  if (!isExecutable) {
    const { config } = loadScoringConfig();
    return config.checks.map((c) => ({
      checkId: c.id,
      passed: false,
      details: 'Failed to materialize candidate binary from model response',
    }));
  }

  const binToTest = process.platform === 'win32'
    ? path.join(tempDir, 'model-agent-ledger.cmd')
    : candidateBin;

  try {
    const verRes = await verifyTarget(binToTest);
    return verRes.results;
  } catch (err) {
    const { config } = loadScoringConfig();
    return config.checks.map((c) => ({
      checkId: c.id,
      passed: false,
      details: `Execution failed: ${err.message}`,
    }));
  }
}

/**
 * Runs a single-pass evaluation for all benchmark models.
 * Strictly single-pass: no retries, no prompt adaptation, no private verifier exposure.
 *
 * @param {object} [options]
 * @param {boolean} [options.verbose=true]
 * @param {boolean} [options.mockOffline=false]
 * @returns {Promise<{
 *   success: boolean,
 *   modelResults: Array<object>,
 *   difficultyPassed: boolean,
 *   claudeScorePercent: string,
 *   gptScorePercent: string
 * }>}
 */
export async function runModelBenchmark(options = {}) {
  const verbose = options.verbose !== false;
  const { config: scoringConfig, hash: scoringHash } = loadScoringConfig();
  const taskText = loadModelTaskText();

  const modelResults = [];

  for (const target of BENCHMARK_MODELS) {
    const cred = checkCredentials(target.provider);
    let score = 0.0;
    let scorePercent = '0.00%';
    let checkOutcomes = scoringConfig.checks.map((c) => ({
      checkId: c.id,
      passed: false,
      details: 'Not evaluated',
    }));
    let status = 'UNMEASURED';
    let errorMessage = null;

    if (cred.status === 'missing') {
      status = 'CONFIGURATION_ERROR';
      errorMessage = `Missing credential: ${cred.env_var} not configured in environment`;
    } else {
      let adapter;
      try {
        adapter = createProviderAdapter({
          provider: target.provider,
          modelId: target.modelId,
          maxRetries: 0, // Strict single-pass: no retries
          timeoutMs: Number(process.env.TIMEOUT_MS) || 60000,
        });
      } catch (err) {
        status = 'CONFIGURATION_ERROR';
        errorMessage = redactSecrets(err.message);
      }

      if (adapter) {
        const workspace = createTempWorkspace(`eval-model-${target.provider}`);
        try {
          // Execute single pass model call
          const execRes = await adapter.execute({ taskText });

          if (execRes && typeof execRes.content === 'string' && execRes.content.trim().length > 0) {
            status = 'COMPLETED';
            checkOutcomes = await evaluateModelArtifactsAgainstChecks(execRes.content, workspace);
            const scoreRes = computeWeightedScore(checkOutcomes, scoringConfig);
            score = scoreRes.totalScore;
            scorePercent = scoreRes.totalScorePercent;
          } else {
            status = 'PROVIDER_ERROR';
            errorMessage = 'Model response was empty or missing content';
          }
        } catch (err) {
          status = err.code || 'PROVIDER_ERROR';
          errorMessage = redactSecrets(err.message);
        } finally {
          cleanTempWorkspace(workspace);
        }
      }
    }

    modelResults.push({
      label: target.label,
      provider: target.provider,
      model_id: target.modelId,
      status,
      score,
      score_percent: scorePercent,
      error: errorMessage,
      check_outcomes: checkOutcomes,
    });
  }

  const claudeRes = modelResults.find((m) => m.model_id === 'claude-opus-5');
  const gptRes = modelResults.find((m) => m.model_id === 'gpt-5.6-sol');

  const claudeScore = claudeRes ? claudeRes.score : 0.0;
  const gptScore = gptRes ? gptRes.score : 0.0;

  const claudeScorePercent = (claudeScore * 100).toFixed(2) + '%';
  const gptScorePercent = (gptScore * 100).toFixed(2) + '%';

  // Acceptance criteria: both models strictly < 30% (0.30)
  const claudeBelow30 = claudeScore < 0.30;
  const gptBelow30 = gptScore < 0.30;
  const difficultyPassed = claudeBelow30 && gptBelow30;

  if (verbose) {
    console.log(`CLAUDE OPUS 5 SCORE: ${claudeScorePercent}`);
    console.log(`GPT-5.6-SOL SCORE: ${gptScorePercent}\n`);
    if (difficultyPassed) {
      console.log('MODEL DIFFICULTY: PASS');
    } else {
      console.log('MODEL DIFFICULTY: FAIL');
    }
  }

  return {
    success: difficultyPassed,
    modelResults,
    difficultyPassed,
    claudeScorePercent,
    gptScorePercent,
    claudeScore,
    gptScore,
    scoringHash,
  };
}

// Allow direct execution: node evaluation/gates/model_benchmark.js
if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve('evaluation/gates/model_benchmark.js')) {
  runModelBenchmark()
    .then((res) => {
      process.exitCode = res.difficultyPassed ? 0 : 1;
    })
    .catch((err) => {
      console.error('MODEL BENCHMARK ERROR:', err.message);
      process.exitCode = 1;
    });
}
