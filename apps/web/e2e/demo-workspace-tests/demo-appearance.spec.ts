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

for (const width of [1440, 390, 320]) {
  test(`demo notifications leave the guide operable at ${width}px`, async ({
    page,
    context,
  }) => {
    await page.setViewportSize({ width, height: 640 });
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
    await openGuide.click();
    await expect(
      page.getByRole("complementary", { name: "Try the synthetic workflow" }),
    ).toBeVisible();
    await page
      .getByRole("button", { name: "Reset synthetic demo data" })
      .click();
    await expect(
      page.getByRole("dialog", { name: "Reset synthetic demo data?" }),
    ).toBeVisible();
    await page.getByRole("button", { name: "Cancel", exact: true }).click();
    await expect(page.getByRole("dialog")).toHaveCount(0);
  });
}
