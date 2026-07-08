import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { expect, type Locator, type Page, test } from "@playwright/test";

const repoRoot = path.resolve(
  fileURLToPath(new URL("../../../../", import.meta.url)),
);
const screenshotsDir = path.join(repoRoot, "docs", "assets", "screenshots");
const publicHeroScreenshotsDir = path.join(
  repoRoot,
  "docs",
  "public",
  "assets",
  "screenshots",
);
const heroScreenshotName = "dashboard.png";
const platformJobUrl =
  "https://boards.greenhouse.io/gitlab/jobs/qa-platform-director";
const jobsFilterParams =
  "stage=all&state=all&deleted=active&sort=fit_score&dir=desc&page=1&pageSize=50";

interface ScreenshotSurface {
  readonly name: string;
  readonly path: string;
  readonly proof: (page: Page) => Locator;
}

const surfaces: readonly ScreenshotSurface[] = [
  {
    name: "dashboard.png",
    path: "/dashboard",
    proof: (page) => page.getByRole("heading", { name: "Source health" }),
  },
  {
    name: "jobs.png",
    path: `/jobs?${jobsFilterParams}`,
    proof: (page) => page.locator("table.jobs-data-grid-table"),
  },
  {
    name: "apply-review.png",
    path: "/apply-review",
    proof: (page) =>
      page.getByRole("complementary", { name: "Application review queue" }),
  },
  {
    name: "profile.png",
    path: "/profile",
    proof: (page) => page.getByRole("heading", { name: "Profile", level: 1 }),
  },
  {
    name: "discovery.png",
    path: "/discovery",
    proof: (page) => page.getByRole("heading", { name: "Discovery controls" }),
  },
  {
    name: "pipelines.png",
    path: "/pipelines",
    proof: (page) => page.getByRole("heading", { name: "Pipeline actions" }),
  },
  {
    name: "runs.png",
    path: "/runs",
    proof: (page) => page.locator("table.runs-data-grid-table"),
  },
];

test.use({
  colorScheme: "light",
  viewport: { width: 1440, height: 1000 },
});

test.beforeAll(async () => {
  await fs.mkdir(screenshotsDir, { recursive: true });
  await fs.mkdir(publicHeroScreenshotsDir, { recursive: true });
});

async function waitForRoute(page: Page, proof: Locator): Promise<void> {
  await expect(proof).toBeVisible({ timeout: 30_000 });
  await page.evaluate(() => document.fonts.ready);
  await page.waitForTimeout(250);
}

async function capture(page: Page, name: string): Promise<void> {
  const outputPath = path.join(screenshotsDir, name);
  await page.screenshot({
    animations: "disabled",
    fullPage: true,
    path: outputPath,
  });
  if (name === heroScreenshotName) {
    await fs.copyFile(
      outputPath,
      path.join(publicHeroScreenshotsDir, heroScreenshotName),
    );
  }
}

test("capture public documentation screenshots from synthetic seed data", async ({
  page,
}) => {
  test.skip(
    process.env.JOBCTRL_DOCS_SCREENSHOTS !== "1",
    "Rewrites docs/assets/screenshots — opt in via JOBCTRL_DOCS_SCREENSHOTS=1 (pnpm docs:screenshots sets it).",
  );
  for (const surface of surfaces) {
    await page.goto(surface.path);
    await waitForRoute(page, surface.proof(page));
    await capture(page, surface.name);
  }

  await page.goto(`/jobs/${encodeURIComponent(platformJobUrl)}?${jobsFilterParams}`);
  const jobDialog = page.getByRole("dialog", { name: "Job details" });
  await waitForRoute(page, jobDialog);
  await expect(jobDialog).toContainText("Director of Platform Engineering");
  await capture(page, "job-detail.png");
});
