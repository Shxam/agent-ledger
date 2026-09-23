import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { canonicalJson } from '../../src/core/canonical_json.js';

export const SCORE_BEARING_CHECKS = [
  'CHECK-SCHEMA-001',
  'CHECK-CRASH-001',
  'CHECK-REPLAY-001',
  'CHECK-DRIFT-001',
  'CHECK-BRANCH-001',
  'CHECK-LOCK-001',
];

/**
 * Basic deterministic YAML parser for scoring.yml
 * Parses simple key-value and list structures without external dependencies.
 *
 * @param {string} content
 * @returns {object}
 */
export function parseScoringYaml(content) {
  if (typeof content !== 'string' || content.trim().length === 0) {
    throw new Error('Scoring configuration file is empty');
  }

  const lines = content.split(/\r?\n/);
  const result = { checks: [] };
  let currentCheck = null;

  for (let i = 0; i < lines.length; i++) {
    const rawLine = lines[i];
    const stripped = rawLine.replace(/#.*$/, '').trimEnd();
    if (!stripped.trim()) continue;

    const trimmed = stripped.trim();

    if (trimmed.startsWith('version:')) {
      result.version = trimmed.replace('version:', '').trim().replace(/^["']|["']$/g, '');
      continue;
    }

    if (trimmed.startsWith('description:')) {
      result.description = trimmed.replace('description:', '').trim().replace(/^["']|["']$/g, '');
      continue;
    }

    if (trimmed.startsWith('checks:')) {
      continue;
    }

    // List item start
    if (trimmed.startsWith('-')) {
      currentCheck = {};
      result.checks.push(currentCheck);
      const rest = trimmed.substring(1).trim();
      if (rest) {
        const colonIdx = rest.indexOf(':');
        if (colonIdx !== -1) {
          const key = rest.substring(0, colonIdx).trim();
          const val = rest.substring(colonIdx + 1).trim().replace(/^["']|["']$/g, '');
          currentCheck[key] = key === 'weight' ? Number(val) : val;
        }
      }
      continue;
    }

    // Key-value inside list item
    if (currentCheck && rawLine.search(/\S/) > 0) {
      const colonIdx = trimmed.indexOf(':');
      if (colonIdx !== -1) {
        const key = trimmed.substring(0, colonIdx).trim();
        const val = trimmed.substring(colonIdx + 1).trim().replace(/^["']|["']$/g, '');
        currentCheck[key] = key === 'weight' ? Number(val) : val;
      }
    }
  }

  return result;
}

/**
 * Validates the scoring configuration strictly according to benchmark requirements:
 * - Reject missing weights
 * - Reject duplicate check IDs
 * - Reject negative weights
 * - Reject weights greater than 1
 * - Reject total weight != 1.0 using exact integer arithmetic (basis points)
 * - Ensure all score-bearing checks are present
 *
 * @param {object} config
 * @returns {{ valid: boolean, config: object, hash: string }}
 */
export function validateScoringConfig(config) {
  if (!config || !Array.isArray(config.checks) || config.checks.length === 0) {
    throw new Error('Scoring configuration must define a non-empty "checks" list');
  }

  const seenIds = new Set();
  let totalBasisPoints = 0;

  for (let idx = 0; idx < config.checks.length; idx++) {
    const item = config.checks[idx];
    if (!item.id || typeof item.id !== 'string' || item.id.trim().length === 0) {
      throw new Error(`Check at index ${idx} is missing a valid 'id'`);
    }

    const checkId = item.id.trim();

    if (seenIds.has(checkId)) {
      throw new Error(`Duplicate check ID detected in scoring configuration: '${checkId}'`);
    }
    seenIds.add(checkId);

    if (item.weight === undefined || item.weight === null || typeof item.weight !== 'number' || Number.isNaN(item.weight)) {
      throw new Error(`Check '${checkId}' is missing a valid numeric 'weight'`);
    }

    if (item.weight < 0) {
      throw new Error(`Negative weight detected for check '${checkId}': ${item.weight}`);
    }

    if (item.weight > 1.0) {
      throw new Error(`Weight exceeds 1.0 for check '${checkId}': ${item.weight}`);
    }

    // Convert decimal weight to basis points with precision protection (4 decimal places = 10,000 bp)
    const weightBp = Math.round(item.weight * 10000);
    // Verify decimal fidelity
    if (Math.abs(item.weight - weightBp / 10000) > 1e-6) {
      throw new Error(`Check '${checkId}' weight ${item.weight} exceeds 4-decimal precision limit`);
    }

    totalBasisPoints += weightBp;
  }

  // Exact total weight assertion: 10,000 basis points = 1.0000
  if (totalBasisPoints !== 10000) {
    const actualSum = (totalBasisPoints / 10000).toFixed(4);
    throw new Error(
      `Total weight must equal exactly 1.0. Found: ${actualSum} (${totalBasisPoints} / 10000 basis points)`
    );
  }

  // Verify all expected score-bearing checks are present
  for (const expectedId of SCORE_BEARING_CHECKS) {
    if (!seenIds.has(expectedId)) {
      throw new Error(`Missing required score-bearing check in scoring configuration: '${expectedId}'`);
    }
  }

  const canonical = canonicalJson(config);
  const hash = crypto.createHash('sha256').update(canonical, 'utf8').digest('hex');

  return {
    valid: true,
    config,
    hash,
  };
}

/**
 * Loads, parses, and validates scoring.yml from disk.
 *
 * @param {string} [filePath]
 * @returns {{ config: object, hash: string }}
 */
export function loadScoringConfig(filePath) {
  const resolvedPath = path.resolve(filePath || 'scoring.yml');
  if (!fs.existsSync(resolvedPath)) {
    throw new Error(`Scoring configuration file not found at: ${resolvedPath}`);
  }

  const raw = fs.readFileSync(resolvedPath, 'utf8');
  const parsed = parseScoringYaml(raw);
  const validated = validateScoringConfig(parsed);

  return {
    config: validated.config,
    hash: validated.hash,
    raw,
  };
}

/**
 * Computes deterministic weighted score from check results.
 *
 * @param {Array<{ checkId: string, passed: boolean }>} checkResults
 * @param {object} scoringConfig
 * @returns {{
 *   totalScore: number,
 *   totalScorePercent: string,
 *   maxScore: number,
 *   allPassed: boolean,
 *   perCheckScores: Array<{ checkId: string, name: string, weight: number, passed: boolean, weightedScore: number }>
 * }}
 */
export function computeWeightedScore(checkResults, scoringConfig) {
  const resultsMap = new Map();
  for (const res of checkResults) {
    resultsMap.set(res.checkId, res.passed === true);
  }

  let totalBp = 0;
  let allPassed = true;
  const perCheckScores = [];

  for (const item of scoringConfig.checks) {
    const passed = resultsMap.get(item.id) === true;
    if (!passed) {
      allPassed = false;
    }

    const weightBp = Math.round(item.weight * 10000);
    const earnedBp = passed ? weightBp : 0;
    totalBp += earnedBp;

    perCheckScores.push({
      checkId: item.id,
      name: item.name || item.id,
      weight: item.weight,
      passed,
      weightedScore: earnedBp / 10000,
    });
  }

  const totalScore = totalBp / 10000;
  const totalScorePercent = (totalScore * 100).toFixed(2) + '%';

  return {
    totalScore,
    totalScorePercent,
    maxScore: 1.0,
    allPassed,
    perCheckScores,
  };
}
