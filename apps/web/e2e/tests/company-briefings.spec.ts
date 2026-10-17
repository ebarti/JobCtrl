import { test, expect } from "@playwright/test";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { injectAxe, checkA11y } from "axe-playwright";

const root = path.resolve(fileURLToPath(new URL("../../../..", import.meta.url)));
const job = "90000000-0000-4000-8000-000000000021";
test.beforeAll(() => {
  const result = spawnSync(path.join(root, "workers/automation/.venv/bin/python"), [path.join(root, "workers/automation/tests/company_briefing_fixture.py"), process.env["JOBCTRL_E2E_DB_PATH"]!], {
    cwd: root, encoding: "utf8", env: { ...process.env, JOBCTRL_DIR: process.env["JOBCTRL_E2E_APP_DIR"]!, LANGFUSE_DISABLE: "1", PYTHONPATH: path.join(root, "workers/automation/src") },
  });
  expect(result.status, result.stderr).toBe(0);
});

for (const mobile of [false, true]) {
  test(`Shared company briefing preserves stale citations across Job Detail, Interviews and digest${mobile ? " @mobile" : ""}`, async ({ page }) => {
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    page.on("console", (message) => {
      if (["error", "warning"].includes(message.type())) errors.push(message.text());
    });
    await page.goto(`/jobs/${job}`);
    await expect(page).toHaveURL((url) => url.pathname === `/jobs/${job}`);
    await expect(page).toHaveTitle(/JobCtrl/);
    await expect(page.locator("vite-error-overlay")).toHaveCount(0);
    const briefing = page.getByRole("region", { name: "Company briefing", exact: true });
    await expect(briefing).toBeVisible();
    await expect(briefing).toContainText("Stale briefing");
    await expect(briefing).toContainText("Synthetic company hypothesis");
    await briefing.getByText("Sources for this claim").click();
    await expect(briefing.getByText("Example Company public source text.")).toBeVisible();
    await expect(briefing.getByRole("link", { name: "https://example.com/about" })).toHaveAttribute("href", "https://example.com/about");
    await expect(briefing).toBeInViewport();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    await injectAxe(page);
    await checkA11y(page, '[aria-label="Company briefing"]', { includedImpacts: ["critical", "serious"] });
    await page.screenshot({ path: `/tmp/jobctrl-1016-${mobile ? "mobile" : "desktop"}.png`, fullPage: false });
    await page.goto(`/interviews?card=B11&job=${job}`);
    await expect(page.getByRole("region", { name: "Company briefing", exact: true })).toContainText("Synthetic company hypothesis");
    await page.goto("/");
    await expect(page.getByRole("region", { name: "Company briefings", exact: true })).toContainText("Example Company");
    await expect(page.getByRole("region", { name: "Company briefings", exact: true })).toContainText("stale");
    expect(errors).toEqual([]);
  });
}
