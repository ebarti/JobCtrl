import { execFile as execFileCallback } from "node:child_process";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { promisify } from "node:util";

import { test, expect } from "./harness/demo-fixtures.js";
import { demoAuthority } from "./harness/demo-persistence.js";

const execFile = promisify(execFileCallback);
const originalBullet =
  "Coordinated a reliability improvement with the engineering team, documenting delivery checks and incident recovery steps.";
const editedBullet =
  "Coordinated a synthetic reliability improvement with a documented review trail.";
const editedProfileName = "Synthetic Demo Profile Edit";
const editedWording =
  "Coordinated the reliability improvement and retained its delivery checks and recovery notes.";
const editedTargetRole = "Synthetic Demo Target Role";

// Playwright DOM snapshots inject scripts into the deliberately script-free
// render sandbox. The owned negative-control probe reproduces those refusals
// only with snapshots enabled; keep strict console checks and other trace data.
test.use({
  trace: {
    mode: "retain-on-failure",
    snapshots: false,
    screenshots: true,
    sources: true,
  },
});

// The Browser plugin is unavailable in this environment. This journey uses the
// repository Playwright browser against the real demo bundle and consent Worker.
test("demo tour retains local exact wording approval, durable edits and a real accepted PDF without product network requests", async ({
  page,
  context,
  baseURL,
}, testInfo) => {
  test.setTimeout(150_000);
  if (!baseURL)
    throw new Error("The demo fixture did not provide its preview URL.");
  const origin = new URL(baseURL).origin;
  const errors: string[] = [];
  const productRequests: string[] = [];
  const unexpectedExternalRequests: string[] = [];
  const privateTextLeaks: string[] = [];
  const consentWrites: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  page.on("console", (message) => {
    if (message.type() === "error") errors.push(message.text());
  });
  context.on("request", (request) => {
    const url = new URL(request.url());
    if (url.origin === origin && /^\/v1(?:\/|$)/.test(url.pathname))
      productRequests.push(`${request.method()} ${url.pathname}`);
    if (
      url.origin === origin &&
      url.pathname === "/api/demo-consent" &&
      request.method() === "POST"
    )
      consentWrites.push(url.pathname);
    if (
      [editedBullet, editedProfileName, editedWording, editedTargetRole].some(
        (text) => request.postData()?.includes(text),
      )
    )
      privateTextLeaks.push(url.pathname);
    if (
      url.protocol === "https:" &&
      url.origin !== origin &&
      !(
        (url.hostname === "www.googletagmanager.com" &&
          url.pathname === "/gtag/js") ||
        (["www.google-analytics.com", "region1.google-analytics.com"].includes(
          url.hostname,
        ) &&
          url.pathname === "/g/collect")
      )
    )
      unexpectedExternalRequests.push(url.origin + url.pathname);
  });
  // Google Analytics is the sole simulated external boundary; first-party
  // consent, telemetry, assets and all product behavior execute normally.
  await context.route(
    /^https:\/\/www\.googletagmanager\.com\/gtag\/js\?/,
    (route) =>
      route.fulfill({
        status: 200,
        contentType: "application/javascript",
        body: "",
      }),
  );
  await context.route(
    /^https:\/\/(?:www|region1)\.google-analytics\.com\/g\/collect(?:\?|$)/,
    (route) => route.fulfill({ status: 204, body: "" }),
  );

  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.goto("/");
  await expect(
    page.getByRole("heading", {
      name: "Explore JobCtrl with synthetic data",
      exact: true,
    }),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Open demo guide", exact: true }),
  ).toHaveCount(0);
  const consentResponse = page.waitForResponse(
    (response) =>
      response.url() === origin + "/api/demo-consent" &&
      response.request().method() === "POST",
  );
  await page
    .getByRole("button", { name: "Accept cookies and enter demo", exact: true })
    .click();
  expect((await consentResponse).ok()).toBe(true);
  await expect(
    page.getByRole("button", { name: "Open demo guide", exact: true }),
  ).toBeVisible();
  await page.goto("/runs");
  await expect(
    page.getByRole("heading", { name: "Runs", level: 1, exact: true }),
  ).toBeVisible();
  await expect(page.getByText("Loading runs…", { exact: true })).toHaveCount(0);
  const runLinks = page.locator('main a[href^="/runs/"]');
  const originalRuns = await runLinks.evaluateAll((links) =>
    links.map((link) => link.getAttribute("href")),
  );

  // The demo registers Fit but cannot execute model-backed manual updates.
  // Opening Profile must keep that unavailable capability quiet and must not
  // turn an unsupported pending read into a product error.
  await page.goto("/profile?section=personal");
  await expect(
    page.getByRole("heading", {
      name: "Personal details",
      level: 1,
      exact: true,
    }),
  ).toBeVisible();
  const fullName = page.getByRole("textbox", {
    name: "Full name",
    exact: true,
  });
  await expect(fullName).toBeVisible();
  await expect(fullName).toHaveValue(/.+/);
  const originalName = await fullName.inputValue();
  await fullName.fill(editedProfileName);
  await page.getByRole("button", { name: "Save changes", exact: true }).click();
  await expect(page.getByText("Profile saved", { exact: true })).toBeVisible();
  await page.reload();
  await expect(fullName).toHaveValue(editedProfileName);
  await fullName.fill(originalName);
  await page.getByRole("button", { name: "Save changes", exact: true }).click();
  await expect(page.getByText("Profile saved", { exact: true })).toBeVisible();
  await page
    .getByRole("navigation", { name: "My profile sections", exact: true })
    .getByRole("link", { name: "Experience", exact: true })
    .click();
  const affectedMatches = page.getByRole("region", {
    name: "Affected matches",
    exact: true,
  });
  await expect(affectedMatches).toBeVisible();
  await expect(affectedMatches).toContainText(
    "Updating matches is unavailable in the demo.",
  );
  await expect(
    affectedMatches.getByText("Checking saved match state…", { exact: true }),
  ).toHaveCount(0);
  await affectedMatches.scrollIntoViewIfNeeded();
  await testInfo.attach("demo-profile-refresh-unavailable", {
    contentType: "image/png",
    body: await page.screenshot(),
  });
  await expect(affectedMatches.getByRole("alert")).toHaveCount(0);
  await expect(
    affectedMatches.getByRole("button", {
      name: "Update affected matches",
      exact: true,
    }),
  ).toBeDisabled();
  await expect(affectedMatches).not.toContainText(
    "Saved changes may affect matches.",
  );
  await test.step("edit browser-local proposed wording, requirement links, search preferences and appearance", async () => {
    const proposal = page.getByRole("article", {
      name: "Proposed revision 1",
      exact: true,
    });
    await proposal
      .getByRole("button", { name: "Edit draft", exact: true })
      .click();
    await proposal
      .getByRole("textbox", { name: "Wording text", exact: true })
      .fill(editedWording);
    await proposal
      .getByRole("button", { name: "Save wording draft", exact: true })
      .click();
    await expect(
      proposal.getByRole("textbox", { name: "Wording text", exact: true }),
    ).toHaveCount(0);
    await expect(
      proposal.locator("p").filter({ hasText: editedWording }),
    ).toHaveCount(1);
    await proposal
      .getByRole("button", { name: "Approve exact wording", exact: true })
      .click();
    await expect(proposal).toHaveCount(0);
    await expect(
      page
        .getByRole("article", { name: "Saved wording", exact: true })
        .first(),
    ).toBeVisible();

    await page
      .getByRole("button", { name: "Open demo guide", exact: true })
      .click();
    await page
      .getByRole("link", {
        name: "Browse requirements and linked achievements",
        exact: true,
      })
      .click();
    await expect(
      page.getByRole("heading", { name: "Requirements library", exact: true }),
    ).toBeVisible();
    const definition = (await page
      .locator("#requirement-definition-title")
      .textContent())!;
    const requirementFilter = definition.slice(0, 18);
    await page
      .getByRole("textbox", { name: "Find a requirement", exact: true })
      .fill(requirementFilter);
    await page
      .getByRole("button", { name: "Link achievement", exact: true })
      .click();
    const picker = page.getByRole("dialog", {
      name: "Link an achievement",
      exact: true,
    });
    await picker
      .getByRole("group", { name: "Choose an achievement", exact: true })
      .getByRole("button")
      .filter({ hasText: "Systems delivery coordinator" })
      .click();
    await picker
      .getByRole("button", { name: "Save link", exact: true })
      .click();
    await expect(picker).toHaveCount(0);
    const linkedAchievement = page.getByRole("article").filter({
      has: page.getByRole("heading", {
        name: "Example systems studio · Systems delivery coordinator",
        exact: true,
      }),
    });
    await expect(
      linkedAchievement.getByText("Your link · unassessed", { exact: true }),
    ).toBeVisible();
    await linkedAchievement
      .getByRole("button", { name: "Remove link", exact: true })
      .click();
    await page
      .locator("summary")
      .filter({ hasText: /^Removed links/ })
      .click();
    await page
      .getByRole("button", { name: "Restore link", exact: true })
      .click();
    await expect(
      linkedAchievement.getByText("Your link · unassessed", { exact: true }),
    ).toBeVisible();
    await page.reload();
    await expect(
      page.getByRole("textbox", { name: "Find a requirement", exact: true }),
    ).toHaveValue(requirementFilter);
    await expect(
      linkedAchievement.getByText("Your link · unassessed", { exact: true }),
    ).toBeVisible();

    await page
      .getByRole("button", { name: "Open demo guide", exact: true })
      .click();
    await page
      .getByRole("link", { name: "Adjust search preferences", exact: true })
      .click();
    const target = page.getByRole("textbox", {
      name: "Target roles 1",
      exact: true,
    });
    const originalTarget = await target.inputValue();
    await target.fill(editedTargetRole);
    await target.press("Enter");
    await expect(
      page.getByRole("textbox", { name: "Target roles 2", exact: true }),
    ).toBeFocused();
    await page
      .getByRole("button", { name: "Save changes", exact: true })
      .click();
    await expect(
      page.getByText("Search preferences saved.", { exact: true }),
    ).toBeVisible();
    await page.reload();
    await expect(target).toHaveValue(editedTargetRole);
    const location = page.getByRole("group", {
      name: "Location 1",
      exact: true,
    });
    await location
      .getByRole("button", { name: "Search map", exact: true })
      .click();
    await expect(location.getByRole("alert")).toContainText(
      /unavailable.*demo|demo.*unavailable/i,
    );
    await expect(location).toContainText("Unverified location");
    await target.fill(originalTarget);
    await page
      .getByRole("button", { name: "Save changes", exact: true })
      .click();
    await expect(
      page.getByText("Search preferences saved.", { exact: true }),
    ).toBeVisible();

    await page
      .getByRole("button", { name: "Open demo guide", exact: true })
      .click();
    await page
      .getByRole("link", {
        name: "Choose your workspace appearance",
        exact: true,
      })
      .click();
    await page
      .getByRole("combobox", { name: "Color scheme", exact: true })
      .click();
    await page.getByRole("option", { name: "Cobalt", exact: true }).click();
    await page
      .getByRole("combobox", { name: "Font scheme", exact: true })
      .click();
    await page.getByRole("option", { name: "Inter", exact: true }).click();
    await page.reload();
    await expect(page.locator("html")).toHaveAttribute(
      "data-color-scheme",
      "cobalt",
    );
    await expect(page.locator("html")).toHaveAttribute(
      "data-font-scheme",
      "inter",
    );
    await page
      .getByRole("button", { name: "Restore Graphite & Geist", exact: true })
      .click();
  });
  await page.goto("/");

  await page
    .getByRole("button", { name: "Open demo guide", exact: true })
    .click();
  const guide = page.getByRole("complementary", {
    name: "Explore your demo workspace",
    exact: true,
  });
  await expect(guide).toBeVisible();
  const receiptHistory = page.getByText(/^Receipt history \(\d+\)$/);
  const originalReceipts = await receiptHistory.textContent();
  await testInfo.attach("demo-guide-desktop", {
    contentType: "image/png",
    body: await page.screenshot(),
  });
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(guide).toBeVisible();
  await testInfo.attach("demo-guide-mobile", {
    contentType: "image/png",
    body: await page.screenshot(),
  });
  await page.setViewportSize({ width: 1440, height: 1000 });

  // This guide teaches model-backed behavior without executing it. Exercise
  // every outcome, then compare public Profile, receipt and run projections.
  await test.step("explore synthetic matching and wording without saved work", async () => {
    await guide
      .locator("summary")
      .filter({ hasText: /^Learn about model-backed matching$/ })
      .click();
    const entry = guide.getByRole("button", {
      name: "Explore matching and wording",
      exact: true,
    });
    const walkthrough = page.getByRole("dialog", {
      name: "How matching and wording work",
      exact: true,
    });
    const next = walkthrough.getByRole("button", {
      name: "Next step",
      exact: true,
    });
    const previous = walkthrough.getByRole("button", {
      name: "Previous step",
      exact: true,
    });
    await entry.focus();
    await page.keyboard.press("Enter");
    await expect(walkthrough).toBeVisible();
    await expect(walkthrough).toContainText(
      "This is a synthetic illustration. No model runs and no changes are saved.",
    );
    await expect(walkthrough).toContainText(
      "The real update action is unavailable in this demo.",
    );
    await expect(previous).toBeDisabled();
    await expect(walkthrough).toContainText("entire saved catalog");
    await expect(walkthrough).toContainText("Posting 1:");
    await expect(walkthrough).toContainText("Posting 2:");
    await expect(walkthrough).toContainText(
      "An uncertain or refused comparison stays unresolved",
    );
    // The modal intercepts background guide controls and keeps both forward
    // and reverse keyboard navigation inside the dialog.
    const backgroundReset = page.getByRole("button", {
      name: "Reset synthetic demo data",
      exact: true,
      includeHidden: true,
    });
    expect(
      await backgroundReset.evaluate((button) => {
        const bounds = button.getBoundingClientRect();
        const target = document.elementFromPoint(
          bounds.x + bounds.width / 2,
          bounds.y + bounds.height / 2,
        );
        return target === button || button.contains(target);
      }),
    ).toBe(false);
    await page.keyboard.press("Tab");
    await expect(walkthrough.locator(":focus")).toHaveCount(1);
    await page.keyboard.press("Shift+Tab");
    await expect(walkthrough.locator(":focus")).toHaveCount(1);
    await testInfo.attach("demo-matching-modal-desktop", {
      contentType: "image/png",
      body: await page.screenshot(),
    });
    await testInfo.attach("demo-matching-catalog-desktop", {
      contentType: "image/png",
      body: await walkthrough.screenshot(),
    });
    await page.setViewportSize({ width: 390, height: 844 });
    await testInfo.attach("demo-mobile-dialog-initial-geometry", {
      contentType: "application/json",
      body: JSON.stringify(
        await walkthrough.evaluate((dialog) => {
          const style = getComputedStyle(dialog);
          return {
            innerWidth: window.innerWidth,
            clientWidth: document.documentElement.clientWidth,
            desktopMedia: window.matchMedia("(min-width: 640px)").matches,
            width: style.width,
            maxWidth: style.maxWidth,
            minWidth: style.minWidth,
            boxSizing: style.boxSizing,
            left: style.left,
            transform: style.transform,
            transitionProperty: style.transitionProperty,
            transitionDuration: style.transitionDuration,
            rect: dialog.getBoundingClientRect().toJSON(),
          };
        }),
        null,
        2,
      ),
    });
    // Shared dialog width transitions also run when the viewport changes.
    // Observe its settled visibility rather than sampling the first frame.
    await expect(walkthrough).toBeInViewport({ ratio: 1 });
    const mobileDialog = await walkthrough.boundingBox();
    expect(mobileDialog).not.toBeNull();
    expect(mobileDialog!.x).toBeGreaterThanOrEqual(0);
    expect(mobileDialog!.x + mobileDialog!.width).toBeLessThanOrEqual(390);
    expect(mobileDialog!.y).toBeGreaterThanOrEqual(0);
    expect(mobileDialog!.y + mobileDialog!.height).toBeLessThanOrEqual(844);
    expect(mobileDialog!.height).toBeLessThanOrEqual(844);
    await testInfo.attach("demo-matching-catalog-mobile", {
      contentType: "image/png",
      body: await page.screenshot(),
    });
    await next.click();
    await expect(walkthrough).toContainText("Saved changes wait for review");
    await walkthrough
      .getByRole("button", { name: "Approved wording change", exact: true })
      .click();
    await expect(walkthrough.getByRole("status")).toContainText(
      "does not change person qualification or its score",
    );
    await walkthrough
      .getByRole("button", { name: "Fact or source edit", exact: true })
      .click();
    await expect(walkthrough.getByRole("status")).toContainText(
      "previously marked missing or never linked",
    );
    await expect(walkthrough).toContainText(
      "does not itself run a model or regenerate a resume",
    );
    await next.click();
    await walkthrough
      .getByRole("button", { name: "Show completed example", exact: true })
      .click();
    await expect(walkthrough.getByRole("status")).toContainText(
      "Affected assessments and selected job scores can update",
    );
    await walkthrough
      .getByRole("button", { name: "Show stopped example", exact: true })
      .click();
    await expect(walkthrough.getByRole("status")).toContainText(
      "No new factual results are published",
    );
    await walkthrough
      .getByRole("button", { name: "Show partial example", exact: true })
      .click();
    await expect(walkthrough.getByRole("status")).toContainText(
      "The factual stage published, but later wording preparation failed",
    );
    await expect(walkthrough.getByRole("status")).toContainText(
      "without rerunning factual assessments or updating scores",
    );
    await testInfo.attach("demo-matching-partial-mobile", {
      contentType: "image/png",
      body: await page.screenshot(),
    });
    await page.setViewportSize({ width: 1440, height: 1000 });
    await expect(walkthrough).toBeInViewport({ ratio: 1 });
    await testInfo.attach("demo-matching-partial-desktop", {
      contentType: "image/png",
      body: await walkthrough.screenshot(),
    });
    await previous.click();
    await expect(
      walkthrough.getByRole("button", {
        name: "Fact or source edit",
        exact: true,
      }),
    ).toHaveAttribute("aria-pressed", "true");
    await next.click();
    await expect(walkthrough.getByRole("status")).toContainText(
      "Example: partial result",
    );
    await next.focus();
    await page.keyboard.press("Enter");
    await expect(walkthrough).toContainText("Reuse wording with your approval");
    await expect(walkthrough).toContainText("one grouped proposal");
    await expect(walkthrough).toContainText(
      "Led recovery for 12 production incidents; created response runbooks used by 3 teams.",
    );
    await expect(walkthrough).toContainText(
      "One grouped proposal · not approved",
    );
    await walkthrough
      .getByRole("button", { name: "Show approval example", exact: true })
      .click();
    await expect(walkthrough.getByRole("status")).toContainText(
      "This example did not save an approval",
    );
    await walkthrough
      .getByRole("button", { name: "Show deferral example", exact: true })
      .click();
    await expect(walkthrough.getByRole("status")).toContainText(
      "This example did not change the Profile",
    );
    await testInfo.attach("demo-matching-wording-desktop", {
      contentType: "image/png",
      body: await walkthrough.screenshot(),
    });
    await page.setViewportSize({ width: 390, height: 844 });
    await expect(walkthrough).toBeInViewport({ ratio: 1 });
    await walkthrough
      .getByRole("heading", {
        name: "How matching and wording work",
        exact: true,
      })
      .scrollIntoViewIfNeeded();
    await testInfo.attach("demo-matching-wording-mobile", {
      contentType: "image/png",
      body: await page.screenshot(),
    });
    await walkthrough.getByRole("status").scrollIntoViewIfNeeded();
    await testInfo.attach("demo-matching-decision-mobile", {
      contentType: "image/png",
      body: await page.screenshot(),
    });
    await walkthrough
      .getByRole("button", { name: "Start example again", exact: true })
      .click();
    await expect(previous).toBeDisabled();
    await expect(walkthrough).toContainText("Step 1 of 4");
    await next.click();
    await next.click();
    await expect(walkthrough.getByRole("status")).toContainText(
      "Select an outcome to see what remains available",
    );
    await page.keyboard.press("Escape");
    await expect(walkthrough).toHaveCount(0);
    await expect(entry).toBeFocused();
    await entry.press("Enter");
    await expect(walkthrough).toContainText("Step 1 of 4");
    await walkthrough
      .getByRole("button", { name: "Close", exact: true })
      .click();
    await expect(entry).toBeFocused();
    await expect(receiptHistory).toHaveText(originalReceipts!);
    await page.reload();
    // Guide preferences are intentionally in memory; workspace data and
    // consent persist independently when the page reloads.
    await page
      .getByRole("button", { name: "Open demo guide", exact: true })
      .click();
    await expect(guide).toBeVisible();
    await expect(
      page.getByRole("heading", {
        name: "Explore JobCtrl with synthetic data",
        exact: true,
      }),
    ).toHaveCount(0);
    await guide
      .locator("summary")
      .filter({ hasText: /^Learn about model-backed matching$/ })
      .click();
    await entry.click();
    await next.click();
    await walkthrough
      .getByRole("link", { name: "Open demo Profile", exact: true })
      .click();
    await expect(page).toHaveURL(/\/profile(?:\?|$)/);
    await page
      .getByRole("navigation", { name: "My profile sections", exact: true })
      .getByRole("link", { name: "Personal details", exact: true })
      .click();
    await expect(fullName).toHaveValue(originalName);
    await page
      .getByRole("navigation", { name: "My profile sections", exact: true })
      .getByRole("link", { name: "Experience", exact: true })
      .click();
    await expect(receiptHistory).toHaveText(originalReceipts!);
    await expect(
      affectedMatches.getByRole("button", {
        name: "Update affected matches",
        exact: true,
      }),
    ).toBeDisabled();
    await page.setViewportSize({ width: 1440, height: 1000 });
    await page.goto("/");
    await page
      .getByRole("button", { name: "Open demo guide", exact: true })
      .click();
  });
  // The guide now leads into the real editor and registered PDFs. Their actual
  // preview, bytes, text and raster are verified below through Materials.
  await guide
    .getByRole("button", { name: "Hide demo guide", exact: true })
    .click();

  await page
    .getByRole("button", { name: "Open demo guide", exact: true })
    .click();
  await page
    .getByRole("link", { name: "See simulated run history", exact: true })
    .click();
  await expect(page).toHaveURL(/\/runs(?:\?|$)/);
  await expect(
    page.getByRole("heading", { name: "Runs", level: 1, exact: true }),
  ).toBeVisible();
  await expect(page.getByText(/Runs could not be refreshed:/)).toHaveCount(0);
  await expect(page.getByText("Page not found.", { exact: true })).toHaveCount(
    0,
  );
  await expect(page.getByText("Loading runs…", { exact: true })).toHaveCount(0);
  expect(
    await runLinks.evaluateAll((links) =>
      links.map((link) => link.getAttribute("href")),
    ),
  ).toEqual(originalRuns);
  await page
    .getByRole("navigation", { name: "Main navigation", exact: true })
    .getByRole("link", { name: "Jobs", exact: true })
    .click();
  await page
    .getByRole("navigation", { name: "Jobs sections", exact: true })
    .getByRole("link", { name: "Applications", exact: true })
    .click();
  await expect(
    page.getByRole("heading", {
      name: "Applications",
      level: 1,
      exact: true,
    }),
  ).toBeVisible();
  await page
    .getByRole("button", { name: "Open demo guide", exact: true })
    .click();
  await page
    .getByRole("link", {
      name: "Edit and export a synthetic resume",
      exact: true,
    })
    .click();
  await expect(page).toHaveURL(
    (url) => url.pathname === "/jobs/6e2f4a10-20be-4d5f-98a4-a4bb9a877a35",
  );
  const resumeJobDetails = page.getByRole("main", {
    name: "Job details",
    exact: true,
  });
  await expect(resumeJobDetails).toBeVisible();
  await resumeJobDetails
    .getByRole("combobox", { name: "Resume to prepare", exact: true })
    .selectOption("tailored");
  await expect(
    resumeJobDetails.getByRole("button", { name: "Prepare resume", exact: true }),
  ).toBeDisabled();
  await resumeJobDetails
    .getByRole("combobox", { name: "Resume to prepare", exact: true })
    .selectOption("baseline");
  await resumeJobDetails
    .getByRole("button", { name: "Prepare resume locally", exact: true })
    .click();
  const editor = page.getByRole("textbox", {
    name: "Resume editor",
    exact: true,
  });
  await expect(editor.getByText(originalBullet, { exact: true })).toBeVisible();
  await editor.getByText(originalBullet, { exact: true }).fill(editedBullet);
  await page.getByRole("button", { name: "Save resume", exact: true }).click();
  const approval = page.getByRole("region", {
    name: "Approve edited wording",
    exact: true,
  });
  await expect(approval.getByText(editedBullet, { exact: true })).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Accept resume", exact: true }),
  ).toBeDisabled();
  await approval
    .getByRole("button", { name: "Approve these exact edits", exact: true })
    .click();
  await expect(
    page.getByText("Mechanical check: valid", { exact: true }),
  ).toBeVisible();
  await expect(approval).toHaveCount(0);
  await page.reload();
  await expect(editor.getByText(editedBullet, { exact: true })).toBeVisible();
  await page
    .locator("summary:visible")
    .filter({ hasText: /^Document validation and recovery tools$/ })
    .click();
  await page
    .getByRole("button", { name: "Render resume", exact: true })
    .click();
  await expect(
    page.getByRole("button", { name: "Accept resume", exact: true }),
  ).toBeEnabled({ timeout: 45_000 });
  await page
    .getByRole("button", { name: "Accept resume", exact: true })
    .click();
  await expect(
    page.getByText(
      "Accepted copy matches this document; review not applicable.",
    ),
  ).toBeVisible();
  const downloading = page.waitForEvent("download");
  await page
    .getByRole("button", { name: "Export accepted PDF", exact: true })
    .click();
  const download = await downloading;
  const pdfPath = testInfo.outputPath("accepted-demo-resume.pdf");
  await download.saveAs(pdfPath);
  expect(await download.failure()).toBeNull();
  const bytes = await readFile(pdfPath);
  expect(bytes.subarray(0, 5).toString()).toBe("%PDF-");
  expect(bytes.length).toBeGreaterThan(1_000);
  const textPath = testInfo.outputPath("accepted-demo-resume.txt");
  await execFile("pdftotext", ["-layout", pdfPath, textPath]);
  const extracted = (await readFile(textPath, "utf8")).replace(/\s+/g, " ");
  expect(extracted).toContain("Synthetic profile");
  expect(extracted).toContain("Sample workshop");
  expect(extracted).toContain(editedBullet);
  expect(extracted).not.toContain(originalBullet);
  const info = await execFile("pdfinfo", [pdfPath]);
  expect(info.stdout).toMatch(/Pages:\s+[1-9]\d*/);
  await execFile("pdftoppm", [
    "-f",
    "1",
    "-singlefile",
    "-scale-to",
    "1100",
    "-png",
    pdfPath,
    testInfo.outputPath("accepted-demo-resume"),
  ]);
  await testInfo.attach("accepted-demo-pdf", {
    path: pdfPath,
    contentType: "application/pdf",
  });
  await testInfo.attach("accepted-demo-pdf-page", {
    path: testInfo.outputPath("accepted-demo-resume.png"),
    contentType: "image/png",
  });
  await testInfo.attach("accepted-demo-pdf-sha256", {
    body: createHash("sha256").update(bytes).digest("hex"),
    contentType: "text/plain",
  });
  await page.reload();
  await expect(
    page.getByText(
      "Accepted copy matches this document; review not applicable.",
    ),
  ).toBeVisible();
  await expect(editor.getByText(editedBullet, { exact: true })).toBeVisible();
  await page
    .getByRole("navigation", { name: "Jobs sections", exact: true })
    .getByRole("link", { name: "Materials", exact: true })
    .click();
  await expect(
    page.getByRole("heading", { name: "Materials", level: 1, exact: true }),
  ).toBeVisible();
  await expect(
    page.getByText("The resume catalog response is invalid.", { exact: true }),
  ).toHaveCount(0);
  await testInfo.attach("demo-artifact-catalog", {
    body: await page.screenshot(),
    contentType: "image/png",
  });
  await page
    .getByRole("table", { name: "Saved materials", exact: true })
    .locator('a[href^="/artifacts/"]')
    .first()
    .click();
  await expect(
    page.getByText(createHash("sha256").update(bytes).digest("hex"), {
      exact: true,
    }),
  ).toBeVisible();
  const registeredPreview = page
    .getByRole("region", { name: "Recorded PDF preview", exact: true })
    .getByRole("img", { name: "Recorded resume PDF page 1", exact: true });
  await expect(registeredPreview).toBeVisible();
  await expect
    .poll(() =>
      registeredPreview.evaluate(
        (image) =>
          image instanceof HTMLImageElement &&
          image.complete &&
          image.naturalWidth > 0,
      ),
    )
    .toBe(true);
  const recordedDownload = page.waitForEvent("download");
  await page
    .getByRole("button", { name: "Download recorded PDF", exact: true })
    .click();
  const recorded = await recordedDownload;
  const recordedStream = await recorded.createReadStream();
  if (!recordedStream)
    throw new Error(
      "The registered browser-local PDF did not expose its downloaded bytes.",
    );
  const recordedHash = createHash("sha256");
  for await (const chunk of recordedStream) recordedHash.update(chunk);
  expect(await recorded.failure()).toBeNull();
  expect(recordedHash.digest("hex")).toBe(
    createHash("sha256").update(bytes).digest("hex"),
  );
  // Reset is a real browser-local destructive action with its own confirmation.
  // Cancelling it preserves the accepted edit; confirming restores the seeds
  // while consent remains independently accepted.
  await page
    .getByRole("button", { name: "Open demo guide", exact: true })
    .click();
  await guide
    .getByRole("button", { name: "Reset synthetic demo data", exact: true })
    .click();
  const resetDialog = page.getByRole("dialog", {
    name: "Reset synthetic demo data?",
    exact: true,
  });
  await expect(resetDialog).toContainText(
    "removes simulated changes and receipts",
  );
  await resetDialog
    .getByRole("button", { name: "Cancel", exact: true })
    .click();
  await expect(resetDialog).toHaveCount(0);
  await guide
    .getByRole("link", {
      name: "Edit and export a synthetic resume",
      exact: true,
    })
    .click();
  await expect(
    page.getByText(
      "Accepted copy matches this document; review not applicable.",
    ),
  ).toBeVisible();
  await expect(editor.getByText(editedBullet, { exact: true })).toBeVisible();
  const otherTab = await context.newPage();
  const resetObservations: Record<string, unknown>[] = [];
  await otherTab.exposeFunction(
    "recordOwnedResetMetadata",
    (entry: Record<string, unknown>) => resetObservations.push(entry),
  );
  await otherTab.addInitScript((ownedOrigin) => {
    if (window.top !== window || location.origin !== ownedOrigin) return;
    const channel = new BroadcastChannel("jobctrl-demo-workspace");
    channel.addEventListener("message", (event) => {
      const value = event.data as Record<string, unknown>;
      void (
        window as unknown as {
          recordOwnedResetMetadata: (
            entry: Record<string, unknown>,
          ) => Promise<void>;
        }
      ).recordOwnedResetMetadata({
        at: Date.now(),
        source: value["source"],
        kind: value["kind"],
        workspaceId: value["workspaceId"],
        revision: value["revision"],
        resetEpoch: value["resetEpoch"],
        lastEventSequence: value["lastEventSequence"],
      });
    });
    window.addEventListener("pagehide", () => channel.close(), { once: true });
  }, origin);
  otherTab.on("pageerror", (error) => errors.push(error.message));
  otherTab.on("console", (message) => {
    if (message.type() === "error") errors.push(message.text());
  });
  await otherTab.goto("/profile");
  const otherWording = otherTab
    .getByRole("article", { name: "Saved wording", exact: true })
    .first();
  await otherWording
    .getByRole("button", { name: "Edit wording", exact: true })
    .click();
  const resetWording = editedWording + " awaiting the owned reset";
  await otherWording
    .getByRole("textbox", { name: "Wording text", exact: true })
    .fill(resetWording);
  await expect(
    otherWording.getByText("Saving recovery copy…", { exact: true }),
  ).toHaveCount(0);
  await otherTab
    .getByRole("navigation", { name: "My profile sections", exact: true })
    .getByRole("link", { name: "Search preferences", exact: true })
    .click();
  const otherTarget = otherTab.getByRole("textbox", {
    name: "Target roles 1",
    exact: true,
  });
  const resetTarget = await otherTarget.inputValue();
  const preferencesForm = otherTab.locator("form").filter({ has: otherTarget });
  const preferenceSave = preferencesForm.getByRole("button", {
    name: "Save changes",
    exact: true,
  });
  await otherTarget.fill(editedTargetRole + " awaiting the owned reset");
  await expect(preferenceSave).toBeVisible();
  const beforeReset = await demoAuthority(otherTab);
  resetObservations.push({
    stage: "before-reset",
    at: Date.now(),
    ...beforeReset,
  });
  await page
    .getByRole("button", { name: "Open demo guide", exact: true })
    .click();
  await guide
    .getByRole("button", { name: "Reset synthetic demo data", exact: true })
    .click();
  await resetDialog
    .getByRole("button", { name: "Reset demo data", exact: true })
    .click();
  await expect(page).toHaveURL(/\/jobs(?:\?|$)/);
  await expect(
    page.getByText(
      "Synthetic demo data reset. The seeded examples are ready again.",
      { exact: true },
    ),
  ).toBeVisible();
  await expect(otherTarget).toHaveValue(resetTarget);
  const afterReset = await demoAuthority(otherTab);
  resetObservations.push({
    stage: "after-reset-clear",
    at: Date.now(),
    ...afterReset,
  });
  expect(afterReset.resetEpoch).toBeGreaterThan(beforeReset.resetEpoch);
  expect(afterReset.profileVersion).toBeLessThan(beforeReset.profileVersion);
  await expect(preferenceSave).toHaveCount(0);
  // A real post-reset autosave is the positive control: its debounce completes
  // after the old pending timer, and a reload must retain only the new epoch.
  await otherTab.bringToFront();
  await otherTarget.fill(editedTargetRole + " after the owned reset");
  await expect(otherTarget).toHaveValue(
    editedTargetRole + " after the owned reset",
  );
  await expect(preferenceSave).toBeVisible();
  resetObservations.push({
    stage: "after-positive-fill",
    at: Date.now(),
    ...(await demoAuthority(otherTab)),
  });
  try {
    await expect(preferenceSave).toHaveCount(0);
    await expect
      .poll(async () => (await demoAuthority(otherTab)).targetRole)
      .toBe(editedTargetRole + " after the owned reset");
  } catch (error) {
    await testInfo.attach("demo-post-reset-preferences-state", {
      contentType: "application/json",
      body: JSON.stringify({
        url: otherTab.url(),
        target: await otherTarget.inputValue(),
        canonical: await demoAuthority(otherTab),
        resetObservations,
        visibility: await otherTab.evaluate(() => document.visibilityState),
        statuses: await otherTab.getByRole("status").allTextContents(),
        alerts: await otherTab.getByRole("alert").allTextContents(),
        buttons: await otherTab
          .getByRole("button", { name: "Save changes", exact: true })
          .evaluateAll((elements) =>
            elements.map((element) => ({
              text: element.textContent,
              disabled: (element as HTMLButtonElement).disabled,
              form: element.closest("form")?.className,
            })),
          ),
      }),
    });
    throw error;
  }
  await testInfo.attach("demo-reset-authority-and-notifications", {
    contentType: "application/json",
    body: JSON.stringify({
      resetObservations,
      canonical: await demoAuthority(otherTab),
    }),
  });
  await otherTab.reload();
  await expect(otherTarget).toHaveValue(
    editedTargetRole + " after the owned reset",
  );
  await otherTarget.fill(resetTarget);
  await otherTab
    .getByRole("button", { name: "Save changes", exact: true })
    .click();
  await expect(
    otherTab.getByRole("button", { name: "Save changes", exact: true }),
  ).toHaveCount(0);
  await otherTab
    .getByRole("navigation", { name: "My profile sections", exact: true })
    .getByRole("link", { name: "Experience", exact: true })
    .click();
  await expect(
    otherTab.getByRole("button", {
      name: "Restore unfinished edit",
      exact: true,
    }),
  ).toHaveCount(0);
  await expect(otherTab.getByText(resetWording, { exact: true })).toHaveCount(
    0,
  );
  let staleGuards = 0;
  const onStaleGuard = async (dialog: import("@playwright/test").Dialog) => {
    staleGuards++;
    await dialog.dismiss();
  };
  otherTab.on("dialog", onStaleGuard);
  await otherTab.reload();
  otherTab.off("dialog", onStaleGuard);
  expect(
    staleGuards,
    "Reset removes prior-epoch pending unload guards in the other tab",
  ).toBe(0);
  await expect(
    otherTab.getByRole("button", {
      name: "Restore unfinished edit",
      exact: true,
    }),
  ).toHaveCount(0);
  await otherTab.close();
  await page
    .getByRole("button", { name: "Open demo guide", exact: true })
    .click();
  await guide
    .getByRole("link", {
      name: "Edit and export a synthetic resume",
      exact: true,
    })
    .click();
  await page
    .getByRole("combobox", { name: "Resume to prepare", exact: true })
    .selectOption("baseline");
  await expect(
    page.getByRole("button", { name: "Prepare resume locally", exact: true }),
  ).toBeEnabled();
  await page
    .getByRole("button", { name: "Prepare resume locally", exact: true })
    .click();
  await expect(editor.getByText(originalBullet, { exact: true })).toBeVisible();
  await expect(editor.getByText(editedBullet, { exact: true })).toHaveCount(0);
  await expect(
    page.getByText(
      "Accepted copy matches this document; review not applicable.",
    ),
  ).toHaveCount(0);
  expect(
    consentWrites,
    "Guide examples, reload and workspace reset must preserve consent.",
  ).toEqual(["/api/demo-consent"]);
  expect(
    productRequests,
    "Demo product reads and edits must stay in IndexedDB.",
  ).toEqual([]);
  expect(
    privateTextLeaks,
    "Authored text must stay out of consent and telemetry requests.",
  ).toEqual([]);
  expect(unexpectedExternalRequests).toEqual([]);
  expect(errors).toEqual([]);
});
