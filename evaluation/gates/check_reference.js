import path from 'node:path';
import fs from 'node:fs';
import { verifyTarget } from '../verifier/index.js';
import { loadScoringConfig, computeWeightedScore } from '../scoring/scoring_config.js';
import { loadModelTaskText } from '../contracts/request.js';

/**
 * Executes the Reference Score Gate:
 * 1. Verifies frozen task/instruction.md presence and integrity.
 * 2. Loads and validates scoring.yml.
 * 3. Runs reference implementation against all score-bearing checks.
 * 4. Applies weighted scoring.
 * 5. Requires exactly 100.00% score to pass.
 *
 * @param {object} [options]
 * @param {string} [options.referenceBin]
 * @param {boolean} [options.verbose=true]
 * @returns {Promise<{
 *   success: boolean,
 *   score: number,
 *   scorePercent: string,
 *   result: 'PASS' | 'FAIL',
 *   details: object
 * }>}
 */
export async function runReferenceCheck(options = {}) {
  const verbose = options.verbose !== false;
  const refBin = path.resolve(options.referenceBin || 'bin/agent-ledger');

  if (!fs.existsSync(refBin)) {
    throw new Error(`Reference binary not found at: ${refBin}`);
  }

  // 1. Verify frozen task instruction
  loadModelTaskText();

  // 2. Load and validate scoring configuration
  const { config: scoringConfig, hash: scoringHash } = loadScoringConfig();

  // 3. Execute reference binary against all checks
  const verifierResult = await verifyTarget(refBin);

  // 4. Calculate weighted score
  const scoreResult = computeWeightedScore(verifierResult.results, scoringConfig);

  const passes100 = scoreResult.totalScore === 1.0 && scoreResult.allPassed;
  const resultStatus = passes100 ? 'PASS' : 'FAIL';

  if (verbose) {
    console.log(`REFERENCE SCORE: ${scoreResult.totalScorePercent}`);
    console.log(`REFERENCE RESULT: ${resultStatus}`);
  }

  return {
    success: passes100,
    score: scoreResult.totalScore,
    scorePercent: scoreResult.totalScorePercent,
    result: resultStatus,
    scoringHash,
    checkResults: scoreResult.perCheckScores,
    target: refBin,
  };
}

// Allow direct execution: node evaluation/gates/check_reference.js
if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve('evaluation/gates/check_reference.js')) {
  runReferenceCheck()
    .then((res) => {
      process.exit(res.success ? 0 : 1);
    })
    .catch((err) => {
      console.error('REFERENCE CHECK ERROR:', err.message);
      process.exit(1);
    });
}
