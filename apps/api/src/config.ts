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
