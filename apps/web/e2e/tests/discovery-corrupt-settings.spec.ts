import Database from "better-sqlite3";
import { expect, test } from "@playwright/test";

import { loadE2eDbPath } from "../fixtures/e2e-state.js";

test.skip(
  process.platform !== "linux" || process.env["JOBCTRL_E2E_ISOLATED"] !== "1",
  "Requires hosted Linux and the owned synthetic API workspace.",
);

test("corrupt saved settings show recovery without replacing their bytes", async ({ page, baseURL }, testInfo) => {
  // loadE2eDbPath verifies the run's ownership capability before any write.
  const db = new Database(loadE2eDbPath());
  const read = db.prepare(
    "SELECT search_config_json, created_at, updated_at FROM discovery_settings WHERE tenant_id='local'",
  );
  const original = read.get() as {
    search_config_json: string; created_at: string; updated_at: string;
  } | undefined;
  const malformed = '{ "boards": ["linkedin"], "defaults": {"results_per_site": null}, "synthetic_note": "retain" }';
  const restored = '{ "boards": ["linkedin"], "defaults": {"results_per_site": 25, "hours_old": 48} }';
  const put = db.prepare(
    `INSERT INTO discovery_settings (tenant_id, search_config_json, created_at, updated_at)
     VALUES ('local', ?, ?, ?)
     ON CONFLICT(tenant_id) DO UPDATE SET
       search_config_json=excluded.search_config_json, created_at=excluded.created_at, updated_at=excluded.updated_at`,
  );
  const errors: string[] = [];
  let browserPatches = 0;
  page.on("pageerror", (error) => errors.push(error.message));
  page.on("request", (request) => {
    if (new URL(request.url()).pathname === "/v1/discovery/settings" && request.method() === "PATCH") {
      browserPatches += 1;
    }
  });

  try {
    put.run(malformed, "synthetic-created", "synthetic-updated");
    const corruptRow = read.get();
    await page.setViewportSize({ width: 1216, height: 1228 });
    await page.goto("/discovery");
    await expect(page).toHaveTitle(/JobCtrl.*Discovery/);
    const runtime = page.locator(".discovery-runtime-settings");
    const automation = page.locator(".discovery-automation-settings");
    for (const panel of [runtime, automation]) {
      await expect(panel.getByRole("alert")).toContainText("restore a verified backup", { timeout: 15_000 });
      await expect(panel.getByText(/Loading (runtime|automation) settings\./)).toHaveCount(0);
      await expect(panel.getByRole("spinbutton")).toHaveCount(0);
    }
    await expect(page.locator("vite-error-overlay")).toHaveCount(0);
    expect(browserPatches).toBe(0);
    const rejected = await page.request.patch("/v1/discovery/settings", {
      headers: { origin: new URL(baseURL!).origin, "sec-fetch-site": "same-origin" },
      data: { schedulingEnabled: true },
    });
    expect(rejected.status()).toBe(409);
    expect(await rejected.json()).toMatchObject({ ok: false, error: "invalid_saved_search" });
    expect(read.get()).toEqual(corruptRow);
    await page.screenshot({ path: testInfo.outputPath("corrupt-settings-recovery.png") });

    // Restore only synthetic fixture data, then retry through the actual route.
    put.run(restored, "synthetic-created", "synthetic-updated");
    await page.reload();
    await expect(runtime.getByRole("spinbutton", { name: "Results per board" })).toHaveValue("25");
    await expect(automation.getByRole("spinbutton", { name: "Minimum fit score" })).toBeVisible();
    expect(read.get()).toMatchObject({ search_config_json: restored });
    expect(browserPatches).toBe(0);
    expect(errors).toEqual([]);
    await page.screenshot({ path: testInfo.outputPath("restored-settings.png") });
  } finally {
    if (original) put.run(original.search_config_json, original.created_at, original.updated_at);
    else db.prepare("DELETE FROM discovery_settings WHERE tenant_id='local'").run();
    db.close();
  }
});
