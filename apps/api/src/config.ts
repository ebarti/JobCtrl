import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export interface ApiRuntimeConfig {
  appDir: string;
  dbPath: string;
  settingsPath: string;
  host: string;
  port: number;
}

export function resolveApiConfig(env: NodeJS.ProcessEnv = process.env): ApiRuntimeConfig {
  const appDir = env.JOBCTL_DIR || migrateDefaultWorkspace(env);
  const port = Number.parseInt(env.JOBCTL_API_PORT || env.PORT || "8766", 10);
  const host = env.JOBCTL_API_HOST || "127.0.0.1";
  const remoteBindAllowed = ["1", "true", "yes"].includes((env.JOBCTL_API_ALLOW_REMOTE_BIND || "").toLowerCase());
  if (!isLoopbackHost(host) && !remoteBindAllowed) {
    throw new Error(
      `Refusing to bind JobCtl API to non-loopback host "${host}". Set JOBCTL_API_ALLOW_REMOTE_BIND=1 to opt in.`,
    );
  }

  return {
    appDir,
    dbPath: env.JOBCTL_DB_PATH || path.join(appDir, "jobctl.db"),
    settingsPath: env.JOBCTL_DASHBOARD_CONFIG_PATH || path.join(appDir, "dashboard.json"),
    host,
    port: Number.isFinite(port) ? port : 8766,
  };
}

const legacyToken = "job" + "hunter";
const legacyAppDirname = `.${legacyToken}`;
const currentAppDirname = ".jobctl";
const legacyDbFilename = `${legacyToken}.db`;
const currentDbFilename = "jobctl.db";

export function migrateDefaultWorkspace(env: NodeJS.ProcessEnv = process.env): string {
  if (env.JOBCTL_DIR) return env.JOBCTL_DIR;

  const home = env.HOME || env.USERPROFILE || os.homedir();
  const legacyDir = path.join(home, legacyAppDirname);
  const currentDir = path.join(home, currentAppDirname);
  const lockDir = path.join(home, ".jobctl-migration.lock");

  if (fs.existsSync(currentDir)) {
    if (fs.existsSync(legacyDir)) {
      throw new Error(`refusing to move legacy workspace because ${currentDir} already exists`);
    }
    return currentDir;
  }
  if (!fs.existsSync(legacyDir)) {
    return currentDir;
  }

  try {
    fs.mkdirSync(lockDir);
  } catch (error) {
    if (fs.existsSync(currentDir)) return currentDir;
    throw new Error(`another JobCtl workspace migration is in progress; retry after it completes`, {
      cause: error,
    });
  }

  try {
    if (!fs.existsSync(currentDir) && fs.existsSync(legacyDir)) {
      moveWorkspace(legacyDir, currentDir);
      renameLegacyDbFiles(currentDir);
      console.warn(`migrated legacy local workspace to ${currentDir}`);
    }
  } finally {
    fs.rmSync(lockDir, { recursive: true, force: true });
  }

  return currentDir;
}

function moveWorkspace(legacyDir: string, currentDir: string): void {
  try {
    fs.renameSync(legacyDir, currentDir);
    return;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EXDEV") {
      throw error;
    }
  }
  fs.cpSync(legacyDir, currentDir, { recursive: true, verbatimSymlinks: true });
  verifyCopiedTree(legacyDir, currentDir);
  fs.rmSync(legacyDir, { recursive: true, force: true });
}

function verifyCopiedTree(source: string, destination: string): void {
  for (const relative of walkRelative(source)) {
    const sourcePath = path.join(source, relative);
    const destinationPath = path.join(destination, relative);
    const sourceStat = fs.lstatSync(sourcePath);
    if (sourceStat.isDirectory()) {
      if (!fs.statSync(destinationPath).isDirectory()) {
        throw new Error(`workspace copy verification failed for ${relative}`);
      }
      continue;
    }
    if (sourceStat.isSymbolicLink()) {
      if (!fs.lstatSync(destinationPath).isSymbolicLink() || fs.readlinkSync(sourcePath) !== fs.readlinkSync(destinationPath)) {
        throw new Error(`workspace symlink verification failed for ${relative}`);
      }
      continue;
    }
    if (!fs.statSync(destinationPath).isFile() || sourceStat.size !== fs.statSync(destinationPath).size) {
      throw new Error(`workspace copy verification failed for ${relative}`);
    }
  }
}

function walkRelative(root: string, prefix = ""): string[] {
  const base = path.join(root, prefix);
  return fs.readdirSync(base, { withFileTypes: true }).flatMap((entry) => {
    const relative = path.join(prefix, entry.name);
    if (!entry.isDirectory()) return [relative];
    return [relative, ...walkRelative(root, relative)];
  });
}

function renameLegacyDbFiles(appDir: string): void {
  for (const suffix of ["", "-wal", "-shm"]) {
    const legacyPath = path.join(appDir, `${legacyDbFilename}${suffix}`);
    const currentPath = path.join(appDir, `${currentDbFilename}${suffix}`);
    if (!fs.existsSync(legacyPath)) continue;
    if (fs.existsSync(currentPath)) {
      throw new Error(`refusing to overwrite existing database file: ${currentPath}`);
    }
    fs.renameSync(legacyPath, currentPath);
  }
}

function isLoopbackHost(host: string): boolean {
  const normalized = host.trim().toLowerCase().replace(/^\[(.*)\]$/, "$1");
  return normalized === "localhost" || normalized === "::1" || normalized.startsWith("127.");
}
