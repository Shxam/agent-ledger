import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import {
  parseScoringYaml,
  validateScoringConfig,
  computeWeightedScore,
  SCORE_BEARING_CHECKS,
} from '../../evaluation/scoring/scoring_config.js';
import { canonicalJson } from '../../src/core/canonical_json.js';
import { FORBIDDEN_PRIVACY_PATTERNS } from '../../evaluation/gates/check_privacy.js';

describe('Benchmark Acceptance Gates & Scoring (Unit Tests)', () => {
  const validYaml = `
version: "1.0"
checks:
  - id: CHECK-SCHEMA-001
    name: Schema & Causal Ordering
    weight: 0.20
  - id: CHECK-CRASH-001
    name: Torn-Write Crash Recovery
    weight: 0.15
  - id: CHECK-REPLAY-001
    name: Deterministic Replay & Virtualization
    weight: 0.20
  - id: CHECK-DRIFT-001
    name: Cryptographic Drift & Tamper Detection
    weight: 0.15
  - id: CHECK-BRANCH-001
    name: Speculative Branch DAG Isolation
    weight: 0.15
  - id: CHECK-LOCK-001
    name: POSIX Advisory Locking
    weight: 0.15
`;

  it('correctly parses and validates standard scoring.yml', () => {
    const parsed = parseScoringYaml(validYaml);
    assert.strictEqual(parsed.checks.length, 6);

    const validated = validateScoringConfig(parsed);
    assert.strictEqual(validated.valid, true);
    assert.strictEqual(typeof validated.hash, 'string');
    assert.strictEqual(validated.hash.length, 64);
  });

  it('rejects duplicate check IDs in scoring configuration', () => {
    const duplicateYaml = `
checks:
  - id: CHECK-SCHEMA-001
    weight: 0.5
  - id: CHECK-SCHEMA-001
    weight: 0.5
`;
    const parsed = parseScoringYaml(duplicateYaml);
    assert.throws(
      () => validateScoringConfig(parsed),
      /Duplicate check ID detected/
    );
  });

  it('rejects missing or non-numeric check weights', () => {
    const missingWeight = {
      checks: [
        { id: 'CHECK-SCHEMA-001', weight: null },
      ],
    };
    assert.throws(
      () => validateScoringConfig(missingWeight),
      /missing a valid numeric 'weight'/
    );
  });

  it('rejects negative check weights', () => {
    const negativeWeight = {
      checks: [
        { id: 'CHECK-SCHEMA-001', weight: -0.2 },
      ],
    };
    assert.throws(
      () => validateScoringConfig(negativeWeight),
      /Negative weight detected/
    );
  });

  it('rejects weights greater than 1.0', () => {
    const overWeight = {
      checks: [
        { id: 'CHECK-SCHEMA-001', weight: 1.5 },
      ],
    };
    assert.throws(
      () => validateScoringConfig(overWeight),
      /Weight exceeds 1.0/
    );
  });

  it('rejects total weight != 1.0 using exact integer basis-point arithmetic', () => {
    const invalidSum = {
      checks: [
        { id: 'CHECK-SCHEMA-001', weight: 0.20 },
        { id: 'CHECK-CRASH-001', weight: 0.15 },
        { id: 'CHECK-REPLAY-001', weight: 0.20 },
        { id: 'CHECK-DRIFT-001', weight: 0.15 },
        { id: 'CHECK-BRANCH-001', weight: 0.15 },
        { id: 'CHECK-LOCK-001', weight: 0.10 }, // Total = 0.95
      ],
    };
    assert.throws(
      () => validateScoringConfig(invalidSum),
      /Total weight must equal exactly 1.0/
    );
  });

  it('rejects scoring configuration missing one of the six score-bearing checks', () => {
    const missingCheck = {
      checks: [
        { id: 'CHECK-SCHEMA-001', weight: 0.25 },
        { id: 'CHECK-CRASH-001', weight: 0.25 },
        { id: 'CHECK-REPLAY-001', weight: 0.25 },
        { id: 'CHECK-DRIFT-001', weight: 0.25 },
        // CHECK-BRANCH-001 and CHECK-LOCK-001 missing
      ],
    };
    assert.throws(
      () => validateScoringConfig(missingCheck),
      /Missing required score-bearing check/
    );
  });

  it('calculates deterministic weighted scores: 100% when all pass, exact fraction when partial', () => {
    const parsed = parseScoringYaml(validYaml);
    const validated = validateScoringConfig(parsed);

    // All pass
    const allPassResults = SCORE_BEARING_CHECKS.map((id) => ({ checkId: id, passed: true }));
    const allPassScore = computeWeightedScore(allPassResults, validated.config);
    assert.strictEqual(allPassScore.totalScore, 1.0);
    assert.strictEqual(allPassScore.totalScorePercent, '100.00%');
    assert.strictEqual(allPassScore.allPassed, true);

    // Partial pass: only CHECK-SCHEMA-001 (0.20) and CHECK-REPLAY-001 (0.20) pass = 0.40 (40.00%)
    const partialResults = SCORE_BEARING_CHECKS.map((id) => ({
      checkId: id,
      passed: id === 'CHECK-SCHEMA-001' || id === 'CHECK-REPLAY-001',
    }));
    const partialScore = computeWeightedScore(partialResults, validated.config);
    assert.strictEqual(partialScore.totalScore, 0.40);
    assert.strictEqual(partialScore.totalScorePercent, '40.00%');
    assert.strictEqual(partialScore.allPassed, false);

    // All fail
    const allFailResults = SCORE_BEARING_CHECKS.map((id) => ({ checkId: id, passed: false }));
    const allFailScore = computeWeightedScore(allFailResults, validated.config);
    assert.strictEqual(allFailScore.totalScore, 0.0);
    assert.strictEqual(allFailScore.totalScorePercent, '0.00%');
    assert.strictEqual(allFailScore.allPassed, false);
  });

  it('privacy filter detects all forbidden private tokens and regex patterns', () => {
    const leakSample1 = 'Let us execute CHECK-SCHEMA-001 against the target';
    const leakSample2 = 'Evaluating MUTANT-TAIL-CRASH in verifier';
    const cleanSample = 'This is the public agent-ledger specification for autonomous execution';

    const testMatch = (text) => {
      for (const pattern of FORBIDDEN_PRIVACY_PATTERNS) {
        if (pattern instanceof RegExp && pattern.test(text)) return true;
        if (typeof pattern === 'string' && text.includes(pattern)) return true;
      }
      return false;
    };

    assert.strictEqual(testMatch(leakSample1), true);
    assert.strictEqual(testMatch(leakSample2), true);
    assert.strictEqual(testMatch(cleanSample), false);
  });

  it('guarantees byte-for-byte canonical serialization and evidence digest reproducibility', () => {
    const sampleObj1 = {
      benchmark_version: '1.0.0',
      reference_score: '100.00%',
      overall_acceptance: 'PASS',
      z_field: 42,
      a_field: 'alphabetical',
    };
    const sampleObj2 = {
      a_field: 'alphabetical',
      overall_acceptance: 'PASS',
      benchmark_version: '1.0.0',
      z_field: 42,
      reference_score: '100.00%',
    };

    const canon1 = canonicalJson(sampleObj1);
    const canon2 = canonicalJson(sampleObj2);
    assert.strictEqual(canon1, canon2);

    const hash1 = crypto.createHash('sha256').update(canon1).digest('hex');
    const hash2 = crypto.createHash('sha256').update(canon2).digest('hex');
    assert.strictEqual(hash1, hash2);
  });
});
