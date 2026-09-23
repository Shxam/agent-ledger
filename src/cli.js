import { ExitCode, LedgerError } from './core/errors.js';
import { initCommand } from './commands/init.js';
import { appendCommand } from './commands/append.js';
import { checkpointCommand } from './commands/checkpoint.js';
import { branchCommand } from './commands/branch.js';
import { replayCommand } from './commands/replay.js';
import { recoverCommand } from './commands/recover.js';
import { registerPutCommand } from './commands/register_put.js';
import { registerGetCommand } from './commands/register_get.js';
import { statusCommand } from './commands/status.js';
import { exportCommand } from './commands/export.js';

/**
 * Command registry for agent-ledger CLI.
 */
const COMMANDS = {
  init: initCommand,
  append: appendCommand,
  checkpoint: checkpointCommand,
  branch: branchCommand,
  replay: replayCommand,
  recover: recoverCommand,
  'register-put': registerPutCommand,
  'register-get': registerGetCommand,
  status: statusCommand,
  export: exportCommand,
};

/**
 * Prints CLI usage information to stderr.
 */
function printUsage() {
  process.stderr.write(
    'Usage: agent-ledger <command> [options]\n\n' +
    'Available commands:\n' +
    '  init [run_id]                                 Initialize a new agent execution ledger\n' +
    '  append <event_json_path>                      Append a validated event to active branch\n' +
    '  checkpoint --id <checkpoint_id>               Create an immutable state checkpoint\n' +
    '  branch --from <checkpoint_id> --name <branch> Fork a new branch from a checkpoint\n' +
    '  replay --from <checkpoint_id> [--step <cnt>]  Replay state deterministically from a checkpoint\n' +
    '  recover                                       Recover ledger from crash and torn trailing bytes\n' +
    '  register-put --reg <name> <file_path>         Save raw binary blob to named scratch register\n' +
    '  register-get --reg <name>                     Stream raw binary content of register to stdout\n' +
    '  status [--json]                               Display current workspace status\n' +
    '  export --format json                          Export canonical execution trace to stdout\n'
  );
}

/**
 * Main CLI execution entry point.
 *
 * @param {string[]} [argv] CLI argument array (defaults to process.argv.slice(2))
 * @param {object} [options] Options for execution environment
 * @param {string} [options.cwd]
 * @returns {number} Exit code
 */
export async function runCli(argv = process.argv.slice(2), options = {}) {
  const [commandName, ...args] = argv;

  if (!commandName || commandName === '--help' || commandName === '-h') {
    printUsage();
    return ExitCode.USAGE_OR_NOT_FOUND;
  }

  const handler = COMMANDS[commandName];
  if (!handler) {
    process.stderr.write(`Error: Unknown command '${commandName}'\n\n`);
    printUsage();
    return ExitCode.USAGE_OR_NOT_FOUND;
  }

  try {
    const result = await handler(args, options);
    if (result && result.message) {
      process.stdout.write(result.message + '\n');
    }
    return result && typeof result.exitCode === 'number' ? result.exitCode : ExitCode.SUCCESS;
  } catch (err) {
    if (err instanceof LedgerError) {
      process.stderr.write(err.message + '\n');
      return err.exitCode;
    }
    process.stderr.write(`Internal Error: ${err.message || String(err)}\n`);
    return ExitCode.USAGE_OR_NOT_FOUND;
  }
}

import { fileURLToPath } from 'node:url';
import path from 'node:path';

// When invoked directly as a standalone script
if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  const code = await runCli();
  process.exit(code);
}
