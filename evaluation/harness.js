import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { verifyTarget } from './verifier/index.js';
import { canonicalJson } from '../src/core/canonical_json.js';

export const BENCHMARK_MUTANTS = [
  {
    id: 'MUTANT-CAUSAL-ORDER',
    binPath: path.resolve('evaluation/mutants/mutant_causal_order/bin/agent-ledger'),
    targetedCheck: 'CHECK-SCHEMA-001',
    description: 'Associates tool results by array position (FIFO) instead of tool_request_id',
  },
  {
    id: 'MUTANT-TAIL-CRASH',
    binPath: path.resolve('evaluation/mutants/mutant_tail_crash/bin/agent-ledger'),
    targetedCheck: 'CHECK-CRASH-001',
    description: 'Parses entire log at once and crashes on torn final record without descriptor truncation',
  },
  {
    id: 'MUTANT-LIVE-REPLAY',
    binPath: path.resolve('evaluation/mutants/mutant_live_replay/bin/agent-ledger'),
    targetedCheck: 'CHECK-REPLAY-001',
    description: 'Executes real tool subprocesses during replay instead of virtualizing recorded results',
  },
  {
    id: 'MUTANT-DRIFT-BLIND',
    binPath: path.resolve('evaluation/mutants/mutant_drift_blind/bin/agent-ledger'),
    targetedCheck: 'CHECK-DRIFT-001',
    description: 'Bypasses historical SHA-256 chain verification on status and export read paths',
  },
  {
    id: 'MUTANT-BRANCH-OVERWRITE',
    binPath: path.resolve('evaluation/mutants/mutant_branch_overwrite/bin/agent-ledger'),
    targetedCheck: 'CHECK-BRANCH-001',
    description: 'Overwrites or truncates parent branch events upon branch creation',
  },
  {
    id: 'MUTANT-LOCK-OMISSION',
    binPath: path.resolve('evaluation/mutants/mutant_lock_omission/bin/agent-ledger'),
    targetedCheck: 'CHECK-LOCK-001',
    description: 'Omits OS-level POSIX flock advisory locking, allowing concurrent mutating operations',
  },
];

/**
 * Runs the full benchmark evaluation against the reference implementation and all mutants.
 * Generates reproducible proof-of-work evidence in evaluation/evidence/.
 *
 * @param {object} [options]
 * @param {string} [options.referenceBin] Path to reference binary (defaults to ./bin/agent-ledger)
 * @param {boolean} [options.verbose=true]
 * @returns {Promise<{ success: boolean, evidence: object }>}
 */
export async function runBenchmark(options = {}) {
  const refBin = path.resolve(options.referenceBin || 'bin/agent-ledger');
  const verbose = options.verbose !== false;

  if (verbose) {
    console.log('============================================================');
    console.log('         AGENT-LEDGER BENCHMARK & VERIFIER SUITE            ');
    console.log('============================================================\n');
    console.log(`Reference Target: ${refBin}`);
  }

  // 1. Verify Reference Implementation
  if (verbose) console.log('\n[1/2] Evaluating Reference Implementation against all hidden checks...');
  const refResult = await verifyTarget(refBin);

  if (verbose) {
    for (const r of refResult.results) {
      console.log(`  - ${r.checkId}: ${r.passed ? 'PASS' : 'FAIL - ' + r.details}`);
    }
  }

  if (!refResult.allPassed) {
    if (verbose) {
      console.error('\nERROR: Reference implementation failed one or more hidden checks!');
    }
    return { success: false, refPassed: false, evidence: null };
  }

  if (verbose) console.log('\nREFERENCE: PASS\n');

  // 2. Evaluate all mutants
  if (verbose) console.log('[2/2] Evaluating Mutants against targeted hidden checks...');
  const mutantResults = [];
  let allMutantsKilled = true;

  for (const mutant of BENCHMARK_MUTANTS) {
    const mRes = await verifyTarget(mutant.binPath);
    const targetCheckResult = mRes.results.find((r) => r.checkId === mutant.targetedCheck);

    const isKilled = targetCheckResult && !targetCheckResult.passed;
    if (!isKilled) {
      allMutantsKilled = false;
    }

    mutantResults.push({
      mutant_id: mutant.id,
      targeted_check: mutant.targetedCheck,
      description: mutant.description,
      status: isKilled ? 'KILLED' : 'SURVIVED',
      killed_by_target: isKilled,
      failure_details: targetCheckResult?.details || 'Target check passed unexpectedly',
      all_checks: mRes.results.map((r) => ({ checkId: r.checkId, passed: r.passed })),
    });

    if (verbose) {
      if (isKilled) {
        console.log(`${mutant.id}: KILLED (by ${mutant.targetedCheck})`);
      } else {
        console.log(`${mutant.id}: SURVIVED (Target check ${mutant.targetedCheck} did not fail!)`);
      }
    }
  }

  // 3. Generate Evidence Artifacts
  const evidenceData = {
    benchmark_version: '1.0.0',
    timestamp: new Date().toISOString(),
    git_commit_sha: 'reference-stage-8-baseline',
    environment: {
      platform: process.platform,
      arch: process.arch,
      node_version: process.version,
    },
    reference_evaluation: {
      status: 'PASS',
      total_checks: refResult.results.length,
      passed_checks: refResult.results.filter((r) => r.passed).length,
      checks: refResult.results.map((r) => ({ checkId: r.checkId, passed: r.passed, details: r.details })),
    },
    mutant_evaluation: {
      total_mutants: BENCHMARK_MUTANTS.length,
      killed_mutants: mutantResults.filter((m) => m.killed_by_target).length,
      all_mutants_killed: allMutantsKilled,
      mutants: mutantResults,
    },
    overall_result: refResult.allPassed && allMutantsKilled ? 'PASS' : 'FAIL',
  };

  // Compute canonical deterministic hash of evidence
  const canonicalEvidence = canonicalJson(evidenceData);
  const evidenceDigest = crypto.createHash('sha256').update(canonicalEvidence).digest('hex');
  evidenceData.evidence_digest = evidenceDigest;

  // Persist evidence
  const evidenceDir = path.resolve('evaluation/evidence');
  if (!fs.existsSync(evidenceDir)) {
    fs.mkdirSync(evidenceDir, { recursive: true });
  }

  const evidenceJsonPath = path.join(evidenceDir, 'evidence.json');
  fs.writeFileSync(evidenceJsonPath, JSON.stringify(evidenceData, null, 2), 'utf8');

  const reportPath = path.join(evidenceDir, 'verification_report.md');
  const reportContent = `# Benchmark Verification Evidence Report

**Generated**: ${evidenceData.timestamp}
**Platform**: ${process.platform} (${process.arch}), Node.js ${process.version}
**Evidence SHA-256 Digest**: \`${evidenceDigest}\`

## 1. Reference Implementation Verification
**Result**: **${evidenceData.reference_evaluation.status}** (${evidenceData.reference_evaluation.passed_checks}/${evidenceData.reference_evaluation.total_checks} checks passed)

| Check ID | Result | Description |
| :--- | :---: | :--- |
${refResult.results.map((r) => `| \`${r.checkId}\` | **${r.passed ? 'PASS' : 'FAIL'}** | ${r.details.replace(/\n/g, ' ')} |`).join('\n')}

## 2. Mutant Kill Suite
**Result**: **${allMutantsKilled ? 'ALL MUTANTS KILLED' : 'MUTANTS SURVIVED'}** (${evidenceData.mutant_evaluation.killed_mutants}/${evidenceData.mutant_evaluation.total_mutants} killed)

| Mutant Identifier | Targeted Check | Status | Defect Description |
| :--- | :--- | :---: | :--- |
${mutantResults.map((m) => `| \`${m.mutant_id}\` | \`${m.targeted_check}\` | **${m.status}** | ${m.description} |`).join('\n')}

## 3. Summary
${allMutantsKilled ? 'All controlled mutant variants were successfully killed by their targeted behavioral checks. The reference implementation satisfies all verification criteria.' : 'One or more mutants survived evaluation.'}
`;
  fs.writeFileSync(reportPath, reportContent, 'utf8');

  if (verbose) {
    console.log('\n============================================================');
    console.log(`VERIFICATION EVIDENCE SAVED: ${evidenceJsonPath}`);
    console.log(`REPORT SAVED: ${reportPath}`);
    console.log(`EVIDENCE DIGEST: ${evidenceDigest}`);
    console.log('============================================================\n');
  }

  return {
    success: refResult.allPassed && allMutantsKilled,
    refPassed: refResult.allPassed,
    allMutantsKilled,
    evidence: evidenceData,
  };
}

// Allow direct CLI execution: node evaluation/harness.js
if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve('evaluation/harness.js')) {
  runBenchmark()
    .then((res) => {
      process.exit(res.success ? 0 : 1);
    })
    .catch((err) => {
      console.error(err);
      process.exit(1);
    });
}
