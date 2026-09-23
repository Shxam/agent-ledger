import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { writeAtomicSync, writeJsonAtomicSync } from '../../src/core/fs_atomic.js';

describe('Atomic File Writing Utility', () => {
  let tempDir;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-ledger-atomic-test-'));
  });

  afterEach(() => {
    if (fs.existsSync(tempDir)) {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it('atomically creates a file with correct content', () => {
    const target = path.join(tempDir, 'sample.txt');
    writeAtomicSync(target, 'Hello Atomic World\n');

    assert.ok(fs.existsSync(target));
    assert.equal(fs.readFileSync(target, 'utf8'), 'Hello Atomic World\n');
  });

  it('atomically overwrites an existing file', () => {
    const target = path.join(tempDir, 'replace.txt');
    writeAtomicSync(target, 'Initial Content\n');
    writeAtomicSync(target, 'Replaced Content\n');

    assert.equal(fs.readFileSync(target, 'utf8'), 'Replaced Content\n');
  });

  it('writes JSON deterministically and atomically', () => {
    const target = path.join(tempDir, 'data.json');
    const data = { z: 10, a: 1, nested: { y: 2, x: 1 } };

    writeJsonAtomicSync(target, data);

    const raw = fs.readFileSync(target, 'utf8');
    assert.equal(raw, '{"a":1,"nested":{"x":1,"y":2},"z":10}\n');
  });

  it('leaves no temporary files behind in target directory', () => {
    const target = path.join(tempDir, 'cleanup.json');
    writeJsonAtomicSync(target, { status: 'ok' });

    const files = fs.readdirSync(tempDir);
    assert.equal(files.length, 1);
    assert.equal(files[0], 'cleanup.json');
  });

  it('creates parent directory if it does not exist', () => {
    const target = path.join(tempDir, 'sub', 'nested', 'doc.txt');
    writeAtomicSync(target, 'nested content');

    assert.ok(fs.existsSync(target));
    assert.equal(fs.readFileSync(target, 'utf8'), 'nested content');
  });
});
