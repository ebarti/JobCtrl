import { execFile as execFileCallback } from "node:child_process";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { promisify } from "node:util";

import { test, expect } from "./harness/demo-fixtures.js";

const execFile = promisify(execFileCallback);
const originalBullet = "Coordinated a reliability improvement.";
const editedBullet =
  "Coordinated a synthetic reliability improvement with a documented review trail.";

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
    if (request.postData()?.includes(editedBullet))
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
  await page.goto("/profile");
  await expect(
    page.getByRole("heading", { name: "Profile", level: 1, exact: true }),
  ).toBeVisible();
  const fullName = page.getByRole("textbox", {
    name: "Full name",
    exact: true,
  });
  await expect(fullName).toBeVisible();
  await expect(fullName).toHaveValue(/.+/);
  const originalName = await fullName.inputValue();
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
  await page.goto("/");

  await page
    .getByRole("button", { name: "Open demo guide", exact: true })
    .click();
  const guide = page.getByRole("complementary", {
    name: "Try the synthetic workflow",
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
    await entry.click();
    await next.click();
    await walkthrough
      .getByRole("link", { name: "Open demo Profile", exact: true })
      .click();
    await expect(page).toHaveURL(/\/profile(?:\?|$)/);
    await expect(fullName).toHaveValue(originalName);
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
  const sampleOpening = page.waitForEvent("popup");
  await page
    .getByRole("link", {
      name: "Open an illustrative resume sample",
      exact: true,
    })
    .click();
  const sample = await sampleOpening;
  await sample.waitForLoadState("domcontentloaded");
  expect(new URL(sample.url()).origin).toBe(origin);
  await expect(sample.locator("body")).toContainText(/synthetic/i);
  await sample.close();

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
    .getByRole("button", { name: "Open demo guide", exact: true })
    .click();
  await page
    .getByRole("link", {
      name: "Open browser-local application review",
      exact: true,
    })
    .click();
  await expect(
    page.getByRole("heading", {
      name: "Application review",
      level: 1,
      exact: true,
    }),
  ).toBeVisible();
  await page
    .getByRole("button", { name: "Open demo guide", exact: true })
    .click();
  await page
    .getByRole("link", {
      name: "Inspect synthetic scoring evidence",
      exact: true,
    })
    .click();
  await expect(
    page.getByRole("button", { name: "Copy baseline", exact: true }),
  ).toBeEnabled();
  await expect(
    page.getByRole("button", { name: "Compose tailored resume", exact: true }),
  ).toBeDisabled();
  await page
    .getByRole("button", { name: "Copy baseline", exact: true })
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
    .getByRole("button", { name: "Render resume", exact: true })
    .click();
  await expect(
    page.getByRole("button", { name: "Accept resume", exact: true }),
  ).toBeEnabled({ timeout: 45_000 });
  await page
    .getByRole("button", { name: "Accept resume", exact: true })
    .click();
  await expect(page.getByText(/Accepted revision is current/)).toBeVisible();
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
  await expect(page.getByText(/Accepted revision is current/)).toBeVisible();
  await expect(editor.getByText(editedBullet, { exact: true })).toBeVisible();
  await page.goto("/artifacts");
  await expect(
    page.getByRole("heading", { name: "Artifacts", level: 1, exact: true }),
  ).toBeVisible();
  await expect(
    page.getByText("The resume catalog response is invalid.", { exact: true }),
  ).toHaveCount(0);
  await testInfo.attach("demo-artifact-catalog", {
    body: await page.screenshot(),
    contentType: "image/png",
  });
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
      name: "Inspect synthetic scoring evidence",
      exact: true,
    })
    .click();
  await expect(page.getByText(/Accepted revision is current/)).toBeVisible();
  await expect(editor.getByText(editedBullet, { exact: true })).toBeVisible();
  await page
    .getByRole("button", { name: "Open demo guide", exact: true })
    .click();
  await guide
    .getByRole("button", { name: "Reset synthetic demo data", exact: true })
    .click();
  await resetDialog
    .getByRole("button", { name: "Reset demo data", exact: true })
    .click();
  await expect(page).toHaveURL(/\/dashboard(?:\?|$)/);
  await expect(guide).toContainText(
    "Synthetic demo data reset. The seeded examples are ready again.",
  );
  await guide
    .getByRole("link", {
      name: "Inspect synthetic scoring evidence",
      exact: true,
    })
    .click();
  await expect(
    page.getByRole("button", { name: "Copy baseline", exact: true }),
  ).toBeEnabled();
  await page
    .getByRole("button", { name: "Copy baseline", exact: true })
    .click();
  await expect(editor.getByText(originalBullet, { exact: true })).toBeVisible();
  await expect(editor.getByText(editedBullet, { exact: true })).toHaveCount(0);
  await expect(page.getByText(/Accepted revision is current/)).toHaveCount(0);
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
