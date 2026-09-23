import fs from 'node:fs';
import path from 'node:path';
import { StorageManager } from './storage.js';
import { LedgerManager } from './ledger.js';
import { canonicalJson } from './canonical_json.js';

/**
 * Builds a deterministic, branch-aware export document representing the complete
 * observable run history and execution state.
 *
 * @param {StorageManager} [storage]
 * @returns {object} Export data object
 */
export function buildExportData(storage = new StorageManager()) {
  const ledger = new LedgerManager(storage);

  // 1. Verify complete ledger and hash chain (throws ExitCode.TAMPER_DETECTED (5) on drift)
  ledger.loadAndValidateHistory();

  const config = storage.readConfig();
  const allRecords = [...ledger.allRecords];

  // 2. Build branch topology
  const branches = {};

  // Add main branch
  const mainEvents = allRecords.filter((e) => e.branch === 'main');
  const mainLastEvt = mainEvents.length > 0 ? mainEvents[mainEvents.length - 1] : null;

  branches.main = {
    events: mainEvents,
    head_event_hash: mainLastEvt ? ledger.eventHashMap.get(mainLastEvt.event_id) : null,
    head_event_id: mainLastEvt ? mainLastEvt.event_id : null,
    head_seq_num: mainLastEvt ? mainLastEvt.seq_num : 0,
    name: 'main',
  };

  // Add other branches from storage.branchesDir
  if (fs.existsSync(storage.branchesDir)) {
    const branchFiles = fs.readdirSync(storage.branchesDir).sort();
    for (const file of branchFiles) {
      if (!file.endsWith('.json')) continue;
      try {
        const raw = fs.readFileSync(path.join(storage.branchesDir, file), 'utf8');
        const bMeta = JSON.parse(raw);
        const bName = bMeta.name || bMeta.branch_name;

        if (bName && bName !== 'main') {
          const bEvents = allRecords.filter((e) => e.branch === bName);
          const bLast = bEvents.length > 0 ? bEvents[bEvents.length - 1] : null;

          branches[bName] = {
            events: bEvents,
            fork_event_id: bMeta.fork_event_id || null,
            fork_hash: bMeta.fork_hash || null,
            fork_seq_num: bMeta.fork_seq_num || 0,
            head_event_hash: bLast
              ? ledger.eventHashMap.get(bLast.event_id)
              : bMeta.head_event_hash || bMeta.fork_hash || null,
            head_event_id: bLast ? bLast.event_id : bMeta.head_event_id || bMeta.fork_event_id || null,
            head_seq_num: bLast ? bLast.seq_num : bMeta.head_seq_num || bMeta.fork_seq_num || 0,
            name: bName,
            origin_checkpoint_id: bMeta.origin_checkpoint_id || null,
          };
        }
      } catch {
        // ignore malformed branch metadata
      }
    }
  }

  // 3. Collect checkpoints deterministically
  const checkpoints = [];
  if (fs.existsSync(storage.checkpointsDir)) {
    const cpFiles = fs.readdirSync(storage.checkpointsDir).sort();
    for (const file of cpFiles) {
      if (!file.endsWith('.json')) continue;
      try {
        const raw = fs.readFileSync(path.join(storage.checkpointsDir, file), 'utf8');
        checkpoints.push(JSON.parse(raw));
      } catch {
        // ignore
      }
    }
  }
  checkpoints.sort((a, b) => {
    if (a.seq_num !== b.seq_num) return a.seq_num - b.seq_num;
    return a.checkpoint_id.localeCompare(b.checkpoint_id);
  });

  // 4. Derive tool request/result relationships
  const toolInteractionsMap = new Map();
  const toolInteractions = [];

  for (const event of allRecords) {
    if (event.type === 'tool_requested' && event.payload && event.payload.tool_request_id) {
      const entry = {
        branch: event.branch,
        requested_at_seq: event.seq_num,
        resolved: false,
        result: null,
        tool_input: event.payload.tool_input !== undefined ? event.payload.tool_input : null,
        tool_name: event.payload.tool_name || null,
        tool_request_id: event.payload.tool_request_id,
      };
      toolInteractionsMap.set(event.payload.tool_request_id, entry);
      toolInteractions.push(entry);
    } else if (
      event.type === 'tool_result_received' &&
      event.payload &&
      event.payload.tool_request_id
    ) {
      const entry = toolInteractionsMap.get(event.payload.tool_request_id);
      if (entry) {
        entry.resolved = true;
        entry.resolved_at_seq = event.seq_num;
        entry.result = event.payload;
      }
    }
  }

  // 5. Derive file modifications
  const modifiedFiles = {};
  for (const event of allRecords) {
    if (event.type === 'file_changed' && event.payload) {
      const filePath = event.payload.file || event.payload.path;
      if (filePath) {
        modifiedFiles[filePath] = {
          branch: event.branch,
          hash_or_content: event.payload.hash || event.payload.content || 'modified',
          last_modified_seq: event.seq_num,
        };
      }
    }
  }

  // 6. Derive test records
  const testSummary = { failed: 0, passed: 0, total: 0 };
  const testRuns = [];

  for (const event of allRecords) {
    if (event.type === 'test_finished' && event.payload) {
      const p = typeof event.payload.passed === 'number' ? event.payload.passed : 0;
      const f = typeof event.payload.failed === 'number' ? event.payload.failed : 0;
      testSummary.passed += p;
      testSummary.failed += f;
      testSummary.total += p + f;
      testRuns.push({
        branch: event.branch,
        failed: f,
        passed: p,
        seq_num: event.seq_num,
      });
    }
  }

  // 7. Derive completion state
  let completed = false;
  let completedAtSeq = null;
  let completedEventId = null;

  for (const event of allRecords) {
    if (event.type === 'run_completed') {
      completed = true;
      completedAtSeq = event.seq_num;
      completedEventId = event.event_id;
      break;
    }
  }

  return {
    active_branch: config.active_branch,
    branches,
    checkpoints,
    completion_state: {
      completed,
      completed_at_seq: completedAtSeq,
      completed_by_event_id: completedEventId,
    },
    events: allRecords,
    modified_files: modifiedFiles,
    run_id: config.run_id,
    test_records: {
      runs: testRuns,
      summary: testSummary,
    },
    tool_interactions: toolInteractions,
  };
}

/**
 * Returns canonical JSON string of the complete execution export.
 *
 * @param {StorageManager} [storage]
 * @returns {string}
 */
export function exportCanonicalJson(storage = new StorageManager()) {
  const data = buildExportData(storage);
  return canonicalJson(data);
}
