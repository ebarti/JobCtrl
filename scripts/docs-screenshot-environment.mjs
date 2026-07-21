import path from "node:path";

const TOOLCHAIN_ENVIRONMENT_KEYS = [
  "PATH",
  "Path",
  "HOME",
  "USERPROFILE",
  "SHELL",
  "TERM",
  "TMPDIR",
  "TMP",
  "TEMP",
  "LANG",
  "LC_ALL",
  "LC_CTYPE",
  "CI",
  "GITHUB_ACTIONS",
  "COREPACK_HOME",
  "PNPM_HOME",
  "PLAYWRIGHT_BROWSERS_PATH",
  "NO_COLOR",
  "FORCE_COLOR",
  "SYSTEMROOT",
  "COMSPEC",
  "PATHEXT",
];

/**
 * Build the complete environment for the documentation screenshot runner.
 *
 * The allowlist intentionally excludes provider, cloud, release, credential,
 * and arbitrary Vite variables. The runner keeps only the host paths needed to
 * find Node, Corepack, pnpm, and Playwright; the API and Vite services receive
 * a separate disposable HOME through JOBCTRL_E2E_SERVICE_HOME.
 */
export function createDocsScreenshotEnvironment({
  appDir,
  apiPort,
  webPort,
  sourceEnvironment = process.env,
  platform = process.platform,
}) {
  const environment = {};
  for (const key of TOOLCHAIN_ENVIRONMENT_KEYS) {
    const value = sourceEnvironment[key];
    if (typeof value === "string" && value.length > 0) {
      environment[key] = value;
    }
  }

  if (!environment.PLAYWRIGHT_BROWSERS_PATH) {
    const home = sourceEnvironment.HOME ?? sourceEnvironment.USERPROFILE;
    const defaultCacheRoot =
      platform === "darwin"
        ? home && path.join(home, "Library", "Caches")
        : platform === "win32"
          ? (sourceEnvironment.LOCALAPPDATA ??
            (home && path.join(home, "AppData", "Local")))
          : (sourceEnvironment.XDG_CACHE_HOME ??
            (home && path.join(home, ".cache")));
    if (defaultCacheRoot) {
      environment.PLAYWRIGHT_BROWSERS_PATH = path.join(
        defaultCacheRoot,
        "ms-playwright",
      );
    }
  }

  return {
    ...environment,
    TZ: "UTC",
    JOBCTRL_DOCS_SCREENSHOTS: "1",
    JOBCTRL_E2E_APP_DIR: appDir,
    JOBCTRL_E2E_DB_PATH: path.join(appDir, "jobctrl.db"),
    JOBCTRL_E2E_CONFIG_PATH: path.join(appDir, "config.json"),
    JOBCTRL_E2E_SERVICE_HOME: path.join(appDir, "service-home"),
    JOBCTRL_E2E_API_PORT: String(apiPort),
    JOBCTRL_E2E_WEB_PORT: String(webPort),
  };
}
