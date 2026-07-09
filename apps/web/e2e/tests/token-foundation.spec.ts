import { expect, type Locator, type Page, test } from "@playwright/test";

const ROOT_TOKENS = [
  "--background",
  "--foreground",
  "--primary",
  "--ring",
  "--sidebar",
] as const;

type RootToken = (typeof ROOT_TOKENS)[number];

async function readRootTokens(page: Page): Promise<Record<RootToken, string>> {
  return page.evaluate((tokens) => {
    const style = getComputedStyle(document.documentElement);
    return Object.fromEntries(
      tokens.map((token) => [token, style.getPropertyValue(token).trim()]),
    );
  }, ROOT_TOKENS) as Promise<Record<RootToken, string>>;
}

function expectRootTokenValues(tokens: Record<RootToken, string>): void {
  for (const token of ROOT_TOKENS) {
    expect(tokens[token], `${token} should compute to a non-empty value`).not.toBe("");
  }
}

async function readRootTokensWhenReady(page: Page): Promise<Record<RootToken, string>> {
  for (const token of ROOT_TOKENS) {
    await expect.poll(() => readRootTokens(page).then((tokens) => tokens[token])).not.toBe("");
  }
  const tokens = await readRootTokens(page);
  expectRootTokenValues(tokens);
  return tokens;
}

async function expectColorScheme(page: Page, expected: "light" | "dark"): Promise<void> {
  await expect
    .poll(() => page.evaluate(() => getComputedStyle(document.documentElement).colorScheme))
    .toContain(expected);
}

async function expectDensity(page: Page, density: "compact" | "regular" | "comfy", height: string) {
  await page.getByRole("combobox", { name: "Row density" }).selectOption(density);
  const shell = page.locator(".app-shell");

  await expect(shell).toHaveAttribute("data-density", density);
  await expect
    .poll(() => shell.evaluate((element) => getComputedStyle(element).getPropertyValue("--jh-row-height").trim()))
    .toBe(height);
}

async function readSurfaceStyles(locator: Locator) {
  return locator.evaluate((element) => {
    const style = getComputedStyle(element);
    return {
      backgroundColor: style.backgroundColor,
      borderBottomColor: style.borderBottomColor,
      borderBottomStyle: style.borderBottomStyle,
      borderBottomWidth: style.borderBottomWidth,
      borderTopColor: style.borderTopColor,
      borderTopStyle: style.borderTopStyle,
      borderTopWidth: style.borderTopWidth,
      color: style.color,
      colorScheme: style.colorScheme,
    };
  });
}

interface PaintedStatusStyles {
  readonly backgroundColor: string;
  readonly borderTopColor: string;
  readonly borderTopStyle: string;
  readonly borderTopWidth: string;
  readonly color: string;
  readonly height: number;
  readonly toneDiffersFromBase: boolean;
  readonly width: number;
}

async function readFirstPaintedStatus(locator: Locator): Promise<PaintedStatusStyles | null> {
  return locator.evaluateAll((elements) => {
    function baseClassFor(element: Element): string | null {
      if (element.classList.contains("status-dot")) return "status-dot";
      if (element.classList.contains("stage-pill")) return "stage-pill";
      if (element.classList.contains("tag")) return "tag";
      return null;
    }

    function toneDiffersFromBase(element: Element, style: CSSStyleDeclaration): boolean {
      const baseClass = baseClassFor(element);
      if (baseClass === null) return true;
      const base = document.createElement("span");
      base.className = baseClass;
      base.style.position = "absolute";
      base.style.visibility = "hidden";
      element.parentElement?.append(base);
      const baseStyle = getComputedStyle(base);
      const differs =
        style.backgroundColor !== baseStyle.backgroundColor
        || style.borderTopColor !== baseStyle.borderTopColor
        || style.color !== baseStyle.color;
      base.remove();
      return differs;
    }

    for (const element of elements) {
      const style = getComputedStyle(element);
      const rect = element.getBoundingClientRect();
      const isPainted = rect.width > 0 && rect.height > 0 && style.display !== "none" && style.visibility !== "hidden";
      if (isPainted) {
        return {
          backgroundColor: style.backgroundColor,
          borderTopColor: style.borderTopColor,
          borderTopStyle: style.borderTopStyle,
          borderTopWidth: style.borderTopWidth,
          color: style.color,
          height: rect.height,
          toneDiffersFromBase: toneDiffersFromBase(element, style),
          width: rect.width,
        };
      }
    }
    return null;
  });
}

function expectPainted(value: string, label: string): void {
  expect(value, `${label} should not be empty`).not.toBe("");
  expect(value, `${label} should not be transparent`).not.toMatch(/^(transparent|rgba\(0, 0, 0, 0\))$/);
}

async function expectPaintedStatus(locator: Locator, label: string): Promise<void> {
  await expect.poll(() => locator.count(), { message: `${label} should exist in the DOM` }).toBeGreaterThan(0);
  await expect
    .poll(() => readFirstPaintedStatus(locator), { message: `${label} should have a painted visible instance` })
    .not.toBeNull();
  const styles = await readFirstPaintedStatus(locator);
  if (styles === null) {
    throw new Error(`${label} did not resolve to a painted status element.`);
  }

  expectPainted(styles.backgroundColor, `${label} background`);
  expectPainted(styles.color, `${label} foreground`);
  expect(styles.width, `${label} width`).toBeGreaterThan(0);
  expect(styles.height, `${label} height`).toBeGreaterThan(0);
  if (Number.parseFloat(styles.borderTopWidth) > 0) {
    expectPainted(styles.borderTopColor, `${label} border`);
    expect(styles.borderTopStyle, `${label} border style`).not.toBe("none");
  }
  expect(styles.toneDiffersFromBase, `${label} should differ from its base status styling`).toBe(true);
}

async function focusByKeyboard(page: Page, target: Locator): Promise<void> {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    const isFocused = await target.evaluate((element) => element === document.activeElement);
    if (isFocused) {
      return;
    }
    await page.keyboard.press("Tab");
  }

  throw new Error("Expected to reach the theme toggle via keyboard navigation.");
}

async function expectVisibleFocusIndicator(locator: Locator): Promise<void> {
  const focus = await locator.evaluate((element) => {
    const style = getComputedStyle(element);
    return {
      boxShadow: style.boxShadow,
      outlineStyle: style.outlineStyle,
      outlineWidth: style.outlineWidth,
    };
  });

  const outlineWidth = Number.parseFloat(focus.outlineWidth);
  const hasOutline = focus.outlineStyle !== "none" && Number.isFinite(outlineWidth) && outlineWidth >= 1;
  const hasShadow = focus.boxShadow !== "none";

  expect(hasOutline || hasShadow, "focused theme control should expose a visible indicator").toBe(true);
}

async function expectThemeIconDimensions(themeButton: Locator): Promise<void> {
  const dimensions = await themeButton.locator("svg").first().evaluate((element) => {
    const rect = element.getBoundingClientRect();
    return { height: rect.height, width: rect.width };
  });

  expect(dimensions.width, "theme icon should render with a stable width").toBeGreaterThanOrEqual(12);
  expect(dimensions.width, "theme icon should not inflate the shell control").toBeLessThanOrEqual(18);
  expect(dimensions.height, "theme icon should render with a stable height").toBeGreaterThanOrEqual(12);
  expect(dimensions.height, "theme icon should not inflate the shell control").toBeLessThanOrEqual(18);
}

async function expectNoDocumentInlineOverflow(page: Page): Promise<void> {
  const layout = await page.evaluate(() => {
    const root = document.documentElement;
    const rail = document.querySelector(".side-rail");
    return {
      clientWidth: root.clientWidth,
      railWidth: rail?.getBoundingClientRect().width ?? 0,
      scrollWidth: root.scrollWidth,
    };
  });

  expect(layout.scrollWidth, "shell should not create horizontal document overflow").toBeLessThanOrEqual(
    layout.clientWidth + 1,
  );
  expect(layout.railWidth, "navigation rail should stay within the viewport").toBeLessThanOrEqual(
    layout.clientWidth,
  );
}

async function expectArtifactPdfPreviewRendered(page: Page): Promise<void> {
  const preview = page.getByRole("region", { name: "Artifact PDF preview" });
  await expect(preview).toBeVisible({ timeout: 30_000 });
  await expect(preview.getByText("1 page", { exact: true })).toBeVisible({ timeout: 30_000 });
  await expect(preview.getByText("Preview failed", { exact: true })).toHaveCount(0);

  const pageImage = preview.locator(".pdf-preview-page img");
  await expect(pageImage).toHaveCount(1);
  await expect(pageImage).toBeVisible();
  await expect
    .poll(() => pageImage.evaluate((element) => (element as HTMLImageElement).naturalWidth), {
      message: "artifact PDF preview page should load real image pixels",
    })
    .toBeGreaterThan(0);
}

async function expectShellChromePainted(page: Page, route: string, activeLink: string): Promise<void> {
  await page.goto(route);

  const topbar = page.locator(".topbar");
  await expect(topbar).toBeVisible({ timeout: 30_000 });
  await expect(page.getByRole("link", { name: activeLink })).toBeVisible();
  await expect(page.getByRole("textbox", { name: "Global search" })).toBeVisible();
  await expect(page.getByRole("combobox", { name: "Row density" })).toBeVisible();
  await expect(page.getByRole("button", { name: /Switch to (dark|light) theme/i })).toBeVisible();
  await expect(page.locator(".connection-pill")).toBeVisible();

  const topbarStyles = await readSurfaceStyles(topbar);
  expectPainted(topbarStyles.backgroundColor, `${route} topbar background`);
  expectPainted(topbarStyles.borderBottomColor, `${route} topbar border`);
  expect(Number.parseFloat(topbarStyles.borderBottomWidth)).toBeGreaterThan(0);
  expect(topbarStyles.borderBottomStyle).not.toBe("none");

  const activeNavStyles = await readSurfaceStyles(page.getByRole("link", { name: activeLink }));
  expectPainted(activeNavStyles.backgroundColor, `${route} active nav background`);
  expectPainted(activeNavStyles.color, `${route} active nav foreground`);

  const searchStyles = await readSurfaceStyles(page.getByRole("textbox", { name: "Global search" }));
  expectPainted(searchStyles.backgroundColor, `${route} global search background`);
  expectPainted(searchStyles.color, `${route} global search foreground`);
  expectPainted(searchStyles.borderTopColor, `${route} global search border`);
  expect(Number.parseFloat(searchStyles.borderTopWidth)).toBeGreaterThan(0);

  const densityStyles = await readSurfaceStyles(page.getByRole("combobox", { name: "Row density" }));
  expectPainted(densityStyles.backgroundColor, `${route} density background`);
  expectPainted(densityStyles.color, `${route} density foreground`);
  expectPainted(densityStyles.borderTopColor, `${route} density border`);
  expect(Number.parseFloat(densityStyles.borderTopWidth)).toBeGreaterThan(0);

  const pillStyles = await readSurfaceStyles(page.locator(".connection-pill"));
  expectPainted(pillStyles.backgroundColor, `${route} connection pill background`);
  expectPainted(pillStyles.color, `${route} connection pill foreground`);

  const themeStyles = await readSurfaceStyles(page.getByRole("button", { name: /Switch to (dark|light) theme/i }));
  expectPainted(themeStyles.color, `${route} theme toggle foreground`);
}

test("token foundation computes light/dark app-shell tokens and density values", async ({ page }) => {
  await page.goto("/dashboard");

  const themeButton = page.getByRole("button", { name: /Switch to dark theme/i });
  await expect(themeButton).toBeVisible({ timeout: 30_000 });
  await expect(page.locator(".topbar")).toBeVisible();
  await expectThemeIconDimensions(themeButton);
  await expectNoDocumentInlineOverflow(page);

  const lightTokens = await readRootTokensWhenReady(page);
  await expectColorScheme(page, "light");

  await focusByKeyboard(page, themeButton);
  await expectVisibleFocusIndicator(themeButton);

  await themeButton.click();
  await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
  await expectColorScheme(page, "dark");

  const darkTokens = await readRootTokensWhenReady(page);
  expect(darkTokens["--background"]).not.toBe(lightTokens["--background"]);
  expect(darkTokens["--foreground"]).not.toBe(lightTokens["--foreground"]);

  await expectDensity(page, "compact", "32px");
  await expectDensity(page, "regular", "40px");
  await expectDensity(page, "comfy", "48px");

  const topbarStyles = await readSurfaceStyles(page.locator(".topbar"));
  expectPainted(topbarStyles.backgroundColor, "topbar background");
  expectPainted(topbarStyles.borderBottomColor, "topbar border");
  expect(Number.parseFloat(topbarStyles.borderBottomWidth)).toBeGreaterThan(0);
  expect(topbarStyles.borderBottomStyle).not.toBe("none");

  const dashboardNavStyles = await readSurfaceStyles(page.getByRole("link", { name: "Dashboard" }));
  expectPainted(dashboardNavStyles.backgroundColor, "active dashboard nav background");
  expectPainted(dashboardNavStyles.color, "active dashboard nav foreground");

  const densityStyles = await readSurfaceStyles(page.getByRole("combobox", { name: "Row density" }));
  expectPainted(densityStyles.backgroundColor, "row density select background");
  expectPainted(densityStyles.borderTopColor, "row density select border");
  expectPainted(densityStyles.color, "row density select foreground");
  expect(Number.parseFloat(densityStyles.borderTopWidth)).toBeGreaterThan(0);
  expect(densityStyles.borderTopStyle).not.toBe("none");
  expect(densityStyles.colorScheme).toContain("dark");

  const globalSearch = page.getByRole("textbox", { name: "Global search" });
  await globalSearch.fill("  platform reliability  ");
  await globalSearch.press("Enter");
  await expect(page).toHaveURL(/\/jobs\b/);
  const jobsUrl = new URL(page.url());
  expect(jobsUrl.pathname).toBe("/jobs");
  expect(jobsUrl.searchParams.get("q")).toBe("platform reliability");
  expect(jobsUrl.searchParams.get("page")).toBe("1");
  await expect(page.locator(".app-shell")).toHaveAttribute("data-density", "comfy");
  await expect(page.locator("table.jobs-data-grid-table")).toBeVisible({ timeout: 30_000 });

  await page.reload();
  await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
  await expect(page.locator(".app-shell")).toHaveAttribute("data-density", "comfy");
  await expect(page.locator("table.jobs-data-grid-table")).toBeVisible({ timeout: 30_000 });
  await expectNoDocumentInlineOverflow(page);
});

test("shell chrome stays readable on Phase 8 route surfaces", async ({ page }) => {
  await expectShellChromePainted(page, "/jobs", "Jobs");
  await expectShellChromePainted(page, "/apply-review", "Apply review");
  await expectShellChromePainted(page, "/artifacts/2", "Artifacts");
  await expect(page.getByRole("dialog", { name: "Artifact details" })).toBeVisible();
  await expectArtifactPdfPreviewRendered(page);
  await expect(page.getByRole("link", { name: "open PDF" })).toBeVisible();

  await page.goto("/jobs");
  await page.getByRole("button", { name: /Switch to dark theme/i }).click();
  await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");

  await expectShellChromePainted(page, "/jobs", "Jobs");
  await expectShellChromePainted(page, "/apply-review", "Apply review");
  await expectShellChromePainted(page, "/pipelines", "Pipelines");
  await expectShellChromePainted(page, "/artifacts/2", "Artifacts");
  await expect(page.getByRole("dialog", { name: "Artifact details" })).toBeVisible();
  await expectArtifactPdfPreviewRendered(page);
  await expect(page.getByRole("link", { name: "open PDF" })).toBeVisible();
});

test("shell chrome collapses navigation into a sheet on the mobile viewport", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/jobs");

  await expect(page.locator(".topbar")).toBeVisible({ timeout: 30_000 });
  await expect(page.locator(".side-rail")).toBeHidden();
  await expect(page.getByRole("textbox", { name: "Global search" })).toBeVisible();
  await expect(page.getByRole("combobox", { name: "Row density" })).toBeVisible();
  await expect(page.getByRole("button", { name: /Switch to dark theme/i })).toBeVisible();
  await expectNoDocumentInlineOverflow(page);

  await page.getByRole("button", { name: "Open navigation" }).click();
  const navSheet = page.getByRole("dialog");
  await expect(navSheet).toBeVisible();
  await expect(navSheet.getByRole("link", { name: "Jobs" })).toBeVisible();
  await expect(navSheet.getByRole("link", { name: "Apply review" })).toBeVisible();
  // The mobile sheet must render the full grouped, labelled nav — not the
  // icon-only collapse the <=1180px rail uses. Assert the visible label and
  // group-header text (not just the aria-label) survives the media query.
  await expect(navSheet.locator(".side-rail__label", { hasText: "Jobs" })).toBeVisible();
  await expect(navSheet.locator(".side-rail__group-label", { hasText: "Pipeline" })).toBeVisible();
  await navSheet.getByRole("link", { name: "Dashboard" }).click();
  await expect(page).toHaveURL(/\/dashboard\b/);
});

test("domain status surfaces use painted semantic token classes", async ({ page }) => {
  await page.goto("/dashboard");
  await expect(page.getByRole("heading", { name: "Source health" })).toBeVisible({ timeout: 30_000 });
  await expectPaintedStatus(page.locator(".seg-done"), "dashboard completed funnel segment");
  await expectPaintedStatus(page.locator(".seg-failed"), "dashboard failed funnel segment");
  await expectPaintedStatus(page.locator(".seg-blocked"), "dashboard blocked funnel segment");
  await expectPaintedStatus(page.locator(".seg-pending"), "dashboard pending funnel segment");
  await expectPaintedStatus(page.locator(".status-dot.succeeded"), "dashboard completed apply-run dot");
  await expectPaintedStatus(page.locator(".tag.info"), "dashboard dry-run info tag");

  await page.goto("/jobs");
  await expect(page.locator("table.jobs-data-grid-table")).toBeVisible({ timeout: 30_000 });
  await expectPaintedStatus(page.locator(".fit.good"), "jobs good fit score");
  await expectPaintedStatus(page.locator(".stage-pill.ok"), "jobs apply stage pill");
  await expectPaintedStatus(page.locator(".tag.danger"), "jobs failed state tag");
  await expectPaintedStatus(page.locator(".tag.warn"), "jobs blocked state tag");
  await expectPaintedStatus(page.locator(".tag.muted"), "jobs pending state tag");

  await page.goto("/apply-review");
  await expect(page.getByRole("complementary", { name: "Application review queue" })).toBeVisible({ timeout: 30_000 });
  await expectPaintedStatus(page.locator(".tag.ok"), "apply review fit score tag");
  await expectPaintedStatus(page.locator(".tag.info"), "apply review preparing status tag");

  await page.goto("/artifacts");
  await expect(page.locator("table.artifacts-data-grid-table")).toBeVisible({ timeout: 30_000 });
  await expectPaintedStatus(page.locator(".tag.ok"), "artifacts approved status tag");
  await expectPaintedStatus(page.locator(".tag.muted"), "artifacts type tag");

  await page.goto("/runs");
  await expect(page.locator("table.runs-data-grid-table")).toBeVisible({ timeout: 30_000 });
  await expectPaintedStatus(page.locator(".tag.info"), "runs active workflow status tag");
  await expectPaintedStatus(page.locator(".tag.ok"), "runs succeeded workflow status tag");

  await page.goto("/debug");
  await expect(page.locator("table.activity-data-grid-table")).toBeVisible({ timeout: 30_000 });
  await expectPaintedStatus(page.locator(".tag.info"), "debug activity level tag");

  await page.getByRole("button", { name: /Switch to dark theme/i }).click();
  await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
  await page.goto("/dashboard");
  await expect(page.getByRole("heading", { name: "Source health" })).toBeVisible({ timeout: 30_000 });
  await expectPaintedStatus(page.locator(".seg-done"), "dark dashboard completed funnel segment");
  await expectPaintedStatus(page.locator(".status-dot.succeeded"), "dark dashboard completed apply-run dot");

  await page.goto("/jobs");
  await expect(page.locator("table.jobs-data-grid-table")).toBeVisible({ timeout: 30_000 });
  await expectPaintedStatus(page.locator(".fit.good"), "dark jobs good fit score");
  await expectPaintedStatus(page.locator(".tag.danger"), "dark jobs failed state tag");
});
