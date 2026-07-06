import { expect, type Locator, type Page, test } from "@playwright/test";

type Density = "compact" | "regular" | "comfy";

interface RouteSurface {
  readonly path: string;
  readonly activeLink: string;
  readonly proof: (page: Page) => Locator;
  readonly surface: (page: Page) => Locator;
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
    proof: (page) => page.getByRole("heading", { name: "Profile" }),
    surface: (page) => page.locator(".card").first(),
  },
  {
    path: "/settings",
    activeLink: "Settings",
    proof: (page) => page.getByRole("heading", { name: "Config" }),
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

const DENSITY_ROUTES = [
  { path: "/jobs", table: "table.jobs-data-grid-table" },
  { path: "/artifacts", table: "table.artifacts-data-grid-table" },
  { path: "/runs", table: "table.runs-data-grid-table" },
  { path: "/debug", table: "table.activity-data-grid-table" },
] as const;

const REQUIREMENT_FIT_JOB_URL = "https://boards.greenhouse.io/gitlab/jobs/qa-platform-director";
const JOB_FILTER_PARAMS = "stage=all&state=all&deleted=active&sort=fit_score&dir=desc&page=1&pageSize=50";
const PRIMARY_REQUIREMENT_TEXT = "Lead platform reliability improvements across critical services.";

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
  await expect(locator, `${label} should be visible`).toBeVisible({
    timeout: 30_000,
  });
  const styles = await readSurfaceStyles(locator);
  expect(styles.display, `${label} should be rendered`).not.toBe("none");
  expect(styles.visibility, `${label} should be visible`).not.toBe("hidden");
  expect(styles.width, `${label} width`).toBeGreaterThan(0);
  expect(styles.height, `${label} height`).toBeGreaterThan(0);
  expectPainted(styles.backgroundColor, `${label} background`);
  expectPainted(styles.color, `${label} foreground`);
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
  await expect(locator, `${label} visual snapshot`).toHaveScreenshot(snapshotName, {
    animations: "disabled",
    caret: "hide",
    maxDiffPixelRatio: 0.01,
  });
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
  await expectPaintedSurface(
    page.getByRole("link", { name: route.activeLink }),
    `${route.path} active nav`,
  );
  await expectPaintedSurface(
    route.surface(page),
    `${route.path} route surface`,
  );
  await expect(
    page.getByRole("textbox", { name: "Global search" }),
  ).toBeVisible();
  await expect(
    page.getByRole("combobox", { name: "Row density" }),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: /Switch to (dark|light) theme/i }),
  ).toBeVisible();
  await expectNoDocumentInlineOverflow(page);
}

async function setDensity(page: Page, density: Density): Promise<void> {
  await page
    .getByRole("combobox", { name: "Row density" })
    .selectOption(density);
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

test("representative routes stay painted in light and dark themes", async ({
  page,
}) => {
  test.setTimeout(90_000);

  for (const route of ROUTE_SURFACES) {
    await expectShellForRoute(page, route);
  }

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
    page.getByRole("combobox", { name: "Row density" }),
    "row density select",
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
  await expect(page.getByRole("heading", { name: "Config" })).toBeVisible({
    timeout: 30_000,
  });
  await expectKeyboardFocusIndicator(
    page,
    page.getByLabel("Apply concurrency"),
    "settings apply concurrency input",
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
  await expect(page.getByRole("heading", { name: "Profile" })).toBeVisible({
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
  );
});

test("route overlays open with seeded data and dismiss from the keyboard", async ({
  page,
}) => {
  await page.goto("/jobs");
  await expect(page.locator("table.jobs-data-grid-table")).toBeVisible({
    timeout: 30_000,
  });
  await page
    .getByRole("button", { name: /Open job Director of Platform Engineering/i })
    .click();
  const jobDialog = page.getByRole("dialog", { name: "Job details" });
  await expect(jobDialog).toBeVisible({ timeout: 30_000 });
  await expectKeyboardFocusIndicator(
    page,
    page.getByRole("button", { name: /Close job details/i }),
    "job detail close",
  );
  await page.keyboard.press("Escape");
  await expect(jobDialog).toHaveCount(0);

  await page.goto("/artifacts/2");
  const artifactDialog = page.getByRole("dialog", { name: "Artifact details" });
  await expect(artifactDialog).toBeVisible({ timeout: 30_000 });
  await expect(
    page.getByRole("region", { name: "Artifact PDF preview" }),
  ).toBeVisible();
  await expectKeyboardFocusIndicator(
    page,
    page.getByRole("button", { name: /Close artifact details/i }),
    "artifact detail close",
  );
  await page.keyboard.press("Escape");
  await expect(artifactDialog).toHaveCount(0);

  await page.goto("/runs");
  await expect(page.locator("table.runs-data-grid-table")).toBeVisible({
    timeout: 30_000,
  });
  await page
    .getByRole("button", { name: /Open run/i })
    .first()
    .click();
  const runDialog = page.getByRole("dialog", { name: "Workflow run details" });
  await expect(runDialog).toBeVisible({ timeout: 30_000 });
  await expectKeyboardFocusIndicator(
    page,
    page.getByRole("button", { name: /Close workflow run details/i }),
    "workflow run detail close",
  );
  await page.keyboard.press("Escape");
  await expect(runDialog).toHaveCount(0);

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

test("requirement-fit drawer and Apply Review cards have visual regression coverage", async ({
  page,
}) => {
  await page.goto(`/jobs/${encodeURIComponent(REQUIREMENT_FIT_JOB_URL)}?${JOB_FILTER_PARAMS}`);
  const drawer = page.getByRole("dialog", { name: "Job details" });
  await expect(drawer).toBeVisible({ timeout: 30_000 });

  const drawerRequirement = drawer
    .locator(".employer-analysis-requirement")
    .filter({ hasText: PRIMARY_REQUIREMENT_TEXT });
  await expect(drawerRequirement).toHaveCount(1);
  await expect(drawerRequirement).toContainText("Requirement fit");
  await expect(drawerRequirement).toContainText("matched");
  await expect(drawerRequirement).toContainText("Score contribution");
  await expect(drawerRequirement).toContainText("Double Down");
  await expectVisualSnapshot(
    drawerRequirement,
    "job-drawer-requirement-fit-card.png",
    "job drawer requirement-fit card",
  );

  await page.goto(`/apply-review?jobKey=${encodeURIComponent(REQUIREMENT_FIT_JOB_URL)}`);
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
  await expect(applyReviewRequirement).toContainText("covered in tailored resume");
  await expectVisualSnapshot(
    applyReviewRequirement,
    "apply-review-requirement-fit-card.png",
    "Apply Review requirement-fit card",
  );
});
