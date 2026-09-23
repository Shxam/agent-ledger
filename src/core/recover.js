import fs from 'node:fs';
import path from 'node:path';
import { ExitCode, LedgerError } from './errors.js';
import { StorageManager } from './storage.js';
import { LedgerManager } from './ledger.js';
import { validateEventSchema } from './schema.js';
import { writeJsonAtomicSync } from './fs_atomic.js';

/**
 * Recovers ledger from abnormal crashes, truncating torn trailing bytes at descriptor level
 * and reconciling branch heads and causal state.
 */
export class RecoveryEngine {
  /**
   * @param {StorageManager} [storage]
   */
  constructor(storage = new StorageManager()) {
    this.storage = storage;
  }

  /**
   * Executes crash recovery.
   *
   * @returns {{
   *   preserved_events_count: number,
   *   truncated_bytes: number,
   *   active_branch: string,
   *   run_id: string
   * }}
   */
  recover() {
    if (!this.storage.isInitialized()) {
      throw new LedgerError(
        ExitCode.USAGE_OR_NOT_FOUND,
        'Error: Repository not initialized in ' + this.storage.baseDir
      );
    }

    const config = this.storage.readConfig();
    let truncatedBytes = 0;
    let preservedRecords = [];

    // 1. Byte-level scan and torn-tail detection on events.ndjson
    if (fs.existsSync(this.storage.eventsFile)) {
      const stats = fs.statSync(this.storage.eventsFile);
      const totalFileSize = stats.size;

      if (totalFileSize > 0) {
        const buffer = fs.readFileSync(this.storage.eventsFile);
        let lineStartIndex = 0;
        const lineSegments = [];

        for (let i = 0; i < buffer.length; i++) {
          if (buffer[i] === 0x0a) {
            // Newline delimiter '\n'
            lineSegments.push({
              start: lineStartIndex,
              end: i + 1,
              content: buffer.subarray(lineStartIndex, i + 1),
            });
            lineStartIndex = i + 1;
          }
        }

        const hasTrailingBytesWithoutNewline = lineStartIndex < buffer.length;
        let lastValidOffset = 0;
        let tornTailDetected = false;

        for (let idx = 0; idx < lineSegments.length; idx++) {
          const seg = lineSegments[idx];
          const rawStr = seg.content.toString('utf8').trim();

          if (rawStr.length === 0) {
            // Empty newline at EOF is harmless, but if in the middle or followed by invalid data:
            if (idx === lineSegments.length - 1 && !hasTrailingBytesWithoutNewline) {
              lastValidOffset = seg.end;
              break;
            }
            continue;
          }

          let parsed = null;
          let schemaValid = false;

          try {
            parsed = JSON.parse(rawStr);
            validateEventSchema(parsed);
            schemaValid = true;
          } catch {
            schemaValid = false;
          }

          if (!schemaValid) {
            // Check if this is the final line segment with no trailing bytes after it
            const isFinalSegment = (idx === lineSegments.length - 1) && !hasTrailingBytesWithoutNewline;

            if (isFinalSegment) {
              // Torn tail at the end of the file
              tornTailDetected = true;
              break;
            } else {
              // Historical corruption in intermediate records!
              throw new LedgerError(
                ExitCode.UNRECOVERABLE_CORRUPTION,
                `Unrecoverable corruption: Invalid event record at line ${idx + 1} prior to log tail`
              );
            }
          } else {
            preservedRecords.push(parsed);
            lastValidOffset = seg.end;
          }
        }

        if (hasTrailingBytesWithoutNewline) {
          // Trailing bytes without terminating newline constitutes torn tail
          tornTailDetected = true;
        }

        // 2. Perform descriptor-level truncation using ftruncateSync if torn tail detected
        if (lastValidOffset < totalFileSize) {
          truncatedBytes = totalFileSize - lastValidOffset;
          let fd = null;
          try {
            fd = fs.openSync(this.storage.eventsFile, 'r+');
            fs.ftruncateSync(fd, lastValidOffset);
            fs.fsyncSync(fd);
            fs.closeSync(fd);
            fd = null;
          } catch (err) {
            if (fd !== null) {
              try { fs.closeSync(fd); } catch {}
            }
            throw new LedgerError(
              ExitCode.UNRECOVERABLE_CORRUPTION,
              `Unrecoverable error: Failed to truncate damaged tail: ${err.message}`
            );
          }
        }
      }
    }

    // 3. Cryptographic hash-chain and causal revalidation across all preserved records
    const ledger = new LedgerManager(this.storage);
    try {
      ledger.loadAndValidateHistory();
    } catch (err) {
      // Any historical tamper / hash mismatch or sequence violation is unrecoverable
      throw new LedgerError(
        ExitCode.UNRECOVERABLE_CORRUPTION,
        `Unrecoverable corruption detected during history validation: ${err.message}`
      );
    }

    // 4. Reconcile branch heads
    if (fs.existsSync(this.storage.branchesDir)) {
      const branchFiles = fs.readdirSync(this.storage.branchesDir);

      for (const branchFile of branchFiles) {
        if (!branchFile.endsWith('.json')) continue;
        const branchPath = path.join(this.storage.branchesDir, branchFile);

        try {
          const branchMeta = JSON.parse(fs.readFileSync(branchPath, 'utf8'));
          const branchName = branchMeta.name || branchMeta.branch_name;

          if (branchName) {
            const eventsOnBranch = ledger.allRecords.filter((e) => e.branch === branchName);

            let newHeadSeq;
            let newHeadId;
            let newHeadHash;

            if (eventsOnBranch.length > 0) {
              const lastEvt = eventsOnBranch[eventsOnBranch.length - 1];
              newHeadSeq = lastEvt.seq_num;
              newHeadId = lastEvt.event_id;
              newHeadHash = ledger.eventHashMap.get(lastEvt.event_id);
            } else {
              newHeadSeq = branchMeta.fork_seq_num;
              newHeadId = branchMeta.fork_event_id;
              newHeadHash = branchMeta.fork_hash;
            }

            const currentHeadSeq = branchMeta.head_seq_num;
            const currentHeadId = branchMeta.head_event_id;

            if (currentHeadSeq !== newHeadSeq || currentHeadId !== newHeadId) {
              branchMeta.head_seq_num = newHeadSeq;
              branchMeta.head_event_id = newHeadId;
              branchMeta.head_event_hash = newHeadHash;
              writeJsonAtomicSync(branchPath, branchMeta);
            }
          }
        } catch (err) {
          if (err instanceof LedgerError) throw err;
          // Ignore parse errors on corrupted branch files if any
        }
      }
    }

    // 5. Clean up stale temporary files in storage base
    try {
      const baseFiles = fs.readdirSync(this.storage.baseDir);
      for (const file of baseFiles) {
        if (file.startsWith('.') && file.includes('.tmp.')) {
          try {
            fs.unlinkSync(path.join(this.storage.baseDir, file));
          } catch {}
        }
      }
    } catch {}

    return {
      preserved_events_count: ledger.allRecords.length,
      truncated_bytes: truncatedBytes,
      active_branch: config.active_branch,
      run_id: config.run_id,
    };
  }
}
