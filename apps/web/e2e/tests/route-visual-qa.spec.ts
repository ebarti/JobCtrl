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
  compact: "44px",
  regular: "52px",
  comfy: "60px",
};

const DENSITY_LABELS: Record<Density, string> = {
  compact: "Compact",
  regular: "Regular",
  comfy: "Comfortable",
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
    proof: (page) => page.getByRole("heading", { name: "Source registry" }),
    surface: (page) =>
      page.locator(".discovery-control-panel .filterable-data-grid").first(),
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
    proof: (page) => page.getByRole("heading", { name: "Live pipeline" }),
    surface: (page) => page.locator(".pipeline-live-flow").first(),
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
    proof: (page) => page.getByRole("list", { name: "Jobs" }),
    surface: (page) => page.getByRole("list", { name: "Jobs" }),
    primaryControl: (page) =>
      page.getByRole("button", {
        name: /^Open job Director of Platform Engineering/,
      }),
  },
  {
    ...ROUTE_SURFACES[2]!,
    proof: (page) => page.getByRole("list", { name: "Artifacts" }),
    surface: (page) => page.getByRole("list", { name: "Artifacts" }),
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
    proof: (page) => page.getByRole("list", { name: "Workflow runs" }),
    surface: (page) => page.getByRole("list", { name: "Workflow runs" }),
    primaryControl: (page) =>
      page.getByRole("button", { name: /Open run/i }).first(),
  },
  {
    ...ROUTE_SURFACES[8]!,
    primaryControl: (page) =>
      page.getByRole("button", { name: "Inspector", exact: true }),
  },
  {
    ...ROUTE_SURFACES[9]!,
    proof: (page) => page.getByRole("list", { name: "Recent activity" }),
    surface: (page) => page.getByRole("list", { name: "Recent activity" }),
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

const VISUAL_SYSTEM_AUDIT_ROUTES = [
  { name: "Dashboard", path: "/dashboard" },
  { name: "Jobs", path: "/jobs" },
  { name: "Artifacts", path: "/artifacts" },
  { name: "Artifact detail", path: "/artifacts/2" },
  { name: "Application review", path: "/apply-review" },
  { name: "Outcome analytics", path: "/analytics" },
  { name: "Discovery", path: "/discovery" },
  { name: "Outreach", path: "/outreach" },
  {
    name: "Outreach detail",
    path: "/outreach/qa-contact-hiring-manager",
  },
  { name: "Profile", path: "/profile" },
  { name: "Preferences", path: "/preferences" },
  { name: "Resume import entry", path: "/profile/import" },
  { name: "Resume import upload", path: "/profile/import/upload" },
  { name: "Resume import preview", path: "/profile/import/preview" },
  { name: "Resume import confirmation", path: "/profile/import/confirm" },
  { name: "Settings", path: "/settings" },
  { name: "Credential settings", path: "/settings/credentials" },
  { name: "Model settings", path: "/settings/models" },
  { name: "Browser settings", path: "/settings/browser" },
  { name: "Runs", path: "/runs" },
  { name: "Run detail", path: "/runs/qa-run-1" },
  { name: "Pipelines", path: "/pipelines" },
  { name: "Debug", path: "/debug" },
  { name: "Activity detail", path: "/activity/5" },
  {
    name: "Job detail",
    path: `/jobs/${encodeURIComponent(REQUIREMENT_FIT_JOB_URL)}?${JOB_FILTER_PARAMS}`,
  },
  {
    name: "Job run detail",
    path: `/jobs/${encodeURIComponent(REQUIREMENT_FIT_JOB_URL)}/run/qa-run-1?${JOB_FILTER_PARAMS}`,
  },
  { name: "Requirement evidence", path: "/evidence-map" },
] as const;

const APPROVED_ROLE_METRICS = {
  "page-title": "24px/30px/700",
  "section-title": "18px/24px/600",
  "component-title": "16px/22px/600",
  body: "14px/20px/400",
  "strong-body": "14px/20px/600",
  control: "14px/20px/600",
  label: "12px/16px/600",
  status: "12px/16px/600",
  "table-header": "12px/16px/600",
  metadata: "12px/16px/400",
  metric: "20px/24px/700",
  code: "14px/20px/400",
} as const;

type TypographyRole = keyof typeof APPROVED_ROLE_METRICS;

interface TypographyAuditResult {
  readonly checked: number;
  readonly roleStyles: Record<string, string[]>;
  readonly unknown: Array<{ selector: string; text: string }>;
  readonly violations: Array<{
    actual: string;
    expected: string;
    role: string;
    selector: string;
    text: string;
  }>;
}

async function collectTypographyAudit(
  page: Page,
): Promise<TypographyAuditResult> {
  return page.locator(".app-shell").evaluate((shell, approvedRoleMetrics) => {
    const approved = approvedRoleMetrics as Record<string, string>;
    const metricFallback: Record<string, string> = {
      "24px/30px/700": "page-title",
      "18px/24px/600": "section-title",
      "16px/22px/600": "component-title",
      "14px/20px/400": "body",
      "14px/20px/600": "strong-body",
      "12px/16px/600": "label",
      "12px/16px/400": "metadata",
      "20px/24px/700": "metric",
    };
    const roleStyles = new Map<string, Set<string>>();
    const unknown: Array<{ selector: string; text: string }> = [];
    const violations: Array<{
      actual: string;
      expected: string;
      role: string;
      selector: string;
      text: string;
    }> = [];

    const candidates = [shell, ...shell.querySelectorAll<HTMLElement>("*")];
    let checked = 0;
    for (const element of candidates) {
      if (
        element.closest('[aria-hidden="true"]') ||
        element.closest(".sr-only") ||
        // The generated resume is an artifact preview, not application chrome.
        // Its document typography is intentionally preserved for output fidelity.
        element.closest(".resume-plate-page") ||
        element.matches('input[type="hidden"]')
      ) {
        continue;
      }
      const style = getComputedStyle(element);
      const bounds = element.getBoundingClientRect();
      if (
        style.display === "none" ||
        style.visibility === "hidden" ||
        bounds.width <= 0 ||
        bounds.height <= 0
      ) {
        continue;
      }
      const hasDirectText = [...element.childNodes].some(
        (node) =>
          node.nodeType === Node.TEXT_NODE && Boolean(node.textContent?.trim()),
      );
      const hasControlText =
        element instanceof HTMLInputElement ||
        element instanceof HTMLTextAreaElement ||
        element instanceof HTMLSelectElement;
      if (!hasDirectText && !hasControlText) continue;

      checked += 1;
      const tag = element.tagName.toLowerCase();
      const metric = `${style.fontSize}/${style.lineHeight}/${style.fontWeight}`;
      const ownRole = element.getAttribute("data-typography");
      const ancestorRole = element.parentElement
        ?.closest<HTMLElement>("[data-typography]")
        ?.getAttribute("data-typography");
      let role: string | null = ownRole;
      if (!role && (tag === "label" || tag === "legend" || tag === "dt")) {
        role = "label";
      } else if (!role && tag === "th") {
        role = "table-header";
      } else if (
        !role &&
        (tag === "button" || element.getAttribute("role") === "button")
      ) {
        role = "control";
      } else if (
        !role &&
        (tag === "input" || tag === "textarea" || tag === "select")
      ) {
        role = "body";
      } else if (!role && element.matches(".meta, time, small")) {
        role = "metadata";
      } else if (
        !role &&
        element.matches(
          ".eyebrow, .job-audit-triage-kicker, .text-xs.font-medium",
        )
      ) {
        role = "label";
      } else if (!role && element.matches(".tag, .stage-pill")) {
        role = "status";
      } else if (!role && element.matches("code, pre, .mono")) {
        role = "code";
      } else if (!role && (tag === "strong" || tag === "b")) {
        role = "strong-body";
      } else if (!role && ancestorRole) {
        role = ancestorRole;
      } else if (!role && tag === "h1") {
        role = "page-title";
      } else if (!role && tag === "h2") {
        role = "section-title";
      } else if (!role && /^h[3-6]$/.test(tag)) {
        role = "component-title";
      } else if (!role && ["p", "li", "td", "dd", "blockquote"].includes(tag)) {
        role = "body";
      } else if (!role) {
        role = metricFallback[metric] ?? null;
      }
      if (!role && (tag === "a" || tag === "div" || tag === "span")) {
        role = "body";
      }

      const text =
        element instanceof HTMLInputElement ||
        element instanceof HTMLTextAreaElement ||
        element instanceof HTMLSelectElement
          ? element.value ||
            element.getAttribute("placeholder") ||
            element.getAttribute("aria-label") ||
            ""
          : (element.textContent?.trim() ?? "");
      const selector = `${tag}${element.id ? `#${element.id}` : ""}${
        element.classList.length
          ? `.${[...element.classList].slice(0, 3).join(".")}`
          : ""
      }`;
      if (!role || !(role in approved)) {
        unknown.push({ selector, text: text.slice(0, 120) });
        continue;
      }

      const expected = approved[role]!;
      const letterSpacingOk =
        style.letterSpacing === "normal" || style.letterSpacing === "0px";
      const actual = `${metric}|${style.letterSpacing}|${style.textTransform}|${style.fontFamily}`;
      const stylesForRole = roleStyles.get(role) ?? new Set<string>();
      stylesForRole.add(actual);
      roleStyles.set(role, stylesForRole);
      if (
        metric !== expected ||
        !letterSpacingOk ||
        style.textTransform !== "none"
      ) {
        violations.push({
          actual,
          expected,
          role,
          selector,
          text: text.slice(0, 120),
        });
      }
    }

    return {
      checked,
      roleStyles: Object.fromEntries(
        [...roleStyles].map(([role, styles]) => [role, [...styles].sort()]),
      ),
      unknown,
      violations,
    };
  }, APPROVED_ROLE_METRICS);
}

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

function multiRowApplyReviewQueue(): ApplyReviewQueueResponse {
  const base = sampleApplyReviewQueue.items[0]!;
  const titles = [
    "Principal Platform Engineer",
    "Director of Engineering",
    "Head of Engineering",
    "Staff Software Engineer",
    "Engineering Manager",
    "Senior Backend Engineer",
    "Platform Reliability Lead",
    "Principal Software Architect",
  ];
  return {
    ok: true,
    items: titles.map((title, index) => ({
      ...base,
      jobKey: `qa-apply-review-row-${index + 1}`,
      title,
      company: `QA Employer ${index + 1}`,
      fitScore: 10 - (index % 4),
    })),
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
      ".job-detail-workspace::-webkit-scrollbar,.apply-review-pane-scroll::-webkit-scrollbar{width:15px;height:15px}";
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
  const option = page.getByRole("button", {
    name: DENSITY_LABELS[density],
    exact: true,
  });
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

interface DensityGeometry {
  readonly actionHeight: number;
  readonly densityControlHeight: number;
  readonly headerPaddingTop: number;
  readonly sectionPaddingTop: number;
  readonly titleFontSize: string;
}

async function readJobDetailDensityGeometry(
  page: Page,
  density: Density,
): Promise<DensityGeometry> {
  await setDensity(page, density);

  const densityControl = page.getByRole("button", {
    name: DENSITY_LABELS[density],
    exact: true,
  });
  const action = page.locator(".job-detail-top-actions .jh-control").first();
  const header = page.locator(".route-workspace__header");
  const section = page
    .locator(".job-detail-workspace__content > .section")
    .first();
  const title = page.locator(".job-overview h1");

  await expect(action, `${density} job action`).toBeVisible();
  await expect(section, `${density} job section`).toBeVisible();

  return {
    actionHeight: await action.evaluate(
      (element) => element.getBoundingClientRect().height,
    ),
    densityControlHeight: await densityControl.evaluate(
      (element) => element.getBoundingClientRect().height,
    ),
    headerPaddingTop: await header.evaluate((element) =>
      Number.parseFloat(getComputedStyle(element).paddingTop),
    ),
    sectionPaddingTop: await section.evaluate((element) =>
      Number.parseFloat(getComputedStyle(element).paddingTop),
    ),
    titleFontSize: await title.evaluate(
      (element) => getComputedStyle(element).fontSize,
    ),
  };
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

test("target screens use only approved typography roles and identical role metrics", async ({
  page,
}) => {
  test.setTimeout(120_000);

  const allRoleStyles = new Map<TypographyRole, Set<string>>();
  for (const route of VISUAL_SYSTEM_AUDIT_ROUTES) {
    await page.goto(route.path);
    await expect(
      page.locator('[data-typography="page-title"]').first(),
      `${route.name} page title`,
    ).toBeVisible({ timeout: 30_000 });
    const audit = await collectTypographyAudit(page);

    expect(
      audit.checked,
      `${route.name} should expose rendered text`,
    ).toBeGreaterThan(0);
    expect(audit.unknown, `${route.name} unknown typography roles`).toEqual([]);
    expect(audit.violations, `${route.name} unapproved typography`).toEqual([]);
    for (const [role, styles] of Object.entries(audit.roleStyles)) {
      const typedRole = role as TypographyRole;
      const collected = allRoleStyles.get(typedRole) ?? new Set<string>();
      styles.forEach((style) => collected.add(style));
      allRoleStyles.set(typedRole, collected);
    }
  }

  for (const [role, styles] of allRoleStyles) {
    expect(
      [...styles],
      `${role} must resolve identically across target screens`,
    ).toHaveLength(1);
  }
});

test("compact, regular, and comfortable modes preserve typography metrics", async ({
  page,
}) => {
  test.setTimeout(90_000);
  await page.goto("/jobs");
  await expect(page.locator("table.jobs-data-grid-table")).toBeVisible({
    timeout: 30_000,
  });

  const metrics = new Map<Density, string>();
  for (const density of Object.keys(DENSITY_TOKENS) as Density[]) {
    await setDensity(page, density);
    const audit = await collectTypographyAudit(page);
    expect(audit.violations, `${density} typography`).toEqual([]);
    metrics.set(density, JSON.stringify(audit.roleStyles));
  }
  expect(new Set(metrics.values()).size).toBe(1);
});

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

test("every target screen preserves semantic foreground and surface colors in dark mode", async ({
  page,
}) => {
  test.setTimeout(180_000);

  await page.goto("/dashboard");
  await page.getByRole("button", { name: /Switch to dark theme/i }).click();
  await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");

  for (const route of VISUAL_SYSTEM_AUDIT_ROUTES) {
    await page.goto(route.path);
    const title = page.locator('[data-typography="page-title"]').first();
    await expect(title, `${route.name} page title`).toBeVisible({
      timeout: 30_000,
    });
    const colors = await page.locator(".app-shell").evaluate((shell) => {
      const shellStyle = getComputedStyle(shell);
      const titleElement = shell.querySelector<HTMLElement>(
        '[data-typography="page-title"]',
      );
      return {
        background: shellStyle.backgroundColor,
        foreground: titleElement ? getComputedStyle(titleElement).color : "",
      };
    });
    expectPainted(colors.background, `${route.name} dark surface`);
    expectPainted(colors.foreground, `${route.name} dark foreground`);
  }
});

test("@mobile key product routes keep navigation, content, and primary controls usable", async ({
  page,
}) => {
  test.setTimeout(120_000);
  await page.setViewportSize({ width: 320, height: 800 });

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

test("@mobile every target screen reflows without document overflow at 320 CSS pixels", async ({
  page,
}) => {
  test.setTimeout(180_000);
  await page.setViewportSize({ width: 320, height: 800 });

  for (const route of VISUAL_SYSTEM_AUDIT_ROUTES) {
    await page.goto(route.path);
    await expect(
      page.locator('[data-typography="page-title"]').first(),
      `${route.name} page title`,
    ).toBeVisible({ timeout: 30_000 });
    await expectNoDocumentInlineOverflow(page);
    if (route.path === "/profile") {
      const actionBar = page.locator(".editor-bulk-actions").first();
      await expect(
        actionBar,
        "Profile should not show a permanent inactive save bar before edits",
      ).toHaveCount(0);
    }
  }
});

test("density modes visibly change shared job-detail geometry without shrinking type", async ({
  page,
}) => {
  await page.goto(
    `/jobs/${encodeURIComponent(REQUIREMENT_FIT_JOB_URL)}?${JOB_FILTER_PARAMS}`,
  );
  await expect(page.getByRole("article", { name: "Job details" })).toBeVisible({
    timeout: 30_000,
  });

  const compact = await readJobDetailDensityGeometry(page, "compact");
  const regular = await readJobDetailDensityGeometry(page, "regular");
  const comfy = await readJobDetailDensityGeometry(page, "comfy");

  expect(compact.densityControlHeight).toBeLessThan(
    regular.densityControlHeight,
  );
  expect(regular.densityControlHeight).toBeLessThan(comfy.densityControlHeight);
  expect(compact.actionHeight).toBeLessThan(regular.actionHeight);
  expect(regular.actionHeight).toBeLessThan(comfy.actionHeight);
  expect(compact.headerPaddingTop).toBeLessThan(regular.headerPaddingTop);
  expect(regular.headerPaddingTop).toBeLessThan(comfy.headerPaddingTop);
  expect(compact.sectionPaddingTop).toBeLessThan(regular.sectionPaddingTop);
  expect(regular.sectionPaddingTop).toBeLessThan(comfy.sectionPaddingTop);
  expect(
    new Set([compact.titleFontSize, regular.titleFontSize, comfy.titleFontSize])
      .size,
    "density must not reduce readable typography",
  ).toBe(1);
});

test("Apply Review queue items contain their content at every density", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1666, height: 900 });
  await page.route("**/v1/apply/review-queue", async (route) => {
    await route.fulfill({
      contentType: "application/json",
      body: JSON.stringify(multiRowApplyReviewQueue()),
    });
  });
  await page.goto("/apply-review");

  const queueItems = page.locator(".apply-review-queue-item");
  await expect(queueItems.first()).toBeVisible({ timeout: 30_000 });
  expect(
    await queueItems.count(),
    "queue fixture should contain multiple rows",
  ).toBeGreaterThan(1);

  for (const density of Object.keys(DENSITY_TOKENS) as Density[]) {
    await setDensity(page, density);
    const rows = await queueItems.evaluateAll((elements) =>
      elements.slice(0, 8).map((element) => {
        const rect = element.getBoundingClientRect();
        const children = [...element.children].map((child) =>
          child.getBoundingClientRect(),
        );
        return {
          bottom: rect.bottom,
          childBottom: children.length
            ? Math.max(...children.map((child) => child.bottom))
            : rect.top,
          clientHeight: element.clientHeight,
          height: rect.height,
          scrollHeight: element.scrollHeight,
          top: rect.top,
        };
      }),
    );

    expect(rows.length, `${density} queue measurements`).toBeGreaterThan(1);
    for (const [index, row] of rows.entries()) {
      expect(
        row.height,
        `${density} row ${index} height`,
      ).toBeGreaterThanOrEqual(88);
      expect(
        row.scrollHeight,
        `${density} row ${index} content must fit its box`,
      ).toBeLessThanOrEqual(row.clientHeight + 1);
      expect(
        row.childBottom,
        `${density} row ${index} children must stay inside the row`,
      ).toBeLessThanOrEqual(row.bottom + 1);
      if (index > 0) {
        expect(
          rows[index - 1]!.bottom,
          `${density} rows ${index - 1} and ${index} must not overlap`,
        ).toBeLessThanOrEqual(row.top + 1);
      }
    }
  }
});

test("Configuration checkboxes share one target, visual, and label alignment", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1666, height: 900 });
  await page.goto("/discovery");

  const discoveryCheckbox = page.getByRole("checkbox", {
    name: "Individual Contributor",
  });
  await expect(discoveryCheckbox).toBeVisible({ timeout: 30_000 });

  const readGeometry = async (checkbox: Locator) =>
    checkbox.evaluate((element) => {
      const target = element.getBoundingClientRect();
      const visual = getComputedStyle(element, "::before");
      const labelledBy = element.getAttribute("aria-labelledby");
      const label = labelledBy
        ? document.getElementById(labelledBy)
        : (element.parentElement?.querySelector("label") ?? null);
      const labelRect = label?.getBoundingClientRect() ?? null;
      const visualHeight = Number.parseFloat(visual.height);
      return {
        labelLineHeight: label
          ? Number.parseFloat(getComputedStyle(label).lineHeight)
          : 0,
        targetHeight: target.height,
        targetWidth: target.width,
        visualHeight,
        visualTopFromLabel:
          labelRect === null
            ? Number.NaN
            : target.top + (target.height - visualHeight) / 2 - labelRect.top,
        visualWidth: Number.parseFloat(visual.width),
      };
    });

  const discoveryGeometry = new Map<
    Density,
    Awaited<ReturnType<typeof readGeometry>>
  >();

  for (const density of Object.keys(DENSITY_TOKENS) as Density[]) {
    await setDensity(page, density);
    const geometry = await readGeometry(discoveryCheckbox);
    discoveryGeometry.set(density, geometry);

    expect(geometry.targetHeight, `${density} target height`).toBeCloseTo(
      24,
      1,
    );
    expect(geometry.targetWidth, `${density} target width`).toBeCloseTo(24, 1);
    expect(geometry.visualHeight, `${density} visual height`).toBeCloseTo(
      16,
      1,
    );
    expect(geometry.visualWidth, `${density} visual width`).toBeCloseTo(16, 1);
    expect(
      geometry.visualHeight,
      `${density} visual control should not exceed the label line box`,
    ).toBeLessThanOrEqual(geometry.labelLineHeight);
  }

  await page.goto("/preferences");
  const preferencesCheckbox = page.getByRole("checkbox", {
    name: "Available full-time",
  });
  await expect(preferencesCheckbox).toBeVisible({ timeout: 30_000 });
  await expect(
    page.getByRole("button", {
      name: "Set Available full-time to not answered",
    }),
  ).toHaveCount(0);

  for (const density of Object.keys(DENSITY_TOKENS) as Density[]) {
    await setDensity(page, density);
    const preferencesGeometry = await readGeometry(preferencesCheckbox);
    const expectedGeometry = discoveryGeometry.get(density);
    expect(expectedGeometry, `${density} Discovery geometry`).toBeDefined();

    expect(
      preferencesGeometry.targetHeight,
      `${density} Preferences target height`,
    ).toBeCloseTo(24, 1);
    expect(
      preferencesGeometry.targetWidth,
      `${density} Preferences target width`,
    ).toBeCloseTo(24, 1);
    expect(
      preferencesGeometry.visualHeight,
      `${density} Preferences visual height`,
    ).toBeCloseTo(16, 1);
    expect(
      preferencesGeometry.visualWidth,
      `${density} Preferences visual width`,
    ).toBeCloseTo(16, 1);
    expect(
      Math.abs(
        preferencesGeometry.visualTopFromLabel -
          expectedGeometry!.visualTopFromLabel,
      ),
      `${density} checkbox visuals should align with the same label line`,
    ).toBeLessThanOrEqual(1);
  }
});

test("Discovery settings pack related controls and reflow with available width", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1666, height: 900 });
  await page.goto("/discovery");

  await expect(page.getByRole("group", { name: "Target tracks" })).toBeVisible({
    timeout: 30_000,
  });

  const targetGrid = page.locator(".target-preferences-grid");
  const targetClusters = targetGrid.locator(
    ":scope > .target-preference-cluster",
  );
  const boardGrid = page.locator(".discovery-board-options");
  const boardOptions = boardGrid.locator(":scope > .target-choice");
  const targetCardTitles = targetGrid.locator(
    ':scope > .target-preference-cluster [data-slot="card-title"]',
  );
  const assertUsableTargetInputs = async (viewport: string) => {
    for (const inputKind of ["Target roles", "Target location"] as const) {
      const inputs = page.locator(`input[aria-label^="${inputKind} "]`);
      const count = await inputs.count();
      expect(count, `${viewport} ${inputKind} inputs`).toBeGreaterThan(0);
      const widths = await inputs.evaluateAll((elements) =>
        elements.map((element) =>
          Math.round(element.getBoundingClientRect().width),
        ),
      );
      for (const [index, width] of widths.entries()) {
        expect(
          width,
          `${viewport} ${inputKind} input ${index + 1}`,
        ).toBeGreaterThanOrEqual(180);
      }
    }
  };

  await expect(targetClusters).toHaveCount(4);
  await expect(targetCardTitles).toHaveCount(4);
  await expect(boardOptions).toHaveCount(4);

  const desktopTarget = await targetGrid.evaluate((element) => {
    const grid = element.getBoundingClientRect();
    const children = Array.from(element.children).map((child) => {
      const bounds = child.getBoundingClientRect();
      return {
        height: Math.round(bounds.height),
        top: Math.round(bounds.top),
      };
    });
    return {
      children,
      gridHeight: Math.round(grid.height),
      maxChildHeight: Math.max(...children.map(({ height }) => height)),
    };
  });
  const desktopBoards = await boardGrid.evaluate((element) =>
    Array.from(element.children).map((child) => {
      const bounds = child.getBoundingClientRect();
      return {
        left: Math.round(bounds.left),
        right: Math.round(bounds.right),
        top: Math.round(bounds.top),
        width: Math.round(bounds.width),
      };
    }),
  );
  const targetTitleStyles = await targetCardTitles.evaluateAll((elements) =>
    elements.map((element) => {
      const style = getComputedStyle(element);
      return `${style.fontFamily}|${style.fontSize}|${style.fontWeight}|${style.lineHeight}`;
    }),
  );

  expect(new Set(desktopTarget.children.map(({ top }) => top)).size).toBe(1);
  expect(desktopTarget.gridHeight).toBeLessThanOrEqual(
    desktopTarget.maxChildHeight + 42,
  );
  expect(new Set(desktopBoards.map(({ top }) => top)).size).toBe(1);
  expect(new Set(targetTitleStyles).size).toBe(1);
  expect(Math.max(...desktopBoards.map(({ width }) => width))).toBeLessThanOrEqual(160);
  expect(
    Math.max(...desktopBoards.map(({ right }) => right)) -
      Math.min(...desktopBoards.map(({ left }) => left)),
  ).toBeLessThanOrEqual(700);
  await expect(page.getByText(/Saved in SQLite/i)).toHaveCount(0);
  await expect(page.getByRole("button", { name: /^Help for / })).toHaveCount(10);
  await page.getByRole("button", { name: "Help for Results per board" }).click();
  const settingHelp = page.getByRole("dialog", { name: "Results per board help" });
  await expect(settingHelp).toBeVisible();
  await expect(settingHelp.getByRole("link", { name: "Open documentation" })).toHaveAttribute(
    "href",
    "https://jobctrl.dev/user/discovery#runtime-setting-results-per-board",
  );
  await page.keyboard.press("Escape");
  await expect(settingHelp).toBeHidden();
  await assertUsableTargetInputs("desktop");

  await page.setViewportSize({ width: 900, height: 900 });

  const tabletTarget = await targetGrid.evaluate((element) =>
    Array.from(element.children).map((child) => {
      const bounds = child.getBoundingClientRect();
      return {
        left: Math.round(bounds.left),
        top: Math.round(bounds.top),
      };
    }),
  );
  expect(new Set(tabletTarget.map(({ left }) => left)).size).toBeGreaterThan(1);
  expect(new Set(tabletTarget.map(({ left }) => left)).size).toBeLessThan(4);
  expect(new Set(tabletTarget.map(({ top }) => top)).size).toBeGreaterThan(1);
  await assertUsableTargetInputs("tablet");

  await page.setViewportSize({ width: 390, height: 844 });
  await assertUsableTargetInputs("phone");

  const narrowGeometry = await page.locator("body").evaluate(() => {
    const targetClusters = Array.from(
      document.querySelectorAll(
        ".target-preferences-grid > .target-preference-cluster",
      ),
    ).map((element) => {
      const bounds = element.getBoundingClientRect();
      return {
        left: Math.round(bounds.left),
        top: Math.round(bounds.top),
      };
    });
    const boards = Array.from(
      document.querySelectorAll(".discovery-board-options > .target-choice"),
    ).map((element) => {
      const bounds = element.getBoundingClientRect();
      return {
        left: Math.round(bounds.left),
        top: Math.round(bounds.top),
      };
    });
    return {
      boardColumns: new Set(boards.map(({ left }) => left)).size,
      boardRows: new Set(boards.map(({ top }) => top)).size,
      documentOverflow:
        document.documentElement.scrollWidth -
        document.documentElement.clientWidth,
      targetColumns: new Set(targetClusters.map(({ left }) => left)).size,
      targetRows: new Set(targetClusters.map(({ top }) => top)).size,
    };
  });

  expect(narrowGeometry.targetColumns).toBe(1);
  expect(narrowGeometry.targetRows).toBe(4);
  expect(narrowGeometry.boardColumns).toBe(1);
  expect(narrowGeometry.boardRows).toBe(4);
  expect(narrowGeometry.documentOverflow).toBeLessThanOrEqual(1);
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
    page.getByRole("button", { name: "Comfortable", exact: true }),
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
    page.getByRole("heading", { name: "Live pipeline" }),
  ).toBeVisible({ timeout: 30_000 });
  await expectKeyboardFocusIndicator(
    page,
    page.getByRole("button", { name: /Freshness and capacity/i }),
    "pipeline freshness and capacity disclosure",
    100,
  );
});
test("Profile and Preferences subjects share one expandable-card hierarchy", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto("/profile");
  await expect(
    page.getByRole("heading", { name: "Profile", level: 1 }),
  ).toBeVisible({ timeout: 30_000 });

  const sections = page.locator(".profile-sections > .profile-disclosure");
  await expect(sections).toHaveCount(6);

  const cardStyles = await sections.evaluateAll((elements) =>
    elements.map((element) => {
      const style = getComputedStyle(element);
      const rect = element.getBoundingClientRect();
      return {
        backgroundColor: style.backgroundColor,
        borderRadius: style.borderRadius,
        borderStyles: [
          style.borderTopStyle,
          style.borderRightStyle,
          style.borderBottomStyle,
          style.borderLeftStyle,
        ],
        borderWidths: [
          style.borderTopWidth,
          style.borderRightWidth,
          style.borderBottomWidth,
          style.borderLeftWidth,
        ],
        bottom: rect.bottom,
        top: rect.top,
      };
    }),
  );

  for (const [index, style] of cardStyles.entries()) {
    expectPainted(
      style.backgroundColor,
      `Profile card ${index + 1} background`,
    );
    expect(style.borderStyles, `Profile card ${index + 1} borders`).toEqual([
      "solid",
      "solid",
      "solid",
      "solid",
    ]);
    expect(
      style.borderWidths,
      `Profile card ${index + 1} border widths`,
    ).toEqual(["1px", "1px", "1px", "1px"]);
    expect(style.borderRadius, `Profile card ${index + 1} radius`).toBe("8px");
    if (index > 0) {
      expect(
        style.top - cardStyles[index - 1]!.bottom,
        `Profile card ${index + 1} spacing`,
      ).toBe(16);
    }
  }

  const baselineSection = sections.filter({
    has: page.getByRole("heading", { name: "Resume baseline" }),
  });
  const baselineTrigger = baselineSection.getByRole("button", {
    name: /Resume baseline/i,
  });
  const baselineContent = baselineSection.locator(
    '[data-slot="collapsible-content"]',
  );
  await expect(baselineContent).toBeVisible();
  await baselineTrigger.click();
  await expect(baselineContent).toBeHidden();
  await baselineTrigger.click();
  await expect(baselineContent).toBeVisible();

  await page.goto("/preferences");
  await expect(
    page.getByRole("heading", { name: "Preferences", level: 1 }),
  ).toBeVisible({ timeout: 30_000 });

  const preferenceSections = page.locator(".profile-sections > .form-section");
  await expect(preferenceSections).toHaveCount(3);
  await expect(page.locator(".profile-sections--card-stack")).toHaveCount(1);
  await expect(page.locator(".profile-sections--resume-data")).toHaveCount(0);

  const preferenceHierarchy = await page
    .locator(".profile-sections")
    .evaluate((element) => {
      const sections = Array.from(element.children).filter((child) =>
        child.classList.contains("form-section"),
      );
      return {
        gap: getComputedStyle(element).gap,
        sections: sections.map((section) => {
          const style = getComputedStyle(section);
          return {
            backgroundColor: style.backgroundColor,
            borderRadius: style.borderRadius,
            borderStyles: [
              style.borderTopStyle,
              style.borderRightStyle,
              style.borderBottomStyle,
              style.borderLeftStyle,
            ],
            borderWidths: [
              style.borderTopWidth,
              style.borderRightWidth,
              style.borderBottomWidth,
              style.borderLeftWidth,
            ],
            bottom: section.getBoundingClientRect().bottom,
            top: section.getBoundingClientRect().top,
          };
        }),
      };
    });

  expect(preferenceHierarchy.gap).toBe("16px");
  for (const [index, section] of preferenceHierarchy.sections.entries()) {
    expectPainted(
      section.backgroundColor,
      `Preferences card ${index + 1} background`,
    );
    expect(
      section.borderStyles,
      `Preferences card ${index + 1} borders`,
    ).toEqual(["solid", "solid", "solid", "solid"]);
    expect(
      section.borderWidths,
      `Preferences card ${index + 1} border widths`,
    ).toEqual(["1px", "1px", "1px", "1px"]);
    expect(section.borderRadius, `Preferences card ${index + 1} radius`).toBe(
      "8px",
    );
    if (index > 0) {
      expect(
        section.top - preferenceHierarchy.sections[index - 1]!.bottom,
        `Preferences card ${index + 1} spacing`,
      ).toBe(16);
    }
  }

  const tailoringSection = preferenceSections.filter({
    has: page.getByRole("heading", { name: "Tailoring controls" }),
  });
  const tailoringTrigger = tailoringSection.getByRole("button", {
    name: /Tailoring controls/i,
  });
  const tailoringContent = tailoringSection.locator(
    '[data-slot="collapsible-content"]',
  );
  await expect(tailoringContent).toBeVisible();
  await tailoringTrigger.click();
  await expect(tailoringContent).toBeHidden();
  await tailoringTrigger.click();
  await expect(tailoringContent).toBeVisible();

  const resumeStyleSection = preferenceSections.filter({
    has: page.getByRole("heading", { name: "Resume style" }),
  });
  const resumeStyleTrigger = resumeStyleSection.getByRole("button", {
    name: /Resume style/i,
  });
  const resumeStyleContent = resumeStyleSection.locator(
    '[data-slot="collapsible-content"]',
  );
  await expect(resumeStyleContent).toBeHidden();
  await resumeStyleTrigger.click();
  await expect(resumeStyleContent).toBeVisible();
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
  await expect(
    decisionCard.getByRole("combobox", { name: "Resume template" }),
  ).toHaveCount(0);

  const materialsCard = page.locator(".apply-review-materials-pane");
  const templateControl = materialsCard.locator(
    ".apply-review-resume-template-control",
  );
  await expect(materialsCard).toBeVisible();
  await expect(
    materialsCard.getByRole("combobox", { name: "Resume template" }),
  ).toBeVisible();
  await expect(templateControl).toBeVisible();
  expect(
    await templateControl.evaluate((element) => {
      const audit = element.parentElement?.querySelector(
        ".apply-review-resume-review",
      );
      if (!(audit instanceof HTMLElement)) return false;
      return (
        element.getBoundingClientRect().top <= audit.getBoundingClientRect().top
      );
    }),
    "resume template control should lead directly into the resume review surface",
  ).toBe(true);

  const layout = await decisionCard.evaluate((element) => {
    const context = element.querySelector(".apply-review-selected-facts");
    const actions = element.querySelector(".apply-review-selected-actions");
    const decisionButtons = [
      ...element.querySelectorAll(".apply-review-decision-buttons button"),
    ].map((node) => node.getBoundingClientRect());
    const summaryItems = [
      ...element.querySelectorAll(".apply-review-audit-summary-list li"),
    ].map((node) => node.getBoundingClientRect());
    return {
      actionWidth: actions?.getBoundingClientRect().width ?? 0,
      buttonCount: decisionButtons.length,
      buttonTopSpread: decisionButtons.length
        ? Math.max(...decisionButtons.map((rect) => rect.top)) -
          Math.min(...decisionButtons.map((rect) => rect.top))
        : 0,
      contextWidth: context?.getBoundingClientRect().width ?? 0,
      cardHeight: element.getBoundingClientRect().height,
      maxSummaryItemHeight: summaryItems.length
        ? Math.max(...summaryItems.map((rect) => rect.height))
        : 0,
      minSummaryItemWidth: summaryItems.length
        ? Math.min(...summaryItems.map((rect) => rect.width))
        : 0,
      summaryItemCount: summaryItems.length,
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
    layout.buttonCount,
    "the current decision-button selector must match real controls",
  ).toBeGreaterThan(0);
  expect(
    layout.buttonTopSpread,
    "decision buttons should remain on one row",
  ).toBeLessThanOrEqual(1);
  expect(
    layout.summaryItemCount,
    "the current audit summary selector must match real content",
  ).toBeGreaterThan(0);
  expect(
    layout.minSummaryItemWidth,
    "audit summary items should not collapse",
  ).toBeGreaterThan(500);
  expect(
    layout.maxSummaryItemHeight,
    "audit summary items should remain readable",
  ).toBeLessThan(140);
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
