import { expect, type Page, test } from "@playwright/test";

const browserCapabilitiesResponse = {
  ok: true,
  detectedBrowsers: [
    {
      id: "google-chrome",
      label: "Google Chrome",
      defaultProfileAvailable: true,
      profiles: [
        {
          id: "profile-0123456789abcdef0123456789abcdef",
          label: "Signed in",
        },
      ],
    },
    {
      id: "chromium",
      label: "Chromium",
      defaultProfileAvailable: false,
      profiles: [],
    },
  ],
  capabilities: [
    {
      id: "core-browser",
      status: "ready",
      detail: "Managed browser ready.",
      mutable: false,
      enabled: true,
      profileCopyReady: false,
    },
    {
      id: "auto-apply-browser",
      status: "disabled",
      detail: "Disabled until you explicitly enable a detected browser.",
      mutable: true,
      enabled: false,
      profileCopyReady: false,
    },
    {
      id: "authenticated-linkedin-browser",
      status: "disabled",
      detail: "Disabled until you explicitly enable a detected browser.",
      mutable: true,
      enabled: false,
      profileCopyReady: false,
    },
  ],
} as const;

async function installSyntheticBrowserCapabilities(page: Page): Promise<void> {
  await page.route("**/v1/browser-capabilities", async (route) => {
    await route.fulfill({
      contentType: "application/json",
      body: JSON.stringify(browserCapabilitiesResponse),
    });
  });
}

test.beforeEach(async ({ page }) => {
  await installSyntheticBrowserCapabilities(page);
});

test("browser capability content keeps owned insets and a compact desktop action", async ({
  page,
}) => {
  await page.goto("/settings/browser");

  const card = page.locator("[data-browser-capabilities]");
  const content = card.locator('[data-slot="card-content"]');
  const actionRow = card.locator(
    '[data-browser-detected-actions="auto-apply-browser"]',
  );
  const select = card.getByLabel("Detected browser for Auto-apply browser");
  const enable = card
    .getByRole("button", { name: "Enable Google Chrome" })
    .first();

  await expect(
    page.getByRole("heading", { name: "Browser capabilities", exact: true }),
  ).toBeVisible({ timeout: 30_000 });
  await expect(select).toBeVisible();
  await expect(enable).toBeVisible();

  const geometry = await actionRow.evaluate((row) => {
    const card = row.closest<HTMLElement>("[data-browser-capabilities]");
    const content = card?.querySelector<HTMLElement>(
      '[data-slot="card-content"]',
    );
    const select = row.querySelector<HTMLElement>(
      '[aria-label="Detected browser for Auto-apply browser"]',
    );
    const enable = [...row.querySelectorAll<HTMLButtonElement>("button")].find(
      (button) => button.textContent?.trim() === "Enable Google Chrome",
    );
    if (!card || !content || !select || !enable) {
      throw new Error("Expected the browser capability card action controls.");
    }

    const cardRect = card.getBoundingClientRect();
    const contentStyle = getComputedStyle(content);
    const selectRect = select.getBoundingClientRect();
    const enableRect = enable.getBoundingClientRect();
    return {
      cardWidth: cardRect.width,
      contentInsetLeft: Number.parseFloat(contentStyle.paddingLeft),
      contentInsetRight: Number.parseFloat(contentStyle.paddingRight),
      enableBottom: enableRect.bottom,
      enableWidth: enableRect.width,
      selectBottom: selectRect.bottom,
    };
  });

  expect(geometry.contentInsetLeft).toBeGreaterThanOrEqual(16);
  expect(geometry.contentInsetRight).toBeGreaterThanOrEqual(16);
  expect(geometry.enableWidth).toBeLessThan(geometry.cardWidth * 0.5);
  expect(geometry.enableWidth).toBeLessThanOrEqual(320);
  expect(geometry.enableWidth).toBeGreaterThan(100);
  expect(
    Math.abs(geometry.enableBottom - geometry.selectBottom),
  ).toBeLessThanOrEqual(2);
  await expect(content).toBeVisible();
});

test("browser capability actions stack without overflow on mobile", async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/settings/browser");

  const card = page.locator("[data-browser-capabilities]");
  const actionRow = card.locator(
    '[data-browser-detected-actions="auto-apply-browser"]',
  );

  await expect(
    page.getByRole("heading", { name: "Browser capabilities", exact: true }),
  ).toBeVisible({ timeout: 30_000 });

  const geometry = await actionRow.evaluate((row) => {
    const card = row.closest<HTMLElement>("[data-browser-capabilities]");
    const content = card?.querySelector<HTMLElement>(
      '[data-slot="card-content"]',
    );
    const select = row.querySelector<HTMLElement>(
      '[aria-label="Detected browser for Auto-apply browser"]',
    );
    const enable = [...row.querySelectorAll<HTMLButtonElement>("button")].find(
      (button) => button.textContent?.trim() === "Enable Google Chrome",
    );
    if (!card || !content || !select || !enable) {
      throw new Error("Expected the mobile browser capability controls.");
    }

    const contentRect = content.getBoundingClientRect();
    const selectRect = select.getBoundingClientRect();
    const enableRect = enable.getBoundingClientRect();
    return {
      buttonContained:
        enableRect.left >= contentRect.left - 1 &&
        enableRect.right <= contentRect.right + 1,
      buttonWidth: enableRect.width,
      contentWidth: contentRect.width,
      pageScrollWidth: document.documentElement.scrollWidth,
      selectBottom: selectRect.bottom,
      buttonTop: enableRect.top,
      viewportWidth: document.documentElement.clientWidth,
    };
  });

  expect(geometry.buttonTop).toBeGreaterThanOrEqual(geometry.selectBottom + 8);
  expect(geometry.buttonContained).toBe(true);
  expect(geometry.buttonWidth).toBeLessThan(geometry.contentWidth);
  expect(geometry.pageScrollWidth).toBeLessThanOrEqual(
    geometry.viewportWidth + 1,
  );
});
