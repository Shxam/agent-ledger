import fs from 'node:fs';
import { ExitCode, LedgerError } from '../../../../src/core/errors.js';
import { StorageManager } from '../../../../src/core/storage.js';
import { initCommand } from '../../../../src/commands/init.js';
import { appendCommand } from '../../../../src/commands/append.js';
import { checkpointCommand } from '../../../../src/commands/checkpoint.js';
import { branchCommand } from '../../../../src/commands/branch.js';
import { replayCommand } from '../../../../src/commands/replay.js';
import { registerPutCommand } from '../../../../src/commands/register_put.js';
import { registerGetCommand } from '../../../../src/commands/register_get.js';
import { statusCommand } from '../../../../src/commands/status.js';
import { exportCommand } from '../../../../src/commands/export.js';

async function mutantRecoverCommand(args = [], options = {}) {
  const storage = new StorageManager(options.cwd);
  if (!storage.isInitialized()) {
    throw new LedgerError(ExitCode.USAGE_OR_NOT_FOUND, 'Error: Repository not initialized');
  }

  if (fs.existsSync(storage.eventsFile)) {
    const raw = fs.readFileSync(storage.eventsFile, 'utf8');
    // DEFECT: Naively parsing entire log at once without torn-tail scanning or descriptor truncation
    const lines = raw.split('\n');
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i].trim();
      if (line.length === 0) continue;
      try {
        JSON.parse(line);
      } catch (err) {
        // Crashes with error instead of truncating damaged tail at descriptor level
        throw new LedgerError(ExitCode.VALIDATION_ERROR, `Crash: Failed to parse log record at line ${i + 1}: ${err.message}`);
      }
    }
  }

  return { exitCode: ExitCode.SUCCESS, message: 'Recovery completed.' };
}

const COMMANDS = {
  init: initCommand,
  append: appendCommand,
  checkpoint: checkpointCommand,
  branch: branchCommand,
  replay: replayCommand,
  recover: mutantRecoverCommand,
  'register-put': registerPutCommand,
  'register-get': registerGetCommand,
  status: statusCommand,
  export: exportCommand,
};

export async function runCli(argv = process.argv.slice(2), options = {}) {
  const [commandName, ...args] = argv;
  if (!commandName || commandName === '--help' || commandName === '-h') {
    process.stderr.write('Usage: agent-ledger <command> [options]\n');
    return ExitCode.USAGE_OR_NOT_FOUND;
  }

  const commandHandler = COMMANDS[commandName];
  if (!commandHandler) {
    process.stderr.write(`Error: Unknown command '${commandName}'\n`);
    return ExitCode.USAGE_OR_NOT_FOUND;
  }

  try {
    const result = await commandHandler(args, options);
    if (result && result.message && result.message.length > 0) {
      process.stdout.write(result.message + '\n');
    }
    return result.exitCode !== undefined ? result.exitCode : ExitCode.SUCCESS;
  } catch (err) {
    const exitCode = err.exitCode !== undefined ? err.exitCode : ExitCode.USAGE_OR_NOT_FOUND;
    process.stderr.write((err.message || String(err)) + '\n');
    return exitCode;
  }
}
