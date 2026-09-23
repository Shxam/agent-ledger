import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { runCli } from '../../src/cli.js';
import { ExitCode } from '../../src/core/errors.js';
import { LockArbiter } from '../../src/core/lock.js';

describe('CLI: agent-ledger register-put / register-get', () => {
  let tempDir;
  const runId = 'test_reg_cli';

  beforeEach(async () => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-ledger-reg-cli-'));
    await runCli(['init', runId], { cwd: tempDir });
  });

  afterEach(() => {
    if (fs.existsSync(tempDir)) {
      try {
        fs.rmSync(tempDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
      } catch {}
    }
  });

  it('puts binary data into single-character register and gets exact bytes back (exit 0)', async () => {
    const binaryData = Buffer.from([0x00, 0xde, 0xad, 0xbe, 0xef, 0xff, 0x0a]);
    const srcPath = path.join(tempDir, 'fixture.bin');
    fs.writeFileSync(srcPath, binaryData);

    const putCode = await runCli(['register-put', '--reg', 'a', srcPath], { cwd: tempDir });
    assert.equal(putCode, ExitCode.SUCCESS);

    const blobPath = path.join(tempDir, '.agent-ledger', 'registers', 'reg_a.blob');
    assert.ok(fs.existsSync(blobPath));

    const blobContent = fs.readFileSync(blobPath);
    assert.equal(Buffer.compare(blobContent, binaryData), 0);

    // Capture stdout for register-get
    let captured = [];
    const origWrite = process.stdout.write;
    process.stdout.write = (chunk) => {
      captured.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
      return true;
    };

    try {
      const getCode = await runCli(['register-get', '--reg', 'a'], { cwd: tempDir });
      assert.equal(getCode, ExitCode.SUCCESS);
      const combined = Buffer.concat(captured);
      assert.equal(Buffer.compare(combined, binaryData), 0);
    } finally {
      process.stdout.write = origWrite;
    }
  });

  it('rejects invalid register names with ExitCode.USAGE_OR_NOT_FOUND (exit 1)', async () => {
    const srcPath = path.join(tempDir, 'file.txt');
    fs.writeFileSync(srcPath, 'test');

    for (const badName of ['ab', '', '12', 'reg_a', 'a/b', '..', '$', '-']) {
      const putCode = await runCli(['register-put', '--reg', badName, srcPath], { cwd: tempDir });
      assert.equal(putCode, ExitCode.USAGE_OR_NOT_FOUND);

      const getCode = await runCli(['register-get', '--reg', badName], { cwd: tempDir });
      assert.equal(getCode, ExitCode.USAGE_OR_NOT_FOUND);
    }
  });

  it('rejects missing source file with ExitCode.USAGE_OR_NOT_FOUND (exit 1)', async () => {
    const putCode = await runCli(['register-put', '--reg', '1', 'nonexistent_file.bin'], { cwd: tempDir });
    assert.equal(putCode, ExitCode.USAGE_OR_NOT_FOUND);
  });

  it('rejects nonexistent or empty register on register-get with ExitCode.USAGE_OR_NOT_FOUND (exit 1)', async () => {
    const getCode = await runCli(['register-get', '--reg', 'z'], { cwd: tempDir });
    assert.equal(getCode, ExitCode.USAGE_OR_NOT_FOUND);

    // Empty file
    const emptyPath = path.join(tempDir, 'empty.txt');
    fs.writeFileSync(emptyPath, '');
    await runCli(['register-put', '--reg', 'e', emptyPath], { cwd: tempDir });

    const getEmptyCode = await runCli(['register-get', '--reg', 'e'], { cwd: tempDir });
    assert.equal(getEmptyCode, ExitCode.USAGE_OR_NOT_FOUND);
  });

  it('blocks register-put with ExitCode.LOCK_CONTENTION (exit 3) during active lock contention', async () => {
    const lockPath = path.join(tempDir, '.agent-ledger', 'locks', 'ledger.lock');
    const arbiter = new LockArbiter(lockPath);
    await arbiter.acquire('holding_lock');

    const srcPath = path.join(tempDir, 'file.txt');
    fs.writeFileSync(srcPath, 'data');

    try {
      const code = await runCli(['register-put', '--reg', 'c', srcPath], { cwd: tempDir });
      assert.equal(code, ExitCode.LOCK_CONTENTION);
    } finally {
      arbiter.release();
    }
  });
});
