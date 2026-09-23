import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { StorageManager } from '../../src/core/storage.js';
import { RegisterManager, validateRegisterName } from '../../src/core/registers.js';
import { ExitCode, LedgerError } from '../../src/core/errors.js';

describe('Named Registers (Unit)', () => {
  let tempDir;
  let storage;
  let registerManager;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-ledger-reg-unit-'));
    storage = new StorageManager(tempDir);
    storage.initLedger('reg_test_run');
    registerManager = new RegisterManager(storage);
  });

  afterEach(() => {
    if (fs.existsSync(tempDir)) {
      try {
        fs.rmSync(tempDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
      } catch {}
    }
  });

  it('validates register names strictly matching ^[a-zA-Z0-9]$', () => {
    // Valid names
    for (const valid of ['a', 'Z', '0', '9', 'x']) {
      assert.doesNotThrow(() => validateRegisterName(valid));
    }

    // Invalid names
    for (const invalid of ['', 'ab', '12', 'a_b', 'reg1', 'a/', '..', ' ', '\n', '$', '-']) {
      assert.throws(
        () => validateRegisterName(invalid),
        (err) => err instanceof LedgerError && err.exitCode === ExitCode.USAGE_OR_NOT_FOUND
      );
    }
  });

  it('preserves arbitrary binary contents (null bytes, high bytes, un-encoded bytes)', () => {
    // Arbitrary binary buffer
    const binaryData = Buffer.from([0x00, 0x01, 0xff, 0xfe, 0x80, 0x7f, 0x0a, 0x00, 0x41]);
    const srcFile = path.join(tempDir, 'binary.bin');
    fs.writeFileSync(srcFile, binaryData);

    const written = registerManager.put('b', srcFile);
    assert.equal(written, binaryData.length);

    const retrieved = registerManager.get('b');
    assert.ok(Buffer.isBuffer(retrieved));
    assert.equal(Buffer.compare(retrieved, binaryData), 0);
  });

  it('overwrites existing register atomically', () => {
    const f1 = path.join(tempDir, 'f1.bin');
    const f2 = path.join(tempDir, 'f2.bin');
    fs.writeFileSync(f1, Buffer.from('hello'));
    fs.writeFileSync(f2, Buffer.from('world'));

    registerManager.put('a', f1);
    assert.equal(registerManager.get('a').toString('utf8'), 'hello');

    registerManager.put('a', f2);
    assert.equal(registerManager.get('a').toString('utf8'), 'world');
  });

  it('throws ExitCode.USAGE_OR_NOT_FOUND when source file does not exist', () => {
    assert.throws(
      () => registerManager.put('a', path.join(tempDir, 'nonexistent.bin')),
      (err) => err instanceof LedgerError && err.exitCode === ExitCode.USAGE_OR_NOT_FOUND
    );
  });

  it('throws ExitCode.USAGE_OR_NOT_FOUND when register does not exist', () => {
    assert.throws(
      () => registerManager.get('x'),
      (err) => err instanceof LedgerError && err.exitCode === ExitCode.USAGE_OR_NOT_FOUND
    );
  });

  it('throws ExitCode.USAGE_OR_NOT_FOUND when register is empty (0 bytes)', () => {
    const emptyFile = path.join(tempDir, 'empty.bin');
    fs.writeFileSync(emptyFile, Buffer.alloc(0));

    registerManager.put('e', emptyFile);

    assert.throws(
      () => registerManager.get('e'),
      (err) => err instanceof LedgerError && err.exitCode === ExitCode.USAGE_OR_NOT_FOUND
    );
  });
});
