import { test, expect } from "@playwright/test";

import { sampleCredentialsResponse } from "../../src/test/fixtures/projections.js";

test("Profile edit + Plate baseline editor: edit a field, save, preview HTML refreshes with a new cache key", async ({
  page,
}) => {
  const previewRequests: string[] = [];
  page.on("request", (request) => {
    const url = request.url();
    if (url.includes("/v1/profile/preview.html")) {
      previewRequests.push(url);
    }
  });

  await page.goto("/profile");

  await expect(page.getByText(/Full name/i).first()).toBeVisible({ timeout: 30_000 });

  await expect(page.getByText("Baseline resume editor", { exact: true })).toBeVisible({ timeout: 30_000 });
  await expect(page.getByText("Plate HTML/CSS editor", { exact: true })).toBeVisible({ timeout: 30_000 });
  await expect(page.getByRole("button", { name: "Bold" })).toBeVisible({ timeout: 30_000 });
  await expect.poll(() => previewRequests.some((url) => url.includes("/v1/profile/preview.html?v=0")), {
    timeout: 30_000,
  }).toBe(true);

  const fullNameLabel = page.getByText(/Full name/i).first();
  const fullNameInput = fullNameLabel.locator("xpath=following-sibling::input").first();
  await fullNameInput.click();
  await fullNameInput.fill("QA Candidate Updated");

  const saveButton = page.getByRole("button", { name: /^save all$/i });
  await expect(saveButton).toBeEnabled({ timeout: 10_000 });
  await saveButton.click();

  await expect(saveButton).toBeDisabled({ timeout: 30_000 });

  await expect.poll(() => previewRequests.some((url) => url.includes("/v1/profile/preview.html?v=1")), {
    timeout: 30_000,
  }).toBe(true);
});

test("Credential notices keep a real, contained layout box at mobile width", async ({
  page,
}) => {
  type CredentialScenario = "available" | "inspection_failed" | "unsupported_platform";

  let scenario: CredentialScenario = "available";
  await page.route("**/v1/credentials", async (route) => {
    if (route.request().method() !== "GET") {
      await route.continue();
      return;
    }

    const available = scenario === "available";
    await route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({
        ...sampleCredentialsResponse,
        store: {
          ...sampleCredentialsResponse.store,
          available,
          unavailableReason: available ? null : scenario,
        },
        credentials: sampleCredentialsResponse.credentials.map((credential) => ({
          ...credential,
          configured: available ? credential.configured : null,
        })),
      }),
    });
  });

  await page.setViewportSize({ width: 390, height: 844 });

  for (const expected of [
    {
      scenario: "available" as const,
      copy: "Keychain changes are loaded by Python processes at startup.",
      display: "block",
      guidance: true,
    },
    {
      scenario: "unsupported_platform" as const,
      copy: "Keychain credential editing is available only on macOS.",
      display: "block",
      guidance: true,
    },
    {
      scenario: "inspection_failed" as const,
      copy: "JobCtrl could not safely inspect macOS Keychain.",
      display: "flex",
      guidance: false,
    },
  ]) {
    scenario = expected.scenario;
    await page.goto(`/settings/credentials?qa=${expected.scenario}`);

    const notice =
      expected.scenario === "inspection_failed"
        ? page.getByRole("alert", {
            name: "Keychain inspection unavailable",
          })
        : page.getByText(expected.copy, { exact: false }).first();
    await expect(notice).toBeVisible({ timeout: 30_000 });

    const geometry = await notice.evaluate((element) => {
      const noticeBox = element.getBoundingClientRect();
      const cardBox = element.closest(".card")?.getBoundingClientRect();
      const textRange = document.createRange();
      textRange.selectNodeContents(element);
      const textBoxes = [...textRange.getClientRects()];
      const probe = document.createElement("span");
      probe.style.color = "var(--foreground)";
      probe.style.background = "var(--status-info-muted)";
      document.body.append(probe);
      const probeStyle = getComputedStyle(probe);
      const expectedInfoColor = probeStyle.color;
      const expectedInfoBackground = probeStyle.backgroundColor;
      probe.remove();

      return {
        display: getComputedStyle(element).display,
        color: getComputedStyle(element).color,
        background: getComputedStyle(element).backgroundColor,
        expectedInfoColor,
        expectedInfoBackground,
        clientHeight: element.clientHeight,
        scrollHeight: element.scrollHeight,
        cardContained: Boolean(
          cardBox &&
            noticeBox.left >= cardBox.left - 1 &&
            noticeBox.right <= cardBox.right + 1,
        ),
        viewportContained:
          noticeBox.left >= -1 && noticeBox.right <= window.innerWidth + 1,
        textContained: textBoxes.every(
          (box) =>
            box.left >= noticeBox.left - 1 &&
            box.right <= noticeBox.right + 1 &&
            box.top >= noticeBox.top - 1 &&
            box.bottom <= noticeBox.bottom + 1,
        ),
        pageOverflows: document.documentElement.scrollWidth > window.innerWidth,
      };
    });

    expect(geometry.display).toBe(expected.display);
    expect(geometry.clientHeight).toBeGreaterThan(0);
    expect(geometry.scrollHeight).toBeLessThanOrEqual(geometry.clientHeight + 1);
    expect(geometry.cardContained).toBe(true);
    expect(geometry.viewportContained).toBe(true);
    expect(geometry.textContained).toBe(true);
    expect(geometry.pageOverflows).toBe(false);

    if (expected.guidance) {
      expect(geometry.color).toBe(geometry.expectedInfoColor);
      expect(geometry.background).toBe(geometry.expectedInfoBackground);
    }
  }
});
