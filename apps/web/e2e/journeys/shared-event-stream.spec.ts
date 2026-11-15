import type { Page } from "@playwright/test";

import { test, expect, json } from "../harness/fixtures.js";
import { sharedEventStreamTargets, sharedWorkerEventSources } from "../harness/shared-event-stream.js";

test("more than six Jobs tabs share one upstream and recover peer updates after worker loss", async ({ page, context, browser, api, app }, testInfo) => {
  const pages: Page[] = [page];
  const errors: string[] = [];
  const observe = (tab: Page) => {
    tab.on("pageerror", (error) => errors.push(error.message));
    tab.on("console", (message) => { if (message.type() === "error") errors.push(message.text()); });
  };
  observe(page);
  try {
    await page.goto("/jobs");
    expect(await page.evaluate(() => typeof SharedWorker !== "undefined")).toBe(true);
    for (let index = 1; index < 8; index += 1) { const tab = await context.newPage(); observe(tab); pages.push(tab); }
    await Promise.all(pages.slice(1).map((tab) => tab.goto("/jobs")));
    for (const tab of pages) {
      await expect(tab.getByRole("heading", { name: "Jobs", exact: true })).toBeVisible();
      await expect(tab.locator(".connection-pill")).toHaveText("Live");
    }
    const targets = () => sharedEventStreamTargets(browser, app.baseURL);
    await expect.poll(async () => (await targets()).length, { message: "eight pages use one shared browser worker" }).toBe(1);
    const original = (await targets())[0]!;
    await expect.poll(async () => sharedWorkerEventSources(browser, original.targetId), { message: "one real open native EventSource" })
      .toEqual([{ url: `${app.baseURL}/v1/events/stream?tenantId=local&envelope=1&after=latest`, readyState: 1 }]);

    const writer = pages[7]!;
    await writer.locator("summary").filter({ hasText: /^Add a job by URL or text$/ }).click();
    await writer.getByText("Manual capture", { exact: true }).click();
    const capture = writer.locator("form").filter({ has: writer.getByRole("button", { name: "Save job", exact: true }) });
    await capture.getByLabel("Posting URL", { exact: true }).fill("https://example.com/jobs/shared-tab-ui");
    await capture.getByLabel("Job title", { exact: true }).fill("Synthetic Shared Stream Engineer");
    await capture.getByLabel("Company", { exact: true }).fill("Synthetic Shared Company");
    await capture.getByLabel("Posting description", { exact: true }).fill("Maintain durable event delivery across independent browser tabs.");
    await capture.getByRole("button", { name: "Save job", exact: true }).click();
    for (const tab of pages) await expect(tab.getByRole("table", { name: "Jobs table", exact: true })
      .getByRole("link", { name: "Synthetic Shared Stream Engineer", exact: true })).toBeVisible();

    await page.close();
    const survivors = pages.slice(1);
    await json(api, "post", "/v1/jobs/capture", { url: "https://example.com/jobs/shared-tab-survivor", title: "Synthetic Surviving Tab Lead", company: "Synthetic Shared Company", description: "Keep peer updates available when one subscriber closes." });
    for (const tab of survivors) await expect(tab.getByRole("table", { name: "Jobs table", exact: true })
      .getByRole("link", { name: "Synthetic Surviving Tab Lead", exact: true })).toBeVisible();
    expect((await targets()).map((target) => target.targetId)).toEqual([original.targetId]);

    const inspector = await browser.newBrowserCDPSession();
    try { expect((await inspector.send("Target.closeTarget", { targetId: original.targetId })).success).toBe(true); }
    finally { await inspector.detach(); }
    await json(api, "post", "/v1/jobs/capture", { url: "https://example.com/jobs/shared-tab-gap", title: "Synthetic Reconciled Gap Engineer", company: "Synthetic Shared Company", description: "Persist canonical work while the browser event transport reconnects." });
    await expect.poll(async () => (await targets()).filter((target) => target.targetId !== original.targetId).length,
      { timeout: 35_000, message: "surviving subscribers reconnect one shared worker after its real termination" }).toBe(1);
    for (const tab of survivors) await expect(tab.getByRole("table", { name: "Jobs table", exact: true })
      .getByRole("link", { name: "Synthetic Reconciled Gap Engineer", exact: true })).toBeVisible();
    const replacement = (await targets())[0]!;
    expect(replacement.targetId).not.toBe(original.targetId);
    expect((await sharedWorkerEventSources(browser, replacement.targetId)).filter((source) => source.readyState === 1)).toHaveLength(1);
    await json(api, "post", "/v1/jobs/capture", { url: "https://example.com/jobs/shared-tab-restored", title: "Synthetic Restored Stream Engineer", company: "Synthetic Shared Company", description: "Observe subsequent committed events after shared transport recovery." });
    for (const tab of survivors) await expect(tab.getByRole("table", { name: "Jobs table", exact: true })
      .getByRole("link", { name: "Synthetic Restored Stream Engineer", exact: true })).toBeVisible();
    expect((await json<{ total: number }>(api, "get", "/v1/jobs")).total).toBe(4);
    expect(app.external.calls).toHaveLength(0);
    expect(errors).toEqual([]);
    await testInfo.attach("shared-stream-multi-tab", { contentType: "application/json", body: JSON.stringify({ tabs: pages.length, originalTarget: original.targetId, replacementTarget: replacement.targetId, sources: await sharedWorkerEventSources(browser, replacement.targetId), jobs: 4, errors }) });
    await testInfo.attach("shared-stream-recovered-jobs", { contentType: "image/png", body: await writer.screenshot({ animations: "disabled" }) });
    await Promise.all(survivors.map((tab) => tab.goto("about:blank")));
    await expect.poll(async () => {
      const remaining = await targets();
      let upstreams = 0;
      for (const target of remaining) {
        try { upstreams += (await sharedWorkerEventSources(browser, target.targetId)).length; }
        catch (error) {
          // A worker removed while being inspected has released its upstream.
          if ((await targets()).some((current) => current.targetId === target.targetId)) throw error;
        }
      }
      return upstreams;
    }, { message: "the last page unsubscribe closes the native upstream" }).toBe(0);
  } finally {
    await Promise.all(pages.filter((tab) => !tab.isClosed()).map((tab) => tab.close()));
  }
});
