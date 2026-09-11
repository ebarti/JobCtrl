import { chromium, type BrowserContext } from "@playwright/test";
import path from "node:path";
import { fileURLToPath } from "node:url";

const DIST = path.resolve(
  fileURLToPath(new URL(".", import.meta.url)),
  "../../../dist/extension",
);

/** A required browser prerequisite must reject the test instead of returning a passing no-op. */
export async function launchExtensionContext(
  userDataDir: string,
): Promise<BrowserContext> {
  return chromium.launchPersistentContext(userDataDir, {
    headless: false,
    args: [
      `--disable-extensions-except=${DIST}`,
      `--load-extension=${DIST}`,
      "--host-resolver-rules=MAP careers.jobctrl.test 127.0.0.1, MAP www.linkedin.com 127.0.0.1",
    ],
  });
}
