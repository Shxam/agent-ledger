import path from 'node:path';
import fs from 'node:fs';
import crypto from 'node:crypto';
import { runReferenceCheck } from './check_reference.js';
import { runMutantCheck } from './check_mutants.js';
import { runDeterminismCheck } from './check_determinism.js';
import { runPrivacyCheck } from './check_privacy.js';
import { runModelBenchmark } from './model_benchmark.js';
import { canonicalJson } from '../../src/core/canonical_json.js';
import { redactSecrets } from '../security/redact.js';

/**
 * Top-Level Final Benchmark Acceptance Gate Orchestrator.
 * Executes in exact specified order:
 * 1. check:reference
 * 2. check:mutants
 * 3. check:determinism
 * 4. check:privacy
 * 5. single-pass model benchmark
 *
 * @param {object} [options]
 * @param {boolean} [options.verbose=true]
 * @returns {Promise<{
 *   success: boolean,
 *   evidence: object,
 *   evidencePath: string,
 *   evidenceDigest: string
 * }>}
 */
export async function runAcceptanceGate(options = {}) {
  const verbose = options.verbose !== false;

  // 1. Reference Score Gate
  const refRes = await runReferenceCheck({ verbose: false });

  // 2. Mutant Gate
  const mutRes = await runMutantCheck({ verbose: false });

  // 3. Determinism Gate
  const detRes = await runDeterminismCheck({ verbose: false, runs: 3 });

  // 4. Privacy Gate
  const privRes = await runPrivacyCheck({ verbose: false });

  // 5. Single-Pass Model Benchmark
  const modelRes = await runModelBenchmark({ verbose: false });

  // All acceptance criteria check
  const allPassed =
    refRes.success &&
    mutRes.success &&
    detRes.success &&
    privRes.success &&
    modelRes.difficultyPassed;

  const overallStatus = allPassed ? 'PASS' : 'FAIL';

  if (verbose) {
    console.log('========================================');
    console.log('FINAL BENCHMARK ACCEPTANCE');
    console.log('========================================\n');
    console.log(`REFERENCE SCORE: ${refRes.scorePercent}`);
    console.log(`REFERENCE RESULT: ${refRes.result}\n`);
    console.log(`MUTANTS: ${mutRes.mutantsKilled}/${mutRes.totalMutants} KILLED`);
    console.log(`MUTANT RESULT: ${mutRes.result}\n`);
    console.log(`DETERMINISM: ${detRes.result}`);
    console.log(`PRIVACY: ${privRes.result}\n`);
    console.log(`CLAUDE OPUS 5 SCORE: ${modelRes.claudeScorePercent}`);
    console.log(`GPT-5.6-SOL SCORE: ${modelRes.gptScorePercent}\n`);
    console.log(`MODEL DIFFICULTY: ${modelRes.difficultyPassed ? 'PASS' : 'FAIL'}\n`);
    console.log(`OVERALL ACCEPTANCE: ${overallStatus}`);
    console.log('========================================');
  }

  // 10. Persist sanitized evidence artifact: evaluation/evidence/acceptance.json
  const evidenceDir = path.resolve('evaluation/evidence');
  if (!fs.existsSync(evidenceDir)) {
    fs.mkdirSync(evidenceDir, { recursive: true });
  }

  const acceptanceEvidence = {
    benchmark_version: '1.0.0',
    timestamp: new Date().toISOString(),
    scoring_configuration_hash: refRes.scoringHash,
    reference_score: refRes.scorePercent,
    per_check_reference_results: refRes.checkResults,
    mutant_results: mutRes.mutantResults.map((m) => ({
      mutant_id: m.mutant_id,
      targeted_check: m.targeted_check,
      killed: m.killed,
      killing_check: m.killing_check,
      score: m.score_percent,
    })),
    determinism_result: {
      status: detRes.result,
      repeated_runs: detRes.runs,
    },
    privacy_result: {
      status: privRes.result,
      violations_count: privRes.violations.length,
    },
    claude_score: modelRes.claudeScorePercent,
    gpt_score: modelRes.gptScorePercent,
    model_evaluation_metadata: {
      difficulty_passed: modelRes.difficultyPassed,
      models: modelRes.modelResults.map((m) => ({
        label: m.label,
        provider: m.provider,
        model_id: m.model_id,
        status: m.status,
        score: m.score_percent,
        error: m.error ? redactSecrets(m.error) : null,
      })),
    },
    overall_acceptance: overallStatus,
  };

  const canonicalEvidence = canonicalJson(acceptanceEvidence);
  const evidenceDigest = crypto.createHash('sha256').update(canonicalEvidence, 'utf8').digest('hex');
  acceptanceEvidence.evidence_digest = evidenceDigest;

  const evidencePath = path.join(evidenceDir, 'acceptance.json');
  fs.writeFileSync(evidencePath, JSON.stringify(acceptanceEvidence, null, 2), 'utf8');

  return {
    success: allPassed,
    evidence: acceptanceEvidence,
    evidencePath,
    evidenceDigest,
  };
}

// Allow direct execution: node evaluation/gates/check_acceptance.js
if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve('evaluation/gates/check_acceptance.js')) {
  runAcceptanceGate()
    .then((res) => {
      process.exitCode = res.success ? 0 : 1;
    })
    .catch((err) => {
      console.error('ACCEPTANCE GATE ERROR:', err.message);
      process.exitCode = 1;
    });
}
