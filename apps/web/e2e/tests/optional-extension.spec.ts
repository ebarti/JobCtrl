import { expect, test } from "@playwright/test";

import { refreshE2eWorkerHeartbeat } from "../fixtures/e2e-state.js";

// Real Chromium, UI, API and owned SQLite fixture. The existing E2E dispatcher
// acknowledges launches without running workers or contacting job sites;
// production worker fixtures separately prove transport choice and persistence.
test("Discovery launches offline and prefers a connected extension in its status", async ({ page }) => {
  refreshE2eWorkerHeartbeat();
  const pageErrors: string[] = [];
  page.on("pageerror", (error) => pageErrors.push(error.message));
  await page.goto("/pipelines");
  await expect(page).toHaveURL(/\/pipelines$/);
  await expect(page).toHaveTitle(/JobCtrl/);
  await expect(page.locator("vite-error-overlay")).toHaveCount(0);
  const status = page.getByRole("status", { name: "Extension connection" });
  await expect(status).toContainText("Extension offline");
  await expect(status).toContainText("can run with anonymous access");

  const run = page.getByRole("button", { name: "Run Discover", exact: true });
  await expect(run).toBeEnabled();
  const offlineDispatch = page.waitForResponse((response) =>
    new URL(response.url()).pathname === "/v1/pipeline/actions/run-stage"
    && response.request().method() === "POST",
  );
  await run.click();
  const offlineResponse = await offlineDispatch;
  expect(offlineResponse.status()).toBe(202);
  expect(offlineResponse.request().postDataJSON()).toMatchObject({ stages: ["discover"] });
  await expect(page.getByText(/Discover queued successfully/)).toBeVisible();

  // Model a freshly paired selected installation through the authenticated
  // broker API, without replacing the status query or loading personal Chrome.
  const pairing = await page.request.get("/v1/extension/pairing-token");
  expect(pairing.ok()).toBe(true);
  const { token } = await pairing.json() as { token: string };
  const claim = await page.request.post("/v1/extension/discovery/claim", {
    headers: { authorization: `Bearer ${token}` },
    data: {
      installationId: "00000000-0000-4000-8000-000000000176",
      extensionVersion: "0.1.1",
      replace: true,
    },
  });
  expect(claim.status()).toBe(200);
  await page.reload();
  await expect(status).toContainText("Connected extension preferred for Discovery and Enrich");
  await expect(run).toBeEnabled();
  const connectedDispatch = page.waitForResponse((response) =>
    new URL(response.url()).pathname === "/v1/pipeline/actions/run-stage"
    && response.request().method() === "POST",
  );
  await run.click();
  expect((await connectedDispatch).status()).toBe(202);
  await expect(page.getByText(/Discover queued successfully/)).toBeVisible();
  expect(pageErrors).toEqual([]);
});
