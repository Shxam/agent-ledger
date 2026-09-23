import path from 'node:path';
import fs from 'node:fs';
import { runReferenceCheck } from './check_reference.js';
import { canonicalJson } from '../../src/core/canonical_json.js';
import { runCli, createTempWorkspace, cleanTempWorkspace } from '../verifier/runner.js';

/**
 * Executes the Determinism Gate:
 * Runs the complete scoring/verifier pipeline 3 times using identical frozen inputs and state.
 * Verifies byte-for-byte deterministic equality for:
 * - per-check scores
 * - weighted total
 * - reference result
 * - verifier output
 * - exported JSON
 * - canonical evidence
 * - scoring summary
 *
 * @param {object} [options]
 * @param {number} [options.runs=3]
 * @param {boolean} [options.verbose=true]
 * @returns {Promise<{
 *   success: boolean,
 *   runs: number,
 *   result: 'PASS' | 'FAIL',
 *   details: object
 * }>}
 */
export async function runDeterminismCheck(options = {}) {
  const verbose = options.verbose !== false;
  const numRuns = options.runs || 3;
  const runsData = [];

  const refBin = path.resolve('bin/agent-ledger');

  for (let runIdx = 1; runIdx <= numRuns; runIdx++) {
    // 1. Run reference check (scores, checks, verifier)
    const refRes = await runReferenceCheck({ referenceBin: refBin, verbose: false });

    // 2. Run export test on a frozen benchmark state to verify byte-for-byte export determinism
    const ws = createTempWorkspace(`det-run-${runIdx}`);
    let exportOutput = '';
    try {
      await runCli(refBin, ['init', 'det_run'], { cwd: ws });

      // Populate with frozen deterministic event log
      const fixedEvent = {
        event_id: 'evt_det_001',
        seq_num: 1,
        run_id: 'det_run',
        branch: 'main',
        timestamp: '2026-09-24T00:00:00.000Z',
        timestamp_ms: 1774396800000,
        type: 'run_started',
        prev_hash: 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
        payload: { task: 'determinism_test' },
      };

      const eventsFile = path.join(ws, '.agent-ledger', 'events.ndjson');
      fs.writeFileSync(eventsFile, JSON.stringify(fixedEvent) + '\n', 'utf8');

      // Update branch head
      const branchFile = path.join(ws, '.agent-ledger', 'branches', 'main.json');
      fs.writeFileSync(
        branchFile,
        JSON.stringify({
          name: 'main',
          head_seq_num: 1,
          head_event_id: 'evt_det_001',
          head_event_hash: 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
        }),
        'utf8'
      );

      const expRes = await runCli(refBin, ['export', '--format', 'json'], { cwd: ws });
      exportOutput = expRes.stdout.trim();
    } finally {
      cleanTempWorkspace(ws);
    }

    const runSnapshot = {
      score: refRes.score,
      scorePercent: refRes.scorePercent,
      result: refRes.result,
      scoringHash: refRes.scoringHash,
      checkResults: refRes.checkResults,
      exportedJson: exportOutput,
      canonicalSummary: canonicalJson({
        score: refRes.score,
        result: refRes.result,
        scoringHash: refRes.scoringHash,
        checks: refRes.checkResults,
      }),
    };

    runsData.push(runSnapshot);
  }

  // Verify byte-for-byte equality across all runs
  const baseline = runsData[0];
  const baselineCanonical = canonicalJson(baseline);
  let isDeterministic = true;
  let divergenceReason = null;

  for (let i = 1; i < runsData.length; i++) {
    const current = runsData[i];
    const currentCanonical = canonicalJson(current);

    if (currentCanonical !== baselineCanonical) {
      isDeterministic = false;
      divergenceReason = `Run ${i + 1} diverged from baseline Run 1:\nBaseline: ${baselineCanonical}\nCurrent:  ${currentCanonical}`;
      break;
    }
  }

  const resultStatus = isDeterministic ? 'PASS' : 'FAIL';

  if (verbose) {
    console.log(`DETERMINISM: ${resultStatus}`);
    console.log(`REPEATED RUNS: ${numRuns}`);
    if (!isDeterministic && divergenceReason) {
      console.error(divergenceReason);
    }
  }

  return {
    success: isDeterministic,
    runs: numRuns,
    result: resultStatus,
    divergenceReason,
  };
}

// Allow direct execution: node evaluation/gates/check_determinism.js
if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve('evaluation/gates/check_determinism.js')) {
  runDeterminismCheck()
    .then((res) => {
      process.exit(res.success ? 0 : 1);
    })
    .catch((err) => {
      console.error('DETERMINISM CHECK ERROR:', err.message);
      process.exit(1);
    });
}
