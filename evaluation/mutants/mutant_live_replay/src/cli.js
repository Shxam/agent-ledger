import { execSync } from 'node:child_process';
import { ExitCode, LedgerError } from '../../../../src/core/errors.js';
import { StorageManager } from '../../../../src/core/storage.js';
import { ReplayEngine } from '../../../../src/core/replay.js';
import { withLock } from '../../../../src/core/lock.js';
import { canonicalJson } from '../../../../src/core/canonical_json.js';
import { initCommand } from '../../../../src/commands/init.js';
import { appendCommand } from '../../../../src/commands/append.js';
import { checkpointCommand } from '../../../../src/commands/checkpoint.js';
import { branchCommand } from '../../../../src/commands/branch.js';
import { recoverCommand } from '../../../../src/commands/recover.js';
import { registerPutCommand } from '../../../../src/commands/register_put.js';
import { registerGetCommand } from '../../../../src/commands/register_get.js';
import { statusCommand } from '../../../../src/commands/status.js';
import { exportCommand } from '../../../../src/commands/export.js';

class MutantLiveReplayEngine extends ReplayEngine {
  replay(checkpointId, options = {}) {
    const res = super.replay(checkpointId, options);

    // DEFECT: Instead of purely virtualizing results, execute live tool subprocesses
    if (Array.isArray(res.replayed_events)) {
      for (const evt of res.replayed_events) {
        if (evt.type === 'tool_requested' && evt.payload?.arguments?.command) {
          try {
            execSync(evt.payload.arguments.command, {
              cwd: this.storage.baseDir,
              stdio: 'ignore',
            });
          } catch {
            // ignore command exit error in mutant
          }
        }
      }
    }

    return res;
  }
}

async function mutantReplayCommand(args = [], options = {}) {
  let checkpointId = null;
  let stepCount = Infinity;
  let isJson = false;

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--from') {
      checkpointId = args[i + 1];
      i++;
    } else if (arg === '--step') {
      stepCount = parseInt(args[i + 1], 10);
      i++;
    } else if (arg === '--json') {
      isJson = true;
    }
  }

  if (!checkpointId) {
    throw new LedgerError(ExitCode.USAGE_OR_NOT_FOUND, 'Usage: agent-ledger replay --from <checkpoint_id>');
  }

  const storage = new StorageManager(options.cwd);
  if (!storage.isInitialized()) {
    throw new LedgerError(ExitCode.USAGE_OR_NOT_FOUND, 'Error: Repository not initialized in ' + storage.baseDir);
  }

  const engine = new MutantLiveReplayEngine(storage);
  const replayResult = await withLock(storage.lockFile, 'replay', async () => {
    return engine.replay(checkpointId, { stepCount });
  });

  const message = isJson
    ? canonicalJson({
        checkpoint_id: replayResult.checkpoint_id,
        run_id: replayResult.run_id,
        branch: replayResult.branch,
        from_seq_num: replayResult.from_seq_num,
        replayed_events_count: replayResult.replayed_events_count,
        target_seq_num: replayResult.target_seq_num,
        state: replayResult.state,
      })
    : `Replayed ${replayResult.replayed_events_count} event(s) from checkpoint '${replayResult.checkpoint_id}'`;

  return { exitCode: ExitCode.SUCCESS, message };
}

const COMMANDS = {
  init: initCommand,
  append: appendCommand,
  checkpoint: checkpointCommand,
  branch: branchCommand,
  replay: mutantReplayCommand,
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
