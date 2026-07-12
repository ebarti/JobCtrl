import { test, expect } from "@playwright/test";

import {
  sampleCredentialsResponse,
  sampleProviderStatusResponse,
} from "../../src/test/fixtures/projections.js";
import {
  removeClaudeProviderBatch,
  removeGoogleProviderBatch,
} from "../../src/contexts/profile/lib/provider-credential-plans.js";

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
  await page.route("**/v1/providers/status", async (route) => {
    await route.fulfill({
      contentType: "application/json",
      body: JSON.stringify(sampleProviderStatusResponse),
    });
  });

  await page.setViewportSize({ width: 390, height: 844 });

  for (const expected of [
    {
      scenario: "available" as const,
      copy: "Provider settings saved here stay in macOS Keychain.",
      display: "block",
      guidance: true,
    },
    {
      scenario: "unsupported_platform" as const,
      copy: "Guided secret storage is available only with macOS Keychain.",
      display: "block",
      guidance: true,
    },
    {
      scenario: "inspection_failed" as const,
      copy: "JobCtrl could not safely inspect Keychain.",
      display: "block",
      guidance: false,
    },
  ]) {
    scenario = expected.scenario;
    await page.goto(`/settings/credentials?qa=${expected.scenario}`);

    const notice = page
      .locator(".credential-store-notice")
      .filter({ hasText: expected.copy })
      .first();
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

test("Guided Claude and Google setup can be removed through confirmed provider batches", async ({
  page,
}) => {
  const configuredKeys = new Set([
    "ANTHROPIC_API_KEY",
    "CLAUDE_CODE_USE_VERTEX",
    "GEMINI_API_KEY",
    "GOOGLE_GENAI_USE_VERTEXAI",
  ]);
  const submittedBatches: unknown[] = [];
  const credentialsResponse = () => ({
    ...sampleCredentialsResponse,
    credentials: sampleCredentialsResponse.credentials.map((credential) => ({
      ...credential,
      configured: configuredKeys.has(credential.key),
    })),
  });

  await page.route(/\/v1\/credentials(?:\/batch)?(?:\?.*)?$/, async (route) => {
    if (route.request().method() === "PATCH") {
      const body = route.request().postDataJSON() as {
        operations: Array<{ operation: "delete" | "set"; key: string }>;
      };
      submittedBatches.push(body);
      for (const operation of body.operations) {
        if (operation.operation === "delete") configuredKeys.delete(operation.key);
      }
    }
    await route.fulfill({
      contentType: "application/json",
      body: JSON.stringify(credentialsResponse()),
    });
  });
  await page.route("**/v1/providers/status", async (route) => {
    await route.fulfill({
      contentType: "application/json",
      body: JSON.stringify(sampleProviderStatusResponse),
    });
  });

  await page.goto("/settings/credentials");

  for (const provider of ["Claude", "Google"] as const) {
    await page.getByRole("button", { name: `Remove ${provider} setup` }).click();
    const dialog = page.getByRole("dialog", {
      name: `Remove ${provider} provider setup?`,
    });
    await expect(dialog).toContainText("External vendor CLI and cloud credentials are unchanged.");
    await dialog.getByRole("button", { name: `Remove ${provider} setup` }).click();
    await expect(
      page.getByText(
        new RegExp(`${provider} provider settings removed\\. Restart JobCtrl`, "i"),
      ),
    ).toBeVisible();
    await expect(page.getByRole("button", { name: `Remove ${provider} setup` })).toHaveCount(0);
  }

  expect(submittedBatches).toEqual([
    removeClaudeProviderBatch(),
    removeGoogleProviderBatch(),
  ]);
});
