import { expect, test } from "@playwright/test";

for (const colorScheme of ["light", "dark"] as const) {
  for (const width of [1440, 320]) {
    test(`demo entry remains readable and fail-closed: ${colorScheme}, ${width}px`, async ({
      page,
      context,
    }) => {
      await page.setViewportSize({ width, height: 900 });
      await page.emulateMedia({ colorScheme });
      // JobCtrl follows its saved preference, not the OS color scheme.
      await page.addInitScript((theme) => {
        localStorage.setItem(
          "jh:ui-preferences",
          JSON.stringify({
            state: { theme },
            version: 1,
          }),
        );
      }, colorScheme);
      const effects: string[] = [];
      page.on("request", (request) => {
        const url = new URL(request.url());
        if (
          url.pathname.startsWith("/v1") ||
          url.pathname === "/api/demo-health" ||
          url.pathname === "/api/demo-telemetry" ||
          url.hostname === "www.googletagmanager.com"
        )
          effects.push(url.pathname);
      });
      await context.route("**/api/demo-consent", async (route) => {
        if (route.request().method() === "GET") {
          await route.fulfill({ json: { choice: "unknown", version: "v2" } });
        } else {
          await route.fulfill({ status: 503, json: { error: "unavailable" } });
        }
      });
      await page.goto("/dashboard");
      await expect(page).toHaveTitle("JobCtrl");
      await expect(page.locator("html")).toHaveAttribute(
        "data-theme",
        colorScheme,
      );
      await expect(
        page.getByRole("heading", {
          name: "Explore JobCtrl with synthetic data",
        }),
      ).toBeVisible();
      await expect(
        page.getByText(
          "The live demo can only be used after accepting analytics cookies.",
        ),
      ).toBeVisible();
      await expect(
        page.getByRole("link", { name: "demo data notice" }),
      ).toBeVisible();
      await expect(
        page.getByRole("link", { name: "security boundary" }),
      ).toBeVisible();

      // Exercise keyboard entry and inspect the actual rendered focus ring.
      const accept = page.getByRole("button", {
        name: "Accept cookies and enter demo",
      });
      await page.getByRole("link", { name: "security boundary" }).focus();
      await page.keyboard.press("Tab");
      await expect(accept).toBeFocused();
      expect(
        await accept.evaluate((element) => {
          const css = getComputedStyle(element);
          return css.outlineStyle !== "none" || css.boxShadow !== "none";
        }),
      ).toBe(true);
      await page.keyboard.press("Enter");
      await expect(page.getByRole("alert")).toHaveText(
        "The consent service is unavailable. Please try again to enter the demo.",
      );
      await expect(accept).toBeEnabled();
      await expect(
        page.getByRole("button", { name: "Decline and return to jobctrl.dev" }),
      ).toBeEnabled();

      const layout = await page
        .locator(".demo-consent-card")
        .evaluate((card) => {
          const viewport = document.documentElement.clientWidth;
          const elements = [...card.querySelectorAll("h1, p, a, button")];
          return {
            overflow: document.documentElement.scrollWidth > viewport,
            clipped: elements
              .filter((element) => {
                const bounds = element.getBoundingClientRect();
                return (
                  bounds.left < -1 ||
                  bounds.right > viewport + 1 ||
                  (element.scrollWidth > element.clientWidth + 1 &&
                    element.tagName === "BUTTON")
                );
              })
              .map((element) => element.textContent),
            shadow: getComputedStyle(card).boxShadow,
            radius: getComputedStyle(card).borderRadius,
          };
        });
      expect(layout.overflow).toBe(false);
      expect(layout.clipped).toEqual([]);
      expect(layout.shadow).toBe("none");
      expect(layout.radius).toBe("0px");
      expect(
        await page.evaluate(async () =>
          (await indexedDB.databases()).map((db) => db.name),
        ),
      ).not.toContain("jobctrl-demo");
      expect(
        effects,
        "failed acceptance must not initialize the workspace or analytics",
      ).toEqual([]);
    });
  }
}

for (const [width, height] of [
  [1440, 640],
  [390, 640],
  [320, 640],
  [320, 400],
] as const) {
  test(`demo notifications leave the guide operable at ${width}x${height}px`, async ({
    page,
    context,
  }) => {
    await page.setViewportSize({ width, height });
    await context.route("**/api/demo-consent", (route) =>
      route.fulfill({
        json: { choice: "granted", version: "v2" },
      }),
    );
    await context.route("**/api/demo-health", (route) =>
      route.fulfill({ status: 204 }),
    );
    await context.route("**/api/demo-telemetry", (route) =>
      route.fulfill({ status: 204 }),
    );
    await context.route("https://www.googletagmanager.com/**", (route) =>
      route.fulfill({
        contentType: "application/javascript",
        body: "",
      }),
    );
    await page.goto("/dashboard");
    const openGuide = page.getByRole("button", { name: "Open demo guide" });
    await openGuide.click();
    const guide = page.getByRole("complementary", {
      name: "Try the synthetic workflow",
    });
    await page.getByRole("button", { name: "Hide demo guide" }).focus();
    const geometry = await guide.evaluate((element) => {
      const panel = element.getBoundingClientRect();
      return {
        overflow: element.scrollWidth > element.clientWidth,
        offset: element.scrollLeft,
        clipped: [...element.querySelectorAll("h2, p, a, button")]
          .filter((child) => {
            const bounds = child.getBoundingClientRect();
            return bounds.left < panel.left || bounds.right > panel.right;
          })
          .map((child) => child.textContent),
      };
    });
    expect(geometry).toEqual({ overflow: false, offset: 0, clipped: [] });
    await page
      .getByRole("link", { name: "Review synthetic tailored materials" })
      .click();
    // This capability is intentionally unavailable: retain the real error and
    // verify it doesn't block the demo's navigation or reset controls.
    const toast = page
      .locator('[data-slot="toast"]')
      .filter({ hasText: "learningRecommendations" });
    await expect(toast).toBeVisible();
    // Hold the real notifications open while checking stacked-toast geometry.
    await toast.first().hover();
    await openGuide.click();
    await expect(guide).toBeVisible();
    const viewport = page.locator('[data-slot="toast-viewport"]');
    const notifications = page.locator('[data-slot="toast"]');
    if (height === 400) {
      await expect(notifications).toHaveCount(2);
      await expect
        .poll(
          () => viewport.evaluate((element) =>
            element.scrollHeight > element.clientHeight,
          ),
          { message: "short notification regions must scroll instead of shrinking the text" },
        )
        .toBe(true);
    }
    for (const notification of await notifications.all()) {
      await notification.scrollIntoViewIfNeeded();
      await notification.hover();
      const description = notification.locator(
        '[data-slot="toast-description"]',
      );
      await expect
        .poll(
          () => description.evaluate((element) => {
            const text = element.getBoundingClientRect();
            const box = element.closest('[data-slot="toast"]')!
              .getBoundingClientRect();
            const region = element.closest('[data-slot="toast-viewport"]')!
              .getBoundingClientRect();
            return (
              text.top >= box.top && text.bottom <= box.bottom &&
              text.top >= region.top && text.bottom <= region.bottom
            );
          }),
          { message: "each complete notification must be readable after scrolling" },
        )
        .toBe(true);
    }
    const hideGuide = page.getByRole("button", { name: "Hide demo guide" });
    expect(
      await hideGuide.evaluate((element) => {
        const bounds = element.getBoundingClientRect();
        const hit = document.elementFromPoint(
          bounds.x + bounds.width / 2,
          bounds.y + bounds.height / 2,
        );
        return hit === element || element.contains(hit);
      }),
      "stacked notifications must not cover the guide close control",
    ).toBe(true);
    const overlap = await guide.evaluate((element) => {
      const guideBox = element.getBoundingClientRect();
      const viewport = document
        .querySelector('[data-slot="toast-viewport"]')!
        .getBoundingClientRect();
      return (
        viewport.bottom > guideBox.top &&
        viewport.right > guideBox.left &&
        viewport.left < guideBox.right
      );
    });
    expect(overlap).toBe(false);
    await page
      .getByRole("button", { name: "Reset synthetic demo data" })
      .click();
    await expect(
      page.getByRole("dialog", { name: "Reset synthetic demo data?" }),
    ).toBeVisible();
    await expect(
      page.getByRole("dialog", { name: "Reset synthetic demo data?" }),
    ).toHaveCSS("border-radius", "0px");
    const resetDialog = page.getByRole("dialog", {
      name: "Reset synthetic demo data?",
    });
    const closeReset = resetDialog.getByRole("button", {
      name: "Close", exact: true,
    });
    // Actionability waits for the popup animation to settle before hit-testing.
    await closeReset.click({ trial: true });
    expect(
      await resetDialog.getByRole("heading").evaluate((element) => {
        const bounds = element.getBoundingClientRect();
        const hit = document.elementFromPoint(
          bounds.x + bounds.width / 2,
          bounds.y + bounds.height / 2,
        );
        return hit === element || element.contains(hit);
      }),
      "live notifications must not obscure the reset dialog title",
    ).toBe(true);
    await closeReset.click();
    await expect(resetDialog).toHaveCount(0);
    await page.getByRole("button", { name: "Reset synthetic demo data" }).click();
    await page.getByRole("button", { name: "Cancel", exact: true }).click();
    await expect(page.getByRole("dialog")).toHaveCount(0);
    // When the final notification closes, the guide expands upward. Its close
    // control must remain above the notice, which is in normal document flow.
    for (const notification of await notifications.all()) {
      await notification.scrollIntoViewIfNeeded();
      await notification.getByRole("button", { name: "Close", exact: true }).click();
    }
    await expect(notifications).toHaveCount(0);
    await hideGuide.click();
    await expect(guide).toHaveCount(0);
    await expect(openGuide).toBeFocused();
  });
}

for (const width of [1440, 1024, 390]) {
  test(`job inspector preserves material labels and stage status at ${width}px`, async ({
    page,
    context,
  }) => {
    await page.setViewportSize({ width, height: 1000 });
    await context.route("**/api/demo-consent", (route) =>
      route.fulfill({
        json: { choice: "granted", version: "v2" },
      }),
    );
    await context.route("**/api/demo-health", (route) =>
      route.fulfill({ status: 204 }),
    );
    await context.route("**/api/demo-telemetry", (route) =>
      route.fulfill({ status: 204 }),
    );
    await context.route("https://www.googletagmanager.com/**", (route) =>
      route.fulfill({
        contentType: "application/javascript",
        body: "",
      }),
    );
    await page.goto("/jobs/6e2f4a10-20be-4d5f-98a4-a4bb9a877a35");
    await expect(
      page.getByRole("heading", { name: "Platform systems lead", exact: true }),
    ).toBeVisible();
    const diagnostics = page.getByRole("button", {
      name: "Progress and history",
      exact: true,
    });
    if (await diagnostics.isVisible()) await diagnostics.click();
    const inspector = page.locator(".job-detail-workspace__inspector");
    await expect(inspector.getByText("running", { exact: true })).toBeVisible();
    const rows = inspector.locator(".job-artifact-row");
    await expect(rows).toHaveCount(2);
    await expect(
      rows.first().getByText("resume_pdf", { exact: true }),
    ).toBeVisible();
    await expect(
      rows.first().getByRole("button", { name: "Preview in browser" }),
    ).toBeVisible();
    await rows.first().getByText("Technical details", { exact: true }).click();
    await expect(rows.first().locator("code")).toBeVisible();
    const geometry = await inspector.evaluate((element) => {
      const panel = element.getBoundingClientRect();
      const labels = [
        ...element.querySelectorAll<HTMLElement>(
          ".job-artifact-row > :nth-child(2)",
        ),
      ];
      const content = [
        ...element.querySelectorAll(
          ".stage-timeline__header, .job-artifact-row",
        ),
      ];
      return {
        overflow: element.scrollWidth > element.clientWidth,
        clipped: content.some((child) => {
          const box = child.getBoundingClientRect();
          return box.left < panel.left || box.right > panel.right;
        }),
        // Short artifact types should take at most two text lines, never a
        // column of individual characters beside the preview action.
        readable: labels.every(
          (label) =>
            label.getBoundingClientRect().height <=
            parseFloat(getComputedStyle(label).lineHeight) * 2 + 1,
        ),
      };
    });
    expect(geometry).toEqual({
      overflow: false,
      clipped: false,
      readable: true,
    });
  });
}

test("mobile score markers remain square and preserve longer numbers", async ({
  page,
  context,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await context.route("**/api/demo-consent", (route) =>
    route.fulfill({ json: { choice: "granted", version: "v2" } }),
  );
  await context.route("**/api/demo-health", (route) =>
    route.fulfill({ status: 204 }),
  );
  await context.route("**/api/demo-telemetry", (route) =>
    route.fulfill({ status: 204 }),
  );
  await context.route("https://www.googletagmanager.com/**", (route) =>
    route.fulfill({ contentType: "application/javascript", body: "" }),
  );
  await page.goto("/jobs");
  const marker = page.locator(".fit:visible").first();
  await expect(marker).toBeVisible();
  // This is a geometry probe on the rendered shared primitive; persistence and
  // unknown-score meaning are exercised by the independent synthetic QA lane.
  for (const label of ["8", "-", "7.125"]) {
    await marker.evaluate((element, value) => {
      element.textContent = value;
    }, label);
    const shape = await marker.evaluate((element) => {
      const bounds = element.getBoundingClientRect();
      return {
        width: bounds.width,
        height: bounds.height,
        overflow: element.scrollWidth > element.clientWidth,
        radius: getComputedStyle(element).borderRadius,
      };
    });
    expect(Math.abs(shape.width - shape.height)).toBeLessThanOrEqual(1);
    expect(shape.overflow).toBe(false);
    expect(shape.radius).toBe("0px");
  }
});
