import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const rootDir = path.resolve(__dirname, '../../');

describe('Benchmark Lifecycle Scaffolding', () => {
  it('has app-setup/build.sh with valid structure', () => {
    const script = path.join(rootDir, 'app-setup', 'build.sh');
    assert.ok(fs.existsSync(script), 'build.sh must exist');
    const content = fs.readFileSync(script, 'utf8');
    assert.ok(content.startsWith('#!/usr/bin/env bash'), 'Must use bash shebang');
    assert.ok(content.includes('chmod +x'), 'Must ensure binary execution permission');
  });

  it('has app-setup/start.sh with valid structure', () => {
    const script = path.join(rootDir, 'app-setup', 'start.sh');
    assert.ok(fs.existsSync(script), 'start.sh must exist');
    const content = fs.readFileSync(script, 'utf8');
    assert.ok(content.startsWith('#!/usr/bin/env bash'), 'Must use bash shebang');
    assert.ok(content.includes('agent-ledger'), 'Must verify agent-ledger executable');
  });

  it('has app-setup/reset.sh with valid structure', () => {
    const script = path.join(rootDir, 'app-setup', 'reset.sh');
    assert.ok(fs.existsSync(script), 'reset.sh must exist');
    const content = fs.readFileSync(script, 'utf8');
    assert.ok(content.startsWith('#!/usr/bin/env bash'), 'Must use bash shebang');
    assert.ok(content.includes('.agent-ledger'), 'Must clean .agent-ledger directory');
  });

  it('has executable entrypoint bin/agent-ledger', () => {
    const binFile = path.join(rootDir, 'bin', 'agent-ledger');
    assert.ok(fs.existsSync(binFile), 'bin/agent-ledger must exist');
    const content = fs.readFileSync(binFile, 'utf8');
    assert.ok(content.startsWith('#!/usr/bin/env node'), 'Must have node shebang');
  });
});
