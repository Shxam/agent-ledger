import fs from 'node:fs';
import { ExitCode, LedgerError } from '../../../../src/core/errors.js';
import { StorageManager } from '../../../../src/core/storage.js';
import { canonicalJson } from '../../../../src/core/canonical_json.js';
import { initCommand } from '../../../../src/commands/init.js';
import { appendCommand } from '../../../../src/commands/append.js';
import { checkpointCommand } from '../../../../src/commands/checkpoint.js';
import { branchCommand } from '../../../../src/commands/branch.js';
import { replayCommand } from '../../../../src/commands/replay.js';
import { recoverCommand } from '../../../../src/commands/recover.js';
import { registerPutCommand } from '../../../../src/commands/register_put.js';
import { registerGetCommand } from '../../../../src/commands/register_get.js';

// DEFECT: Read paths bypass SHA-256 hash chain verification completely
async function mutantStatusCommand(args = [], options = {}) {
  const isJson = args.includes('--json');
  const storage = new StorageManager(options.cwd);
  if (!storage.isInitialized()) {
    throw new LedgerError(ExitCode.USAGE_OR_NOT_FOUND, 'Error: Repository not initialized');
  }

  const config = storage.readConfig();
  let totalEvents = 0;
  if (fs.existsSync(storage.eventsFile)) {
    const lines = fs.readFileSync(storage.eventsFile, 'utf8').trim().split('\n');
    totalEvents = lines.filter((l) => l.trim().length > 0).length;
  }

  const statusObj = {
    run_id: config.run_id,
    branch: config.active_branch,
    total_events: totalEvents,
    last_checkpoint_id: 'none',
    open_tool_calls: 0,
  };

  const message = isJson
    ? canonicalJson(statusObj)
    : `Run ID: ${statusObj.run_id}\nBranch: ${statusObj.branch}\nTotal Events: ${statusObj.total_events}\nLast Checkpoint: ${statusObj.last_checkpoint_id}\nOpen Tool Calls: 0`;

  return { exitCode: ExitCode.SUCCESS, message };
}

async function mutantExportCommand(args = [], options = {}) {
  const storage = new StorageManager(options.cwd);
  if (!storage.isInitialized()) {
    throw new LedgerError(ExitCode.USAGE_OR_NOT_FOUND, 'Error: Repository not initialized');
  }

  const config = storage.readConfig();
  const branches = { [config.active_branch]: { events: [] } };
  if (fs.existsSync(storage.eventsFile)) {
    const lines = fs.readFileSync(storage.eventsFile, 'utf8').trim().split('\n');
    for (const l of lines) {
      if (l.trim().length === 0) continue;
      // Blindly parses without SHA-256 chain verification!
      const evt = JSON.parse(l);
      if (!branches[evt.branch]) branches[evt.branch] = { events: [] };
      branches[evt.branch].events.push(evt);
    }
  }

  const exportObj = {
    schema_version: '1.0.0',
    run_id: config.run_id,
    active_branch: config.active_branch,
    branches,
    checkpoints: [],
    tool_interactions: [],
    files_modified: {},
    tests_summary: { passed: 0, failed: 0, total_runs: 0 },
    completed: false,
  };

  return { exitCode: ExitCode.SUCCESS, message: canonicalJson(exportObj) };
}

const COMMANDS = {
  init: initCommand,
  append: appendCommand,
  checkpoint: checkpointCommand,
  branch: branchCommand,
  replay: replayCommand,
  recover: recoverCommand,
  'register-put': registerPutCommand,
  'register-get': registerGetCommand,
  status: mutantStatusCommand,
  export: mutantExportCommand,
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
