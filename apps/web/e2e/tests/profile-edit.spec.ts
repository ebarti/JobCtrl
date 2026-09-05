import { readFile } from "node:fs/promises";

import { test, expect } from "@playwright/test";
import { checkA11y, injectAxe } from "axe-playwright";
import type { ProviderId } from "@jobctrl/contracts";
import { getDocument, OPS } from "pdfjs-dist/legacy/build/pdf.mjs";

import {
  sampleCredentialsResponse,
  sampleProviderModelsResponse,
  sampleProviderStatusResponse,
  sampleResumeTemplateListResponse,
  sampleSettingsResponse,
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

  const profileDataView = page.getByRole("button", { name: "Profile data" });
  const resumeEditorView = page.getByRole("button", { name: "Resume editor" });
  await expect(profileDataView).toHaveAttribute("aria-pressed", "true");
  await expect(page.getByText(/Full name/i).first()).toBeVisible({ timeout: 30_000 });
  await expect(page.getByText("Verified resume metrics", { exact: true })).toHaveCount(0);

  await page.getByRole("button", { name: /Experience entries/ }).click();
  await expect(
    page.getByText(
      "Keep each achievement and its numbers together. JobCtrl extracts metrics from the bullet and keeps them bound to that achievement when tailoring.",
      { exact: true },
    ),
  ).toBeVisible();

  await resumeEditorView.click();
  await expect(resumeEditorView).toHaveAttribute("aria-pressed", "true");
  await expect(page.getByText("Baseline resume editor", { exact: true })).toBeVisible({ timeout: 30_000 });
  await expect(page.getByText("Plate HTML/CSS editor", { exact: true })).toBeVisible({ timeout: 30_000 });
  await expect(page.getByRole("button", { name: "Bold" })).toBeVisible({ timeout: 30_000 });
  await expect.poll(() => previewRequests.some((url) => url.includes("/v1/profile/preview.html?v=0")), {
    timeout: 30_000,
  }).toBe(true);
  await expect(
    page.locator(".profile-resume-plate-editor .resume-page"),
  ).toBeVisible({ timeout: 30_000 });
  await expect(
    page.locator(".profile-resume-plate-editor .resume-name"),
  ).toBeVisible({ timeout: 30_000 });
  const templatePresentation = await page.locator(".profile-resume-plate-editor").evaluate(async (editor) => {
    await document.fonts.ready;
    const resumePage = editor.querySelector(".resume-page");
    const resumeName = editor.querySelector(".resume-name");
    if (!resumePage || !resumeName) {
      throw new Error("Editable baseline resume template is incomplete");
    }
    const pageStyle = getComputedStyle(resumePage);
    const nameStyle = getComputedStyle(resumeName);
    return {
      fontFamily: pageStyle.fontFamily,
      geistLoaded: document.fonts.check('16px "Geist Variable"'),
      nameFontSize: nameStyle.fontSize,
      nameTextAlign: nameStyle.textAlign,
      paddingTop: Number.parseFloat(pageStyle.paddingTop),
    };
  });
  expect(templatePresentation.fontFamily).toContain("Geist Variable");
  expect(templatePresentation.geistLoaded).toBe(true);
  expect(templatePresentation.nameFontSize).toBe("29.3333px");
  expect(templatePresentation.nameTextAlign).toBe("center");
  expect(templatePresentation.paddingTop).toBeGreaterThan(62);

  await profileDataView.click();
  await expect(profileDataView).toHaveAttribute("aria-pressed", "true");
  const fullNameLabel = page.getByText(/Full name/i).first();
  const fullNameInput = fullNameLabel.locator("xpath=following-sibling::input").first();
  await fullNameInput.click();
  await fullNameInput.fill("QA Candidate Updated");

  const saveButton = page.getByRole("button", { name: "Save changes" });
  await expect(saveButton).toBeEnabled({ timeout: 10_000 });
  await saveButton.click();

  await expect(saveButton).toHaveCount(0, { timeout: 30_000 });
  await expect(page.getByRole("status").filter({ hasText: "Profile saved" })).toBeVisible();

  await expect.poll(() => previewRequests.some((url) => url.includes("/v1/profile/preview.html?v=1")), {
    timeout: 30_000,
  }).toBe(true);
});

test("Plate deletion and digit edits update the boxed Profile draft and unsaved state", async ({
  page,
}) => {
  await page.goto("/profile");
  await page.getByRole("button", { name: "Resume editor" }).click();

  const plateEditor = page.getByRole("textbox", {
    name: "Baseline resume editor editor",
  });
  const plateBullet = plateEditor.locator(
    '[data-resume-layout-target="experience:qa_platform:bullet:1"]',
  );
  await expect(plateBullet).toHaveText(
    "Led platform reliability and security validation programs.",
    { timeout: 30_000 },
  );
  await plateEditor.focus();
  await plateBullet.evaluate((element) => {
    const selection = window.getSelection();
    const range = document.createRange();
    range.selectNodeContents(element);
    range.collapse(false);
    selection?.removeAllRanges();
    selection?.addRange(range);
  });
  await page.keyboard.press("Backspace");
  await page.keyboard.type(" 40");
  await page.keyboard.press("Backspace");
  await page.keyboard.type("5%.");
  await expect(plateBullet).toHaveText(
    "Led platform reliability and security validation programs 45%.",
  );
  await page.keyboard.press("Enter");
  await page.keyboard.type("Added from Plate.");
  const projectedBullets = plateEditor.locator(
    '[data-resume-layout-target="experience:qa_platform:bullet:1"]',
  );
  await expect(projectedBullets).toHaveCount(2);
  await expect(projectedBullets.nth(1)).toHaveText("Added from Plate.");

  await page.getByRole("button", { name: "Profile data" }).click();
  await page.getByRole("button", { name: /^Experience entries\b/i }).click();
  await expect(page.getByRole("textbox", { name: "Bullet 1", exact: true })).toHaveValue(
    "Led platform reliability and security validation programs 45%.",
  );
  await expect(page.getByRole("textbox", { name: "Bullet 2", exact: true })).toHaveValue(
    "Added from Plate.",
  );
  await expect(page.getByText("Unsaved changes", { exact: true })).toBeVisible();
});

test("Plate baseline editor downloads the current unsaved document as a PDF", async ({
  page,
}, testInfo) => {
  const letterTheme = {
    ...sampleResumeTemplateListResponse.effectiveDefaultVersion.theme,
    pageSize: "letter" as const,
    fontFamily: "times" as const,
    marginMm: { top: 25, right: 20, bottom: 25, left: 20 },
    headerLayout: "left" as const,
    accentColor: "#c00000",
  };
  await page.route("**/v1/resume-templates", async (route) => {
    await route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({
        ...sampleResumeTemplateListResponse,
        templates: sampleResumeTemplateListResponse.templates.map(
          (template) => ({
            ...template,
            activeVersion: {
              ...template.activeVersion,
              theme: letterTheme,
            },
          }),
        ),
        effectiveDefaultVersion: {
          ...sampleResumeTemplateListResponse.effectiveDefaultVersion,
          theme: letterTheme,
        },
      }),
    });
  });
  await page.goto("/profile");
  await page.getByRole("button", { name: "Resume editor" }).click();

  const plateEditor = page.getByRole("textbox", {
    name: "Baseline resume editor editor",
  });
  await expect(plateEditor).toBeVisible({ timeout: 30_000 });
  const renderedPage = plateEditor.locator(".resume-page");
  const mountedTheme = await renderedPage.evaluate((element) => {
    const style = getComputedStyle(element);
    const rect = element.getBoundingClientRect();
    return {
      color: style.color,
      fontFamily: style.fontFamily,
      height: rect.height,
      paddingTop: Number.parseFloat(style.paddingTop),
      width: rect.width,
    };
  });
  expect(mountedTheme.color).toBe("rgb(192, 0, 0)");
  expect(mountedTheme.fontFamily).toContain("Times New Roman");
  expect(mountedTheme.width).toBeCloseTo(816, 0);
  expect(mountedTheme.height).toBeCloseTo(1_056, 0);
  expect(mountedTheme.paddingTop).toBeCloseTo(94.49, 0);
  const firstResumeLine = plateEditor
    .locator("[data-resume-line-number]")
    .first();
  await firstResumeLine.click();
  await expect(firstResumeLine).toHaveClass(/jobctrl-selected-line/);
  await plateEditor.press("End");
  await plateEditor.type(" Live browser PDF export proof");
  await expect(plateEditor).toContainText("Live browser PDF export proof");

  const downloadPromise = page.waitForEvent("download");
  await page.getByRole("button", { name: "Export PDF" }).click();
  const download = await downloadPromise;

  expect(download.suggestedFilename()).toBe("baseline-resume.pdf");
  expect(await download.failure()).toBeNull();
  const pdfPath = testInfo.outputPath("baseline-resume.pdf");
  await download.saveAs(pdfPath);
  const pdf = await readFile(pdfPath);
  expect(pdf.subarray(0, 5).toString("ascii")).toBe("%PDF-");
  const pdfDocument = await getDocument({
    data: new Uint8Array(pdf),
    verbosity: 0,
  }).promise;
  try {
    expect(pdfDocument.numPages).toBe(1);
    const pdfPage = await pdfDocument.getPage(1);
    const viewport = pdfPage.getViewport({ scale: 1 });
    expect(viewport.width).toBeCloseTo(612, 0);
    expect(viewport.height).toBeCloseTo(792, 0);
    const operatorList = await pdfPage.getOperatorList();
    expect(operatorList.fnArray).toContain(OPS.paintImageXObject);
    const textContent = await pdfPage.getTextContent();
    const exportedText = textContent.items
      .map((item) => ("str" in item ? item.str : ""))
      .join(" ");
    expect(exportedText).toContain("Live browser PDF export proof");
  } finally {
    await pdfDocument.destroy();
  }
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
      copy: "Claude and Google values saved here stay on this Mac in Keychain.",
      display: "block",
      guidance: false,
      privacy: true,
    },
    {
      scenario: "unsupported_platform" as const,
      copy: "Non-secret provider settings remain editable in config.json.",
      display: "block",
      guidance: true,
      privacy: false,
    },
    {
      scenario: "inspection_failed" as const,
      copy: "JobCtrl could not safely inspect Keychain.",
      display: "block",
      guidance: false,
      privacy: false,
    },
  ]) {
    scenario = expected.scenario;
    await page.goto(`/settings/credentials?qa=${expected.scenario}`);

    if (expected.privacy) {
      await page
        .locator(".credential-privacy-disclosure .configuration-section__trigger")
        .click();
    }
    const notice = page
      .locator(expected.privacy ? ".privacy-box-copy" : ".credential-store-notice")
      .filter({ hasText: expected.copy })
      .first();
    await expect(notice).toBeVisible({ timeout: 30_000 });

    const geometry = await notice.evaluate((element) => {
      const noticeBox = element.getBoundingClientRect();
      const containerBox = element
        .closest(".credential-privacy-disclosure, .provider-setup-shell")
        ?.getBoundingClientRect();
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
        containerContained: Boolean(
          containerBox &&
            noticeBox.left >= containerBox.left - 1 &&
            noticeBox.right <= containerBox.right + 1,
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
    expect(geometry.containerContained).toBe(true);
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
      effectiveSource: configuredKeys.has(credential.key)
        ? ("keychain" as const)
        : ("absent" as const),
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
    const providerCard = page.locator(
      `article[data-provider="${provider.toLowerCase()}"]`,
    );
    await providerCard.locator(".configuration-section__trigger").click();
    await providerCard
      .getByRole("button", { name: `Remove ${provider} setup` })
      .click();
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
    await expect(
      providerCard.getByRole("button", { name: `Remove ${provider} setup` }),
    ).toHaveCount(0);
  }

  expect(submittedBatches).toEqual([
    removeClaudeProviderBatch(),
    removeGoogleProviderBatch(),
  ]);
});

test("Model Selection requires a ready provider and saves one provider preference", async ({
  page,
}) => {
  let settings = structuredClone(sampleSettingsResponse);
  const submittedSettings: unknown[] = [];
  await page.route("**/v1/providers/models", async (route) => {
    await route.fulfill({
      contentType: "application/json",
      body: JSON.stringify(sampleProviderModelsResponse),
    });
  });
  await page.route("**/v1/settings", async (route) => {
    if (route.request().method() === "PATCH") {
      const body = route.request().postDataJSON() as {
        preferredModels?: Record<string, string | null>;
      };
      submittedSettings.push(body);
      const nextPreferredModels: Partial<Record<ProviderId, string>> = {
        ...settings.settings.preferredModels,
      };
      for (const [provider, model] of Object.entries(body.preferredModels ?? {})) {
        const providerId = provider as ProviderId;
        if (model === null) delete nextPreferredModels[providerId];
        else nextPreferredModels[providerId] = model;
      }
      settings = {
        ...settings,
        settings: { ...settings.settings, preferredModels: nextPreferredModels },
      };
    }
    await route.fulfill({ contentType: "application/json", body: JSON.stringify(settings) });
  });

  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/settings/models");

  const google = page.locator('article[data-provider="google"]');
  await google.locator(".configuration-section__trigger").click();
  await google.getByRole("link", { name: "Configure Google" }).click();
  await expect(page).toHaveURL(/\/settings\/credentials$/);

  await page.goto("/settings/models");
  const claude = page.locator('article[data-provider="claude"]');
  await claude.locator(".configuration-section__trigger").click();
  await claude.getByRole("combobox", { name: "Preferred model" }).click();
  await page.getByRole("option", { name: /Opus 4\.8/ }).click();
  await claude.getByRole("button", { name: "Save model" }).click();

  await expect(claude.getByRole("status")).toContainText(
    "Claude preference saved for newly started work.",
  );
  expect(submittedSettings).toEqual([
    { preferredModels: { claude: "claude-opus-4-8" } },
  ]);
  expect(
    await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
  ).toBe(true);
});

test.describe("structured profile persistence", () => {
  test.skip(process.env["JOBCTRL_E2E_ISOLATED"] !== "1", "Requires the owned, no-subprocess API fixture");
  const apiOrigin = `http://127.0.0.1:${process.env["JOBCTRL_E2E_API_PORT"]}`;

  test.beforeEach(async ({ context, page, baseURL }) => {
    const allowed = new Set([new URL(baseURL!).origin, apiOrigin]);
    await context.route("**/*", (route) => allowed.has(new URL(route.request().url()).origin)
      ? route.continue() : route.abort("blockedbyclient"));
    for (const [endpoint, response] of [
      ["credentials", sampleCredentialsResponse],
      ["providers/status", sampleProviderStatusResponse],
      ["providers/models", sampleProviderModelsResponse],
    ] as const) await page.route(`**/v1/${endpoint}`, (route) => route.fulfill({ json: response }));
    const stored = await (await page.request.get(`${apiOrigin}/v1/profile`)).json();
    stored.profile.personal.full_name = "Structured Fixture Candidate";
    stored.profile.experience.target_locations = "";
    stored.profile.resume.experience_entries = [
      { id: "structured-first", company: "First Fixture", title: "Platform Lead", location: "", date_range: "Jan 2022 - Present", summary: "First fixture summary.", bullets: ["Built 10 synthetic systems.", "Second unique first-entry bullet."] },
      { id: "structured-second", company: "Second Fixture", title: "Engineer", location: "", date_range: "Jan 2020 - Dec 2021", summary: "Second fixture summary.", bullets: ["Second entry unique achievement."] },
    ];
    const seed = await page.request.patch(`${apiOrigin}/v1/profile`, {
      headers: { origin: new URL(baseURL!).origin, "sec-fetch-site": "same-origin" },
      data: {
        profileText: JSON.stringify(stored.profile), styleText: JSON.stringify(stored.style), templateText: stored.templateText,
      },
    });
    expect(seed.status()).toBe(200);
  });

  test("boxed and Plate edits retain their fields and order through real save and reload", async ({ page }) => {
    await page.goto("/profile");
    await page.getByLabel("Full name", { exact: true }).fill("Structured Saved Candidate");
    await page.getByRole("button", { name: "Resume editor", exact: true }).click();
    const editor = page.getByRole("textbox", { name: "Baseline resume editor editor" });
    const bullet = editor.locator('[data-resume-layout-target="experience:structured-first:bullet:1"]');
    await expect(bullet).toContainText("Built 10 synthetic systems.");
    // Click actual text rather than the full-width line container, then keep
    // keyboard input on that selection instead of refocusing the editor root.
    await bullet.locator('[data-slate-string="true"]').click();
    await expect(editor).toBeFocused();
    await expect.poll(() => bullet.evaluate((element) => {
      const selection = window.getSelection();
      return Boolean(selection && element.contains(selection.anchorNode) && element.contains(selection.focusNode));
    })).toBe(true);
    await page.keyboard.press("End");
    await page.keyboard.press("Backspace");
    await page.keyboard.type("; revised 12x.");
    await expect(bullet).toContainText("Built 10 synthetic systems; revised 12x.");
    await page.getByRole("button", { name: "Profile data", exact: true }).click();
    await expect(page.getByLabel("Full name", { exact: true })).toHaveValue("Structured Saved Candidate");
    await page.getByRole("button", { name: /^Experience entries/ }).click();
    await expect(page.getByLabel("Bullet 1", { exact: true }).first()).toHaveValue("Built 10 synthetic systems; revised 12x.");
    await page.getByRole("button", { name: "Move First Fixture - Platform Lead down" }).click();
    await page.getByRole("button", { name: "Save changes", exact: true }).click();
    await expect(page.getByText("Profile saved", { exact: true })).toBeVisible();
    await page.reload();
    await expect(page.getByLabel("Full name", { exact: true })).toHaveValue("Structured Saved Candidate");
    const stored = await (await page.request.get(`${apiOrigin}/v1/profile`)).json();
    expect(stored.profile.resume.experience_entries.map((entry: { id: string }) => entry.id)).toEqual(["structured-second", "structured-first"]);
    expect(stored.profile.resume.experience_entries[1].bullets).toEqual(["Built 10 synthetic systems; revised 12x.", "Second unique first-entry bullet."]);
    await page.getByRole("button", { name: "Resume editor", exact: true }).click();
    await expect(editor.locator('[data-resume-layout-target="experience:structured-first:bullet:1"]')).toContainText("Built 10 synthetic systems; revised 12x.");
    await expect(editor.locator("li").first()).toContainText("Second entry unique achievement.");
    await injectAxe(page);
    await checkA11y(page, ".profile-workspace", { includedImpacts: ["critical", "serious"] });
  });

  test("preferences keep intermediate numeric input and persist profile and style fields", async ({ page }) => {
    await page.goto("/preferences");
    const salary = page.getByLabel("Salary range min", { exact: true });
    await salary.fill("");
    await expect(salary).toHaveValue("");
    await salary.fill("165001");
    await page.getByRole("button", { name: /^Resume style/ }).click();
    const scale = page.getByLabel("Page scale", { exact: true });
    await scale.fill("");
    await expect(scale).toHaveValue("");
    await scale.fill("0.91");
    await page.getByRole("button", { name: "Save changes", exact: true }).click();
    await expect(page.getByText("Preferences saved", { exact: true })).toBeVisible();
    await page.reload();
    await expect(salary).toHaveValue("165001");
    await page.getByRole("button", { name: /^Resume style/ }).click();
    await expect(scale).toHaveValue("0.91");
    const stored = await (await page.request.get(`${apiOrigin}/v1/profile`)).json();
    expect(stored.profile.compensation.salary_range_min).toBe("165001");
    expect(stored.style.page_scale).toBe(0.91);
    await injectAxe(page);
    await checkA11y(page, ".profile-data-workspace", { includedImpacts: ["critical", "serious"] });
  });
});
