import { expect, type Page, test } from "@playwright/test";

const REPRESENTATIVE_ROUTES = [
  "/dashboard",
  "/pipelines",
  "/settings/browser",
] as const;

const PLATFORM_JOB_URL =
  "https://boards.greenhouse.io/gitlab/jobs/qa-platform-director";
const JOB_DETAIL_ROUTE = `/jobs/${encodeURIComponent(PLATFORM_JOB_URL)}?stage=all&state=all&deleted=active&sort=fit_score&dir=desc&page=1&pageSize=50`;

async function expectFullWidthMobileShell(page: Page): Promise<void> {
  await expect(page.locator(".main-shell")).toBeVisible({ timeout: 30_000 });

  const layout = await page.evaluate(() => {
    const shell = document.querySelector<HTMLElement>(".app-shell");
    const mainShell = document.querySelector<HTMLElement>(".main-shell");
    const main = document.querySelector<HTMLElement>(".main");
    if (!shell || !mainShell || !main) {
      throw new Error("Expected the application shell to be mounted.");
    }

    const shellRect = shell.getBoundingClientRect();
    const mainShellRect = mainShell.getBoundingClientRect();
    const mainRect = main.getBoundingClientRect();
    return {
      mainLeft: mainRect.left,
      mainShellLeft: mainShellRect.left,
      mainShellWidth: mainShellRect.width,
      mainWidth: mainRect.width,
      shellWidth: shellRect.width,
      viewportWidth: document.documentElement.clientWidth,
    };
  });

  expect(layout.shellWidth).toBeCloseTo(layout.viewportWidth, 0);
  expect(layout.mainShellLeft).toBeCloseTo(0, 0);
  expect(layout.mainShellWidth).toBeCloseTo(layout.viewportWidth, 0);
  expect(layout.mainLeft).toBeCloseTo(0, 0);
  expect(layout.mainWidth).toBeCloseTo(layout.viewportWidth, 0);
}

test("representative route shells use the full 390px mobile viewport", async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });

  for (const route of REPRESENTATIVE_ROUTES) {
    await page.goto(route);
    await expectFullWidthMobileShell(page);
  }

  await page.getByRole("button", { name: "Open navigation" }).click();
  const navSheet = page.getByRole("dialog");
  await expect(navSheet).toBeVisible();
  await expect(navSheet.getByRole("link", { name: "Dashboard" })).toBeVisible();
  await expect
    .poll(() =>
      navSheet.evaluate((element) => element.getBoundingClientRect().width),
    )
    .toBeLessThanOrEqual(390);

  await navSheet.getByRole("link", { name: "Dashboard" }).click();
  await expect(page).toHaveURL(/\/dashboard\b/);
  await expect(navSheet).toBeHidden();
  await expectFullWidthMobileShell(page);
});

test("mobile app bar reveals search and display preferences on demand", async ({
  page,
}) => {
  await page.setViewportSize({ width: 320, height: 568 });
  await page.goto("/dashboard");

  const topbar = page.locator(".topbar");
  const search = page.getByRole("textbox", { name: "Global search" });
  const density = page.getByRole("group", { name: "Row density" });
  const theme = page.getByRole("button", {
    name: /Switch to (dark|light) theme/i,
  });
  const searchTrigger = page.getByRole("button", {
    name: "Open global search",
  });
  const preferencesTrigger = page.getByRole("button", {
    name: "Open display preferences",
  });

  await expect(topbar).toBeVisible({ timeout: 30_000 });
  await expect(search).toBeHidden();
  await expect(density).toBeHidden();
  await expect(theme).toBeHidden();
  await expect(searchTrigger).toBeVisible();
  await expect(preferencesTrigger).toBeVisible();
  await expect(page.locator(".connection-pill")).toBeVisible();
  await expect
    .poll(() =>
      topbar.evaluate((element) => element.getBoundingClientRect().height),
    )
    .toBeLessThanOrEqual(52);

  await preferencesTrigger.click();
  const preferences = page.getByRole("menu", {
    name: "Display preferences",
  });
  await expect(preferences).toBeVisible();
  await expect(
    preferences.getByRole("menuitemradio", { name: "Compact" }),
  ).toBeVisible();
  await expect(
    preferences.getByRole("menuitem", { name: /Use dark theme/i }),
  ).toBeVisible();
  await page.keyboard.press("Escape");

  await searchTrigger.click();
  await expect(search).toBeVisible();
  await expect(search).toBeFocused();
  await search.fill("platform");
  await search.press("Enter");
  await expect(page).toHaveURL(/\/jobs\?.*q=platform/);
  await expect(search).toBeHidden();
  await expectFullWidthMobileShell(page);
});

test("profile navigation stays contained at the narrowest mobile viewport", async ({
  page,
}) => {
  await page.setViewportSize({ width: 320, height: 568 });
  await page.goto("/profile");

  await expect(page.getByRole("heading", { name: "Profile" })).toBeVisible({
    timeout: 30_000,
  });
  await expect(page.locator(".profile-workspace-tabs")).toBeVisible();
  await expect(
    page.getByRole("navigation", { name: "Profile sections" }),
  ).toBeVisible();

  const layout = await page.evaluate(() => {
    const workspace = document.querySelector<HTMLElement>(".profile-workspace");
    const tabs = document.querySelector<HTMLElement>(".profile-workspace-tabs");
    const sectionNav = document.querySelector<HTMLElement>(
      ".profile-section-nav",
    );
    if (!workspace || !tabs || !sectionNav) {
      throw new Error(
        "Expected the profile workspace navigation to be mounted.",
      );
    }

    const workspaceRect = workspace.getBoundingClientRect();
    const tabsRect = tabs.getBoundingClientRect();
    const sectionNavRect = sectionNav.getBoundingClientRect();
    return {
      pageScrollWidth: document.documentElement.scrollWidth,
      sectionNavRight: sectionNavRect.right,
      tabsOverflowX: getComputedStyle(tabs).overflowX,
      tabsRight: tabsRect.right,
      tabsScrollWidth: tabs.scrollWidth,
      tabsWidth: tabs.clientWidth,
      viewportWidth: document.documentElement.clientWidth,
      workspaceRight: workspaceRect.right,
    };
  });

  expect(layout.pageScrollWidth).toBeLessThanOrEqual(layout.viewportWidth + 1);
  expect(layout.workspaceRight).toBeLessThanOrEqual(layout.viewportWidth + 1);
  expect(layout.tabsRight).toBeLessThanOrEqual(layout.workspaceRight + 1);
  expect(layout.sectionNavRight).toBeLessThanOrEqual(layout.workspaceRight + 1);
  expect(layout.tabsOverflowX).toBe("auto");
  expect(layout.tabsScrollWidth).toBeGreaterThan(layout.tabsWidth);
});

test("job detail switches between evidence and diagnostics within the mobile viewport", async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(JOB_DETAIL_ROUTE);
  const overviewControl = page.getByRole("button", {
    name: "Summary and evidence",
  });
  const diagnosticsControl = page.getByRole("button", {
    name: "Progress and history",
  });
  const overview = page.locator("#job-detail-overview-panel");
  const diagnostics = page.locator("#job-detail-diagnostics-panel");

  await expect(overviewControl).toHaveAttribute("aria-pressed", "true", {
    timeout: 30_000,
  });
  await expect(overview).toBeVisible();
  await expect(diagnostics).toBeHidden();

  await diagnosticsControl.click();
  await expect(diagnosticsControl).toHaveAttribute("aria-pressed", "true");
  await expect(overview).toBeHidden();
  await expect(diagnostics).toBeVisible();
  await expect(
    page.getByRole("heading", { name: "Preparation diagnostics" }),
  ).toBeVisible();

  const layout = await diagnostics.evaluate((element) => {
    const regionRect = element.getBoundingClientRect();
    return {
      pageScrollWidth: document.documentElement.scrollWidth,
      regionLeft: regionRect.left,
      regionRight: regionRect.right,
      viewportWidth: document.documentElement.clientWidth,
    };
  });

  expect(layout.regionLeft).toBeGreaterThanOrEqual(0);
  expect(layout.regionRight).toBeLessThanOrEqual(layout.viewportWidth + 1);
  expect(layout.pageScrollWidth).toBeLessThanOrEqual(layout.viewportWidth + 1);
});

test("job detail keeps its title and actions readable at desktop and mobile widths", async ({
  page,
}) => {
  for (const viewport of [
    { width: 1440, height: 900 },
    { width: 390, height: 844 },
  ]) {
    await page.setViewportSize(viewport);
    await page.goto(JOB_DETAIL_ROUTE);

    const workspace = page.getByRole("article", { name: "Job details" });
    const toolbar = workspace.getByRole("toolbar", { name: "Job actions" });
    await expect(workspace).toBeVisible({ timeout: 30_000 });
    await expect(
      workspace.getByRole("group", { name: "Preparation actions" }),
    ).toBeVisible();
    await expect(
      workspace.getByRole("group", { name: "Application actions" }),
    ).toBeVisible();
    await expect(
      toolbar.getByRole("link", { name: /apply review/i }),
    ).toHaveCount(0);
    await expect(
      workspace.getByRole("link", { name: /open apply review/i }),
    ).toHaveCount(1);

    const layout = await workspace.evaluate((element) => {
      const header = element.querySelector<HTMLElement>(
        ".job-detail-workspace__header",
      );
      const title = element.querySelector<HTMLElement>(".job-overview h1");
      const actions = element.querySelector<HTMLElement>(
        ".job-detail-top-actions",
      );
      if (!header || !title || !actions) {
        throw new Error("Expected the job detail header, title, and actions.");
      }

      const headerRect = header.getBoundingClientRect();
      const titleRect = title.getBoundingClientRect();
      const actionsRect = actions.getBoundingClientRect();
      const controls = [
        ...actions.querySelectorAll<HTMLElement>("button, a"),
      ].filter((control) => {
        const rect = control.getBoundingClientRect();
        const style = getComputedStyle(control);
        return (
          rect.width > 0 &&
          rect.height > 0 &&
          style.display !== "none" &&
          style.visibility !== "hidden"
        );
      });
      return {
        actionsBelowTitle: actionsRect.top >= titleRect.bottom,
        controlsContained: controls.every((control) => {
          const rect = control.getBoundingClientRect();
          return (
            rect.left >= actionsRect.left - 1 &&
            rect.right <= actionsRect.right + 1
          );
        }),
        pageScrollWidth: document.documentElement.scrollWidth,
        titleWidthRatio: titleRect.width / headerRect.width,
        viewportWidth: document.documentElement.clientWidth,
      };
    });

    expect(layout.titleWidthRatio).toBeGreaterThan(0.65);
    expect(layout.actionsBelowTitle).toBe(true);
    expect(layout.controlsContained).toBe(true);
    expect(layout.pageScrollWidth).toBeLessThanOrEqual(
      layout.viewportWidth + 1,
    );
  }
});

test("settings keeps one compact scrollable section row on mobile", async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/settings/browser");

  const browserTab = page.getByRole("link", {
    name: "Browser & extension",
    exact: true,
  });
  await expect(browserTab).toHaveClass(/\bon\b/, { timeout: 30_000 });

  const layout = await page.evaluate(() => {
    const nav = document.querySelector<HTMLElement>(".settings-tabs");
    const active = nav?.querySelector<HTMLElement>(".tab.on");
    const links = nav ? [...nav.querySelectorAll<HTMLElement>("a")] : [];
    if (!nav || !active) {
      throw new Error("Expected the active settings navigation tab.");
    }

    const navRect = nav.getBoundingClientRect();
    const activeRect = active.getBoundingClientRect();
    return {
      activeLeft: activeRect.left,
      activeRight: activeRect.right,
      allTabsSingleRow:
        Math.max(...links.map((link) => link.getBoundingClientRect().top)) -
          Math.min(...links.map((link) => link.getBoundingClientRect().top)) <=
        1,
      clientWidth: nav.clientWidth,
      flexWrap: getComputedStyle(nav).flexWrap,
      navLeft: navRect.left,
      navRight: navRect.right,
      overflowX: getComputedStyle(nav).overflowX,
      pageScrollWidth: document.documentElement.scrollWidth,
      scrollWidth: nav.scrollWidth,
      viewportWidth: document.documentElement.clientWidth,
    };
  });

  expect(layout.flexWrap).toBe("nowrap");
  expect(layout.allTabsSingleRow).toBe(true);
  expect(layout.overflowX).toBe("auto");
  expect(layout.scrollWidth).toBeGreaterThan(layout.clientWidth);
  expect(layout.activeLeft).toBeGreaterThanOrEqual(layout.navLeft - 1);
  expect(layout.activeRight).toBeLessThanOrEqual(layout.navRight + 1);
  expect(layout.pageScrollWidth).toBeLessThanOrEqual(layout.viewportWidth + 1);
});
