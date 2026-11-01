import { expect, test } from "@playwright/test";

for (const problem of [
  {
    name: "needs migration",
    error: "database_migration_required",
    currentVersion: 14,
    label: "Upgrade required",
    message: "The workspace database needs an upgrade",
  },
  {
    name: "is newer than this build",
    error: "database_schema_incompatible",
    currentVersion: 16,
    label: "Database unavailable",
    message: "This workspace was created by a newer JobCtrl version",
  },
]) {
  test(`shows an actionable database message when the workspace ${problem.name}`, async ({ page }, testInfo) => {
    await page.route("**/v1/health", (route) => route.fulfill({
      status: 503,
      json: { ok: false, error: problem.error, currentVersion: problem.currentVersion, expectedVersion: 15 },
    }));
    await page.goto("/dashboard");
    await expect(page.getByText(problem.label, { exact: true })).toBeVisible();
    const alert = page.getByRole("alert").filter({ hasText: problem.message });
    await expect(alert).toBeVisible();
    await expect(alert.getByRole("link", { name: "Update guidance" })).toBeVisible();
    await page.screenshot({ path: testInfo.outputPath("database-diagnostic.png") });
  });
}
