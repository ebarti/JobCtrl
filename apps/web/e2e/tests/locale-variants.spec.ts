import { expect, test } from "@playwright/test";
import { checkA11y, injectAxe } from "axe-playwright";
import { QA_PLATFORM_JOB_ID } from "../fixtures/e2e-state.js";
import { localeStoryState } from "../../src/contexts/materials/components/MaterialLocaleVariants.stories.js";
import type { MaterialLocaleState } from "@jobctrl/contracts";

// Browser interaction seam only. The API owner separately exercises the real
// Python dispatcher, exact SQLite state and Playwright exports in synthetic workspaces.
for (const kind of ["resume", "cover_letter"] as const) {
  test(`Locale ${kind}: generate, independently review, export links and reload`, async ({
    page,
  }, testInfo) => {
    let state: MaterialLocaleState = {
      revision: 0,
      variants: [],
      failures: [],
    };
    await page.route(`**/v1/jobs/${QA_PLATFORM_JOB_ID}`, async (route) => {
      const response = await route.fetch();
      const detail = await response.json();
      await route.fulfill({
        response,
        json: { ...detail, localeVariants: state },
      });
    });
    await page.route(
      `**/v1/jobs/${QA_PLATFORM_JOB_ID}/locale-variants`,
      async (route) => {
        const mutation = route.request().postDataJSON();
        if (mutation.operation === "generate") {
          state = localeStoryState();
          state.variants[0]!.job_id = QA_PLATFORM_JOB_ID;
          state.variants[0]!.kind = kind;
          state.variants[0]!.artifact_type =
            kind === "resume" ? "tailored_resume" : "cover_letter";
        } else {
          const variant = state.variants[0]!;
          state.revision += 1;
          if (mutation.operation === "review") {
            if (mutation.review_kind === "terminology")
              variant.terminology_review = mutation.decision;
            else variant.formatting_review = mutation.decision;
            variant.revision += 1;
            if (
              variant.terminology_review === variant.formatting_review &&
              variant.formatting_review === "accepted"
            ) {
              variant.status = "accepted";
              variant.accepted_revision = variant.revision;
              variant.document_sha256 = "a".repeat(64);
            }
          } else {
            const id = `90000000-0000-4000-8000-${String(state.revision).padStart(12, "0")}`;
            variant.exports.push({
              export_id: id,
              format: mutation.export_format,
              path: `/owned/${id}`,
              sha256: "a".repeat(64),
              document_sha256: variant.document_sha256!,
              accepted_revision: variant.accepted_revision!,
              created_at: "2026-10-08T00:00:00Z",
            });
          }
        }
        await route.fulfill({ json: state });
      },
    );
    await page.goto(`/jobs/${QA_PLATFORM_JOB_ID}`);
    const panel = page.getByRole("region", {
      name: "Reviewed locale variants",
    });
    await expect(panel).toBeVisible();
    await panel.getByLabel("Material", { exact: true }).selectOption(kind);
    await panel.getByRole("textbox", { name: "Source locale" }).fill("en");
    await panel.getByRole("textbox", { name: "Target locale" }).fill("es");
    await panel
      .getByRole("button", { name: "Generate locale variant" })
      .click();
    await expect(panel.getByText(/Status: candidate/)).toBeVisible();
    await panel.getByRole("button", { name: "Accept terminology" }).click();
    await expect(panel.getByText(/Terminology review: accepted/)).toBeVisible();
    await expect(panel.getByText(/Status: candidate/)).toBeVisible();
    await panel.getByRole("button", { name: "Accept formatting" }).click();
    await expect(panel.getByText(/Status: accepted/)).toBeVisible();
    for (const format of ["TEXT", "HTML", "PDF", "DOCX"]) {
      await panel.getByRole("button", { name: `Export ${format}` }).click();
      await expect(
        panel.getByRole("link", {
          name: new RegExp(`^${format} · accepted revision`),
        }),
      ).toBeVisible();
    }
    await page.reload();
    await expect(panel.getByText(/Status: accepted/)).toBeVisible();
    await injectAxe(page);
    await checkA11y(page, "section[aria-labelledby]", {
      axeOptions: { runOnly: { type: "tag", values: ["wcag2a", "wcag2aa"] } },
      includedImpacts: ["critical", "serious"],
    });
    await page.screenshot({
      path: testInfo.outputPath(`locale-${kind}.png`),
      fullPage: true,
    });
  });
}

test("Locale generation failure preserves the editable draft and accepted preview", async ({
  page,
}) => {
  const state = localeStoryState("accepted");
  await page.route(`**/v1/jobs/${QA_PLATFORM_JOB_ID}`, async (route) => {
    const response = await route.fetch();
    await route.fulfill({
      response,
      json: { ...(await response.json()), localeVariants: state },
    });
  });
  await page.route(
    `**/v1/jobs/${QA_PLATFORM_JOB_ID}/locale-variants`,
    async (route) => {
      await route.fulfill({
        status: 503,
        json: {
          ok: false,
          error: "locale_operation_failed",
          message: "provider unavailable",
        },
      });
    },
  );
  await page.goto(`/jobs/${QA_PLATFORM_JOB_ID}`);
  const panel = page.getByRole("region", { name: "Reviewed locale variants" });
  await panel.getByRole("textbox", { name: "Source locale" }).fill("en");
  await panel.getByRole("textbox", { name: "Target locale" }).fill("fr");
  await panel.getByRole("button", { name: "Generate locale variant" }).click();
  await expect(panel.getByRole("alert")).toBeVisible();
  await expect(
    panel.getByRole("textbox", { name: "Target locale" }),
  ).toHaveValue("fr");
  await expect(panel.getByText(/Status: accepted/)).toBeVisible();
});
