import { expect, type Locator, test } from "@playwright/test";
import { getViolations, injectAxe } from "axe-playwright";

async function columnCount(grid: Locator): Promise<number> {
  return grid
    .locator(".adaptive-field-grid__fields")
    .evaluate(
      (element) =>
        getComputedStyle(element)
          .gridTemplateColumns.split(/\s+/)
          .filter(Boolean).length,
    );
}

test("preferences property grids reflow against their container and explain locked choices", async ({
  page,
}) => {
  const consoleErrors: string[] = [];
  page.on("console", (message) => {
    if (message.type() === "error") consoleErrors.push(message.text());
  });

  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.goto("/preferences");
  await expect(
    page.getByRole("heading", { name: "Preferences", level: 1 }),
  ).toBeVisible({
    timeout: 30_000,
  });

  const applicationGrid = page
    .getByLabel("Salary currency")
    .locator('xpath=ancestor::*[@data-slot="adaptive-field-grid"][1]');
  await expect(applicationGrid).toBeVisible();
  await expect.poll(() => columnCount(applicationGrid)).toBe(4);

  await page.setViewportSize({ width: 900, height: 1000 });
  await expect.poll(() => columnCount(applicationGrid)).toBe(2);

  await page.setViewportSize({ width: 390, height: 844 });
  await expect.poll(() => columnCount(applicationGrid)).toBe(1);
  expect(
    await page.evaluate(() => document.documentElement.scrollWidth),
  ).toBeLessThanOrEqual(
    await page.evaluate(() => document.documentElement.clientWidth + 1),
  );

  const changeTitles = page.getByRole("checkbox", {
    name: "Change experience titles",
  });
  await expect(changeTitles).toBeDisabled();
  await expect(changeTitles).toHaveAccessibleDescription(
    "Experience titles remain fixed to profile evidence during tailoring.",
  );

  for (const name of ["Impact", "Technical depth", "Leadership"]) {
    const standard = page.getByRole("checkbox", { name });
    await expect(standard).toBeDisabled();
    await expect(standard).toBeChecked();
    await expect(standard).toHaveAccessibleDescription(
      "Required for evidence-quality resumes and cannot be disabled.",
    );
  }

  await injectAxe(page);
  const seriousViolations = (
    await getViolations(page, ".preferences-disclosure--tailoring")
  ).filter((violation) =>
    ["critical", "serious"].includes(violation.impact ?? ""),
  );

  expect(seriousViolations).toEqual([]);
  expect(consoleErrors).toEqual([]);
});
