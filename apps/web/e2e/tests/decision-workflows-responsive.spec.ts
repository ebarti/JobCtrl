import { expect, test, type Page } from "@playwright/test";

const JOB_FILTER_PARAMS =
  "stage=all&state=all&deleted=active&sort=fit_score&dir=desc&page=1&pageSize=50";

async function expectNoPageOverflow(page: Page): Promise<void> {
  const dimensions = await page.evaluate(() => ({
    clientWidth: document.documentElement.clientWidth,
    scrollWidth: document.documentElement.scrollWidth,
  }));
  expect(dimensions.scrollWidth).toBeLessThanOrEqual(
    dimensions.clientWidth + 1,
  );
}

test.describe("decision workflow mobile composition", () => {
  test.beforeEach(async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
  });

  test("Apply Review exposes queue selection and the decision before diagnostics", async ({
    page,
  }) => {
    await page.goto("/apply-review");

    await expect(
      page.getByRole("heading", { name: "Application review" }),
    ).toBeVisible({ timeout: 30_000 });
    await expect(
      page.getByRole("combobox", { name: "Review item" }),
    ).toBeVisible();

    const decisionCard = page.locator(".apply-review-decision-card");
    const decisionActions = decisionCard.locator(
      ".apply-review-selected-actions",
    );
    const diagnosticFacts = decisionCard.locator(
      ".apply-review-selected-facts",
    );
    await expect(decisionActions).toBeVisible();
    await expect(diagnosticFacts).toBeVisible();

    const order = await decisionCard.evaluate((card) => {
      const actions = card.querySelector(".apply-review-selected-actions");
      const facts = card.querySelector(".apply-review-selected-facts");
      if (!actions || !facts) return null;
      return Boolean(
        actions.compareDocumentPosition(facts) &
        Node.DOCUMENT_POSITION_FOLLOWING,
      );
    });
    expect(order).toBe(true);
    await expectNoPageOverflow(page);
  });

  test("Evidence Map switches from evidence to selected detail and gaps", async ({
    page,
  }) => {
    await page.goto("/evidence-map");

    const switcher = page.getByRole("group", { name: "Evidence map view" });
    await expect(switcher).toBeVisible({ timeout: 30_000 });
    const evidenceButton = switcher.getByRole("button", {
      name: /Evidence \(/,
    });
    const detailsButton = switcher.getByRole("button", { name: "Details" });
    const gapsButton = switcher.getByRole("button", { name: /Gaps \(/ });
    await expect(evidenceButton).toHaveAttribute("aria-pressed", "true");

    const firstEntry = page
      .getByRole("navigation", { name: "Evidence entries" })
      .locator(".evidence-entry-link")
      .first();
    await expect(firstEntry).toBeVisible();
    await firstEntry.click();
    await expect(detailsButton).toHaveAttribute("aria-pressed", "true");
    await expect(page.locator("#evidence-map-details-panel")).toBeVisible();

    await gapsButton.click();
    await expect(gapsButton).toHaveAttribute("aria-pressed", "true");
    await expect(page.locator("#evidence-map-gaps-panel")).toBeVisible();
    await expectNoPageOverflow(page);
  });

  test("Job Detail keeps its primary handoff visible and discloses commands and diagnostics", async ({
    page,
  }) => {
    const response = await page.request.get("/v1/apply/review-queue");
    expect(response.ok()).toBeTruthy();
    const queue = (await response.json()) as {
      readonly items?: readonly {
        readonly jobKey: string;
        readonly title: string;
      }[];
    };
    const target = queue.items?.[0];
    expect(target).toBeTruthy();

    await page.goto(
      `/jobs/${encodeURIComponent(target!.jobKey)}?${JOB_FILTER_PARAMS}`,
    );
    const workspace = page.getByRole("article", { name: "Job details" });
    await expect(workspace).toBeVisible({ timeout: 30_000 });
    await expect(
      workspace.getByRole("link", {
        name: `Open Apply Review for ${target!.title}`,
      }),
    ).toBeVisible();

    const sectionSwitcher = workspace.getByRole("group", {
      name: "Job detail section",
    });
    const diagnosticsButton = sectionSwitcher.getByRole("button", {
      name: "Progress and history",
    });
    await diagnosticsButton.click();
    await expect(diagnosticsButton).toHaveAttribute("aria-pressed", "true");
    await expect(
      workspace.locator("#job-detail-diagnostics-panel"),
    ).toBeVisible();

    const moreActions = workspace.getByRole("button", {
      name: "More job actions",
    });
    await moreActions.click();
    await expect(moreActions).toHaveAttribute("aria-expanded", "true");
    await expect(
      workspace.getByRole("toolbar", { name: "Job actions" }),
    ).toBeVisible();

    const hasPlaceholderMetadata = await workspace
      .locator(".job-overview-location")
      .evaluateAll((elements) =>
        elements.some((element) =>
          /^\s*-\s*·\s*-\s*$/.test(element.textContent ?? ""),
        ),
      );
    expect(hasPlaceholderMetadata).toBe(false);
    await expectNoPageOverflow(page);
  });
});
