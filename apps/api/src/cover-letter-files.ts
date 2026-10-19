import fs from "node:fs";
import path from "node:path";

export class CoverLetterPathError extends Error {
  constructor() { super("cover_letter_path_forbidden"); }
}

/** Resolve below a trusted workspace; reject symlinks in every owned component.
 * The workspace itself may have an OS alias (for example /tmp on macOS).
 */
export function ownedCoverLetterPath(appDir: string, file: string, missingLeaf = false): string {
  const root = fs.realpathSync(appDir);
  const spelling = path.resolve(appDir);
  const absolute = path.resolve(file);
  const relative = absolute.startsWith(spelling + path.sep) ? path.relative(spelling, absolute)
    : absolute.startsWith(root + path.sep) ? path.relative(root, absolute) : null;
  if (!relative || path.isAbsolute(relative) || relative.split(path.sep).some(part => !part || part === "..")) throw new CoverLetterPathError();
  const candidate = path.resolve(root, relative);
  if (!candidate.startsWith(root + path.sep)) throw new CoverLetterPathError();
  const parts = relative.split(path.sep);
  let current = root;
  for (const [index, part] of parts.entries()) {
    current = path.join(current, part);
    try {
      const stat = fs.lstatSync(current);
      if (stat.isSymbolicLink() || (index < parts.length - 1 && !stat.isDirectory())) throw new CoverLetterPathError();
    } catch (error) {
      if (missingLeaf && index === parts.length - 1 && (error as NodeJS.ErrnoException).code === "ENOENT") return candidate;
      throw error;
    }
  }
  return candidate;
}

/** Bound the read on the descriptor, not a separate stat/read path pair. */
export function readOwnedCoverLetterFile(appDir: string, file: string, maxBytes: number): Buffer {
  const checked = ownedCoverLetterPath(appDir, file);
  const descriptor = fs.openSync(checked, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
  try {
    const before = fs.fstatSync(descriptor);
    if (!before.isFile() || before.nlink !== 1 || before.size > maxBytes) throw new Error("cover_letter_file_invalid");
    const bytes = Buffer.alloc(before.size + 1);
    let length = 0;
    while (length < bytes.length) {
      const count = fs.readSync(descriptor, bytes, length, bytes.length - length, null);
      if (!count) break;
      length += count;
    }
    const after = fs.fstatSync(descriptor);
    const current = fs.lstatSync(ownedCoverLetterPath(appDir, checked));
    if (length !== before.size || after.size !== before.size || after.mtimeMs !== before.mtimeMs
      || current.dev !== before.dev || current.ino !== before.ino) throw new Error("cover_letter_file_changed");
    return bytes.subarray(0, length);
  } finally { fs.closeSync(descriptor); }
}

export function writeOwnedCoverLetterFile(appDir: string, file: string, bytes: Buffer | string): void {
  const checked = ownedCoverLetterPath(appDir, file, true);
  const descriptor = fs.openSync(checked, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_NOFOLLOW, 0o600);
  try {
    fs.writeFileSync(descriptor, bytes);
    const written = fs.fstatSync(descriptor);
    const current = fs.lstatSync(ownedCoverLetterPath(appDir, checked));
    if (current.dev !== written.dev || current.ino !== written.ino) throw new CoverLetterPathError();
  } finally { fs.closeSync(descriptor); }
}

export function createCoverLetterAttempt(appDir: string, previewId: string): { directory: string; stat: fs.Stats } {
  let directory = fs.realpathSync(appDir);
  for (const part of ["generated", "cover-letter-previews", previewId]) {
    const next = ownedCoverLetterPath(appDir, path.join(directory, part), true);
    try { fs.mkdirSync(next, { mode: 0o700 }); }
    catch (error) { if (part === previewId || (error as NodeJS.ErrnoException).code !== "EEXIST") throw error; }
    directory = ownedCoverLetterPath(appDir, next);
    if (!fs.lstatSync(directory).isDirectory()) throw new CoverLetterPathError();
  }
  return { directory, stat: fs.lstatSync(directory) };
}

export function removeCoverLetterAttempt(appDir: string, directory: string, owner: fs.Stats): void {
  try {
    const checked = ownedCoverLetterPath(appDir, directory);
    const current = fs.lstatSync(checked);
    if (current.isDirectory() && current.dev === owner.dev && current.ino === owner.ino) fs.rmSync(checked, { recursive: true, force: true });
  } catch { /* A replaced directory belongs to another writer; never clean it. */ }
}
