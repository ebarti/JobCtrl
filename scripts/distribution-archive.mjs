#!/usr/bin/env node

import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import {
  chmod,
  lstat,
  mkdir,
  readFile,
  readlink,
  realpath,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import path from "node:path";
import { gunzipSync, inflateRawSync } from "node:zlib";

import { assertSafeRelativePath, resolveSafeSymlinkTarget } from "./distribution-manifest.mjs";

const SHA256_PATTERN = /^[a-f0-9]{64}$/;
const TAR_BLOCK_SIZE = 512;

function invariant(condition, message) {
  if (!condition) throw new Error(message);
}

function bytewiseCompare(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}

function bufferString(buffer, start, length) {
  const end = buffer.indexOf(0, start);
  const boundedEnd = end === -1 || end > start + length ? start + length : end;
  return buffer.subarray(start, boundedEnd).toString("utf8");
}

function tarNumber(buffer, start, length, label) {
  const field = buffer.subarray(start, start + length);
  if ((field[0] & 0x80) !== 0) {
    invariant((field[0] & 0x40) === 0, `${label}: negative tar numbers are not supported`);
    let result = BigInt(field[0] & 0x3f);
    for (const value of field.subarray(1)) result = (result << 8n) | BigInt(value);
    invariant(result <= BigInt(Number.MAX_SAFE_INTEGER), `${label}: tar number exceeds JavaScript's safe range`);
    return Number(result);
  }
  const text = field.toString("ascii").replace(/\0.*$/s, "").trim();
  if (text === "") return 0;
  invariant(/^[0-7]+$/.test(text), `${label}: invalid tar octal number`);
  return Number.parseInt(text, 8);
}

function tarChecksum(buffer, offset) {
  let sum = 0;
  for (let index = 0; index < TAR_BLOCK_SIZE; index += 1) {
    sum += index >= 148 && index < 156 ? 0x20 : buffer[offset + index];
  }
  return sum;
}

function parsePax(contents) {
  const values = {};
  let offset = 0;
  while (offset < contents.length) {
    const space = contents.indexOf(0x20, offset);
    invariant(space > offset, "invalid PAX record length");
    const lengthText = contents.subarray(offset, space).toString("ascii");
    invariant(/^[0-9]+$/.test(lengthText), "invalid PAX record length");
    const length = Number.parseInt(lengthText, 10);
    invariant(length > space - offset + 2 && offset + length <= contents.length, "truncated PAX record");
    const record = contents.subarray(space + 1, offset + length - 1).toString("utf8");
    const equals = record.indexOf("=");
    invariant(equals > 0, "invalid PAX record");
    values[record.slice(0, equals)] = record.slice(equals + 1);
    offset += length;
  }
  return values;
}

function stripArchivePath(value, stripComponents, label) {
  invariant(typeof value === "string" && value.length > 0, `${label}: empty archive path`);
  invariant(!value.includes("\\"), `${label}: archive paths must use POSIX separators`);
  invariant(!value.startsWith("/"), `${label}: absolute archive path is forbidden`);
  const withoutDot = value.startsWith("./") ? value.slice(2) : value;
  const normalized = path.posix.normalize(withoutDot.replace(/\/$/, ""));
  invariant(
    normalized !== "." && normalized !== ".." && !normalized.startsWith("../"),
    `${label}: archive path escapes the extraction root`,
  );
  invariant(normalized === withoutDot.replace(/\/$/, ""), `${label}: archive path must be normalized`);
  const segments = normalized.split("/");
  if (segments.length <= stripComponents) return null;
  const stripped = segments.slice(stripComponents).join("/");
  return assertSafeRelativePath(stripped, label);
}

export async function sha256File(filePath) {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(filePath)) hash.update(chunk);
  return hash.digest("hex");
}

export async function verifyLockedArchive(archivePath, lock) {
  invariant(lock && typeof lock === "object", "archive lock must be an object");
  invariant(SHA256_PATTERN.test(lock.sha256 ?? ""), `${lock.id ?? "archive"}: invalid locked SHA-256`);
  const archiveStat = await lstat(archivePath);
  invariant(archiveStat.isFile() && !archiveStat.isSymbolicLink(), `${lock.id}: archive cache entry must be a regular file`);
  const actual = await sha256File(archivePath);
  invariant(actual === lock.sha256, `${lock.id}: archive SHA-256 mismatch (expected ${lock.sha256}, received ${actual})`);
  return actual;
}

export function parseTarGzArchive(archive, { stripComponents = 0 } = {}) {
  invariant(Number.isInteger(stripComponents) && stripComponents >= 0, "stripComponents must be non-negative");
  const tar = gunzipSync(archive);
  const entries = [];
  let offset = 0;
  let nextLongPath = null;
  let nextLongLink = null;
  let nextPax = {};
  while (offset + TAR_BLOCK_SIZE <= tar.length) {
    const header = tar.subarray(offset, offset + TAR_BLOCK_SIZE);
    if (header.every((value) => value === 0)) break;
    const storedChecksum = tarNumber(header, 148, 8, "tar checksum");
    invariant(storedChecksum === tarChecksum(tar, offset), "tar header checksum mismatch");
    const size = tarNumber(header, 124, 12, "tar entry size");
    const mode = tarNumber(header, 100, 8, "tar entry mode");
    const type = String.fromCharCode(header[156] || 0x30);
    const prefix = bufferString(header, 345, 155);
    const rawName = bufferString(header, 0, 100);
    const rawPath = nextPax.path ?? nextLongPath ?? (prefix ? `${prefix}/${rawName}` : rawName);
    const rawLink = nextPax.linkpath ?? nextLongLink ?? bufferString(header, 157, 100);
    const contentsStart = offset + TAR_BLOCK_SIZE;
    const contentsEnd = contentsStart + size;
    invariant(contentsEnd <= tar.length, `${rawPath || "tar entry"}: truncated tar contents`);
    const contents = tar.subarray(contentsStart, contentsEnd);
    offset = contentsStart + Math.ceil(size / TAR_BLOCK_SIZE) * TAR_BLOCK_SIZE;

    if (type === "x" || type === "g") {
      const values = parsePax(contents);
      if (type === "x") nextPax = values;
      continue;
    }
    if (type === "L") {
      nextLongPath = contents.toString("utf8").replace(/\0.*$/s, "");
      continue;
    }
    if (type === "K") {
      nextLongLink = contents.toString("utf8").replace(/\0.*$/s, "");
      continue;
    }

    const relativePath = stripArchivePath(rawPath, stripComponents, "tar entry path");
    nextPax = {};
    nextLongPath = null;
    nextLongLink = null;
    if (relativePath === null) continue;
    invariant((mode & 0o7000) === 0, `${relativePath}: tar entry has unsafe special mode ${mode.toString(8)}`);
    if (type === "5") {
      entries.push({ type: "directory", path: relativePath, mode: "0755" });
    } else if (type === "0" || type === "\0" || type === "7") {
      entries.push({
        type: "file",
        path: relativePath,
        mode: (mode & 0o111) === 0 ? "0644" : "0755",
        contents: Buffer.from(contents),
      });
    } else if (type === "2") {
      entries.push({ type: "symlink", path: relativePath, target: rawLink });
    } else {
      throw new Error(`${relativePath}: unsupported tar entry type ${JSON.stringify(type)}`);
    }
  }
  invariant(entries.length > 0, "archive contains no extractable entries");
  return validateArchiveEntries(entries);
}

function findZipEndOfCentralDirectory(archive) {
  const signature = 0x06054b50;
  const minimum = Math.max(0, archive.length - 0xffff - 22);
  for (let offset = archive.length - 22; offset >= minimum; offset -= 1) {
    if (archive.readUInt32LE(offset) === signature) return offset;
  }
  throw new Error("ZIP end-of-central-directory record was not found");
}

export function parseZipArchive(archive, { stripComponents = 0 } = {}) {
  invariant(Number.isInteger(stripComponents) && stripComponents >= 0, "stripComponents must be non-negative");
  const eocd = findZipEndOfCentralDirectory(archive);
  invariant(archive.readUInt16LE(eocd + 4) === 0 && archive.readUInt16LE(eocd + 6) === 0, "multi-disk ZIP archives are forbidden");
  const entryCount = archive.readUInt16LE(eocd + 10);
  const centralSize = archive.readUInt32LE(eocd + 12);
  let offset = archive.readUInt32LE(eocd + 16);
  invariant(offset + centralSize <= eocd, "invalid ZIP central directory bounds");
  const entries = [];
  for (let index = 0; index < entryCount; index += 1) {
    invariant(archive.readUInt32LE(offset) === 0x02014b50, "invalid ZIP central directory entry");
    const flags = archive.readUInt16LE(offset + 8);
    const method = archive.readUInt16LE(offset + 10);
    const compressedSize = archive.readUInt32LE(offset + 20);
    const uncompressedSize = archive.readUInt32LE(offset + 24);
    const nameLength = archive.readUInt16LE(offset + 28);
    const extraLength = archive.readUInt16LE(offset + 30);
    const commentLength = archive.readUInt16LE(offset + 32);
    const externalAttributes = archive.readUInt32LE(offset + 38);
    const localOffset = archive.readUInt32LE(offset + 42);
    invariant((flags & 0x1) === 0, "encrypted ZIP entries are forbidden");
    invariant(method === 0 || method === 8, "ZIP entry uses an unsupported compression method");
    const rawName = archive.subarray(offset + 46, offset + 46 + nameLength).toString("utf8");
    offset += 46 + nameLength + extraLength + commentLength;
    const relativePath = stripArchivePath(rawName, stripComponents, "ZIP entry path");
    if (relativePath === null) continue;

    invariant(archive.readUInt32LE(localOffset) === 0x04034b50, `${relativePath}: invalid ZIP local header`);
    const localNameLength = archive.readUInt16LE(localOffset + 26);
    const localExtraLength = archive.readUInt16LE(localOffset + 28);
    const dataStart = localOffset + 30 + localNameLength + localExtraLength;
    const compressed = archive.subarray(dataStart, dataStart + compressedSize);
    invariant(compressed.length === compressedSize, `${relativePath}: truncated ZIP data`);
    const contents = method === 0 ? Buffer.from(compressed) : inflateRawSync(compressed);
    invariant(contents.length === uncompressedSize, `${relativePath}: ZIP uncompressed size mismatch`);
    const unixMode = externalAttributes >>> 16;
    const fileType = unixMode & 0o170000;
    const directory = rawName.endsWith("/") || fileType === 0o040000;
    if (directory) {
      entries.push({ type: "directory", path: relativePath, mode: "0755" });
    } else if (fileType === 0o120000) {
      entries.push({ type: "symlink", path: relativePath, target: contents.toString("utf8") });
    } else {
      invariant(fileType === 0 || fileType === 0o100000, `${relativePath}: unsupported ZIP entry type`);
      invariant((unixMode & 0o7000) === 0, `${relativePath}: ZIP entry has unsafe special mode ${unixMode.toString(8)}`);
      entries.push({
        type: "file",
        path: relativePath,
        mode: (unixMode & 0o111) === 0 ? "0644" : "0755",
        contents,
      });
    }
  }
  invariant(offset <= eocd, "ZIP central directory overruns its declared bounds");
  invariant(entries.length > 0, "archive contains no extractable entries");
  return validateArchiveEntries(entries);
}

function validateArchiveEntries(entries) {
  const paths = new Set();
  const casefoldPaths = new Map();
  const filePaths = new Set();
  for (const entry of entries) {
    assertSafeRelativePath(entry.path, "archive entry path");
    invariant(!paths.has(entry.path), `${entry.path}: duplicate archive entry`);
    const folded = entry.path.toLowerCase();
    invariant(!casefoldPaths.has(folded), `${entry.path}: archive entry collides case-insensitively with ${casefoldPaths.get(folded)}`);
    paths.add(entry.path);
    casefoldPaths.set(folded, entry.path);
    if (entry.type !== "directory") filePaths.add(entry.path);
    if (entry.type === "symlink") resolveSafeSymlinkTarget(entry.target, entry.path);
  }
  for (const entry of entries) {
    const segments = entry.path.split("/");
    for (let index = 1; index < segments.length; index += 1) {
      const ancestor = segments.slice(0, index).join("/");
      invariant(!filePaths.has(ancestor), `${entry.path}: archive entry is nested below non-directory ${ancestor}`);
    }
  }
  return entries.sort((left, right) => bytewiseCompare(left.path, right.path));
}

async function validateExtractedSymlinks(destination, entries) {
  const realRoot = await realpath(destination);
  for (const entry of entries) {
    if (entry.type !== "symlink") continue;
    const resolved = resolveSafeSymlinkTarget(entry.target, entry.path);
    let target;
    try {
      target = await realpath(path.join(destination, resolved));
    } catch (error) {
      if (error?.code === "ELOOP") throw new Error(`${entry.path}: archive symlink cycle detected`);
      throw new Error(`${entry.path}: archive symlink target is dangling`);
    }
    invariant(target === realRoot || target.startsWith(`${realRoot}${path.sep}`), `${entry.path}: archive symlink target escapes extraction root`);
  }
}

export async function extractArchiveEntries(entries, destination) {
  await rm(destination, { recursive: true, force: true });
  await mkdir(destination, { recursive: true, mode: 0o755 });
  for (const entry of entries) {
    const targetPath = path.join(destination, ...entry.path.split("/"));
    if (entry.type === "directory") {
      await mkdir(targetPath, { recursive: true, mode: 0o755 });
      await chmod(targetPath, 0o755);
      continue;
    }
    await mkdir(path.dirname(targetPath), { recursive: true, mode: 0o755 });
    if (entry.type === "file") {
      await writeFile(targetPath, entry.contents, { mode: Number.parseInt(entry.mode, 8), flag: "wx" });
      await chmod(targetPath, Number.parseInt(entry.mode, 8));
    } else {
      await symlink(entry.target, targetPath);
    }
  }
  await validateExtractedSymlinks(destination, entries);
  return entries;
}

export async function extractVerifiedArchive({ archivePath, lock, destination, stripComponents = 0, include = null }) {
  await verifyLockedArchive(archivePath, lock);
  const archive = await readFile(archivePath);
  let entries;
  if (lock.archiveType === "tar.gz") {
    entries = parseTarGzArchive(archive, { stripComponents });
  } else if (lock.archiveType === "zip") {
    entries = parseZipArchive(archive, { stripComponents });
  } else {
    throw new Error(`${lock.id}: unsupported locked archive type ${lock.archiveType}`);
  }
  if (include) entries = entries.filter((entry) => include(entry.path, entry));
  invariant(entries.length > 0, `${lock.id}: archive selection contains no entries`);
  await extractArchiveEntries(entries, destination);
  return entries.map(({ contents: _contents, ...entry }) => entry);
}

export async function assertSymlinksPreserved(root, expectedEntries) {
  for (const entry of expectedEntries.filter((value) => value.type === "symlink")) {
    const actual = await readlink(path.join(root, ...entry.path.split("/")));
    invariant(actual === entry.target, `${entry.path}: extracted symlink target changed`);
  }
}
