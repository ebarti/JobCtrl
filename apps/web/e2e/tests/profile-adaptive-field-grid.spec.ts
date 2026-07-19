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
  await page.getByRole("button", { name: "Compact", exact: true }).click();

  const applicationGrid = page
    .getByLabel("Salary currency")
    .locator('xpath=ancestor::*[@data-slot="adaptive-field-grid"][1]');
  await expect(applicationGrid).toBeVisible();
  await expect.poll(() => columnCount(applicationGrid)).toBe(2);
  await expect(page.getByRole("group", { name: "Work authorization and account" })).toBeVisible();
  await expect(page.getByRole("group", { name: "Availability" })).toBeVisible();
  await expect(page.getByRole("group", { name: "Compensation" })).toBeVisible();
  await expect(page.getByLabel("Salary expectation")).toHaveAccessibleDescription(
    "Annual gross amount in the selected currency.",
  );
  await expect(page.getByLabel("Salary currency")).toHaveAccessibleDescription(
    "Three-letter currency code, such as EUR or USD.",
  );

  await page.getByRole("tab", { name: "Writing style" }).click();
  const writingStyleGroup = page.locator(
    ".tailoring-controls-grid--writing > .tailoring-writing-style-group",
  );
  const additionalGuidanceGroup = page.locator(
    ".tailoring-controls-grid--writing > .tailoring-additional-guidance-group",
  );
  const writingLayout = page.locator(".tailoring-controls-grid--writing");
  const measureWritingLayout = async () => {
    const [writing, guidance, layout] = await Promise.all([
      writingStyleGroup.boundingBox(),
      additionalGuidanceGroup.boundingBox(),
      writingLayout.boundingBox(),
    ]);
    if (!writing || !guidance || !layout) {
      throw new Error("Writing-style layout did not produce measurable boxes");
    }
    return { guidance, layout, writing };
  };

  await expect(writingStyleGroup).toBeVisible();
  await expect(additionalGuidanceGroup).toBeVisible();

  const writingTone = page.getByRole("combobox", { name: "Writing tone" });
  const templateFont = page
    .getByRole("group", { name: "Template settings" })
    .getByRole("combobox", { name: "Font" });
  const readSelectStyle = (control: Locator) =>
    control.evaluate((element) => {
      const style = getComputedStyle(element);
      return {
        borderRadius: style.borderRadius,
        dataSlot: element.getAttribute("data-slot"),
        height: style.height,
        legacyOverride: element.classList.contains(
          "configuration-select-trigger",
        ),
      };
    });
  const [writingToneStyle, templateFontStyle] = await Promise.all([
    readSelectStyle(writingTone),
    readSelectStyle(templateFont),
  ]);

  expect(writingToneStyle).toMatchObject({
    dataSlot: "select-trigger",
    legacyOverride: false,
  });
  expect(writingToneStyle.height).toBe(templateFontStyle.height);
  expect(writingToneStyle.borderRadius).toBe(templateFontStyle.borderRadius);

  const desktopLayout = await measureWritingLayout();
  expect(Math.abs(desktopLayout.writing.y - desktopLayout.guidance.y)).toBeLessThanOrEqual(1);
  expect(Math.abs(desktopLayout.writing.width - desktopLayout.guidance.width)).toBeLessThanOrEqual(2);
  expect(desktopLayout.writing.x + desktopLayout.writing.width).toBeLessThan(
    desktopLayout.guidance.x,
  );
  expect(desktopLayout.writing.width / desktopLayout.layout.width).toBeGreaterThan(0.45);

  await page.setViewportSize({ width: 900, height: 1000 });
  await expect.poll(() => columnCount(applicationGrid)).toBe(2);
  const tabletLayout = await measureWritingLayout();
  expect(Math.abs(tabletLayout.writing.y - tabletLayout.guidance.y)).toBeLessThanOrEqual(1);
  expect(Math.abs(tabletLayout.writing.width - tabletLayout.guidance.width)).toBeLessThanOrEqual(2);
  expect(tabletLayout.writing.x + tabletLayout.writing.width).toBeLessThan(
    tabletLayout.guidance.x,
  );

  await page.setViewportSize({ width: 761, height: 900 });
  const aboveBreakpointLayout = await measureWritingLayout();
  expect(
    Math.abs(aboveBreakpointLayout.writing.y - aboveBreakpointLayout.guidance.y),
  ).toBeLessThanOrEqual(1);

  await page.setViewportSize({ width: 760, height: 900 });
  const atBreakpointLayout = await measureWritingLayout();
  expect(atBreakpointLayout.guidance.y).toBeGreaterThanOrEqual(
    atBreakpointLayout.writing.y + atBreakpointLayout.writing.height,
  );
  expect(
    Math.abs(atBreakpointLayout.writing.width - atBreakpointLayout.layout.width),
  ).toBeLessThanOrEqual(1);

  await page.setViewportSize({ width: 390, height: 844 });
  await expect.poll(() => columnCount(applicationGrid)).toBe(1);
  expect(
    await page.evaluate(() => document.documentElement.scrollWidth),
  ).toBeLessThanOrEqual(
    await page.evaluate(() => document.documentElement.clientWidth + 1),
  );

  const mobileLayout = await measureWritingLayout();
  expect(mobileLayout.guidance.y).toBeGreaterThanOrEqual(
    mobileLayout.writing.y + mobileLayout.writing.height,
  );
  expect(Math.abs(mobileLayout.writing.width - mobileLayout.guidance.width)).toBeLessThanOrEqual(1);
  expect(Math.abs(mobileLayout.writing.width - mobileLayout.layout.width)).toBeLessThanOrEqual(1);

  await page.getByRole("tab", { name: "Content rules" }).click();
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

test("preferences cards keep controls inset and anchored headings unobscured", async ({
  page,
}) => {
  const viewports = [
    { width: 1440, height: 1000 },
    { width: 1280, height: 800 },
    { width: 430, height: 932 },
    { width: 390, height: 844 },
    { width: 320, height: 568 },
  ] as const;

  await page.setViewportSize(viewports[0]);
  await page.goto("/preferences");
  await expect(
    page.getByRole("heading", { name: "Preferences", level: 1 }),
  ).toBeVisible({ timeout: 30_000 });
  await page.getByRole("button", { name: "Compact", exact: true }).click();
  expect(
    await page.locator("#preferences-application").evaluate((element) => {
      const nav = document.querySelector<HTMLElement>(".profile-section-nav");
      const title = element.querySelector<HTMLElement>(
        ".configuration-section__title",
      );
      if (!nav || !title) return false;
      return (
        title.getBoundingClientRect().top >= nav.getBoundingClientRect().bottom
      );
    }),
    "initial compact application heading clearance",
  ).toBe(true);

  for (const viewport of viewports) {
    await page.setViewportSize(viewport);

    const insets = await page.locator("#preferences-application").evaluate(
      (element) => {
        const sectionBox = element.getBoundingClientRect();
        const controls = Array.from(
          element.querySelectorAll<HTMLElement>(
            '[data-slot="input"], [data-slot="select-trigger"], [data-slot="checkbox"]',
          ),
        ).filter((control) => control.getClientRects().length > 0);
        return {
          left:
            Math.min(
              ...controls.map(
                (control) => control.getBoundingClientRect().left,
              ),
            ) - sectionBox.left,
          right:
            sectionBox.right -
            Math.max(
              ...controls.map(
                (control) => control.getBoundingClientRect().right,
              ),
            ),
        };
      },
    );
    expect(insets.left, `${viewport.width}px left inset`).toBeGreaterThanOrEqual(
      16,
    );
    expect(
      insets.right,
      `${viewport.width}px right inset`,
    ).toBeGreaterThanOrEqual(16);

    for (const [linkName, sectionId] of [
      ["Application", "preferences-application"],
      ["Tailoring", "preferences-tailoring"],
    ] as const) {
      await page.getByRole("link", { name: linkName, exact: true }).click();
      await expect(page).toHaveURL(new RegExp(`#${sectionId}$`));
      await expect
        .poll(async () =>
          page.locator(`#${sectionId}`).evaluate((element) => {
            const nav = document.querySelector<HTMLElement>(
              ".profile-section-nav",
            );
            const title = element.querySelector<HTMLElement>(
              ".configuration-section__title",
            );
            if (!nav || !title) return false;
            return (
              title.getBoundingClientRect().top >=
              nav.getBoundingClientRect().bottom
            );
          }),
        )
        .toBe(true);
    }

    expect(
      await page.evaluate(
        () =>
          document.documentElement.scrollWidth <=
          document.documentElement.clientWidth + 1,
      ),
      `${viewport.width}px document overflow`,
    ).toBe(true);
  }
});

test("profile cards do not inherit the preferences jump-nav clearance", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.goto("/profile");
  await expect(
    page.getByRole("heading", { name: "Profile", level: 1 }),
  ).toBeVisible({ timeout: 30_000 });

  const marginBlockStart = await page
    .locator(".profile-sections--resume-data")
    .evaluate((stack) => getComputedStyle(stack).marginBlockStart);

  expect(marginBlockStart).toBe("0px");
});

test("resume template settings and persistence actions share the Plate editor workspace", async ({
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
  ).toBeVisible({ timeout: 30_000 });

  const editor = page.getByLabel("Resume template preview");
  const controls = editor.getByLabel("Template settings");
  const actions = controls.locator(".resume-template-actions");
  const toolbar = editor.locator(".resume-plate-toolbar");

  await expect(editor).toBeVisible();
  await expect(controls).toBeVisible();
  await expect(actions).toBeVisible();
  await expect(toolbar).toBeVisible();

  for (const label of [
    "Template",
    "Name",
    "Font",
    "Density",
    "Header",
    "Headings",
    "Alignment",
    "Bullets",
    "Font scale",
    "Accent",
    "Top margin",
    "Side margin",
  ]) {
    await expect(controls.getByLabel(label, { exact: true })).toBeVisible();
  }
  for (const name of ["save version", "save default", "set default"]) {
    await expect(actions.getByRole("button", { name })).toBeVisible();
  }

  const desktopGeometry = await editor.evaluate((element) => {
    const controlsElement = element.querySelector<HTMLElement>(
      ".resume-template-controls",
    );
    const actionsElement = element.querySelector<HTMLElement>(
      ".resume-template-actions",
    );
    const toolbarElement = element.querySelector<HTMLElement>(
      ".resume-plate-toolbar",
    );
    const nameInput = element.querySelector<HTMLInputElement>(
      "#resume-template-name",
    );
    if (!controlsElement || !actionsElement || !toolbarElement || !nameInput) {
      throw new Error("Resume template workspace did not render its complete editor chrome");
    }

    const editorBox = element.getBoundingClientRect();
    const controlsBox = controlsElement.getBoundingClientRect();
    const toolbarBox = toolbarElement.getBoundingClientRect();
    const editorStyle = getComputedStyle(element);
    const inputStyle = getComputedStyle(nameInput);
    return {
      actionsInsideEditor: element.contains(actionsElement),
      controlsInsideEditor: element.contains(controlsElement),
      controlsAligned:
        Math.abs(controlsBox.left - editorBox.left) <= 1 &&
        Math.abs(controlsBox.right - editorBox.right) <= 1,
      toolbarAligned:
        Math.abs(toolbarBox.left - editorBox.left) <= 1 &&
        Math.abs(toolbarBox.right - editorBox.right) <= 1,
      controlsMeetToolbar: Math.abs(controlsBox.bottom - toolbarBox.top) <= 1,
      inputBackground: inputStyle.backgroundColor,
      inputForeground: inputStyle.color,
      workspacePopover: editorStyle.getPropertyValue("--popover").trim(),
      workspaceForeground: editorStyle.getPropertyValue("--foreground").trim(),
    };
  });

  expect(desktopGeometry).toMatchObject({
    actionsInsideEditor: true,
    controlsAligned: true,
    controlsInsideEditor: true,
    controlsMeetToolbar: true,
    toolbarAligned: true,
  });
  expect(desktopGeometry.inputBackground).toBe(
    desktopGeometry.workspacePopover,
  );
  expect(desktopGeometry.inputForeground).toBe(
    desktopGeometry.workspaceForeground,
  );
  expect(desktopGeometry.inputBackground).not.toBe(
    desktopGeometry.inputForeground,
  );

  await injectAxe(page);
  const seriousViolations = (
    await getViolations(page, ".resume-template-plate-editor")
  ).filter((violation) =>
    ["critical", "serious"].includes(violation.impact ?? ""),
  );
  expect(seriousViolations).toEqual([]);

  await page.setViewportSize({ width: 390, height: 844 });
  await expect(actions).toBeVisible();
  expect(
    await page.evaluate(() => document.documentElement.scrollWidth),
  ).toBeLessThanOrEqual(
    await page.evaluate(() => document.documentElement.clientWidth + 1),
  );
  expect(
    await editor.evaluate((element) =>
      element.contains(element.querySelector(".resume-template-actions")),
    ),
  ).toBe(true);
  expect(consoleErrors).toEqual([]);
});
