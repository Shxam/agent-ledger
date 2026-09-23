import fs from 'node:fs';
import path from 'node:path';
import { ExitCode, LedgerError } from './errors.js';
import { writeJsonAtomicSync } from './fs_atomic.js';

export const DEFAULT_RUN_ID = 'run_default';
export const DEFAULT_BRANCH = 'main';
export const LEDGER_VERSION = '1.0.0';

export class StorageManager {
  /**
   * @param {string} [baseDir] Workspace directory (defaults to process.cwd())
   */
  constructor(baseDir = process.cwd()) {
    this.baseDir = path.resolve(baseDir);
    this.rootDir = path.join(this.baseDir, '.agent-ledger');
    this.configFile = path.join(this.rootDir, 'config.json');
    this.eventsFile = path.join(this.rootDir, 'events.ndjson');
    this.checkpointsDir = path.join(this.rootDir, 'checkpoints');
    this.branchesDir = path.join(this.rootDir, 'branches');
    this.registersDir = path.join(this.rootDir, 'registers');
    this.locksDir = path.join(this.rootDir, 'locks');
    this.lockFile = path.join(this.locksDir, 'ledger.lock');
  }

  /**
   * Checks whether the .agent-ledger directory is initialized.
   * @returns {boolean}
   */
  isInitialized() {
    return (
      fs.existsSync(this.rootDir) &&
      fs.existsSync(this.configFile)
    );
  }

  /**
   * Initializes a new .agent-ledger layout in the workspace.
   *
   * @param {string} [runId]
   * @returns {{ run_id: string, active_branch: string, version: string }}
   */
  initLedger(runId) {
    if (this.isInitialized()) {
      throw new LedgerError(
        ExitCode.USAGE_OR_NOT_FOUND,
        'Error: Repository already initialized at ' + this.rootDir
      );
    }

    // Create required directory layout
    fs.mkdirSync(this.rootDir, { recursive: true });
    fs.mkdirSync(this.checkpointsDir, { recursive: true });
    fs.mkdirSync(this.branchesDir, { recursive: true });
    fs.mkdirSync(this.registersDir, { recursive: true });
    fs.mkdirSync(this.locksDir, { recursive: true });

    const finalRunId = runId && runId.trim().length > 0 ? runId.trim() : DEFAULT_RUN_ID;

    const initialConfig = {
      active_branch: DEFAULT_BRANCH,
      run_id: finalRunId,
      version: LEDGER_VERSION,
    };

    // Atomically write config.json
    writeJsonAtomicSync(this.configFile, initialConfig);

    // Create empty events.ndjson file if it does not exist
    if (!fs.existsSync(this.eventsFile)) {
      fs.writeFileSync(this.eventsFile, '', { flag: 'wx', encoding: 'utf8' });
    }

    return initialConfig;
  }

  /**
   * Reads and parses the workspace configuration.
   * @returns {{ run_id: string, active_branch: string, version: string }}
   */
  readConfig() {
    if (!this.isInitialized()) {
      throw new LedgerError(
        ExitCode.USAGE_OR_NOT_FOUND,
        'Error: Repository not initialized in ' + this.baseDir
      );
    }
    const raw = fs.readFileSync(this.configFile, 'utf8');
    try {
      return JSON.parse(raw);
    } catch {
      throw new LedgerError(
        ExitCode.USAGE_OR_NOT_FOUND,
        'Error: Corrupted configuration file at ' + this.configFile
      );
    }
  }

  /**
   * Atomically updates workspace configuration.
   * @param {{ run_id: string, active_branch: string, version: string }} config
   */
  writeConfig(config) {
    writeJsonAtomicSync(this.configFile, config);
  }
}
