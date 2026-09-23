import fs from 'node:fs';
import path from 'node:path';
import { ExitCode, LedgerError } from './errors.js';
import { StorageManager } from './storage.js';
import { writeAtomicSync } from './fs_atomic.js';

const REGISTER_NAME_REGEX = /^[a-zA-Z0-9]$/;

/**
 * Validates that a register name is a single alphanumeric character.
 *
 * @param {string} name
 * @throws {LedgerError} with ExitCode.USAGE_OR_NOT_FOUND (1) if invalid
 */
export function validateRegisterName(name) {
  if (typeof name !== 'string' || !REGISTER_NAME_REGEX.test(name)) {
    throw new LedgerError(
      ExitCode.USAGE_OR_NOT_FOUND,
      `Error: Invalid register name '${name}'. Must be a single alphanumeric character (^[a-zA-Z0-9]$)`
    );
  }
}

/**
 * Manager for named scratch registers stored as raw binary blobs in .agent-ledger/registers/.
 */
export class RegisterManager {
  /**
   * @param {StorageManager} [storage]
   */
  constructor(storage = new StorageManager()) {
    this.storage = storage;
  }

  /**
   * Resolves the blob path for a named register.
   *
   * @param {string} name
   * @returns {string}
   */
  getRegisterPath(name) {
    validateRegisterName(name);
    return path.join(this.storage.registersDir, `reg_${name}.blob`);
  }

  /**
   * Copies raw bytes from source file to the destination register blob atomically.
   *
   * @param {string} name Register single-character identifier
   * @param {string} srcFilePath Absolute or relative path to source file
   * @returns {number} Bytes written
   */
  put(name, srcFilePath) {
    validateRegisterName(name);

    if (!srcFilePath || typeof srcFilePath !== 'string') {
      throw new LedgerError(
        ExitCode.USAGE_OR_NOT_FOUND,
        'Error: Source file path must be specified'
      );
    }

    const resolvedSrc = path.resolve(this.storage.baseDir, srcFilePath);
    if (!fs.existsSync(resolvedSrc)) {
      throw new LedgerError(
        ExitCode.USAGE_OR_NOT_FOUND,
        `Error: Source file '${srcFilePath}' not found`
      );
    }

    const stat = fs.statSync(resolvedSrc);
    if (!stat.isFile()) {
      throw new LedgerError(
        ExitCode.USAGE_OR_NOT_FOUND,
        `Error: Source path '${srcFilePath}' is not a regular file`
      );
    }

    const buffer = fs.readFileSync(resolvedSrc);
    const targetPath = this.getRegisterPath(name);

    writeAtomicSync(targetPath, buffer);
    return buffer.length;
  }

  /**
   * Retrieves the raw binary buffer of a named register.
   *
   * @param {string} name
   * @returns {Buffer}
   */
  get(name) {
    validateRegisterName(name);
    const targetPath = this.getRegisterPath(name);

    if (!fs.existsSync(targetPath)) {
      throw new LedgerError(
        ExitCode.USAGE_OR_NOT_FOUND,
        `Error: Register '${name}' does not exist`
      );
    }

    const stat = fs.statSync(targetPath);
    if (stat.size === 0) {
      throw new LedgerError(
        ExitCode.USAGE_OR_NOT_FOUND,
        `Error: Register '${name}' is empty`
      );
    }

    return fs.readFileSync(targetPath);
  }
}
