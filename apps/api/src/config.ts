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
  const appDir = env.JOBHUNTER_DIR || path.join(os.homedir(), ".jobhunter");
  const port = Number.parseInt(env.JOBHUNTER_API_PORT || env.PORT || "8766", 10);
  const host = env.JOBHUNTER_API_HOST || "127.0.0.1";
  const remoteBindAllowed = ["1", "true", "yes"].includes((env.JOBHUNTER_API_ALLOW_REMOTE_BIND || "").toLowerCase());
  if (!isLoopbackHost(host) && !remoteBindAllowed) {
    throw new Error(
      `Refusing to bind JobHunter API to non-loopback host "${host}". Set JOBHUNTER_API_ALLOW_REMOTE_BIND=1 to opt in.`,
    );
  }

  return {
    appDir,
    dbPath: env.JOBHUNTER_DB_PATH || path.join(appDir, "jobhunter.db"),
    settingsPath: env.JOBHUNTER_DASHBOARD_CONFIG_PATH || path.join(appDir, "dashboard.json"),
    host,
    port: Number.isFinite(port) ? port : 8766,
  };
}

function isLoopbackHost(host: string): boolean {
  const normalized = host.trim().toLowerCase().replace(/^\[(.*)\]$/, "$1");
  return normalized === "localhost" || normalized === "::1" || normalized.startsWith("127.");
}
