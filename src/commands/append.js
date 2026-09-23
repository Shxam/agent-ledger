import fs from 'node:fs';
import path from 'node:path';
import { ExitCode, LedgerError } from '../core/errors.js';
import { StorageManager } from '../core/storage.js';
import { LedgerManager } from '../core/ledger.js';
import { withLock } from '../core/lock.js';

/**
 * Handler for `agent-ledger append <event_json_path>`.
 *
 * @param {string[]} args CLI positional arguments
 * @param {object} [options]
 * @param {string} [options.cwd]
 * @returns {{ exitCode: number, message: string }}
 */
export async function appendCommand(args = [], options = {}) {
  const eventJsonPath = args[0];
  if (!eventJsonPath) {
    throw new LedgerError(
      ExitCode.USAGE_OR_NOT_FOUND,
      'Usage: agent-ledger append <event_json_path>'
    );
  }

  const storage = new StorageManager(options.cwd);
  if (!storage.isInitialized()) {
    throw new LedgerError(
      ExitCode.USAGE_OR_NOT_FOUND,
      'Error: Repository not initialized in ' + storage.baseDir
    );
  }

  const resolvedPath = path.isAbsolute(eventJsonPath)
    ? eventJsonPath
    : path.resolve(options.cwd || process.cwd(), eventJsonPath);

  if (!fs.existsSync(resolvedPath)) {
    throw new LedgerError(
      ExitCode.VALIDATION_ERROR,
      `Error: Event JSON file '${eventJsonPath}' does not exist`
    );
  }

  let rawContent;
  try {
    rawContent = fs.readFileSync(resolvedPath, 'utf8');
  } catch (err) {
    throw new LedgerError(
      ExitCode.VALIDATION_ERROR,
      `Error: Unable to read event JSON file '${eventJsonPath}': ${err.message}`
    );
  }

  let candidateEvent;
  try {
    candidateEvent = JSON.parse(rawContent);
  } catch {
    throw new LedgerError(
      ExitCode.VALIDATION_ERROR,
      `Error: Event JSON file '${eventJsonPath}' contains invalid JSON`
    );
  }

  // Execute append under non-blocking exclusive POSIX lock
  const persistedRecord = await withLock(storage.lockFile, 'append', async () => {
    const ledger = new LedgerManager(storage);
    return ledger.append(candidateEvent);
  });

  return {
    exitCode: ExitCode.SUCCESS,
    message: `Appended event '${persistedRecord.event_id}' (seq: ${persistedRecord.seq_num}, type: ${persistedRecord.type})`,
  };
}
