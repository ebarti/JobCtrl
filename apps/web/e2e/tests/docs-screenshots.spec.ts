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
  readonly verify?: (page: Page) => Promise<void>;
  readonly viewport?: { readonly width: number; readonly height: number };
}

const defaultCaptureViewport = { width: 1440, height: 1000 } as const;
const profileCaptureViewport = { width: 1800, height: 1400 } as const;
const profileEditorWidth = 38;

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
    proof: (page) =>
      page.locator('[aria-label="Editable baseline resume page"]'),
    verify: verifyProfileFraming,
    viewport: profileCaptureViewport,
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
  viewport: defaultCaptureViewport,
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

async function verifyProfileFraming(page: Page): Promise<void> {
  const preview = page.locator(".resume-editor-preview");
  const resumePage = page.locator('[aria-label="Editable baseline resume page"]');
  const scrollPane = page.locator(".profile-resume-plate-editor .resume-plate-scroll");
  const [previewBox, resumePageBox, scrollMetrics] = await Promise.all([
    preview.boundingBox(),
    resumePage.boundingBox(),
    scrollPane.evaluate((element) => ({
      clientHeight: element.clientHeight,
      clientWidth: element.clientWidth,
      scrollHeight: element.scrollHeight,
      scrollWidth: element.scrollWidth,
    })),
  ]);

  expect(previewBox, "Profile resume preview must have a capture box").not.toBeNull();
  expect(resumePageBox, "Profile A4 page must have a capture box").not.toBeNull();
  if (!previewBox || !resumePageBox) return;

  expect(resumePageBox.x).toBeGreaterThanOrEqual(previewBox.x);
  expect(resumePageBox.y).toBeGreaterThanOrEqual(previewBox.y);
  expect(resumePageBox.x + resumePageBox.width).toBeLessThanOrEqual(
    previewBox.x + previewBox.width,
  );
  expect(resumePageBox.y + resumePageBox.height).toBeLessThanOrEqual(
    previewBox.y + previewBox.height,
  );
  expect(scrollMetrics.scrollWidth).toBe(scrollMetrics.clientWidth);
  expect(scrollMetrics.scrollHeight).toBe(scrollMetrics.clientHeight);
}

test("capture public documentation screenshots from synthetic seed data", async ({
  page,
}) => {
  test.skip(
    process.env.JOBCTRL_DOCS_SCREENSHOTS !== "1",
    "Rewrites docs/assets/screenshots — opt in via JOBCTRL_DOCS_SCREENSHOTS=1 (pnpm docs:screenshots sets it).",
  );
  await page.addInitScript(
    ({ key, value }) => window.localStorage.setItem(key, JSON.stringify(value)),
    { key: "jh:profile-preview-split-width", value: profileEditorWidth },
  );
  for (const surface of surfaces) {
    await page.setViewportSize(surface.viewport ?? defaultCaptureViewport);
    await page.goto(surface.path);
    await waitForRoute(page, surface.proof(page));
    await surface.verify?.(page);
    await capture(page, surface.name);
  }

  await page.setViewportSize(defaultCaptureViewport);
  await page.goto(`/jobs/${encodeURIComponent(platformJobUrl)}?${jobsFilterParams}`);
  const jobDialog = page.getByRole("dialog", { name: "Job details" });
  await waitForRoute(page, jobDialog);
  await expect(jobDialog).toContainText("Director of Platform Engineering");
  await capture(page, "job-detail.png");
});
