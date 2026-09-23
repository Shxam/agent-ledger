import fs from 'node:fs';
import { ExitCode, LedgerError } from './errors.js';
import { canonicalJson } from './canonical_json.js';
import { sha256, GENESIS_HASH } from './crypto.js';
import { validateEventSchema } from './schema.js';
import { CausalEngine } from './causal_engine.js';
import { StorageManager } from './storage.js';
import { BranchManager } from './branch.js';
import { CheckpointManager, reconstructStateSnapshot } from './checkpoint.js';

/**
 * Computes the cryptographic hash for an event record given its preceding hash.
 * Formula: Hk = SHA-256(H_{k-1} + canonical_json(E_k \ {prev_hash}))
 *
 * @param {string} prevHash 64-char hex string of preceding event
 * @param {object} event Event object
 * @returns {string} 64-char hex string of current event
 */
export function computeEventHash(prevHash, event) {
  const payloadForHash = {
    event_id: event.event_id,
    seq_num: event.seq_num,
    run_id: event.run_id,
    branch: event.branch,
    type: event.type,
    timestamp_ms: event.timestamp_ms,
    payload: event.payload,
  };

  const canonicalPayload = canonicalJson(payloadForHash);
  return sha256(prevHash + canonicalPayload);
}

/**
 * Core event ledger manager supporting isolated multi-branch DAG execution.
 */
export class LedgerManager {
  /**
   * @param {StorageManager} [storage]
   */
  constructor(storage = new StorageManager()) {
    this.storage = storage;
    this.branchManager = new BranchManager(storage);
    this.checkpointManager = new CheckpointManager(storage);
    this.globalEventIds = new Set();
    this.allRecords = [];
    this.activeBranchEvents = [];
    this.lastSeqNum = 0;
    this.lastHash = GENESIS_HASH;
    this.lastEventId = null;
    this.causalEngine = new CausalEngine();
    this.config = null;
    this.eventHashMap = new Map(); // event_id -> hash
  }

  /**
   * Loads and validates historical ledger records from events.ndjson across all branches.
   *
   * @throws {LedgerError} with ExitCode.TAMPER_DETECTED (5) if integrity is compromised
   */
  loadAndValidateHistory() {
    this.config = this.storage.readConfig();
    this.globalEventIds.clear();
    this.allRecords = [];
    this.activeBranchEvents = [];
    this.eventHashMap.clear();

    const activeBranchName = this.config.active_branch;

    // Track per-branch sequence, hash, and causal state
    const branchStates = new Map();

    // Helper to get or initialize branch state
    const getBranchState = (branchName) => {
      if (branchStates.has(branchName)) {
        return branchStates.get(branchName);
      }

      if (branchName === 'main') {
        const state = {
          lastSeqNum: 0,
          lastHash: GENESIS_HASH,
          lastEventId: null,
          causalEngine: new CausalEngine(),
          events: [],
        };
        branchStates.set(branchName, state);
        return state;
      }

      // Non-main branch: load branch metadata
      const branchMeta = this.branchManager.readBranch(branchName);
      const state = {
        lastSeqNum: branchMeta.fork_seq_num,
        lastHash: branchMeta.fork_hash,
        lastEventId: branchMeta.fork_event_id,
        causalEngine: new CausalEngine(),
        events: [],
      };
      branchStates.set(branchName, state);
      return state;
    };

    // Initialize main and active branch states
    getBranchState('main');
    if (activeBranchName !== 'main') {
      getBranchState(activeBranchName);
    }

    if (fs.existsSync(this.storage.eventsFile)) {
      const rawContent = fs.readFileSync(this.storage.eventsFile, 'utf8');
      if (rawContent && rawContent.trim().length > 0) {
        const lines = rawContent.split('\n');

        for (let i = 0; i < lines.length; i++) {
          const line = lines[i].trim();
          if (line.length === 0) continue;

          let parsed;
          try {
            parsed = JSON.parse(line);
          } catch {
            throw new LedgerError(
              ExitCode.TAMPER_DETECTED,
              `Log integrity error: Corrupted JSON at line ${i + 1}`
            );
          }

          try {
            validateEventSchema(parsed);
          } catch (err) {
            throw new LedgerError(
              ExitCode.TAMPER_DETECTED,
              `Log integrity error: Schema failure at line ${i + 1}: ${err.message}`
            );
          }

          // 1. Global event ID uniqueness
          if (this.globalEventIds.has(parsed.event_id)) {
            throw new LedgerError(
              ExitCode.TAMPER_DETECTED,
              `Log integrity error: Duplicate event_id '${parsed.event_id}' at line ${i + 1}`
            );
          }

          // 2. Branch state validation
          const bState = getBranchState(parsed.branch);

          // Sequence monotonicity within branch
          const expectedSeq = bState.lastSeqNum + 1;
          if (parsed.seq_num !== expectedSeq) {
            throw new LedgerError(
              ExitCode.TAMPER_DETECTED,
              `Log integrity error: Sequence gap/reversal on branch '${parsed.branch}' at line ${i + 1} (got ${parsed.seq_num}, expected ${expectedSeq})`
            );
          }

          // Cryptographic hash chain verification
          if (parsed.prev_hash !== bState.lastHash) {
            throw new LedgerError(
              ExitCode.TAMPER_DETECTED,
              `Log integrity error: Hash chain drift on branch '${parsed.branch}' at line ${i + 1}`
            );
          }

          const calculatedHash = computeEventHash(bState.lastHash, parsed);

          // Causal state tracking within branch
          bState.causalEngine.processEvent(parsed, true);

          // Advance branch state
          bState.lastSeqNum = parsed.seq_num;
          bState.lastHash = calculatedHash;
          bState.lastEventId = parsed.event_id;
          bState.events.push(parsed);

          // Global tracking
          this.globalEventIds.add(parsed.event_id);
          this.allRecords.push(parsed);
          this.eventHashMap.set(parsed.event_id, calculatedHash);
        }
      }
    }

    // Build logical lineage for the active branch
    if (activeBranchName === 'main') {
      const mainState = getBranchState('main');
      this.activeBranchEvents = [...mainState.events];
      this.lastSeqNum = mainState.lastSeqNum;
      this.lastHash = mainState.lastHash;
      this.lastEventId = mainState.lastEventId;
      this.causalEngine = mainState.causalEngine;
    } else {
      const branchMeta = this.branchManager.readBranch(activeBranchName);
      const parentEvents = (branchStates.get('main')?.events || []).filter(
        (e) => e.seq_num <= branchMeta.fork_seq_num
      );
      const branchOnlyEvents = branchStates.get(activeBranchName)?.events || [];

      this.activeBranchEvents = [...parentEvents, ...branchOnlyEvents];

      const bState = getBranchState(activeBranchName);
      this.lastSeqNum = bState.lastSeqNum;
      this.lastHash = bState.lastHash;
      this.lastEventId = bState.lastEventId || branchMeta.fork_event_id;
      this.causalEngine = bState.causalEngine;
    }
  }

  /**
   * Reconstructs the state of the active branch.
   *
   * @returns {{ runId: string, branch: string, seq_num: number, last_event_id: string, last_hash: string, state_snapshot: object, open_tool_count: number }}
   */
  reconstructActiveBranchState() {
    this.loadAndValidateHistory();
    const snapshot = reconstructStateSnapshot(this.activeBranchEvents);

    return {
      runId: this.config.run_id,
      branch: this.config.active_branch,
      seq_num: this.lastSeqNum,
      last_event_id: this.lastEventId,
      last_hash: this.lastHash,
      state_snapshot: snapshot,
      open_tool_count: this.causalEngine.getOpenToolCount(),
    };
  }

  /**
   * Appends a new candidate event to the active branch.
   *
   * @param {object} candidateEvent
   * @returns {object} The persisted record
   */
  append(candidateEvent) {
    this.loadAndValidateHistory();

    // 1. Schema validation
    validateEventSchema(candidateEvent);

    // 2. Validate branch and run_id match config
    if (candidateEvent.branch !== this.config.active_branch) {
      throw new LedgerError(
        ExitCode.VALIDATION_ERROR,
        `Error: Event branch '${candidateEvent.branch}' does not match active branch '${this.config.active_branch}'`
      );
    }

    if (candidateEvent.run_id !== this.config.run_id) {
      throw new LedgerError(
        ExitCode.VALIDATION_ERROR,
        `Error: Event run_id '${candidateEvent.run_id}' does not match workspace run_id '${this.config.run_id}'`
      );
    }

    // 3. Sequence validation
    const expectedSeq = this.lastSeqNum + 1;
    if (candidateEvent.seq_num !== expectedSeq) {
      throw new LedgerError(
        ExitCode.VALIDATION_ERROR,
        `Error: Invalid sequence number ${candidateEvent.seq_num} on branch '${candidateEvent.branch}' (expected strictly ${expectedSeq})`
      );
    }

    // 4. Global event ID uniqueness
    if (this.globalEventIds.has(candidateEvent.event_id)) {
      throw new LedgerError(
        ExitCode.VALIDATION_ERROR,
        `Error: Duplicate event_id '${candidateEvent.event_id}' already exists in ledger`
      );
    }

    // 5. Causal & completion validation
    this.causalEngine.processEvent(candidateEvent, false);

    // 6. Build persisted record with prev_hash
    const timestampMs =
      typeof candidateEvent.timestamp_ms === 'number' && candidateEvent.timestamp_ms > 0
        ? candidateEvent.timestamp_ms
        : Date.now();

    const persistedRecord = {
      event_id: candidateEvent.event_id,
      seq_num: candidateEvent.seq_num,
      run_id: candidateEvent.run_id,
      branch: candidateEvent.branch,
      type: candidateEvent.type,
      prev_hash: this.lastHash,
      timestamp_ms: timestampMs,
      payload: candidateEvent.payload,
    };

    // 7. Calculate new tip hash
    const newHash = computeEventHash(this.lastHash, persistedRecord);

    // 8. Durably append line to events.ndjson
    const lineToAppend = canonicalJson(persistedRecord) + '\n';

    let fd;
    try {
      fd = fs.openSync(this.storage.eventsFile, 'a', 0o666);
      fs.writeSync(fd, lineToAppend, null, 'utf8');
      fs.fsyncSync(fd);
      fs.closeSync(fd);
      fd = null;
    } catch (err) {
      if (fd !== null && fd !== undefined) {
        try {
          fs.closeSync(fd);
        } catch {
          // ignore
        }
      }
      throw err;
    }

    // 9. Update branch head pointer if non-main branch
    if (this.config.active_branch !== 'main') {
      this.branchManager.updateBranchHead(
        this.config.active_branch,
        persistedRecord.seq_num,
        persistedRecord.event_id,
        newHash
      );
    }

    // Advance local state
    this.allRecords.push(persistedRecord);
    this.activeBranchEvents.push(persistedRecord);
    this.globalEventIds.add(persistedRecord.event_id);
    this.lastSeqNum = persistedRecord.seq_num;
    this.lastHash = newHash;
    this.lastEventId = persistedRecord.event_id;
    this.eventHashMap.set(persistedRecord.event_id, newHash);

    return persistedRecord;
  }
}
