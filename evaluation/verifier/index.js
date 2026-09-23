import path from 'node:path';
import * as checkSchema from '../checks/check_schema_001.js';
import * as checkCrash from '../checks/check_crash_001.js';
import * as checkReplay from '../checks/check_replay_001.js';
import * as checkDrift from '../checks/check_drift_001.js';
import * as checkBranch from '../checks/check_branch_001.js';
import * as checkLock from '../checks/check_lock_001.js';

export const ALL_CHECKS = [
  checkSchema,
  checkCrash,
  checkReplay,
  checkDrift,
  checkBranch,
  checkLock,
];

/**
 * Runs all verifier hidden checks against a specified agent-ledger binary.
 * @param {string} binPath Absolute path to target executable
 * @returns {Promise<{
 *   target: string,
 *   allPassed: boolean,
 *   results: Array<{ checkId: string, passed: boolean, details: string }>
 * }>}
 */
export async function verifyTarget(binPath) {
  const resolvedBin = path.resolve(binPath);
  const results = [];
  let allPassed = true;

  for (const checkModule of ALL_CHECKS) {
    try {
      const res = await checkModule.runCheck(resolvedBin);
      results.push(res);
      if (!res.passed) {
        allPassed = false;
      }
    } catch (err) {
      allPassed = false;
      results.push({
        checkId: checkModule.CHECK_ID,
        passed: false,
        details: `Unhandled exception during check execution: ${err.message}\n${err.stack}`,
      });
    }
  }

  return {
    target: resolvedBin,
    allPassed,
    results,
  };
}

// Allow direct CLI execution: node evaluation/verifier/index.js
if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve('evaluation/verifier/index.js')) {
  verifyTarget(process.argv[2] || 'bin/agent-ledger')
    .then((res) => {
      console.log(`REFERENCE VERIFY: ${res.allPassed ? 'PASS' : 'FAIL'}`);
      for (const r of res.results) {
        console.log(`  - ${r.checkId}: ${r.passed ? 'PASS' : 'FAIL - ' + r.details}`);
      }
      process.exit(res.allPassed ? 0 : 1);
    })
    .catch((err) => {
      console.error(err);
      process.exit(1);
    });
}
