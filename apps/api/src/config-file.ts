import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import { resolveDefaultWorkspace } from "./config.js";

export type JobCtrlConfigObject = Record<string, unknown>;

export class ConfigFileInputError extends Error {}

export const CONFIG_LOCK_DIRECTORY = ".config.lock";
const CONFIG_LOCK_TIMEOUT_MS = 30_000;
const CONFIG_LOCK_STALE_MS = 15 * 60_000;
const CONFIG_LOCK_RETRY_MS = 10;
const LOCK_WAIT_BUFFER = new Int32Array(new SharedArrayBuffer(4));

export function readConfigObject(configPath: string): JobCtrlConfigObject {
  if (!fs.existsSync(configPath)) {
    return {};
  }
  try {
    const parsed = JSON.parse(fs.readFileSync(configPath, "utf8")) as unknown;
    if (!isRecord(parsed)) {
      throw new ConfigFileInputError(`${path.basename(configPath)} must contain a JSON object.`);
    }
    return parsed;
  } catch (error) {
    if (error instanceof ConfigFileInputError) {
      throw error;
    }
    throw new ConfigFileInputError(`${path.basename(configPath)} must contain valid JSON.`);
  }
}

export function writeConfigObject(
  configPath: string,
  config: JobCtrlConfigObject,
): void {
  withConfigLock(configPath, () => writeConfigObjectUnlocked(configPath, config));
}

export function updateConfigObject(
  configPath: string,
  update: (config: JobCtrlConfigObject) => void,
): JobCtrlConfigObject {
  return withConfigLock(configPath, () => {
    const config = readConfigObject(configPath);
    update(config);
    writeConfigObjectUnlocked(configPath, config);
    return config;
  });
}

function writeConfigObjectUnlocked(
  configPath: string,
  config: JobCtrlConfigObject,
): void {
  const temporaryPath = `${configPath}.${process.pid}.${crypto.randomUUID()}.tmp`;
  try {
    fs.writeFileSync(temporaryPath, `${JSON.stringify(config, null, 2)}\n`, {
      encoding: "utf8",
      mode: 0o600,
    });
    fs.renameSync(temporaryPath, configPath);
    fs.chmodSync(configPath, 0o600);
  } finally {
    if (fs.existsSync(temporaryPath)) {
      fs.rmSync(temporaryPath, { force: true });
    }
  }
}

function withConfigLock<T>(configPath: string, action: () => T): T {
  const directory = path.dirname(configPath);
  const lockPath = path.join(directory, CONFIG_LOCK_DIRECTORY);
  ensureConfigDirectory(directory);
  const deadline = Date.now() + CONFIG_LOCK_TIMEOUT_MS;

  while (true) {
    try {
      fs.mkdirSync(lockPath, { mode: 0o700 });
      break;
    } catch (error) {
      if (!isNodeError(error) || error.code !== "EEXIST") throw error;
      recoverStaleLock(lockPath);
      if (Date.now() >= deadline) {
        throw new ConfigFileInputError(
          `${path.basename(configPath)} is busy; retry after the current settings update finishes.`,
        );
      }
      Atomics.wait(LOCK_WAIT_BUFFER, 0, 0, CONFIG_LOCK_RETRY_MS);
    }
  }

  try {
    return action();
  } finally {
    try {
      fs.rmdirSync(lockPath);
    } catch (error) {
      if (!isNodeError(error) || error.code !== "ENOENT") throw error;
    }
  }
}

function ensureConfigDirectory(directory: string): void {
  const created: string[] = [];
  let candidate = directory;
  while (!fs.existsSync(candidate)) {
    created.push(candidate);
    const parent = path.dirname(candidate);
    if (parent === candidate) break;
    candidate = parent;
  }
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  for (const createdDirectory of created) {
    fs.chmodSync(createdDirectory, 0o700);
  }
  if (path.resolve(directory) === path.resolve(resolveDefaultWorkspace())) {
    fs.chmodSync(directory, 0o700);
  }
}

function recoverStaleLock(lockPath: string): void {
  let stats: fs.Stats;
  try {
    stats = fs.lstatSync(lockPath);
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") return;
    throw error;
  }
  if (!stats.isDirectory()) {
    throw new ConfigFileInputError("The settings lock path is not a directory.");
  }
  if (Date.now() - stats.mtimeMs <= CONFIG_LOCK_STALE_MS) return;
  try {
    fs.rmdirSync(lockPath);
  } catch (error) {
    if (!isNodeError(error) || !["ENOENT", "ENOTEMPTY"].includes(error.code ?? "")) {
      throw error;
    }
  }
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
