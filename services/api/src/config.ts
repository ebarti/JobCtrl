import os from "node:os";
import path from "node:path";

export interface ApiRuntimeConfig {
  appDir: string;
  dbPath: string;
  profilePath: string;
  resumeStylePath: string;
  resumeTemplatePath: string;
  settingsPath: string;
  host: string;
  port: number;
}

export function resolveApiConfig(env: NodeJS.ProcessEnv = process.env): ApiRuntimeConfig {
  const appDir = env.JOBHUNTER_DIR || path.join(os.homedir(), ".jobhunter");
  const port = Number.parseInt(env.JOBHUNTER_API_PORT || env.PORT || "8766", 10);

  return {
    appDir,
    dbPath: env.JOBHUNTER_DB_PATH || path.join(appDir, "jobhunter.db"),
    profilePath: env.JOBHUNTER_PROFILE_PATH || path.join(appDir, "profile.json"),
    resumeStylePath: env.JOBHUNTER_RESUME_STYLE_PATH || path.join(appDir, "resume_style.json"),
    resumeTemplatePath: env.JOBHUNTER_RESUME_TEMPLATE_PATH || path.join(appDir, "resume_template.tex"),
    settingsPath: env.JOBHUNTER_DASHBOARD_CONFIG_PATH || path.join(appDir, "dashboard.json"),
    host: env.JOBHUNTER_API_HOST || "127.0.0.1",
    port: Number.isFinite(port) ? port : 8766,
  };
}
