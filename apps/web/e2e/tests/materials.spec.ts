import { test, expect } from "@playwright/test";

test.fixme(
  "Generate materials → drawer shows queued → simulate ResumeApproved (blocked: backend /v1/jobs/:jobKey/actions/generate-materials returns 400; see frontend-target.md §7 Out-of-Scope)",
  async ({ page }) => {
    await page.goto("/jobs");
    const row = page.getByText("Director of Platform Engineering").first();
    await expect(row).toBeVisible({ timeout: 30_000 });
    await row.click();

    await page.getByRole("button", { name: /generate materials/i }).click();
    await expect(page.getByText(/queued/i)).toBeVisible({ timeout: 30_000 });
    await expect(page.getByText(/approved/i)).toBeVisible({ timeout: 60_000 });
  },
);
