import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";

import { createDocsScreenshotEnvironment } from "./docs-screenshot-environment.mjs";

test("documentation screenshot environment allows toolchain state but excludes host credentials", () => {
  const appDir = path.join("/tmp", "jobctrl-docs-environment-test");
  const environment = createDocsScreenshotEnvironment({
    appDir,
    apiPort: 18_767,
    webPort: 15_174,
    sourceEnvironment: {
      PATH: "/usr/local/bin:/usr/bin",
      HOME: "/Users/example",
      PLAYWRIGHT_BROWSERS_PATH: "/Users/example/playwright",
      LANG: "en_US.UTF-8",
      UV_EXCLUDE_NEWER: "8 days",
      OPENAI_API_KEY: "must-not-escape",
      GEMINI_API_KEY: "must-not-escape",
      GOOGLE_APPLICATION_CREDENTIALS: "/private/service-account.json",
      AWS_SECRET_ACCESS_KEY: "must-not-escape",
      JOBCTRL_RELEASE_SIGNING_KEY: "must-not-escape",
      VITE_PRIVATE_TOKEN: "must-not-escape",
      PRIVATE_LAUNCH_TOKEN: "must-not-escape",
    },
  });

  assert.equal(environment.PATH, "/usr/local/bin:/usr/bin");
  assert.equal(environment.HOME, "/Users/example");
  assert.equal(
    environment.PLAYWRIGHT_BROWSERS_PATH,
    "/Users/example/playwright",
  );
  assert.equal(environment.TZ, "UTC");
  assert.equal(
    environment.UV_LOCKED,
    "1",
    "profile preview rendering must not rewrite workers/automation/uv.lock",
  );
  assert.equal(environment.JOBCTRL_DOCS_SCREENSHOTS, "1");
  assert.equal(environment.JOBCTRL_E2E_APP_DIR, appDir);
  assert.equal(
    environment.JOBCTRL_E2E_SERVICE_HOME,
    path.join(appDir, "service-home"),
  );
  assert.equal(environment.JOBCTRL_E2E_API_PORT, "18767");
  assert.equal(environment.JOBCTRL_E2E_WEB_PORT, "15174");
  assert.equal(
    "UV_EXCLUDE_NEWER" in environment,
    false,
    "the fixed cutoff belongs to workers/automation/pyproject.toml",
  );

  for (const key of [
    "OPENAI_API_KEY",
    "GEMINI_API_KEY",
    "GOOGLE_APPLICATION_CREDENTIALS",
    "AWS_SECRET_ACCESS_KEY",
    "JOBCTRL_RELEASE_SIGNING_KEY",
    "VITE_PRIVATE_TOKEN",
    "PRIVATE_LAUNCH_TOKEN",
  ]) {
    assert.equal(key in environment, false, `${key} must not reach capture`);
  }
});

test("documentation screenshot environment keeps only the default Playwright cache outside the isolated service home", () => {
  const appDir = path.join("/tmp", "jobctrl-docs-environment-default-cache");
  const environment = createDocsScreenshotEnvironment({
    appDir,
    apiPort: 18_767,
    webPort: 15_174,
    platform: "darwin",
    sourceEnvironment: {
      PATH: "/usr/local/bin:/usr/bin",
      HOME: "/Users/example",
      GOOGLE_APPLICATION_CREDENTIALS: "/private/service-account.json",
    },
  });

  assert.equal(
    environment.PLAYWRIGHT_BROWSERS_PATH,
    "/Users/example/Library/Caches/ms-playwright",
  );
  assert.equal(
    environment.JOBCTRL_E2E_SERVICE_HOME,
    path.join(appDir, "service-home"),
  );
  assert.equal("GOOGLE_APPLICATION_CREDENTIALS" in environment, false);
});
