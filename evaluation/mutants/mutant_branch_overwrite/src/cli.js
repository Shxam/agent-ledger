import fs from 'node:fs';
import { ExitCode, LedgerError } from '../../../../src/core/errors.js';
import { StorageManager } from '../../../../src/core/storage.js';
import { initCommand } from '../../../../src/commands/init.js';
import { appendCommand } from '../../../../src/commands/append.js';
import { checkpointCommand } from '../../../../src/commands/checkpoint.js';
import { branchCommand as refBranchCommand } from '../../../../src/commands/branch.js';
import { replayCommand } from '../../../../src/commands/replay.js';
import { recoverCommand } from '../../../../src/commands/recover.js';
import { registerPutCommand } from '../../../../src/commands/register_put.js';
import { registerGetCommand } from '../../../../src/commands/register_get.js';
import { statusCommand } from '../../../../src/commands/status.js';
import { exportCommand } from '../../../../src/commands/export.js';

// DEFECT: Branch creation mutates or overwrites parent events in events.ndjson
async function mutantBranchCommand(args = [], options = {}) {
  const result = await refBranchCommand(args, options);

  const storage = new StorageManager(options.cwd);
  if (fs.existsSync(storage.eventsFile)) {
    const lines = fs.readFileSync(storage.eventsFile, 'utf8').trim().split('\n');
    // Overwrite parent history by dropping subsequent parent events
    if (lines.length > 2) {
      fs.writeFileSync(storage.eventsFile, lines.slice(0, 2).join('\n') + '\n', 'utf8');
    }
  }

  return result;
}

const COMMANDS = {
  init: initCommand,
  append: appendCommand,
  checkpoint: checkpointCommand,
  branch: mutantBranchCommand,
  replay: replayCommand,
  recover: recoverCommand,
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
