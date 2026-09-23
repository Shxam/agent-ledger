import fs from 'node:fs';
import path from 'node:path';
import { ExitCode, LedgerError } from './errors.js';
import { writeJsonAtomicSync } from './fs_atomic.js';
import { StorageManager } from './storage.js';

/**
 * Branch metadata and DAG manager.
 */
export class BranchManager {
  /**
   * @param {StorageManager} [storage]
   */
  constructor(storage = new StorageManager()) {
    this.storage = storage;
  }

  /**
   * Resolves the metadata file path for a branch name.
   *
   * @param {string} branchName
   * @returns {string}
   */
  getBranchPath(branchName) {
    return path.join(this.storage.branchesDir, `${branchName}.json`);
  }

  /**
   * Checks whether a branch already exists.
   *
   * @param {string} branchName
   * @returns {boolean}
   */
  exists(branchName) {
    if (branchName === 'main') {
      return true;
    }
    return fs.existsSync(this.getBranchPath(branchName));
  }

  /**
   * Reads branch metadata for a named branch.
   *
   * @param {string} branchName
   * @returns {object}
   */
  readBranch(branchName) {
    if (branchName === 'main') {
      const config = this.storage.readConfig();
      return {
        branch_name: 'main',
        run_id: config.run_id,
        origin_checkpoint_id: null,
        fork_seq_num: 0,
        fork_event_id: null,
        fork_hash: null,
      };
    }

    const filePath = this.getBranchPath(branchName);
    if (!fs.existsSync(filePath)) {
      throw new LedgerError(
        ExitCode.CONFLICT,
        `Error: Branch '${branchName}' does not exist`
      );
    }

    try {
      const raw = fs.readFileSync(filePath, 'utf8');
      return JSON.parse(raw);
    } catch (err) {
      throw new LedgerError(
        ExitCode.CONFLICT,
        `Error: Failed to read branch metadata '${branchName}': ${err.message}`
      );
    }
  }

  /**
   * Creates a new branch forked from a checkpoint and sets it as active branch.
   *
   * @param {string} branchName
   * @param {string} checkpointId
   * @param {object} checkpointManifest
   * @param {string} forkHash Cryptographic hash at fork sequence
   * @returns {object} Created branch metadata
   */
  createBranch(branchName, checkpointId, checkpointManifest, forkHash) {
    if (!branchName || typeof branchName !== 'string' || branchName.trim().length === 0) {
      throw new LedgerError(
        ExitCode.USAGE_OR_NOT_FOUND,
        'Error: Branch name must be a non-empty string'
      );
    }

    if (this.exists(branchName)) {
      throw new LedgerError(
        ExitCode.CONFLICT,
        `Error: Branch '${branchName}' already exists`
      );
    }

    const branchMeta = {
      branch_name: branchName,
      run_id: checkpointManifest.run_id,
      origin_checkpoint_id: checkpointId,
      fork_seq_num: checkpointManifest.seq_num,
      fork_event_id: checkpointManifest.last_event_id,
      fork_hash: forkHash,
      head_seq_num: checkpointManifest.seq_num,
      head_event_id: checkpointManifest.last_event_id,
      head_hash: forkHash,
      created_at_ms: Date.now(),
    };

    // 1. Atomically persist branch metadata
    writeJsonAtomicSync(this.getBranchPath(branchName), branchMeta);

    // 2. Atomically update config active_branch pointer
    const currentConfig = this.storage.readConfig();
    currentConfig.active_branch = branchName;
    this.storage.writeConfig(currentConfig);

    return branchMeta;
  }

  /**
   * Updates head pointer of a branch metadata file.
   *
   * @param {string} branchName
   * @param {number} headSeqNum
   * @param {string} headEventId
   * @param {string} headHash
   */
  updateBranchHead(branchName, headSeqNum, headEventId, headHash) {
    if (branchName === 'main') {
      return;
    }

    if (!fs.existsSync(this.getBranchPath(branchName))) {
      return;
    }

    const meta = this.readBranch(branchName);
    meta.head_seq_num = headSeqNum;
    meta.head_event_id = headEventId;
    meta.head_hash = headHash;

    writeJsonAtomicSync(this.getBranchPath(branchName), meta);
  }
}
