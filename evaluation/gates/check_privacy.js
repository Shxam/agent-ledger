import path from 'node:path';
import fs from 'node:fs';

export const FORBIDDEN_PRIVACY_PATTERNS = [
  'CHECK-SCHEMA-001',
  'CHECK-CRASH-001',
  'CHECK-REPLAY-001',
  'CHECK-DRIFT-001',
  'CHECK-BRANCH-001',
  'CHECK-LOCK-001',
  /MUTANT-[A-Z0-9_\-]+/,
  'evaluation/verifier',
  'evaluation/mutants',
  'evaluation/checks',
  'private check',
  'hidden verification',
];

/**
 * Audits model-facing task materials and workspaces to ensure total privacy isolation.
 *
 * @param {object} [options]
 * @param {string} [options.taskDir]
 * @param {boolean} [options.verbose=true]
 * @returns {Promise<{
 *   success: boolean,
 *   result: 'PASS' | 'FAIL',
 *   violations: string[]
 * }>}
 */
export async function runPrivacyCheck(options = {}) {
  const verbose = options.verbose !== false;
  const taskDir = path.resolve(options.taskDir || 'task');
  const violations = [];

  if (!fs.existsSync(taskDir)) {
    violations.push(`Model task directory not found: ${taskDir}`);
  } else {
    // 1. Scan all files in task directory
    const files = fs.readdirSync(taskDir);
    for (const file of files) {
      const fullPath = path.join(taskDir, file);
      const stat = fs.lstatSync(fullPath);

      if (stat.isSymbolicLink()) {
        const linkTarget = fs.readlinkSync(fullPath);
        violations.push(`Symlink detected in model task directory: ${file} -> ${linkTarget}`);
        continue;
      }

      if (stat.isFile()) {
        const content = fs.readFileSync(fullPath, 'utf8');
        for (const pattern of FORBIDDEN_PRIVACY_PATTERNS) {
          if (pattern instanceof RegExp) {
            const match = content.match(pattern);
            if (match) {
              violations.push(
                `Private token matching pattern '${pattern}' leaked in model task file '${file}': '${match[0]}'`
              );
            }
          } else if (typeof pattern === 'string') {
            if (content.includes(pattern)) {
              violations.push(
                `Private token '${pattern}' found in model task file '${file}'`
              );
            }
          }
        }
      }
    }
  }

  // 2. Verify that private directories exist and are outside task/
  const privateDirs = ['evaluation/verifier', 'evaluation/mutants', 'evaluation/checks'];
  for (const pDir of privateDirs) {
    const absPDir = path.resolve(pDir);
    if (!fs.existsSync(absPDir)) {
      violations.push(`Private benchmark directory missing: ${pDir}`);
    } else {
      const rel = path.relative(taskDir, absPDir);
      if (!rel.startsWith('..')) {
        violations.push(`Private directory ${pDir} is located inside model-facing task directory!`);
      }
    }
  }

  const isPrivate = violations.length === 0;
  const resultStatus = isPrivate ? 'PASS' : 'FAIL';

  if (verbose) {
    if (isPrivate) {
      console.log('PRIVACY: PASS');
    } else {
      console.log('PRIVACY: FAIL');
      for (const v of violations) {
        console.error(`  - Violation: ${v}`);
      }
    }
  }

  return {
    success: isPrivate,
    result: resultStatus,
    violations,
  };
}

// Allow direct execution: node evaluation/gates/check_privacy.js
if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve('evaluation/gates/check_privacy.js')) {
  runPrivacyCheck()
    .then((res) => {
      process.exit(res.success ? 0 : 1);
    })
    .catch((err) => {
      console.error('PRIVACY CHECK ERROR:', err.message);
      process.exit(1);
    });
}
