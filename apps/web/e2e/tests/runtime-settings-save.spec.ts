import { expect, test } from "@playwright/test";
import type { DiscoverySettingsUpdateRequest, SettingsUpdateRequest } from "@jobctrl/contracts";

import { sampleDiscoverySettingsResponse, sampleSettingsResponse } from "../../src/test/fixtures/projections.js";

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}

test("Application runtime keeps a later edit through an earlier save", async ({ page }) => {
  const firstSave = deferred();
  let saved = structuredClone(sampleSettingsResponse);
  const requests: SettingsUpdateRequest[] = [];
  await page.route("**/v1/settings", async (route) => {
    if (route.request().method() === "PATCH") {
      const body = route.request().postDataJSON() as SettingsUpdateRequest;
      requests.push(body);
      if (requests.length === 1) await firstSave.promise;
      const timeout = body.applyTimeoutSeconds ?? saved.settings.applyTimeoutSeconds;
      const budget = requests.length === 1 ? 6.5 : body.applyMaxBudgetUsd ?? saved.settings.applyMaxBudgetUsd;
      saved = {
        ...saved,
        settings: { ...saved.settings, applyTimeoutSeconds: timeout, applyMaxBudgetUsd: budget },
        effectiveSettings: {
          ...saved.effectiveSettings,
          applyTimeoutSeconds: { ...saved.effectiveSettings.applyTimeoutSeconds, value: timeout },
          applyMaxBudgetUsd: { ...saved.effectiveSettings.applyMaxBudgetUsd, value: budget },
        },
      };
    }
    await route.fulfill({ json: saved });
  });

  await page.goto("/settings");
  const panel = page.locator(".application-runtime-settings");
  const timeout = panel.getByRole("spinbutton", { name: "Apply agent timeout (seconds)", exact: true });
  const budget = panel.getByRole("spinbutton", { name: "Maximum AI budget per application (USD)", exact: true });
  await timeout.fill("1200");
  await budget.fill("6");
  await panel.getByRole("button", { name: "Save application runtime" }).click();
  await expect.poll(() => requests.length).toBe(1);
  await timeout.fill("1500");
  firstSave.resolve();
  await expect(panel.getByText("Saved; newer changes pending.")).toBeVisible();
  await expect(timeout).toHaveValue("1500");
  await expect(budget).toHaveValue("6.5");
  await panel.getByRole("button", { name: "Save application runtime" }).click();
  await expect.poll(() => requests.length).toBe(2);
  expect(requests[1]).toEqual({ applyTimeoutSeconds: 1500 });
  await expect(panel.locator(".settings-save-actions")).toHaveAttribute("data-save-state", "saved");
});

test("Discovery runtime keeps a later edit through an earlier save", async ({ page }) => {
  const firstSave = deferred();
  let saved = structuredClone(sampleDiscoverySettingsResponse);
  const requests: DiscoverySettingsUpdateRequest[] = [];
  await page.route("**/v1/discovery/settings", async (route) => {
    if (route.request().method() === "PATCH") {
      const body = route.request().postDataJSON() as DiscoverySettingsUpdateRequest;
      requests.push(body);
      if (requests.length === 1) await firstSave.promise;
      const results = body.resultsPerSite ?? saved.settings.resultsPerSite;
      const hours = requests.length === 1 ? 48 : body.hoursOld ?? saved.settings.hoursOld;
      saved = {
        ...saved,
        settings: { ...saved.settings, resultsPerSite: results, hoursOld: hours },
        effectiveSettings: {
          ...saved.effectiveSettings,
          resultsPerSite: { ...saved.effectiveSettings.resultsPerSite, value: results },
          hoursOld: { ...saved.effectiveSettings.hoursOld, value: hours },
        },
      };
    }
    await route.fulfill({ json: saved });
  });

  await page.goto("/discovery");
  const panel = page.locator(".discovery-runtime-settings");
  const results = panel.getByRole("spinbutton", { name: "Results per board", exact: true });
  const hours = panel.getByRole("spinbutton", { name: "Posting lookback hours", exact: true });
  await results.fill("25");
  await panel.getByRole("button", { name: "Save changes" }).click();
  await expect.poll(() => requests.length).toBe(1);
  await results.fill("30");
  firstSave.resolve();
  await expect(panel.getByText(/newer changes pending/i)).toBeVisible();
  await expect(results).toHaveValue("30");
  await expect(hours).toHaveValue("48");
  await panel.getByRole("button", { name: "Save changes" }).click();
  await expect.poll(() => requests.length).toBe(2);
  expect(requests[1]).toEqual({ resultsPerSite: 30 });
  await expect(panel.getByRole("button", { name: "Save changes" })).toHaveCount(0);
});
