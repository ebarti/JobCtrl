import type { Page, Request } from "@playwright/test";

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
      .toEqual([{ url: `${app.baseURL}/v1/events/stream?tenantId=local&envelope=1&after=latest&cursor=workspace`, readyState: 1 }]);

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

test("Jobs tabs reconnect to the same database and require reload when the workspace changes at the same URL", async ({
  page, context, api, app,
}) => {
  const peer = await context.newPage();
  const health = () => json<{ databaseInstanceId: string }>(api, "get", "/v1/health");
  const jobs = () => json<{ total: number }>(api, "get", "/v1/jobs");
  const job = (tab: Page, title: string) => tab.getByRole("table", { name: "Jobs table", exact: true })
    .getByRole("link", { name: title, exact: true });
  const capture = (suffix: string, title: string) => json(api, "post", "/v1/jobs/capture", {
    url: `https://example.com/jobs/${suffix}`, title, company: "Synthetic Stream Restart Company",
    description: "Verify canonical jobs follow the selected workspace.",
  });
  // Hold unrelated page reads through the intentional listener gap. The real
  // EventSource is left free to disconnect from and reconnect to the real API.
  const jobsReads = new Set(["/v1/health", "/v1/preparation/runs", "/v1/jobs/query", "/v1/jobs",
    "/v1/jobs/url-imports", "/v1/digest"]);
  const inFlightReads = new Set<Request>();
  let releaseReads: () => void;
  let readGate: Promise<void> | undefined;
  const finishRead = (request: Request) => inFlightReads.delete(request);
  context.on("requestfinished", finishRead);
  context.on("requestfailed", finishRead);
  await context.route((url) => url.origin === app.baseURL && jobsReads.has(url.pathname), async (route) => {
    if (route.request().method() === "GET") {
      if (readGate) await readGate;
      inFlightReads.add(route.request());
    }
    await route.continue();
  });
  const restart = async (freshWorkspace = false) => {
    readGate = new Promise<void>((resolve) => { releaseReads = resolve; });
    try {
      await expect.poll(() => inFlightReads.size).toBe(0);
      await app.restartApi({ freshWorkspace });
    } finally {
      readGate = undefined;
      releaseReads();
    }
  };
  try {
    await Promise.all([page.goto("/jobs"), peer.goto("/jobs")]);
    for (const tab of [page, peer]) await expect(tab.locator(".connection-pill")).toHaveText("Live");
    const before = await health();
    await capture("before-restart", "Synthetic Before Restart Engineer");
    for (const tab of [page, peer]) await expect(job(tab, "Synthetic Before Restart Engineer")).toBeVisible();

    await restart();
    expect((await health()).databaseInstanceId).toBe(before.databaseInstanceId);
    await capture("after-restart", "Synthetic After Restart Engineer");
    for (const tab of [page, peer]) {
      await expect(job(tab, "Synthetic After Restart Engineer")).toBeVisible({ timeout: 15_000 });
      await expect(tab.locator(".connection-pill")).toHaveText("Live");
    }

    await restart(true);
    const after = await health();
    expect(after.databaseInstanceId).not.toBe(before.databaseInstanceId);
    expect((await jobs()).total).toBe(0);
    for (const tab of [page, peer]) {
      await expect(tab.locator(".connection-pill")).toHaveText("Workspace changed", { timeout: 15_000 });
      await expect(tab.getByRole("alert").filter({ hasText: "The workspace database changed." })).toBeVisible();
    }

    await capture("after-switch", "Synthetic Other Workspace Engineer");
    // Position zero is valid in both databases. Identity alone must refuse replay.
    const refused = await api.get("/v1/events/stream?after=latest&cursor=workspace", {
      headers: { "Last-Event-ID": `${before.databaseInstanceId}:0` }, timeout: 5_000,
    });
    expect(refused.status()).toBe(200);
    expect(await refused.text()).toBe('event: workspace_changed\ndata: {"code":"workspace_changed"}\n\n');
    const malformed = await api.get("/v1/events/stream?after=invalid&cursor=workspace");
    expect(malformed.status()).toBe(400);
    expect((await malformed.json()).error.code).toBe("invalid_event_cursor");
    const unavailable = await api.get("/v1/events/stream?after=9999999");
    expect(unavailable.status()).toBe(409);
    expect((await unavailable.json()).error.code).toBe("event_cursor_unavailable");

    await page.reload();
    await expect(page.locator(".connection-pill")).toHaveText("Live");
    await expect(job(page, "Synthetic Other Workspace Engineer")).toBeVisible();
    await expect(job(page, "Synthetic Before Restart Engineer")).toHaveCount(0);
    await expect(peer.locator(".connection-pill")).toHaveText("Workspace changed");
  } finally {
    await peer.close();
  }
});
