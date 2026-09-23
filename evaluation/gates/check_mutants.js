import path from 'node:path';
import fs from 'node:fs';
import { verifyTarget } from '../verifier/index.js';
import { loadScoringConfig, computeWeightedScore } from '../scoring/scoring_config.js';
import { BENCHMARK_MUTANTS } from '../harness.js';

/**
 * Executes the Mutant Gate:
 * 1. Runs reference benchmark and confirms 100% pass.
 * 2. Runs every controlled mutant through all checks.
 * 3. Scores every mutant using scoring.yml.
 * 4. Identifies which check killed each mutant.
 * 5. Fails if any mutant survives.
 *
 * @param {object} [options]
 * @param {string} [options.referenceBin]
 * @param {boolean} [options.verbose=true]
 * @returns {Promise<{
 *   success: boolean,
 *   referencePassed: boolean,
 *   mutantsKilled: number,
 *   totalMutants: number,
 *   mutantResults: Array<object>,
 *   result: 'PASS' | 'FAIL'
 * }>}
 */
export async function runMutantCheck(options = {}) {
  const verbose = options.verbose !== false;
  const refBin = path.resolve(options.referenceBin || 'bin/agent-ledger');

  const { config: scoringConfig } = loadScoringConfig();

  // 1. Run reference benchmark
  const refResult = await verifyTarget(refBin);
  const refScore = computeWeightedScore(refResult.results, scoringConfig);
  const refPassed = refScore.totalScore === 1.0 && refScore.allPassed;

  if (!refPassed) {
    if (verbose) {
      console.log('REFERENCE: FAIL');
      console.log(`MUTANTS: 0/${BENCHMARK_MUTANTS.length} KILLED`);
      console.log('RESULT: FAIL');
    }
    return {
      success: false,
      referencePassed: false,
      mutantsKilled: 0,
      totalMutants: BENCHMARK_MUTANTS.length,
      mutantResults: [],
      result: 'FAIL',
    };
  }

  // 2. Run all controlled mutants
  const mutantResults = [];
  let killedCount = 0;

  for (const mutant of BENCHMARK_MUTANTS) {
    if (!fs.existsSync(mutant.binPath)) {
      throw new Error(`Mutant binary not found at: ${mutant.binPath}`);
    }

    const mRes = await verifyTarget(mutant.binPath);
    const mScore = computeWeightedScore(mRes.results, scoringConfig);

    const targetCheckResult = mRes.results.find((r) => r.checkId === mutant.targetedCheck);
    const killedByTarget = targetCheckResult ? !targetCheckResult.passed : false;
    const isKilled = !mRes.allPassed || killedByTarget;

    const failedChecks = mRes.results.filter((r) => !r.passed).map((r) => r.checkId);
    const killingCheck = targetCheckResult && !targetCheckResult.passed
      ? mutant.targetedCheck
      : (failedChecks[0] || 'NONE');

    if (isKilled) {
      killedCount++;
    }

    mutantResults.push({
      mutant_id: mutant.id,
      description: mutant.description,
      targeted_check: mutant.targetedCheck,
      killed: isKilled,
      killing_check: killingCheck,
      score: mScore.totalScore,
      score_percent: mScore.totalScorePercent,
      failed_checks: failedChecks,
    });
  }

  const allKilled = killedCount === BENCHMARK_MUTANTS.length;
  const resultStatus = allKilled ? 'PASS' : 'FAIL';

  if (verbose) {
    console.log('REFERENCE: PASS');
    console.log(`MUTANTS: ${killedCount}/${BENCHMARK_MUTANTS.length} KILLED`);
    console.log(`RESULT: ${resultStatus}`);
  }

  return {
    success: allKilled,
    referencePassed: true,
    mutantsKilled: killedCount,
    totalMutants: BENCHMARK_MUTANTS.length,
    mutantResults,
    result: resultStatus,
  };
}

// Allow direct execution: node evaluation/gates/check_mutants.js
if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve('evaluation/gates/check_mutants.js')) {
  runMutantCheck()
    .then((res) => {
      process.exit(res.success ? 0 : 1);
    })
    .catch((err) => {
      console.error('MUTANT CHECK ERROR:', err.message);
      process.exit(1);
    });
}
