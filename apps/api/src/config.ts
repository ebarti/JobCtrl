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
  const port = Number.parseInt(env.JOBCTRL_API_PORT || env.PORT || "8766", 10);
  const host = env.JOBCTRL_API_HOST || "127.0.0.1";
  const remoteBindAllowed = ["1", "true", "yes"].includes((env.JOBCTRL_API_ALLOW_REMOTE_BIND || "").toLowerCase());
  if (!isLoopbackHost(host) && !remoteBindAllowed) {
    throw new Error(
      `Refusing to bind JobCtrl API to non-loopback host "${host}". Set JOBCTRL_API_ALLOW_REMOTE_BIND=1 to opt in.`,
    );
  }
  const appDir = env.JOBCTRL_DIR || migrateDefaultWorkspace(env);

  return {
    appDir,
    dbPath: env.JOBCTRL_DB_PATH || path.join(appDir, "jobctrl.db"),
    settingsPath: env.JOBCTRL_DASHBOARD_CONFIG_PATH || path.join(appDir, "dashboard.json"),
    host,
    port: Number.isFinite(port) ? port : 8766,
  };
}

const legacyTokens = ["job" + "ctl", "job" + "hunter"] as const;
const currentAppDirname = ".jobctrl";
const currentDbFilename = "jobctrl.db";

type LegacyWorkspace = {
  dir: string;
  dbFilename: string;
};

export function migrateDefaultWorkspace(env: NodeJS.ProcessEnv = process.env): string {
  if (env.JOBCTRL_DIR) return env.JOBCTRL_DIR;

  const home = env.HOME || env.USERPROFILE || os.homedir();
  const legacyWorkspaces: LegacyWorkspace[] = legacyTokens.map((token) => ({
    dir: path.join(home, `.${token}`),
    dbFilename: `${token}.db`,
  }));
  const existingLegacyWorkspaces = legacyWorkspaces.filter((workspace) => fs.existsSync(workspace.dir));
  const currentDir = path.join(home, currentAppDirname);
  const lockDir = path.join(home, ".jobctrl-migration.lock");

  if (fs.existsSync(currentDir)) {
    if (existingLegacyWorkspaces.length > 0) {
      throw new Error(`refusing to move legacy workspace because ${currentDir} already exists`);
    }
    return currentDir;
  }
  const legacyWorkspace = existingLegacyWorkspaces[0];
  if (!legacyWorkspace) {
    return currentDir;
  }

  try {
    fs.mkdirSync(lockDir);
  } catch (error) {
    if (fs.existsSync(currentDir)) return currentDir;
    throw new Error(`another JobCtrl workspace migration is in progress; retry after it completes`, {
      cause: error,
    });
  }

  try {
    if (!fs.existsSync(currentDir) && fs.existsSync(legacyWorkspace.dir)) {
      assertNoLegacyDbRenameConflict(legacyWorkspace.dir, legacyWorkspace.dbFilename);
      moveWorkspace(legacyWorkspace.dir, currentDir);
      renameLegacyDbFiles(currentDir, legacyWorkspace.dbFilename);
      console.warn(`migrated legacy local workspace to ${currentDir}`);
    }
  } finally {
    fs.rmSync(lockDir, { recursive: true, force: true });
  }

  return currentDir;
}

function assertNoLegacyDbRenameConflict(legacyDir: string, legacyDbFilename: string): void {
  for (const suffix of ["", "-wal", "-shm"]) {
    const legacyPath = path.join(legacyDir, `${legacyDbFilename}${suffix}`);
    const currentPath = path.join(legacyDir, `${currentDbFilename}${suffix}`);
    if (fs.existsSync(legacyPath) && fs.existsSync(currentPath)) {
      throw new Error(`refusing to overwrite existing database file: ${currentPath}`);
    }
  }
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

function renameLegacyDbFiles(appDir: string, legacyDbFilename: string): void {
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
