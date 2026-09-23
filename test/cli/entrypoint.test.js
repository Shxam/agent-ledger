import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { runCli } from '../../src/cli.js';
import { ExitCode } from '../../src/core/errors.js';

describe('CLI Dispatcher & Entrypoint', () => {
  it('returns ExitCode.USAGE_OR_NOT_FOUND when no command is provided', async () => {
    const code = await runCli([]);
    assert.equal(code, ExitCode.USAGE_OR_NOT_FOUND);
  });

  it('returns ExitCode.USAGE_OR_NOT_FOUND for unknown commands', async () => {
    const code = await runCli(['nonexistent-command']);
    assert.equal(code, ExitCode.USAGE_OR_NOT_FOUND);
  });

  it('returns ExitCode.USAGE_OR_NOT_FOUND on --help flag', async () => {
    const code = await runCli(['--help']);
    assert.equal(code, ExitCode.USAGE_OR_NOT_FOUND);
  });
});
