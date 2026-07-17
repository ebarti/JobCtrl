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

test("job detail stacks evidence and diagnostics within the mobile viewport", async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(JOB_DETAIL_ROUTE);
  await expect(
    page.getByRole("heading", { name: "Fit & evidence" }),
  ).toBeVisible({
    timeout: 30_000,
  });
  await expect(
    page.getByRole("heading", { name: "Preparation diagnostics" }),
  ).toBeVisible();

  const layout = await page.evaluate(() => {
    const grid = document.querySelector<HTMLElement>(
      ".job-detail-workspace > .route-workspace__grid",
    );
    const content = grid?.querySelector<HTMLElement>(
      ".route-workspace__content",
    );
    const inspector = grid?.querySelector<HTMLElement>(
      ".route-workspace__inspector",
    );
    if (!grid || !content || !inspector) {
      throw new Error(
        "Expected the job detail workspace regions to be mounted.",
      );
    }

    const gridRect = grid.getBoundingClientRect();
    const contentRect = content.getBoundingClientRect();
    const inspectorRect = inspector.getBoundingClientRect();
    return {
      contentBottom: contentRect.bottom,
      contentWidth: contentRect.width,
      gridColumns: getComputedStyle(grid).gridTemplateColumns,
      gridWidth: gridRect.width,
      inspectorTop: inspectorRect.top,
      inspectorWidth: inspectorRect.width,
      pageScrollWidth: document.documentElement.scrollWidth,
      viewportWidth: document.documentElement.clientWidth,
    };
  });

  expect(layout.gridColumns).toBe(`${layout.gridWidth}px`);
  expect(layout.contentWidth).toBeCloseTo(layout.gridWidth, 0);
  expect(layout.inspectorWidth).toBeCloseTo(layout.gridWidth, 0);
  expect(layout.inspectorTop).toBeGreaterThanOrEqual(layout.contentBottom - 1);
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
      ];
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
    expect(layout.pageScrollWidth).toBeLessThanOrEqual(layout.viewportWidth + 1);
  }
});

test("settings keeps every section tab readable on mobile", async ({
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
      allTabsContained: links.every((link) => {
        const rect = link.getBoundingClientRect();
        return rect.left >= navRect.left - 1 && rect.right <= navRect.right + 1;
      }),
      flexWrap: getComputedStyle(nav).flexWrap,
      navLeft: navRect.left,
      navRight: navRect.right,
      pageScrollWidth: document.documentElement.scrollWidth,
      viewportWidth: document.documentElement.clientWidth,
    };
  });

  expect(layout.flexWrap).toBe("wrap");
  expect(layout.allTabsContained).toBe(true);
  expect(layout.activeLeft).toBeGreaterThanOrEqual(layout.navLeft - 1);
  expect(layout.activeRight).toBeLessThanOrEqual(layout.navRight + 1);
  expect(layout.pageScrollWidth).toBeLessThanOrEqual(layout.viewportWidth + 1);
});
