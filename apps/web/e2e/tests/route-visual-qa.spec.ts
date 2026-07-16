import { expect, type Locator, type Page, test } from "@playwright/test";
import type { ApplyReviewQueueResponse } from "@jobctrl/contracts";

import {
  makeApplyAudit,
  sampleApplyReviewQueue,
  sampleResumeTemplateListResponse,
} from "../../src/test/fixtures/projections.js";

type Density = "compact" | "regular" | "comfy";

interface RouteSurface {
  readonly path: string;
  readonly activeLink: string;
  readonly proof: (page: Page) => Locator;
  readonly surface: (page: Page) => Locator;
}

interface MobileRouteSurface extends RouteSurface {
  readonly primaryControl: (page: Page) => Locator;
}

const DENSITY_TOKENS: Record<Density, string> = {
  compact: "32px",
  regular: "40px",
  comfy: "48px",
};

const ROUTE_SURFACES: readonly RouteSurface[] = [
  {
    path: "/dashboard",
    activeLink: "Dashboard",
    proof: (page) => page.getByRole("heading", { name: "Source health" }),
    surface: (page) => page.locator(".card").first(),
  },
  {
    path: "/jobs",
    activeLink: "Jobs",
    proof: (page) => page.locator("table.jobs-data-grid-table"),
    surface: (page) => page.locator(".filterable-data-grid").first(),
  },
  {
    path: "/artifacts",
    activeLink: "Artifacts",
    proof: (page) => page.locator("table.artifacts-data-grid-table"),
    surface: (page) => page.locator(".filterable-data-grid").first(),
  },
  {
    path: "/apply-review",
    activeLink: "Apply review",
    proof: (page) =>
      page.getByRole("complementary", { name: "Application review queue" }),
    surface: (page) => page.locator(".apply-review-queue").first(),
  },
  {
    path: "/discovery",
    activeLink: "Discovery",
    proof: (page) => page.getByRole("heading", { name: "Discovery controls" }),
    surface: (page) => page.locator(".card").first(),
  },
  {
    path: "/profile",
    activeLink: "Profile",
    proof: (page) => page.getByRole("heading", { name: "Profile", level: 1 }),
    surface: (page) => page.locator(".card").first(),
  },
  {
    path: "/settings",
    activeLink: "Settings",
    proof: (page) => page.getByRole("heading", { name: "Settings", level: 1 }),
    surface: (page) => page.locator(".card").first(),
  },
  {
    path: "/runs",
    activeLink: "Runs",
    proof: (page) => page.locator("table.runs-data-grid-table"),
    surface: (page) => page.locator(".filterable-data-grid").first(),
  },
  {
    path: "/pipelines",
    activeLink: "Pipelines",
    proof: (page) => page.getByRole("heading", { name: "Pipeline actions" }),
    surface: (page) => page.locator(".stage-trigger-panel").first(),
  },
  {
    path: "/debug",
    activeLink: "Debug",
    proof: (page) => page.locator("table.activity-data-grid-table"),
    surface: (page) => page.locator(".filterable-data-grid").first(),
  },
];

const MOBILE_ROUTE_SURFACES: readonly MobileRouteSurface[] = [
  {
    ...ROUTE_SURFACES[0]!,
    primaryControl: (page) =>
      page
        .locator(".kpis")
        .getByRole("link", { name: /^Jobs\b/i })
        .first(),
  },
  {
    ...ROUTE_SURFACES[1]!,
    primaryControl: (page) =>
      page
        .locator("table.jobs-data-grid-table tbody tr")
        .filter({ hasText: "Director of Platform Engineering" })
        .locator('[data-slot="title-stack-primary"]')
        .filter({ hasText: /^Director of Platform Engineering$/ }),
  },
  {
    ...ROUTE_SURFACES[2]!,
    primaryControl: (page) =>
      page.getByRole("button", { name: /Open artifact/i }).first(),
  },
  {
    ...ROUTE_SURFACES[3]!,
    primaryControl: (page) => page.getByRole("button", { name: /^Defer for / }),
  },
  {
    ...ROUTE_SURFACES[4]!,
    primaryControl: (page) => page.getByLabel("Minimum fit score"),
  },
  {
    ...ROUTE_SURFACES[5]!,
    primaryControl: (page) => page.getByLabel("Full name"),
  },
  {
    ...ROUTE_SURFACES[6]!,
    primaryControl: (page) =>
      page.getByRole("link", { name: "Browser & extension", exact: true }),
  },
  {
    ...ROUTE_SURFACES[7]!,
    primaryControl: (page) =>
      page.getByRole("button", { name: /Open run/i }).first(),
  },
  {
    ...ROUTE_SURFACES[8]!,
    primaryControl: (page) =>
      page.getByRole("tab", { name: "Discover", selected: true }),
  },
  {
    ...ROUTE_SURFACES[9]!,
    primaryControl: (page) =>
      page.getByRole("button", { name: /Open activity/i }).first(),
  },
];

const DENSITY_ROUTES = [
  { path: "/jobs", table: "table.jobs-data-grid-table" },
  { path: "/artifacts", table: "table.artifacts-data-grid-table" },
  { path: "/runs", table: "table.runs-data-grid-table" },
  { path: "/debug", table: "table.activity-data-grid-table" },
] as const;

const REQUIREMENT_FIT_JOB_URL =
  "https://boards.greenhouse.io/gitlab/jobs/qa-platform-director";
const JOB_FILTER_PARAMS =
  "stage=all&state=all&deleted=active&sort=fit_score&dir=desc&page=1&pageSize=50";
const PRIMARY_REQUIREMENT_TEXT =
  "Lead platform reliability improvements across critical services.";

function failedTailoringQueue(): ApplyReviewQueueResponse {
  const base = sampleApplyReviewQueue.items[0]!;
  return {
    ok: true,
    items: [
      {
        ...base,
        title: "Director of Engineering & Platform",
        company: "CHAMP Cargosystems",
        source: "linkedin",
        fitScore: 9,
        currentStage: "discover",
        currentState: "failed",
        applicationUrl: "https://www.linkedin.com/jobs/view/4436454338",
        materials: {
          hasResume: false,
          hasCoverLetter: false,
          hasPdf: false,
          ready: false,
        },
        applyAudit: makeApplyAudit({
          state: "repair",
          label: "tailor failed",
          summary:
            "tailoring ended with status failed validation Review evidence is still available.",
          reviewEvidenceAvailable: true,
          missingPrerequisites: [
            {
              code: "missing_resume",
              label: "Tailored resume missing",
              detail: "The tailored resume has not been generated yet.",
              severity: "warning",
              source: "materials.resume",
            },
            {
              code: "missing_resume_pdf",
              label: "Submit-ready PDF missing",
              detail:
                "The submit-ready PDF cannot exist until a tailored resume is available.",
              severity: "warning",
              source: "materials.pdf",
            },
            {
              code: "missing_profile_attestations",
              label: "Profile attestations incomplete",
              detail:
                "Application attestations missing: age_18_plus, background_check_consent, felony_conviction, previously_worked_at_employer.",
              severity: "warning",
              source: "profile_attestations",
            },
          ],
          hardBlockers: [
            {
              code: "stage_not_ready",
              label: "tailor failed",
              detail: "tailoring ended with status failed validation",
              severity: "blocking",
              source: "stage_state",
            },
          ],
          sources: [
            {
              kind: "application_url",
              label: "Application target",
              status: "present",
              detail: "Application target is available.",
            },
            {
              kind: "materials.resume",
              label: "Tailored resume",
              status: "missing",
              detail: "Tailored resume is not available yet.",
            },
            {
              kind: "materials.pdf",
              label: "Submit-ready PDF",
              status: "missing",
              detail: "Submit-ready resume PDF is not available yet.",
            },
            {
              kind: "stage_state",
              label: "Pipeline state",
              status: "present",
              detail: "tailor is failed.",
            },
          ],
        }),
        materialsPreview: {
          ...base.materialsPreview,
          materialsGeneration: null,
          resumeText: null,
          resumeTextArtifactId: null,
          resumePdfArtifactId: null,
          resumePdfLayoutBoxes: [],
          coverLetterText: null,
          requirementLedAudit: null,
        },
      },
    ],
  };
}

async function installFailedTailoringApplyReviewRoutes(
  page: Page,
): Promise<void> {
  await page.route("**/v1/apply/review-queue", async (route) => {
    await route.fulfill({
      contentType: "application/json",
      body: JSON.stringify(failedTailoringQueue()),
    });
  });
  await page.route("**/v1/resume-templates", async (route) => {
    await route.fulfill({
      contentType: "application/json",
      body: JSON.stringify(sampleResumeTemplateListResponse),
    });
  });
}

function expectPainted(value: string, label: string): void {
  expect(value, `${label} should not be empty`).not.toBe("");
  expect(value, `${label} should not be transparent`).not.toMatch(
    /^(transparent|rgba\(0, 0, 0, 0\))$/,
  );
}

async function readSurfaceStyles(locator: Locator) {
  return locator.evaluate((element) => {
    const style = getComputedStyle(element);
    const rect = element.getBoundingClientRect();
    return {
      backgroundColor: style.backgroundColor,
      borderBottomColor: style.borderBottomColor,
      borderBottomStyle: style.borderBottomStyle,
      borderBottomWidth: style.borderBottomWidth,
      color: style.color,
      display: style.display,
      height: rect.height,
      visibility: style.visibility,
      width: rect.width,
    };
  });
}

async function expectPaintedSurface(
  locator: Locator,
  label: string,
): Promise<void> {
  await expectRenderedSurface(locator, label);
  const styles = await readSurfaceStyles(locator);
  expectPainted(styles.backgroundColor, `${label} background`);
}

async function expectRenderedSurface(
  locator: Locator,
  label: string,
): Promise<void> {
  await expect(locator, `${label} should be visible`).toBeVisible({
    timeout: 30_000,
  });
  await expect(locator, `${label} should be enabled`).toBeEnabled();
  const styles = await readSurfaceStyles(locator);
  expect(styles.display, `${label} should be rendered`).not.toBe("none");
  expect(styles.visibility, `${label} should be visible`).not.toBe("hidden");
  expect(styles.width, `${label} width`).toBeGreaterThan(0);
  expect(styles.height, `${label} height`).toBeGreaterThan(0);
  expectPainted(styles.color, `${label} foreground`);
}

async function expectActiveNavigation(
  locator: Locator,
  label: string,
): Promise<void> {
  await expect(locator, `${label} should be visible`).toBeVisible({
    timeout: 30_000,
  });
  await expect(
    locator,
    `${label} should identify the current route`,
  ).toHaveAttribute("aria-current", "page");
  const styles = await locator.evaluate((element) => {
    const style = getComputedStyle(element);
    const marker = getComputedStyle(element, "::before");
    const rect = element.getBoundingClientRect();
    return {
      color: style.color,
      display: style.display,
      height: rect.height,
      markerBackground: marker.backgroundColor,
      markerDisplay: marker.display,
      markerWidth: Number.parseFloat(marker.width),
      visibility: style.visibility,
      width: rect.width,
    };
  });
  expect(styles.display, `${label} should be rendered`).not.toBe("none");
  expect(styles.visibility, `${label} should be visible`).not.toBe("hidden");
  expect(styles.width, `${label} width`).toBeGreaterThan(0);
  expect(styles.height, `${label} height`).toBeGreaterThan(0);
  expectPainted(styles.color, `${label} foreground`);
  expect(styles.markerDisplay, `${label} selection rule`).not.toBe("none");
  expect(
    styles.markerWidth,
    `${label} selection rule width`,
  ).toBeGreaterThanOrEqual(2);
  expectPainted(styles.markerBackground, `${label} selection rule`);
}

async function expectBorderedSurface(
  locator: Locator,
  label: string,
): Promise<void> {
  const styles = await readSurfaceStyles(locator);
  expect(
    Number.parseFloat(styles.borderBottomWidth),
    `${label} border width`,
  ).toBeGreaterThan(0);
  expect(styles.borderBottomStyle, `${label} border style`).not.toBe("none");
  expectPainted(styles.borderBottomColor, `${label} border`);
}

async function expectVisualSnapshot(
  locator: Locator,
  snapshotName: string,
  label: string,
): Promise<void> {
  await expect(locator, `${label} should be visible`).toBeVisible({
    timeout: 30_000,
  });
  const box = await locator.boundingBox();
  expect(box?.width ?? 0, `${label} width`).toBeGreaterThan(0);
  expect(box?.height ?? 0, `${label} height`).toBeGreaterThan(0);
  await locator.scrollIntoViewIfNeeded();
  await expect(locator, `${label} visual snapshot`).toHaveScreenshot(
    snapshotName,
    {
      animations: "disabled",
      caret: "hide",
      maxDiffPixelRatio: 0.01,
    },
  );
}

async function expectNoDocumentInlineOverflow(page: Page): Promise<void> {
  const layout = await page.evaluate(() => ({
    clientWidth: document.documentElement.clientWidth,
    scrollWidth: document.documentElement.scrollWidth,
  }));
  expect(
    layout.scrollWidth,
    "route should not create document-level horizontal overflow",
  ).toBeLessThanOrEqual(layout.clientWidth + 1);
}

async function expectControlInsideViewport(
  page: Page,
  locator: Locator,
  label: string,
): Promise<void> {
  await expect(locator, `${label} should be visible`).toBeVisible({
    timeout: 30_000,
  });
  await expect(locator, `${label} should be enabled`).toBeEnabled();
  await locator.scrollIntoViewIfNeeded();
  const layout = await locator.evaluate((element) => {
    const rect = element.getBoundingClientRect();
    return {
      bottom: rect.bottom,
      height: rect.height,
      left: rect.left,
      right: rect.right,
      top: rect.top,
      viewportHeight: document.documentElement.clientHeight,
      viewportWidth: document.documentElement.clientWidth,
      width: rect.width,
    };
  });

  expect(layout.width, `${label} should have usable width`).toBeGreaterThan(0);
  expect(layout.height, `${label} should have usable height`).toBeGreaterThan(
    0,
  );
  expect(
    layout.left,
    `${label} should not be clipped on the left`,
  ).toBeGreaterThanOrEqual(-1);
  expect(
    layout.right,
    `${label} should not be clipped on the right`,
  ).toBeLessThanOrEqual(layout.viewportWidth + 1);
  expect(
    layout.top,
    `${label} should be scrolled into view`,
  ).toBeGreaterThanOrEqual(-1);
  expect(
    layout.bottom,
    `${label} should be scrolled into view`,
  ).toBeLessThanOrEqual(layout.viewportHeight + 1);
}

async function installDeterministicRequirementFitScrollbars(
  page: Page,
): Promise<void> {
  // macOS overlay scrollbars reserve 0 layout space, so a scroll container's
  // inner content width flips by the ~15px scrollbar gutter run-to-run. Force
  // classic scrollbars for the two snapshotted cards so their committed
  // baselines remain deterministic across local and Linux CI runs.
  await page.addInitScript(() => {
    const style = document.createElement("style");
    style.textContent =
      ".job-detail-drawer::-webkit-scrollbar,.apply-review-pane-scroll::-webkit-scrollbar{width:15px;height:15px}";
    const attach = () =>
      (document.head ?? document.documentElement).append(style);
    if (document.head) attach();
    else document.addEventListener("DOMContentLoaded", attach, { once: true });
  });
}

async function expectArtifactPdfPreviewRendered(page: Page): Promise<void> {
  const preview = page.getByRole("region", { name: "Artifact PDF preview" });
  await expect(preview).toBeVisible({ timeout: 30_000 });
  await expect(preview.getByText("1 page", { exact: true })).toBeVisible({
    timeout: 30_000,
  });
  await expect(
    preview.getByText("Preview failed", { exact: true }),
  ).toHaveCount(0);

  const pageImage = preview.locator(".pdf-preview-page img");
  await expect(pageImage).toHaveCount(1);
  await expect(pageImage).toBeVisible();
  await expect
    .poll(
      () =>
        pageImage.evaluate(
          (element) => (element as HTMLImageElement).naturalWidth,
        ),
      {
        message: "artifact PDF preview page should load real image pixels",
      },
    )
    .toBeGreaterThan(0);
}

async function hasVisibleFocusIndicator(locator: Locator): Promise<boolean> {
  const focus = await locator.evaluate((element) => {
    const style = getComputedStyle(element);
    const ringProbe = document.createElement("span");
    ringProbe.style.color = "var(--ring)";
    ringProbe.style.position = "absolute";
    ringProbe.style.visibility = "hidden";
    document.body.append(ringProbe);
    const ringColor = getComputedStyle(ringProbe).color;
    ringProbe.remove();
    return {
      borderTopColor: style.borderTopColor,
      borderTopWidth: style.borderTopWidth,
      boxShadow: style.boxShadow,
      outlineStyle: style.outlineStyle,
      outlineWidth: style.outlineWidth,
      ringColor,
    };
  });

  const outlineWidth = Number.parseFloat(focus.outlineWidth);
  const borderTopWidth = Number.parseFloat(focus.borderTopWidth);
  const hasOutline =
    focus.outlineStyle !== "none" &&
    Number.isFinite(outlineWidth) &&
    outlineWidth >= 1;
  const hasShadow = focus.boxShadow !== "none";
  const hasRingBorder =
    Number.isFinite(borderTopWidth) &&
    borderTopWidth > 0 &&
    focus.borderTopColor === focus.ringColor;
  return hasOutline || hasShadow || hasRingBorder;
}

async function expectFocusedVisibleIndicator(
  locator: Locator,
  label: string,
): Promise<void> {
  await expect(locator, `${label} should receive focus`).toBeFocused();
  expect(
    await hasVisibleFocusIndicator(locator),
    `${label} should expose a visible focus indicator`,
  ).toBe(true);
}

async function expectKeyboardFocusIndicator(
  page: Page,
  locator: Locator,
  label: string,
  maxTabs = 80,
): Promise<void> {
  const target = locator.first();
  await expect(
    target,
    `${label} should be visible before focus check`,
  ).toBeVisible({
    timeout: 30_000,
  });
  await target.scrollIntoViewIfNeeded();
  for (let attempt = 0; attempt < maxTabs; attempt += 1) {
    const focused = await target.evaluate(
      (element) => element === document.activeElement,
    );
    if (focused && (await hasVisibleFocusIndicator(target))) {
      await expectFocusedVisibleIndicator(target, label);
      return;
    }
    await page.keyboard.press("Tab");
  }
  throw new Error(
    `${label} was not reachable through keyboard Tab navigation within ${maxTabs} steps.`,
  );
}

async function expectShellForRoute(
  page: Page,
  route: RouteSurface,
): Promise<void> {
  await page.goto(route.path);
  await expect(route.proof(page), `${route.path} proof surface`).toBeVisible({
    timeout: 30_000,
  });
  await expectPaintedSurface(page.locator(".topbar"), `${route.path} topbar`);
  await expectBorderedSurface(page.locator(".topbar"), `${route.path} topbar`);
  await expectActiveNavigation(
    page.getByRole("link", { name: route.activeLink }),
    `${route.path} active nav`,
  );
  await expectRenderedSurface(
    route.surface(page),
    `${route.path} route surface`,
  );
  await expect(
    page.getByRole("textbox", { name: "Global search" }),
  ).toBeVisible();
  await expect(page.getByRole("group", { name: "Row density" })).toBeVisible();
  await expect(
    page.getByRole("button", { name: /Switch to (dark|light) theme/i }),
  ).toBeVisible();
  await expectNoDocumentInlineOverflow(page);
}

async function setDensity(page: Page, density: Density): Promise<void> {
  const option = page.getByRole("button", { name: density, exact: true });
  await option.click();
  await expect(option).toHaveAttribute("aria-pressed", "true");
  const shell = page.locator(".app-shell");
  await expect(shell).toHaveAttribute("data-density", density);
  await expect
    .poll(() =>
      shell.evaluate((element) =>
        getComputedStyle(element).getPropertyValue("--jh-row-height").trim(),
      ),
    )
    .toBe(DENSITY_TOKENS[density]);
}

async function expectTableRowsVisible(
  page: Page,
  tableSelector: string,
  label: string,
): Promise<void> {
  const rows = page.locator(`${tableSelector} tbody tr`);
  await expect(rows.first(), `${label} first row`).toBeVisible({
    timeout: 30_000,
  });
  const rowBox = await rows.first().boundingBox();
  expect(rowBox?.width ?? 0, `${label} row width`).toBeGreaterThan(0);
  expect(rowBox?.height ?? 0, `${label} row height`).toBeGreaterThan(0);
}

async function expectDashboardFunnelContained(page: Page): Promise<void> {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto("/dashboard");
  const pipelineCard = page
    .locator(".card")
    .filter({ has: page.getByRole("heading", { name: "Pipeline" }) });
  await expect(pipelineCard).toBeVisible({ timeout: 30_000 });

  const layout = await pipelineCard.evaluate((card) => {
    const cardRect = card.getBoundingClientRect();
    const rows = [...card.querySelectorAll(".funnel-row")].map((row) => {
      const rowRect = row.getBoundingClientRect();
      const legend = row.querySelector(".legend");
      const legendRect = legend?.getBoundingClientRect() ?? rowRect;
      return {
        rowRight: rowRect.right,
        legendRight: legendRect.right,
        legendHeight: legendRect.height,
      };
    });
    return {
      cardRight: cardRect.right,
      rows,
      scrollWidth: document.documentElement.scrollWidth,
      viewportWidth: document.documentElement.clientWidth,
    };
  });

  for (const [index, row] of layout.rows.entries()) {
    expect(
      row.rowRight,
      `Pipeline row ${index + 1} should fit in card`,
    ).toBeLessThanOrEqual(layout.cardRight + 1);
    expect(
      row.legendRight,
      `Pipeline legend ${index + 1} should fit in card`,
    ).toBeLessThanOrEqual(layout.cardRight + 1);
    expect(
      row.legendHeight,
      `Pipeline legend ${index + 1} should remain compact`,
    ).toBeLessThan(48);
  }
  expect(
    layout.scrollWidth,
    "Dashboard should not create horizontal overflow",
  ).toBeLessThanOrEqual(layout.viewportWidth + 1);
}

test("representative routes stay legible in light and dark themes", async ({
  page,
}) => {
  test.setTimeout(90_000);

  for (const route of ROUTE_SURFACES) {
    await expectShellForRoute(page, route);
  }
  await expectDashboardFunnelContained(page);

  await page.goto("/dashboard");
  await page.getByRole("button", { name: /Switch to dark theme/i }).click();
  await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");

  for (const route of ROUTE_SURFACES) {
    await expectShellForRoute(page, route);
    await expect(
      page.locator("html"),
      `${route.path} should remain in dark theme`,
    ).toHaveAttribute("data-theme", "dark");
  }
});

test("@mobile key product routes keep navigation, content, and primary controls usable", async ({
  page,
}) => {
  test.setTimeout(120_000);

  for (const route of MOBILE_ROUTE_SURFACES) {
    await page.goto(route.path);
    await expect(route.proof(page), `${route.path} proof surface`).toBeVisible({
      timeout: 30_000,
    });
    await expectRenderedSurface(
      route.surface(page),
      `${route.path} route surface`,
    );
    await expectNoDocumentInlineOverflow(page);
    await expectControlInsideViewport(
      page,
      route.primaryControl(page),
      `${route.path} primary control`,
    );
    await expectNoDocumentInlineOverflow(page);

    const navigationTrigger = page.getByRole("button", {
      name: "Open navigation",
    });
    await expectControlInsideViewport(
      page,
      navigationTrigger,
      `${route.path} navigation trigger`,
    );
    await navigationTrigger.click();

    const navigation = page.getByRole("dialog");
    await expect(navigation).toBeVisible();
    const activeLink = navigation.getByRole("link", {
      name: route.activeLink,
      exact: true,
    });
    await expect(activeLink).toHaveAttribute("aria-current", "page");
    await expectControlInsideViewport(
      page,
      activeLink,
      `${route.path} mobile navigation link`,
    );
    await activeLink.click();
    await expect(navigation).toBeHidden();
    await expectNoDocumentInlineOverflow(page);
  }
});

test("density modes, focus rings, filters, forms, and destructive controls remain usable", async ({
  page,
}) => {
  test.setTimeout(120_000);

  await page.goto("/jobs");
  await expect(page.locator("table.jobs-data-grid-table")).toBeVisible({
    timeout: 30_000,
  });

  for (const density of Object.keys(DENSITY_TOKENS) as Density[]) {
    await setDensity(page, density);
    for (const route of DENSITY_ROUTES) {
      await page.goto(route.path);
      await expect(
        page.locator(".app-shell"),
        `${route.path} density`,
      ).toHaveAttribute("data-density", density);
      await expectTableRowsVisible(
        page,
        route.table,
        `${route.path} ${density}`,
      );
      await expectNoDocumentInlineOverflow(page);
    }
  }

  await page.goto("/jobs");
  await expect(page.locator("table.jobs-data-grid-table")).toBeVisible({
    timeout: 30_000,
  });
  await expectKeyboardFocusIndicator(
    page,
    page.getByRole("textbox", { name: "Global search" }),
    "global search",
  );
  await expectKeyboardFocusIndicator(
    page,
    page.getByRole("button", { name: "comfy", exact: true }),
    "selected row density control",
  );

  const titleFilter = page.getByRole("button", {
    name: /Filter Title column/i,
  });
  await expectKeyboardFocusIndicator(page, titleFilter, "title filter control");
  await titleFilter.click();
  const filterDialog = page.getByRole("dialog", { name: "Title filter" });
  await expect(filterDialog).toBeVisible();
  await expectKeyboardFocusIndicator(
    page,
    page.getByLabel("Title filter text"),
    "title filter text input",
  );
  await page.keyboard.press("Escape");
  await expect(filterDialog).toHaveCount(0);

  await page
    .getByRole("checkbox", { name: /Select Director of Platform Engineering/i })
    .check();
  await expect(page.getByText("1 selected")).toBeVisible();
  const deleteSelected = page.getByRole("button", {
    name: /^delete selected$/i,
  });
  await expect(deleteSelected).toBeVisible();

  await page.goto("/settings");
  await expect(
    page.getByRole("heading", { name: "Settings", level: 1 }),
  ).toBeVisible({
    timeout: 30_000,
  });
  await expectKeyboardFocusIndicator(
    page,
    page.getByLabel("Concurrent applications"),
    "settings concurrent applications input",
  );

  await page.goto("/discovery");
  await expect(
    page.getByRole("heading", { name: "Runtime settings" }),
  ).toBeVisible({ timeout: 30_000 });
  await expect(
    page.getByRole("heading", { name: "Automation settings" }),
  ).toBeVisible();
  await expectKeyboardFocusIndicator(
    page,
    page.getByLabel("Minimum fit score"),
    "discovery minimum fit score input",
  );
  await expectKeyboardFocusIndicator(
    page,
    page.getByLabel("Results per board"),
    "discovery results per board input",
  );
  await expect(page.getByRole("checkbox", { name: "LinkedIn" })).toBeVisible();

  await page.goto("/profile");
  await expect(
    page.getByRole("heading", { name: "Profile", level: 1 }),
  ).toBeVisible({
    timeout: 30_000,
  });
  await expectKeyboardFocusIndicator(
    page,
    page.getByLabel("Full name"),
    "profile full name input",
  );

  await page.goto("/pipelines");
  await expect(
    page.getByRole("heading", { name: "Pipeline actions" }),
  ).toBeVisible({ timeout: 30_000 });
  await expectKeyboardFocusIndicator(
    page,
    page.getByRole("tab", { name: "Discover", selected: true }),
    "pipeline discover tab",
    100,
  );
});

test("detail workspaces open with seeded data and preserve route navigation", async ({
  page,
}) => {
  await page.goto("/jobs");
  await expect(page.locator("table.jobs-data-grid-table")).toBeVisible({
    timeout: 30_000,
  });
  const jobRow = page
    .locator("table.jobs-data-grid-table tbody tr")
    .filter({ hasText: "Director of Platform Engineering" });
  const visibleJobTitle = jobRow
    .locator('[data-slot="title-stack-primary"]')
    .filter({ hasText: /^Director of Platform Engineering$/ });
  await expect(visibleJobTitle).toBeVisible();
  await visibleJobTitle.click();
  const jobWorkspace = page.getByRole("article", { name: "Job details" });
  await expect(jobWorkspace).toBeVisible({ timeout: 30_000 });
  await expectKeyboardFocusIndicator(
    page,
    page.getByRole("button", { name: "Back to jobs" }),
    "job detail back navigation",
  );
  await page.getByRole("button", { name: "Back to jobs" }).click();
  await expect(page).toHaveURL(/\/jobs(?:\?|$)/);
  await expect(jobWorkspace).toHaveCount(0);

  const keyboardJobActivation = jobRow.getByRole("button", {
    name: /Open job Director of Platform Engineering/i,
  });
  await keyboardJobActivation.focus();
  await expectFocusedVisibleIndicator(
    keyboardJobActivation,
    "job row keyboard activation",
  );
  await keyboardJobActivation.press("Enter");
  await expect(jobWorkspace).toBeVisible({ timeout: 30_000 });
  await page.getByRole("button", { name: "Back to jobs" }).click();
  await expect(jobWorkspace).toHaveCount(0);

  await page.goto("/artifacts/2");
  const artifactWorkspace = page.getByRole("article", {
    name: "Artifact details",
  });
  await expect(artifactWorkspace).toBeVisible({ timeout: 30_000 });
  await expectArtifactPdfPreviewRendered(page);
  await expectKeyboardFocusIndicator(
    page,
    page.getByRole("button", { name: "Back to artifacts" }),
    "artifact detail back navigation",
  );
  await page.getByRole("button", { name: "Back to artifacts" }).click();
  await expect(page).toHaveURL(/\/artifacts(?:\?|$)/);
  await expect(artifactWorkspace).toHaveCount(0);

  await page.goto("/runs");
  await expect(page.locator("table.runs-data-grid-table")).toBeVisible({
    timeout: 30_000,
  });
  const runRow = page.locator("table.runs-data-grid-table tbody tr").first();
  const visibleRunTitle = runRow
    .locator('[data-slot="title-stack-primary"]')
    .first();
  await expect(visibleRunTitle).toBeVisible();
  await visibleRunTitle.click();
  const runWorkspace = page.getByRole("article", {
    name: "Workflow run details",
  });
  await expect(runWorkspace).toBeVisible({ timeout: 30_000 });
  await expectKeyboardFocusIndicator(
    page,
    page.getByRole("link", { name: "Back to workflow runs" }),
    "workflow run back navigation",
  );
  await page.getByRole("link", { name: "Back to workflow runs" }).click();
  await expect(page).toHaveURL(/\/runs(?:\?|$)/);
  await expect(runWorkspace).toHaveCount(0);

  await page.goto("/debug");
  await expect(page.locator("table.activity-data-grid-table")).toBeVisible({
    timeout: 30_000,
  });
  await expectKeyboardFocusIndicator(
    page,
    page.getByRole("button", { name: /Open activity/i }).first(),
    "debug activity activation",
  );
});

test("Apply Review decision card keeps facts readable and decisions on one row", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1666, height: 900 });
  await installFailedTailoringApplyReviewRoutes(page);
  await page.goto("/apply-review");

  const decisionCard = page.locator(".apply-review-decision-card");
  await expect(decisionCard).toBeVisible({ timeout: 30_000 });
  await expect(decisionCard).toContainText("Tailored resume missing");
  await expect(decisionCard).toContainText("tailor failed");

  const layout = await decisionCard.evaluate((element) => {
    const context = element.querySelector(".apply-review-selected-facts");
    const actions = element.querySelector(".apply-review-selected-actions");
    const decisionButtons = [
      ...element.querySelectorAll(".apply-review-decision-buttons button"),
    ].map((node) => node.getBoundingClientRect());
    const factValues = [
      ...element.querySelectorAll(".apply-review-audit-facts dd"),
    ].map((node) => node.getBoundingClientRect());
    const tags = [
      ...element.querySelectorAll(".apply-review-audit-facts .tag"),
    ].map((node) => node.getBoundingClientRect());
    return {
      actionWidth: actions?.getBoundingClientRect().width ?? 0,
      buttonTopSpread:
        Math.max(...decisionButtons.map((rect) => rect.top)) -
        Math.min(...decisionButtons.map((rect) => rect.top)),
      contextWidth: context?.getBoundingClientRect().width ?? 0,
      cardHeight: element.getBoundingClientRect().height,
      maxTagHeight: Math.max(...tags.map((rect) => rect.height)),
      minFactValueWidth: Math.min(...factValues.map((rect) => rect.width)),
      minTagWidth: Math.min(...tags.map((rect) => rect.width)),
      scrollWidth: document.documentElement.scrollWidth,
      viewportWidth: document.documentElement.clientWidth,
    };
  });

  expect(
    layout.contextWidth,
    "audit context should have real horizontal space",
  ).toBeGreaterThan(600);
  expect(
    layout.actionWidth,
    "approval controls should use the card width",
  ).toBeGreaterThan(600);
  expect(
    layout.buttonTopSpread,
    "decision buttons should remain on one row",
  ).toBeLessThanOrEqual(1);
  expect(
    layout.minFactValueWidth,
    "audit fact values should not collapse",
  ).toBeGreaterThan(500);
  expect(
    layout.minTagWidth,
    "audit chips should not wrap letter-by-letter",
  ).toBeGreaterThan(250);
  expect(layout.maxTagHeight, "audit chips should remain compact").toBeLessThan(
    60,
  );
  expect(
    layout.cardHeight,
    "decision card should remain a compact summary",
  ).toBeLessThan(720);
  expect(
    layout.scrollWidth,
    "route should not create horizontal overflow",
  ).toBeLessThanOrEqual(layout.viewportWidth + 1);
});

test("Job Detail requirement-fit card has visual regression coverage", async ({
  page,
}) => {
  await installDeterministicRequirementFitScrollbars(page);
  await page.goto(
    `/jobs/${encodeURIComponent(REQUIREMENT_FIT_JOB_URL)}?${JOB_FILTER_PARAMS}`,
  );
  const drawer = page.getByRole("article", { name: "Job details" });
  await expect(drawer).toBeVisible({ timeout: 30_000 });

  const drawerRequirement = drawer
    .locator(".employer-analysis-requirement")
    .filter({ hasText: PRIMARY_REQUIREMENT_TEXT });
  await expect(drawerRequirement).toHaveCount(1);
  await expect(drawerRequirement).toContainText("Requirement fit");
  await expect(drawerRequirement).toContainText("matched");
  await expect(drawerRequirement).toContainText("Score contribution");
  await expect(drawerRequirement).toContainText("Double Down");
  await expect(
    drawerRequirement.locator('[data-slot="requirement-fit-summary"]'),
  ).toBeVisible();
  await expect(
    drawerRequirement.locator('[data-slot="requirement-fit-metric"]'),
  ).toHaveCount(2);
  await expect(
    drawerRequirement.locator('[data-slot="requirement-profile-evidence"]'),
  ).toBeVisible();
  await expect(
    drawerRequirement.getByRole("button", { name: "Additional audit details" }),
  ).toHaveAttribute("aria-expanded", "false");
  await expectVisualSnapshot(
    drawerRequirement,
    "job-drawer-requirement-fit-card.png",
    "job drawer requirement-fit card",
  );
});

test("Apply Review requirement-fit card has visual regression coverage", async ({
  page,
}) => {
  await installDeterministicRequirementFitScrollbars(page);
  await page.goto(
    `/apply-review?jobKey=${encodeURIComponent(REQUIREMENT_FIT_JOB_URL)}`,
  );
  const selectedApplication = page.locator(".apply-review-selected");
  await expect(selectedApplication).toBeVisible({ timeout: 30_000 });

  const applyReviewRequirement = selectedApplication
    .locator(".apply-review-ideal-requirements li")
    .filter({ hasText: PRIMARY_REQUIREMENT_TEXT });
  await expect(applyReviewRequirement).toHaveCount(1);
  await expect(applyReviewRequirement).toContainText("Candidate fit");
  await expect(applyReviewRequirement).toContainText("matched direct");
  await expect(applyReviewRequirement).toContainText("Tailoring action");
  await expect(applyReviewRequirement).toContainText("Resume coverage");
  await expect(applyReviewRequirement).toContainText(
    "covered in tailored resume",
  );
  await expectVisualSnapshot(
    applyReviewRequirement,
    "apply-review-requirement-fit-card.png",
    "Apply Review requirement-fit card",
  );
});
