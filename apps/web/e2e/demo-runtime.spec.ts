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
  page.on("pageerror", (error) => errors.push(error.message));
  page.on("console", (message) => {
    if (message.type() === "error") errors.push(message.text());
  });
  context.on("request", (request) => {
    const url = new URL(request.url());
    if (url.origin === origin && /^\/v1(?:\/|$)/.test(url.pathname))
      productRequests.push(`${request.method()} ${url.pathname}`);
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

  await page.goto("/");
  await expect(
    page.getByRole("heading", {
      name: "Explore JobCtrl with synthetic data",
      exact: true,
    }),
  ).toBeVisible();
  const consentResponse = page.waitForResponse(
    (response) =>
      response.url().startsWith(origin + "/api/") &&
      response.request().method() === "POST",
  );
  await page
    .getByRole("button", { name: "Accept cookies and enter demo", exact: true })
    .click();
  expect((await consentResponse).ok()).toBe(true);
  await expect(
    page.getByRole("button", { name: "Open demo guide", exact: true }),
  ).toBeVisible();

  await page
    .getByRole("button", { name: "Open demo guide", exact: true })
    .click();
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
