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

export interface ProductionApiRuntimeConfig extends ApiRuntimeConfig {
  payloadDir: string;
  pythonExecutable: string;
  webAssetsDir: string;
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
  const appDir = resolveDefaultWorkspace(env);
  const settingsOverride = env.JOBCTRL_DASHBOARD_CONFIG_PATH;

  return {
    appDir,
    dbPath: env.JOBCTRL_DB_PATH || path.join(appDir, "jobctrl.db"),
    settingsPath: settingsOverride
      ? expandHomePath(settingsOverride, env)
      : path.join(appDir, "dashboard.json"),
    host,
    port: Number.isFinite(port) ? port : 8766,
  };
}

export function resolveProductionApiConfig(
  env: NodeJS.ProcessEnv = process.env,
): ProductionApiRuntimeConfig {
  const config = resolveApiConfig(env);
  const payloadDir = requiredRealDirectory(env.JOBCTRL_PAYLOAD_DIR, "JOBCTRL_PAYLOAD_DIR");
  const pythonExecutable = requiredPayloadFile(
    env.JOBCTRL_PYTHON_EXECUTABLE,
    "JOBCTRL_PYTHON_EXECUTABLE",
    payloadDir,
    true,
  );
  const webAssetsDir = requiredPayloadDirectory(
    env.JOBCTRL_WEB_ASSETS_DIR,
    "JOBCTRL_WEB_ASSETS_DIR",
    payloadDir,
  );
  // Chromium is a manifest-fixed core component rather than an environment
  // override. Validate its real target so the worker cannot follow a payload
  // symlink into a user-managed Playwright cache.
  requiredPayloadDirectory(
    path.join(payloadDir, "chromium"),
    "bundled Chromium directory",
    payloadDir,
  );
  return {
    ...config,
    payloadDir,
    webAssetsDir,
    pythonExecutable,
  };
}

const currentAppDirname = ".jobctrl";

export function resolveDefaultWorkspace(env: NodeJS.ProcessEnv = process.env): string {
  if (env.JOBCTRL_DIR) return expandHomePath(env.JOBCTRL_DIR, env);

  const home = env.HOME || env.USERPROFILE || os.homedir();
  return path.join(home, currentAppDirname);
}

function expandHomePath(value: string, env: NodeJS.ProcessEnv): string {
  const home = env.HOME || env.USERPROFILE || os.homedir();
  if (value === "~") return home;
  if (value.startsWith("~/") || value.startsWith("~\\")) {
    return path.join(home, value.slice(2));
  }
  return value;
}

function isLoopbackHost(host: string): boolean {
  const normalized = host.trim().toLowerCase().replace(/^\[(.*)\]$/, "$1");
  return normalized === "localhost" || normalized === "::1" || normalized.startsWith("127.");
}

function requiredAbsolutePath(value: string | undefined, name: string): string {
  if (!value?.trim()) {
    throw new Error(`${name} is required in bundled production mode.`);
  }
  if (!path.isAbsolute(value)) {
    throw new Error(`${name} must be an absolute path in bundled production mode.`);
  }
  return path.normalize(value);
}

function requiredRealDirectory(value: string | undefined, name: string): string {
  const configuredPath = requiredAbsolutePath(value, name);
  let realPath: string;
  try {
    realPath = fs.realpathSync(configuredPath);
  } catch {
    throw new Error(`${name} must reference an existing directory in bundled production mode.`);
  }
  if (!fs.statSync(realPath).isDirectory()) {
    throw new Error(`${name} must reference an existing directory in bundled production mode.`);
  }
  return realPath;
}

function requiredPayloadDirectory(
  value: string | undefined,
  name: string,
  payloadDir: string,
): string {
  const realPath = requiredRealDirectory(value, name);
  assertWithinPayload(realPath, name, payloadDir);
  return realPath;
}

function requiredPayloadFile(
  value: string | undefined,
  name: string,
  payloadDir: string,
  executable: boolean,
): string {
  const configuredPath = requiredAbsolutePath(value, name);
  let realPath: string;
  try {
    realPath = fs.realpathSync(configuredPath);
  } catch {
    throw new Error(`${name} must reference an existing file in bundled production mode.`);
  }
  if (!fs.statSync(realPath).isFile()) {
    throw new Error(`${name} must reference an existing file in bundled production mode.`);
  }
  assertWithinPayload(realPath, name, payloadDir);
  if (executable) {
    try {
      fs.accessSync(realPath, fs.constants.X_OK);
    } catch {
      throw new Error(`${name} must reference an executable file in bundled production mode.`);
    }
  }
  return realPath;
}

function assertWithinPayload(candidate: string, name: string, payloadDir: string): void {
  const relative = path.relative(payloadDir, candidate);
  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error(`${name} must resolve inside JOBCTRL_PAYLOAD_DIR in bundled production mode.`);
  }
}
