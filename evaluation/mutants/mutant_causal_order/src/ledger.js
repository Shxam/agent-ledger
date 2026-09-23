import fs from 'node:fs';
import { ExitCode, LedgerError } from '../../../../src/core/errors.js';
import { canonicalJson } from '../../../../src/core/canonical_json.js';
import { sha256, GENESIS_HASH } from '../../../../src/core/crypto.js';
import { validateEventSchema } from '../../../../src/core/schema.js';
import { StorageManager } from '../../../../src/core/storage.js';
import { BranchManager } from '../../../../src/core/branch.js';
import { CheckpointManager, reconstructStateSnapshot } from '../../../../src/core/checkpoint.js';
import { computeEventHash, LedgerManager } from '../../../../src/core/ledger.js';
import { MutantCausalEngine } from './causal_engine.js';

export class MutantLedgerManager extends LedgerManager {
  constructor(storage = new StorageManager()) {
    super(storage);
    this.causalEngine = new MutantCausalEngine();
  }

  loadAndValidateHistory() {
    this.config = this.storage.readConfig();
    this.globalEventIds.clear();
    this.allRecords = [];
    this.activeBranchEvents = [];
    this.eventHashMap.clear();

    const activeBranchName = this.config.active_branch;
    const branchStates = new Map();

    const getBranchState = (branchName) => {
      if (branchStates.has(branchName)) return branchStates.get(branchName);

      if (branchName === 'main') {
        const state = {
          lastSeqNum: 0,
          lastHash: GENESIS_HASH,
          lastEventId: null,
          causalEngine: new MutantCausalEngine(),
          events: [],
        };
        branchStates.set(branchName, state);
        return state;
      }

      const branchMeta = this.branchManager.readBranch(branchName);
      const state = {
        lastSeqNum: branchMeta.fork_seq_num,
        lastHash: branchMeta.fork_hash,
        lastEventId: branchMeta.fork_event_id,
        causalEngine: new MutantCausalEngine(),
        events: [],
      };
      branchStates.set(branchName, state);
      return state;
    };

    getBranchState('main');
    if (activeBranchName !== 'main') getBranchState(activeBranchName);

    if (fs.existsSync(this.storage.eventsFile)) {
      const rawContent = fs.readFileSync(this.storage.eventsFile, 'utf8');
      if (rawContent && rawContent.trim().length > 0) {
        const lines = rawContent.split('\n');
        for (let i = 0; i < lines.length; i++) {
          const line = lines[i].trim();
          if (line.length === 0) continue;
          const parsed = JSON.parse(line);
          validateEventSchema(parsed);

          if (this.globalEventIds.has(parsed.event_id)) {
            throw new LedgerError(ExitCode.TAMPER_DETECTED, `Duplicate event_id '${parsed.event_id}'`);
          }

          const bState = getBranchState(parsed.branch);
          if (parsed.seq_num !== bState.lastSeqNum + 1) {
            throw new LedgerError(ExitCode.TAMPER_DETECTED, `Sequence gap on '${parsed.branch}'`);
          }
          if (parsed.prev_hash !== bState.lastHash) {
            throw new LedgerError(ExitCode.TAMPER_DETECTED, `Hash chain drift on '${parsed.branch}'`);
          }

          const calculatedHash = computeEventHash(bState.lastHash, parsed);
          bState.causalEngine.processEvent(parsed, true);

          bState.lastSeqNum = parsed.seq_num;
          bState.lastHash = calculatedHash;
          bState.lastEventId = parsed.event_id;
          bState.events.push(parsed);

          this.globalEventIds.add(parsed.event_id);
          this.allRecords.push(parsed);
          this.eventHashMap.set(parsed.event_id, calculatedHash);
        }
      }
    }

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
}
