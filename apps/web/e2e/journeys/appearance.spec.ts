import { test, expect, json } from "../harness/fixtures.js";
import {
  acceptBaseline,
  createBaseline,
  createPosting,
  type Profile,
} from "./core-data.js";

const colors = [
  ["graphite", "Graphite · default"],
  ["cobalt", "Cobalt"],
  ["teal", "Teal"],
  ["forest", "Forest"],
  ["indigo", "Indigo"],
  ["plum", "Plum"],
  ["rose", "Rose"],
  ["terracotta", "Terracotta"],
  ["amber", "Amber"],
  ["ocean", "Ocean"],
] as const;
const fonts = [
  ["geist", "Geist · default"],
  ["inter", "Inter"],
  ["manrope", "Manrope"],
  ["dm", "DM Sans"],
  ["plex", "IBM Plex Sans"],
  ["source", "Source Sans 3"],
  ["work", "Work Sans"],
  ["lato", "Lato"],
  ["literary", "Merriweather + Inter"],
  ["editorial", "Newsreader + DM Sans"],
] as const;

test("all ten appearance palettes and font schemes persist while the actual Plate document keeps its template geometry", async ({
  page,
  api,
  app,
}, testInfo) => {
  const { profile } = await createBaseline(api);
  const posting = await createPosting(api, "appearance-template-authority");
  const accepted = await acceptBaseline(
    api,
    posting.job_id,
    profile.profileVersion,
  );
  const acceptedPdfPath = `/v1/resumes/${accepted.resume_id}/export?format=pdf&accepted=true`;
  const originalPdf = await api.get(acceptedPdfPath);
  expect(originalPdf.status()).toBe(200);
  const originalPdfBytes = await originalPdf.body();
  const pdf = await app.inspectPdf(originalPdfBytes);
  expect(pdf.text).toContain(profile.profile.personal.full_name);
  const modelCalls = app.external.calls.filter(
    (call) => call.path === "/model",
  ).length;
  await page.setViewportSize({ width: 1440, height: 1000 });

  const documentGeometry = async () => {
    await page.goto("/profile?section=resume");
    const document = page.getByRole("textbox", {
      name: "Baseline resume editor editor",
      exact: true,
    });
    await expect(document).toContainText(profile.profile.personal.full_name);
    // Font loading can outlive a Plate remount. Wait without retaining a DOM
    // handle, then resolve and measure the current editor in one browser task.
    await page.evaluate(async () => {
      await window.document.fonts.ready;
    });
    await expect(document).toBeVisible();
    return document.evaluateAll((elements) => {
      const element = elements[0];
      if (elements.length !== 1 || !element?.isConnected)
        throw new Error("Expected one connected baseline resume editor.");
      const style = getComputedStyle(element);
      const box = element.getBoundingClientRect();
      if (box.width <= 0 || box.height <= 0)
        throw new Error("The current baseline resume editor has no layout.");
      return {
        width: box.width,
        height: box.height,
        scrollWidth: element.scrollWidth,
        scrollHeight: element.scrollHeight,
        fontFamily: style.fontFamily,
        fontSize: style.fontSize,
        lineHeight: style.lineHeight,
        padding: style.padding,
        letterSpacing: style.letterSpacing,
        text: element.textContent,
      };
    });
  };
  const originalDocument = await documentGeometry();

  await page.goto("/settings/appearance");
  await expect(
    page.getByRole("heading", { name: "Make it yours", exact: true }),
  ).toBeVisible();
  const select = async (label: string, option: string, count?: number) => {
    await page.getByRole("combobox", { name: label, exact: true }).click();
    if (count !== undefined)
      await expect(page.getByRole("option")).toHaveCount(count);
    await page.getByRole("option", { name: option, exact: true }).click();
  };
  const accents = new Set<string>();
  for (const [id, label] of colors) {
    await select("Color scheme", label, 10);
    await expect(page.locator("html")).toHaveAttribute("data-color-scheme", id);
    accents.add(
      await page
        .getByLabel("Selected accent color", { exact: true })
        .evaluate((element) => getComputedStyle(element).backgroundColor),
    );
    await page.reload();
    await expect(
      page
        .getByRole("combobox", { name: "Color scheme", exact: true })
        .locator('[data-slot="select-value"]'),
    ).toHaveText(label);
    await expect(page.locator("html")).toHaveAttribute("data-color-scheme", id);
  }
  expect(
    accents.size,
    "Each palette must apply a distinct rendered accent",
  ).toBe(10);

  const workspaceTypography = new Set<string>();
  for (const [id, label] of fonts) {
    await select("Font scheme", label, 10);
    await expect(page.locator("html")).toHaveAttribute("data-font-scheme", id);
    await page.reload();
    await expect(
      page
        .getByRole("combobox", { name: "Font scheme", exact: true })
        .locator('[data-slot="select-value"]'),
    ).toHaveText(label);
    await expect(page.locator("html")).toHaveAttribute("data-font-scheme", id);
    workspaceTypography.add(
      await page
        .getByRole("heading", { name: "A little more you.", exact: true })
        .evaluate(async (element) => {
          await document.fonts.ready;
          return `${getComputedStyle(document.body).fontFamily}|${getComputedStyle(element).fontFamily}`;
        }),
    );
    expect(
      await documentGeometry(),
      `${label} must preserve the saved resume template`,
    ).toEqual(originalDocument);
    await page.goto("/settings/appearance");
  }
  expect(
    workspaceTypography.size,
    "The ten named schemes must apply ten distinct workspace font combinations",
  ).toBe(10);

  await select("Mode", "Dark");
  await select("Density", "Compact");
  await page.reload();
  await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
  await expect(
    page
      .getByRole("combobox", { name: "Density", exact: true })
      .locator('[data-slot="select-value"]'),
  ).toHaveText("Compact");
  await testInfo.attach("appearance-dark-editorial", {
    contentType: "image/png",
    body: await page.screenshot(),
  });
  await page
    .getByRole("button", { name: "Restore Graphite & Geist", exact: true })
    .click();
  await page.reload();
  await expect(
    page
      .getByRole("combobox", { name: "Color scheme", exact: true })
      .locator('[data-slot="select-value"]'),
  ).toHaveText("Graphite · default");
  await expect(
    page
      .getByRole("combobox", { name: "Font scheme", exact: true })
      .locator('[data-slot="select-value"]'),
  ).toHaveText("Geist · default");
  await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
  await expect(
    page
      .getByRole("combobox", { name: "Density", exact: true })
      .locator('[data-slot="select-value"]'),
  ).toHaveText("Compact");
  expect(await json<Profile>(api, "get", "/v1/profile")).toEqual(profile);
  const preservedPdf = await api.get(acceptedPdfPath);
  expect(preservedPdf.status()).toBe(200);
  expect(
    await preservedPdf.body(),
    "Browser appearance cannot alter an accepted document's exact bytes",
  ).toEqual(originalPdfBytes);
  await testInfo.attach("appearance-template-authority.pdf", {
    contentType: "application/pdf",
    body: originalPdfBytes,
  });
  await testInfo.attach("appearance-template-first-page", {
    contentType: "image/png",
    body: pdf.images[0]!,
  });
  expect(
    app.external.calls.filter((call) => call.path === "/model"),
  ).toHaveLength(modelCalls);
});
