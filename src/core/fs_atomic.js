import fs from 'node:fs';
import path from 'node:path';
import { canonicalJson } from './canonical_json.js';

let tempFileCounter = 0;

/**
 * Atomically writes content to a target file.
 *
 * Sequence:
 * 1. Create a unique temporary file in the target directory.
 * 2. Write the complete content.
 * 3. Flush buffers and fsync the file descriptor.
 * 4. Close the file descriptor.
 * 5. Atomically rename the temporary file to the target path.
 * 6. Best-effort fsync on the parent directory (POSIX).
 *
 * @param {string} targetPath Absolute or relative path to target file
 * @param {string | Buffer} content Content to persist
 */
export function writeAtomicSync(targetPath, content) {
  const dir = path.dirname(targetPath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }

  const baseName = path.basename(targetPath);
  const tempPath = path.join(
    dir,
    `.${baseName}.tmp.${process.pid}.${Date.now()}_${++tempFileCounter}`
  );

  let fd;
  try {
    fd = fs.openSync(tempPath, 'w', 0o666);
    if (typeof content === 'string') {
      fs.writeSync(fd, content, null, 'utf8');
    } else {
      fs.writeSync(fd, content);
    }
    fs.fsyncSync(fd);
    fs.closeSync(fd);
    fd = null;

    fs.renameSync(tempPath, targetPath);

    // Best-effort directory sync on POSIX platforms
    try {
      const dirFd = fs.openSync(dir, 'r');
      try {
        fs.fsyncSync(dirFd);
      } finally {
        fs.closeSync(dirFd);
      }
    } catch {
      // Directory fsync is not supported on all filesystems/platforms (e.g. Windows)
    }
  } catch (err) {
    if (fd !== null && fd !== undefined) {
      try {
        fs.closeSync(fd);
      } catch {
        // ignore close error
      }
    }
    if (fs.existsSync(tempPath)) {
      try {
        fs.unlinkSync(tempPath);
      } catch {
        // ignore unlink error
      }
    }
    throw err;
  }
}

/**
 * Serializes data to canonical JSON and writes it atomically to targetPath.
 *
 * @param {string} targetPath
 * @param {unknown} data
 */
export function writeJsonAtomicSync(targetPath, data) {
  const jsonString = canonicalJson(data) + '\n';
  writeAtomicSync(targetPath, jsonString);
}
