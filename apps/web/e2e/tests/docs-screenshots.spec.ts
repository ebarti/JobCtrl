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
const platformJobId = encodeURIComponent(platformJobUrl);
const qaRunId = "qa-run-1";
const qaArtifactId = "qa-platform-resume-pdf";
const qaContactId = "qa-contact-hiring-manager";
const qaProfileImportFilename = "synthetic-platform-resume.pdf";
const qaProfileImportState = {
  state: {
    filename: qaProfileImportFilename,
    // A synthetic PDF header/footer is sufficient for these non-submitting
    // route captures; the workflow never sends it to the import endpoint.
    pdfBase64: "JVBERi0xLjQKJUVPRgo=",
    importProfile: true,
    importStyle: true,
  },
  version: 1,
};
const jobsFilterParams =
  "stage=all&state=all&deleted=active&sort=fit_score&dir=desc&page=1&pageSize=50";
const jobDetailPath = `/jobs/${platformJobId}?${jobsFilterParams}`;
const jobRunTimelinePath = `/jobs/${platformJobId}/run/${qaRunId}?${jobsFilterParams}`;

interface ScreenshotSurface {
  readonly name: string;
  readonly path: string | ((page: Page) => Promise<string>);
  readonly proof: (page: Page) => Locator;
  readonly verify?: (page: Page) => Promise<void>;
  readonly viewport?: { readonly width: number; readonly height: number };
}

const defaultCaptureViewport = { width: 1440, height: 1000 } as const;
const profileCaptureViewport = { width: 1800, height: 1400 } as const;
const mobileCaptureViewport = { width: 390, height: 844 } as const;
const profileEditorWidth = 48;

const desktopSurfaces: readonly ScreenshotSurface[] = [
  {
    name: "dashboard.png",
    path: "/dashboard",
    proof: (page) => page.getByRole("heading", { name: "Dashboard" }),
  },
  {
    name: "analytics.png",
    path: "/analytics",
    proof: (page) => page.getByRole("heading", { name: "Outcome analytics" }),
  },
  {
    name: "jobs.png",
    path: `/jobs?${jobsFilterParams}`,
    proof: (page) => page.locator("table.jobs-data-grid-table"),
  },
  {
    name: "job-detail.png",
    path: jobDetailPath,
    proof: (page) => page.locator(".job-detail-workspace"),
  },
  {
    name: "job-run-timeline.png",
    path: jobRunTimelinePath,
    proof: (page) => page.locator(".job-run-workspace"),
  },
  {
    name: "apply-review.png",
    path: `/apply-review?jobKey=${platformJobId}`,
    proof: (page) =>
      page.getByRole("complementary", { name: "Application review queue" }),
  },
  {
    name: "pipelines.png",
    path: "/pipelines",
    proof: (page) => page.locator(".pipelines-workspace"),
  },
  {
    name: "discovery.png",
    path: "/discovery",
    proof: (page) => page.getByRole("heading", { name: "Discovery" }),
  },
  {
    name: "artifacts.png",
    path: "/artifacts",
    proof: (page) => page.locator("table.artifacts-data-grid-table"),
  },
  {
    name: "artifact-detail.png",
    path: `/artifacts/${qaArtifactId}`,
    proof: (page) => page.locator(".artifact-detail-workspace"),
  },
  {
    name: "evidence-map.png",
    path: `/evidence-map?entry=ev-platform&job=${platformJobId}`,
    proof: (page) => page.locator(".evidence-map-workspace"),
  },
  {
    name: "contacts.png",
    path: "/outreach",
    proof: (page) => page.locator("table.contacts-data-grid-table"),
  },
  {
    name: "contact-detail.png",
    path: `/outreach/${qaContactId}`,
    proof: (page) => page.locator(".contact-detail-workspace"),
  },
  {
    name: "runs.png",
    path: "/runs",
    proof: (page) => page.locator("table.runs-data-grid-table"),
  },
  {
    name: "run-detail.png",
    path: `/runs/${qaRunId}`,
    proof: (page) => page.locator(".workflow-run-workspace"),
  },
  {
    name: "debug.png",
    path: "/debug",
    proof: (page) => page.getByRole("heading", { name: "Debug" }),
  },
  {
    name: "activity-detail.png",
    path: nonJobActivityDetailPath,
    proof: (page) => page.locator(".activity-detail-workspace"),
  },
  {
    name: "profile.png",
    path: "/profile",
    proof: (page) => page.locator('[aria-label="Editable baseline resume page"]'),
    verify: verifyProfileFraming,
    viewport: profileCaptureViewport,
  },
  {
    name: "profile-import-upload.png",
    path: "/profile/import/upload",
    proof: (page) => page.getByText(qaProfileImportFilename, { exact: true }),
  },
  {
    name: "profile-import-preview.png",
    path: "/profile/import/preview",
    proof: (page) => page.getByText(qaProfileImportFilename, { exact: true }),
    verify: verifyProfileImportPreview,
  },
  {
    name: "profile-import-confirm.png",
    path: "/profile/import/confirm",
    proof: (page) => page.getByText(qaProfileImportFilename, { exact: true }),
    verify: verifyProfileImportConfirm,
  },
  {
    name: "preferences.png",
    path: "/preferences",
    proof: (page) => page.getByRole("heading", { name: "Preferences" }),
  },
  {
    name: "settings-general.png",
    path: "/settings",
    proof: (page) => page.getByRole("heading", { name: "Settings" }),
  },
  {
    name: "settings-credentials.png",
    path: "/settings/credentials",
    proof: (page) => page.getByRole("tab", { name: "Credentials", selected: true }),
  },
  {
    name: "settings-models.png",
    path: "/settings/models",
    proof: (page) => page.getByRole("tab", { name: "Model selection", selected: true }),
  },
  {
    name: "settings-browser.png",
    path: "/settings/browser",
    proof: (page) => page.locator(".settings-browser-sections"),
  },
];

const mobileSurfaces: readonly ScreenshotSurface[] = [
  {
    name: "dashboard-mobile.png",
    path: "/dashboard",
    proof: (page) => page.getByRole("heading", { name: "Dashboard" }),
    viewport: mobileCaptureViewport,
  },
  {
    name: "pipelines-mobile.png",
    path: "/pipelines",
    proof: (page) => page.locator(".pipelines-workspace"),
    viewport: mobileCaptureViewport,
  },
  {
    name: "job-detail-mobile.png",
    path: jobDetailPath,
    proof: (page) => page.locator(".job-detail-workspace"),
    viewport: mobileCaptureViewport,
  },
  {
    name: "apply-review-mobile.png",
    path: `/apply-review?jobKey=${platformJobId}`,
    proof: (page) =>
      page.getByRole("complementary", { name: "Application review queue" }),
    viewport: mobileCaptureViewport,
  },
  {
    name: "profile-mobile.png",
    path: "/profile",
    proof: (page) => page.locator('[aria-label="Editable baseline resume page"]'),
    viewport: mobileCaptureViewport,
  },
  {
    name: "settings-browser-mobile.png",
    path: "/settings/browser",
    proof: (page) => page.locator(".settings-browser-sections"),
    viewport: mobileCaptureViewport,
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

async function nonJobActivityDetailPath(page: Page): Promise<string> {
  const response = await page.request.get(
    "/v1/debug/activity?page=1&pageSize=200&sort=occurred_at&dir=desc",
  );
  if (!response.ok()) {
    throw new Error(`Unable to load synthetic activity events (${response.status()}).`);
  }
  const payload = (await response.json()) as {
    items?: Array<{ eventId?: string; jobKey?: string | null }>;
  };
  const event = payload.items?.find((candidate) => !candidate.jobKey && candidate.eventId);
  if (!event?.eventId) {
    throw new Error("Synthetic screenshot seed must expose a non-job activity event.");
  }

  // Local routes redirect job-linked events back to their owning job. Capture a
  // workflow event instead so this is a genuine direct Activity Detail route;
  // the demo-only direct-load feature flag is not enabled in the local E2E app.
  return `/activity/${encodeURIComponent(event.eventId)}`;
}

async function verifyProfileFraming(page: Page): Promise<void> {
  const preview = page.locator(".resume-editor-preview");
  const resumePage = page.locator('[aria-label="Editable baseline resume page"]');
  const scrollPane = page.locator(".profile-resume-plate-editor .resume-plate-scroll");
  await expect(page.getByLabel("Full name", { exact: true })).toHaveValue("John Doe");
  await expect(page.getByLabel("Preferred name", { exact: true })).toHaveValue("John");
  await expect(page.getByLabel("Email", { exact: true })).toHaveValue("john.doe@example.com");
  await expect(resumePage).toContainText("John Doe");
  await expect(resumePage).toContainText("john.doe@example.com");
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

async function verifyProfileImportPreview(page: Page): Promise<void> {
  await expect(page.getByRole("checkbox", { name: "Profile data" })).toBeChecked();
  await expect(page.getByRole("checkbox", { name: "Style data" })).toBeChecked();
}

async function verifyProfileImportConfirm(page: Page): Promise<void> {
  await expect(page.getByText("profile + style", { exact: true })).toBeVisible();
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
  await page.addInitScript(
    ({ key, value }) => window.localStorage.setItem(key, JSON.stringify(value)),
    { key: "jh:profile-import", value: qaProfileImportState },
  );
  expect(desktopSurfaces, "The Product Tour requires 26 desktop capture surfaces.").toHaveLength(26);
  expect(mobileSurfaces, "The Product Tour requires 6 mobile capture surfaces.").toHaveLength(6);
  for (const surface of [...desktopSurfaces, ...mobileSurfaces]) {
    await page.setViewportSize(surface.viewport ?? defaultCaptureViewport);
    const route =
      typeof surface.path === "function" ? await surface.path(page) : surface.path;
    await page.goto(route);
    await waitForRoute(page, surface.proof(page));
    await surface.verify?.(page);
    await capture(page, surface.name);
  }
});
