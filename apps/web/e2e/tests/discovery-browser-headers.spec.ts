import { expect, test } from "@playwright/test";
import { execFileSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { loadE2eDbPath } from "../fixtures/e2e-state.js";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../..");

function workerHeaders() {
  // Read the same owned SQLite database saved through the actual API. Construct
  // the real worker request without contacting any external site.
  const script = `
import json, sys
from pathlib import Path
from jobctrl import config
config.DB_PATH = Path(sys.argv[1])
config.APP_DIR = config.DB_PATH.parent
from jobctrl.domain.discovery.source_registry import ENRICHMENT_CRAWL_POLICY
from jobctrl.infrastructure.network.politeness import PolitenessGateway, PolitenessSession, PolitenessSourceContext
from jobctrl.infrastructure.network.http_client import GatewayHttpClient
class Response:
    headers = {}
    def __enter__(self): return self
    def __exit__(self, *args): pass
    def read(self): return b"synthetic"
class Capture:
    def open(self, request, **kwargs):
        print(json.dumps(dict(request.header_items())))
        return Response()
gateway = PolitenessGateway()
session = PolitenessSession(gateway, policy=ENRICHMENT_CRAWL_POLICY, budget=gateway.new_run_budget(1), context=PolitenessSourceContext(stage="enrich"))
GatewayHttpClient(session, opener=Capture()).fetch_text("https://example.test/synthetic")
`;
  return JSON.parse(execFileSync(path.join(repoRoot, "workers/automation/.venv/bin/python"), ["-c", script, loadE2eDbPath()], {
    cwd: repoRoot, env: { ...process.env, JOBCTRL_DIR: path.dirname(loadE2eDbPath()), LANGFUSE_DISABLE: "1", JOBCTRL_RUNTIME_MODE: "source" }, encoding: "utf8", timeout: 30_000,
  }));
}

for (const mobile of [false, true]) {
  test(`runtime browser headers persist and reach worker requests${mobile ? " @mobile" : ""}`, async ({ page }, testInfo) => {
    test.setTimeout(90_000);
    await page.setViewportSize(mobile ? { width: 390, height: 844 } : { width: 1440, height: 1000 });
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    page.on("console", (message) => { if (message.type() === "error") errors.push(message.text()); });
    await page.goto("/discovery");
    await page.getByRole("link", { name: "Runtime", exact: true }).click();
    const checkbox = page.getByRole("checkbox", { name: "Use browser headers", exact: true });
    await expect(checkbox).toBeVisible();
    await expect(checkbox).not.toBeChecked();
    const checkboxBounds = await checkbox.boundingBox();
    const labelBounds = await page.getByText("Use browser headers", { exact: true }).boundingBox();
    expect(checkboxBounds).not.toBeNull();
    expect(labelBounds).not.toBeNull();
    expect(Math.abs(checkboxBounds!.y - labelBounds!.y)).toBeLessThan(10);
    expect(checkboxBounds!.x).toBeLessThan(labelBounds!.x);
    await expect(page.getByLabel("Crawler product name", { exact: true })).toHaveCount(0);
    await expect(page.getByLabel("Crawler contact", { exact: true })).toHaveCount(0);
    const original = workerHeaders();
    expect(original["User-agent"]).toMatch(/^JobCtrl\//);
    expect(original["Sec-ch-ua"]).toBeUndefined();
    await checkbox.check();
    await page.getByRole("button", { name: "Discard changes", exact: true }).click();
    await expect(checkbox).not.toBeChecked();
    for (const enabled of [true, false]) {
      await checkbox.setChecked(enabled);
      await page.getByRole("button", { name: "Save changes", exact: true }).click();
      await expect(page.getByText("Runtime settings saved.", { exact: true })).toBeVisible();
      await page.reload();
      await page.getByRole("link", { name: "Runtime", exact: true }).click();
      await expect(checkbox).toBeChecked({ checked: enabled });
      const headers = workerHeaders();
      if (enabled) {
        expect(headers["User-agent"]).toContain("Chrome/");
        expect(headers["Sec-ch-ua"]).toContain("Chromium");
        expect(headers["Sec-ch-ua-mobile"]).toBe("?0");
        expect(headers["Sec-ch-ua-platform"]).toBeTruthy();
      } else {
        expect(headers).toEqual(original);
      }
      await checkbox.scrollIntoViewIfNeeded();
      await page.screenshot({ path: testInfo.outputPath(`browser-headers-${enabled ? "on" : "off"}.png`) });
    }
    expect(page.url()).toContain("/discovery");
    expect(await page.title()).toContain("JobCtrl");
    await expect(page.locator("vite-error-overlay")).toHaveCount(0);
    expect(errors).toEqual([]);
  });
}
