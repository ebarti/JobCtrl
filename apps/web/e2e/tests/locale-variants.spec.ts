import { expect, test } from "@playwright/test";
import { checkA11y, injectAxe } from "axe-playwright";
import { QA_PLATFORM_JOB_ID } from "../fixtures/e2e-state.js";
import { makeLocaleVariant } from "../../src/contexts/materials/components/MaterialLocaleVariants.stories.js";

// Browser interactions use explicit structural boundary states. Real HTTP→Python
// generation, persistence and exports are covered by locale-variants.test.ts.
test("locale generation, independent review, history and downloads", async ({
  page,
}) => {
  let revision = 0;
  let variants: ReturnType<typeof makeLocaleVariant>[] = [];
  const history = () => ({
    ok: true,
    revision,
    locales: ["en", "es", "fr", "de", "it", "pt", "ca"],
    sources: [
      { artifactId: "synthetic-source", generation: 1, kind: "resume" },
    ],
    variants,
  });
  await page.route("**/v1/jobs/*/locale-variants**", async (route) => {
    const url = new URL(route.request().url());
    if (url.pathname.endsWith("/download"))
      return route.fulfill({
        status: 200,
        headers: {
          "content-disposition": 'attachment; filename="locale-variant.txt"',
        },
        body: "Synthetic historical title",
      });
    if (route.request().method() === "POST") {
      const body = route.request().postDataJSON();
      expect(body.expectedRevision).toBe(revision);
      if (url.pathname.endsWith("/review")) {
        expect(body).toMatchObject({
          terminology: "confirmed",
          formatting: "confirmed",
          decision: "accepted",
        });
        variants = [makeLocaleVariant("accepted")];
      } else {
        expect(body).toMatchObject({
          artifactId: "synthetic-source",
          sourceLocale: "en",
          targetLocale: "es",
        });
        variants = [makeLocaleVariant()];
      }
      revision++;
    }
    await route.fulfill({ json: history() });
  });
  await page.goto(`/jobs/${QA_PLATFORM_JOB_ID}`);
  const section = page.getByRole("region", {
    name: "Reviewed locale variants",
    exact: true,
  });
  await section.getByRole("combobox", { name: "Accepted source" }).click();
  await page.getByRole("option", { name: "resume · generation 1" }).click();
  await section
    .getByRole("button", { name: "Generate locale variant" })
    .click();
  await expect(section.getByRole("table")).toBeVisible();
  const accept = section.getByRole("button", { name: "Accept translation" });
  await expect(accept).toBeDisabled();
  await section
    .getByLabel("I reviewed terminology and original credential designations")
    .check();
  await expect(accept).toBeDisabled();
  await section.getByLabel("I reviewed formatting separately").check();
  await accept.click();
  await expect(
    section.getByRole("link", { name: "Download PDF" }),
  ).toBeVisible();
  const download = page.waitForEvent("download");
  await section.getByRole("link", { name: "Download TEXT" }).click();
  expect((await download).suggestedFilename()).toBe("locale-variant.txt");
  await page.reload();
  await expect(
    section.getByRole("link", { name: "Download DOCX" }),
  ).toBeVisible();
  await injectAxe(page);
  await checkA11y(page, 'section[aria-label="Reviewed locale variants"]', {
    includedImpacts: ["critical", "serious"],
  });
});

test("failed refresh keeps the accepted locale history visible", async ({
  page,
}) => {
  const variant = makeLocaleVariant("accepted");
  await page.route("**/v1/jobs/*/locale-variants", (route) =>
    route.request().method() === "POST"
      ? route.fulfill({
          status: 409,
          json: {
            ok: false,
            error: "locale_variant_failed",
            message: "provider_unavailable",
          },
        })
      : route.fulfill({
          json: {
            ok: true,
            revision: 2,
            locales: ["en", "es", "fr"],
            sources: [
              { artifactId: "synthetic-source", generation: 1, kind: "resume" },
            ],
            variants: [variant],
          },
        }),
  );
  await page.goto(`/jobs/${QA_PLATFORM_JOB_ID}`);
  const section = page.getByRole("region", {
    name: "Reviewed locale variants",
    exact: true,
  });
  await section.getByRole("combobox", { name: "Accepted source" }).click();
  await page.getByRole("option", { name: "resume · generation 1" }).click();
  await section.getByRole("combobox", { name: "Target locale" }).click();
  await page.getByRole("option", { name: "fr", exact: true }).click();
  await section
    .getByRole("button", { name: "Generate locale variant" })
    .click();
  await expect(section.getByRole("alert")).toContainText(
    "provider_unavailable",
  );
  await expect(
    section.getByRole("link", { name: "Download PDF" }),
  ).toBeVisible();
});
