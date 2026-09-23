import fs from 'node:fs';
import path from 'node:path';
import { ExitCode, LedgerError } from '../../../../src/core/errors.js';
import { StorageManager } from '../../../../src/core/storage.js';
import { LedgerManager } from '../../../../src/core/ledger.js';
import { initCommand } from '../../../../src/commands/init.js';
import { checkpointCommand } from '../../../../src/commands/checkpoint.js';
import { branchCommand } from '../../../../src/commands/branch.js';
import { replayCommand } from '../../../../src/commands/replay.js';
import { recoverCommand } from '../../../../src/commands/recover.js';
import { registerPutCommand } from '../../../../src/commands/register_put.js';
import { registerGetCommand } from '../../../../src/commands/register_get.js';
import { statusCommand } from '../../../../src/commands/status.js';
import { exportCommand } from '../../../../src/commands/export.js';

// DEFECT: Bypasses authoritative OS-level POSIX flock completely
async function mutantAppendCommand(args = [], options = {}) {
  const eventJsonPath = args[0];
  if (!eventJsonPath) {
    throw new LedgerError(ExitCode.USAGE_OR_NOT_FOUND, 'Usage: agent-ledger append <event_json_path>');
  }

  const storage = new StorageManager(options.cwd);
  if (!storage.isInitialized()) {
    throw new LedgerError(ExitCode.USAGE_OR_NOT_FOUND, 'Error: Repository not initialized in ' + storage.baseDir);
  }

  const resolvedPath = path.isAbsolute(eventJsonPath)
    ? eventJsonPath
    : path.resolve(options.cwd || process.cwd(), eventJsonPath);

  if (!fs.existsSync(resolvedPath)) {
    throw new LedgerError(ExitCode.VALIDATION_ERROR, `Error: Event JSON file '${eventJsonPath}' does not exist`);
  }

  let candidateEvent;
  try {
    candidateEvent = JSON.parse(fs.readFileSync(resolvedPath, 'utf8'));
  } catch {
    throw new LedgerError(ExitCode.VALIDATION_ERROR, `Error: Event JSON file '${eventJsonPath}' contains invalid JSON`);
  }

  const ledger = new LedgerManager(storage);
  // DEFECT: Omission of POSIX flock - directly appending without acquiring OS advisory lock!
  const appendedRecord = ledger.append(candidateEvent);

  return {
    exitCode: ExitCode.SUCCESS,
    message: `Appended event '${appendedRecord.event_id}' (seq: ${appendedRecord.seq_num}, type: ${appendedRecord.type})`,
  };
}

const COMMANDS = {
  init: initCommand,
  append: mutantAppendCommand,
  checkpoint: checkpointCommand,
  branch: branchCommand,
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
