import { expect, type Locator, type Page, test } from "@playwright/test";
import { getViolations, injectAxe } from "axe-playwright";

import { sampleHealthResponse } from "../../src/test/fixtures/projections.js";

const REPRESENTATIVE_ROUTES = [
  "/dashboard",
  "/jobs",
  "/apply-review",
  "/pipelines",
  "/discovery",
  "/profile",
  "/preferences",
  "/settings/credentials",
  "/profile/import/upload",
] as const;

async function expectNoCriticalOrSeriousAxeViolations(
  page: Page,
  route: string,
): Promise<void> {
  await page.goto(route);
  await expect(page.locator(".app-shell")).toBeVisible({ timeout: 30_000 });
  await expect(
    page.locator('[data-typography="page-title"]').first(),
  ).toBeVisible({ timeout: 30_000 });
  if (route === "/preferences") {
    await expect(
      page
        .getByRole("group", { name: "Template settings" })
        .getByRole("combobox", { name: "Font" }),
    ).toBeEnabled({ timeout: 30_000 });
  }
  await injectAxe(page);
  const violations = (await getViolations(page)).filter((violation) =>
    ["critical", "serious"].includes(violation.impact ?? ""),
  );
  const summary = violations.map((violation) => ({
    id: violation.id,
    impact: violation.impact,
    targets: violation.nodes.map((node) => node.target),
  }));
  expect(summary, `${route} critical/serious axe violations`).toEqual([]);
}

async function expectNoDocumentOverflow(page: Page, route: string) {
  const dimensions = await page.evaluate(() => ({
    clientWidth: document.documentElement.clientWidth,
    offenders: Array.from(document.body.querySelectorAll<HTMLElement>("*"))
      .map((element) => {
        const rect = element.getBoundingClientRect();
        return {
          className:
            typeof element.className === "string" ? element.className : "",
          label: element.getAttribute("aria-label") ?? "",
          right: Math.round(rect.right),
          tag: element.tagName.toLowerCase(),
          width: Math.round(rect.width),
        };
      })
      .filter(({ right }) => right > document.documentElement.clientWidth + 1)
      .slice(0, 12),
    scrollWidth: document.documentElement.scrollWidth,
  }));
  expect(
    dimensions.scrollWidth,
    `${route} should reflow without page-level horizontal overflow; offenders=${JSON.stringify(dimensions.offenders)}`,
  ).toBeLessThanOrEqual(dimensions.clientWidth + 1);
}

async function expectMinimumTarget(locator: Locator, label: string) {
  await expect(locator, `${label} should be visible`).toBeVisible({
    timeout: 30_000,
  });
  const box = await locator.boundingBox();
  expect(box, `${label} should have measurable geometry`).not.toBeNull();
  expect(box!.width, `${label} target width`).toBeGreaterThanOrEqual(24);
  expect(box!.height, `${label} target height`).toBeGreaterThanOrEqual(24);
}

async function expectRejectedResumeUpload(page: Page) {
  const resumeImport = page.getByRole("region", {
    name: "Resume import",
    exact: true,
  });
  const fileInput = resumeImport.getByLabel("Resume PDF");
  const continueButton = resumeImport.getByRole("button", {
    name: "Continue to options",
  });
  await expect(fileInput).toBeAttached({ timeout: 30_000 });
  await expect(continueButton).toBeDisabled();
  await fileInput.setInputFiles({
    name: "resume.txt",
    mimeType: "text/plain",
    buffer: Buffer.from("synthetic resume"),
  });
  await expect(resumeImport.getByRole("alert")).toContainText(
    "Choose a PDF file.",
  );
  await expect(continueButton).toBeDisabled();
}

test("representative remediated routes have no critical or serious axe violations", async ({
  page,
}) => {
  test.setTimeout(180_000);
  for (const route of REPRESENTATIVE_ROUTES) {
    await expectNoCriticalOrSeriousAxeViolations(page, route);
  }
});

test("forms expose labels, validation state, and an announced upload error", async ({
  page,
}) => {
  await page.goto("/discovery");
  await expect(page.getByLabel("Minimum fit score")).toBeVisible({
    timeout: 30_000,
  });
  await expect(
    page.getByRole("spinbutton", {
      name: "Results per board",
      exact: true,
    }),
  ).toBeVisible();
  await expect(
    page.getByRole("button", {
      name: "Help for Results per board",
      exact: true,
    }),
  ).toBeVisible();
  await expect(page.getByRole("checkbox", { name: "LinkedIn" })).toBeVisible();

  await page.goto("/settings");
  await expect(
    page.getByLabel("Concurrent applications", { exact: true }),
  ).toBeVisible({
    timeout: 30_000,
  });

  await page.goto("/profile/import/upload");
  await expectRejectedResumeUpload(page);
});

test("resume upload error remains announced with a stale worker warning", async ({
  page,
}) => {
  await page.route("**/v1/health", async (route) => {
    await route.fulfill({
      json: {
        ...sampleHealthResponse,
        worker: {
          ...sampleHealthResponse.worker,
          status: "stale",
          message:
            "JobCtrl automation worker heartbeat is stale; last seen at test time.",
        },
      },
    });
  });

  await page.goto("/profile/import/upload");
  await expect(page.locator(".connection-banner")).toContainText(
    "worker heartbeat is stale",
  );
  await expectRejectedResumeUpload(page);
});

test("200 percent text-scale approximation preserves representative task access", async ({
  page,
}) => {
  test.setTimeout(120_000);
  await page.setViewportSize({ width: 1280, height: 800 });

  for (const route of [
    "/dashboard",
    "/discovery",
    "/settings",
    "/profile/import/upload",
  ] as const) {
    await page.goto(route);
    await expect(page.locator(".app-shell")).toBeVisible({ timeout: 30_000 });
    await page.evaluate(() => {
      const doubledRoleTokens: Record<string, string> = {
        "--jh-type-page-title-size": "48px",
        "--jh-type-page-title-line-height": "60px",
        "--jh-type-section-title-size": "36px",
        "--jh-type-section-title-line-height": "48px",
        "--jh-type-component-title-size": "32px",
        "--jh-type-component-title-line-height": "44px",
        "--jh-type-body-size": "28px",
        "--jh-type-body-line-height": "40px",
        "--jh-type-strong-body-size": "28px",
        "--jh-type-strong-body-line-height": "40px",
        "--jh-type-control-size": "28px",
        "--jh-type-control-line-height": "40px",
        "--jh-type-label-size": "24px",
        "--jh-type-label-line-height": "32px",
        "--jh-type-metadata-size": "24px",
        "--jh-type-metadata-line-height": "32px",
        "--jh-type-metric-size": "40px",
        "--jh-type-metric-line-height": "48px",
      };
      for (const [name, value] of Object.entries(doubledRoleTokens)) {
        document.documentElement.style.setProperty(name, value);
      }
    });

    await expect(
      page.locator('[data-typography="page-title"]').first(),
    ).toBeVisible();
    await expectNoDocumentOverflow(page, `${route} at 200% role text scale`);
  }
});

test("reduced-motion preference suppresses nonessential app-shell motion", async ({
  page,
}) => {
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.goto("/jobs");
  await expect(page.locator(".app-shell")).toBeVisible({ timeout: 30_000 });

  const offenders = await page.locator(".app-shell").evaluate((shell) => {
    const milliseconds = (values: string) =>
      values.split(",").map((value) => {
        const normalized = value.trim();
        if (normalized.endsWith("ms")) return Number.parseFloat(normalized);
        if (normalized.endsWith("s"))
          return Number.parseFloat(normalized) * 1000;
        return 0;
      });
    return [shell, ...shell.querySelectorAll<HTMLElement>("*")]
      .filter((element) => {
        const rect = element.getBoundingClientRect();
        return rect.width > 0 && rect.height > 0;
      })
      .flatMap((element) => {
        const style = getComputedStyle(element);
        const duration = Math.max(
          ...milliseconds(style.animationDuration),
          ...milliseconds(style.transitionDuration),
        );
        return duration > 1
          ? [
              {
                duration,
                selector:
                  element.id ||
                  element.getAttribute("data-slot") ||
                  element.className ||
                  element.tagName,
              },
            ]
          : [];
      });
  });

  expect(offenders).toEqual([]);
});

test("@mobile navigation traps focus, restores its trigger, and exposes visible state", async ({
  page,
}) => {
  await page.setViewportSize({ width: 320, height: 568 });
  await page.goto("/dashboard");
  const trigger = page.getByRole("button", { name: "Open navigation" });
  await trigger.click();
  const dialog = page.getByRole("dialog");
  await expect(dialog).toBeVisible();
  await expect(
    dialog.getByRole("navigation", { name: "Main navigation" }),
  ).toBeVisible();

  for (let step = 0; step < 12; step += 1) {
    const focusIsInside = await dialog.evaluate((element) =>
      element.contains(document.activeElement),
    );
    expect(focusIsInside, `dialog focus containment after ${step} tabs`).toBe(
      true,
    );
    await page.keyboard.press("Tab");
  }

  await page.keyboard.press("Escape");
  await expect(dialog).toBeHidden();
  await expect(trigger).toBeFocused();
});

test("@mobile representative routes reflow at 320 CSS pixels with WCAG-sized controls", async ({
  page,
}) => {
  test.setTimeout(180_000);
  await page.setViewportSize({ width: 320, height: 568 });

  for (const route of REPRESENTATIVE_ROUTES) {
    await page.goto(route);
    await expect(page.locator(".app-shell")).toBeVisible({ timeout: 30_000 });
    await expectNoDocumentOverflow(page, route);
  }

  await page.goto("/dashboard");
  await expectMinimumTarget(
    page.getByRole("button", { name: "Open navigation" }),
    "mobile navigation trigger",
  );
  await expectMinimumTarget(
    page.getByRole("button", { name: "Open global search" }),
    "mobile search trigger",
  );
  await expectMinimumTarget(
    page.getByRole("button", { name: "Open display preferences" }),
    "mobile display-preferences trigger",
  );

  await page.goto("/jobs");
  await expectMinimumTarget(
    page.getByRole("button", { name: /Open job / }).first(),
    "mobile job detail action",
  );

  await page.goto("/evidence-map");
  const switcher = page.getByRole("group", { name: "Evidence map view" });
  await expectMinimumTarget(
    switcher.getByRole("button", { name: /Evidence \(/ }),
    "mobile evidence view switch",
  );
  await expectMinimumTarget(
    switcher.getByRole("button", { name: "Details" }),
    "mobile evidence detail switch",
  );

  await page.goto("/pipelines");
  const pipelineSwitcher = page.getByRole("group", {
    name: "Pipeline view",
  });
  await expectMinimumTarget(
    pipelineSwitcher.getByRole("button", { name: "Pipeline" }),
    "mobile pipeline switch",
  );
  await expectMinimumTarget(
    pipelineSwitcher.getByRole("button", { name: "Inspector" }),
    "mobile inspector switch",
  );
});
