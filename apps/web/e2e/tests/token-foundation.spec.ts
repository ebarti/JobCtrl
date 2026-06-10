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

function expectRootTokens(tokens: Record<RootToken, string>): void {
  for (const token of ROOT_TOKENS) {
    expect(tokens[token], `${token} should compute to a non-empty value`).not.toBe("");
  }
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

function expectPainted(value: string, label: string): void {
  expect(value, `${label} should not be empty`).not.toBe("");
  expect(value, `${label} should not be transparent`).not.toMatch(/^(transparent|rgba\(0, 0, 0, 0\))$/);
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

test("token foundation computes light/dark app-shell tokens and density values", async ({ page }) => {
  await page.goto("/dashboard");

  const themeButton = page.getByRole("button", { name: /Switch to dark theme/i });
  await expect(themeButton).toBeVisible({ timeout: 30_000 });
  await expect(page.locator(".topbar")).toBeVisible();

  const lightTokens = await readRootTokens(page);
  expectRootTokens(lightTokens);
  await expectColorScheme(page, "light");

  await focusByKeyboard(page, themeButton);
  await expectVisibleFocusIndicator(themeButton);

  await themeButton.click();
  await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
  await expectColorScheme(page, "dark");

  const darkTokens = await readRootTokens(page);
  expectRootTokens(darkTokens);
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

  await page.goto("/jobs");
  await expect(page).toHaveURL(/\/jobs\b/);
  await expect(page.locator(".app-shell")).toHaveAttribute("data-density", "comfy");
  await expect(page.locator("table.jobs-data-grid-table")).toBeVisible({ timeout: 30_000 });
});
