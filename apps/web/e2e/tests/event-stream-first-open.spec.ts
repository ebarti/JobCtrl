import { expect, test, type Page, type Route } from "@playwright/test";
import Database from "better-sqlite3";
import type { ProfileConfigResponse } from "@jobctrl/contracts";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

import { loadE2eDbPath } from "../fixtures/e2e-state.js";

test.setTimeout(90_000);

function gate() {
  let release!: () => void;
  const promise = new Promise<void>((resolve) => { release = resolve; });
  return { promise, release };
}

async function readProfile(page: Page): Promise<ProfileConfigResponse> {
  const response = await page.request.get("/v1/profile");
  expect(response.ok()).toBe(true);
  return await response.json() as ProfileConfigResponse;
}

async function writeProfile(page: Page, origin: string, base: ProfileConfigResponse, name: string): Promise<ProfileConfigResponse> {
  const profile = structuredClone(base.profile) as { personal: { full_name: string } };
  profile.personal.full_name = name;
  const response = await page.request.patch("/v1/profile", {
    headers: { origin, "sec-fetch-site": "same-origin" },
    data: { profile, expectedProfileVersion: base.profileVersion },
  });
  expect(response.ok(), await response.text()).toBe(true);
  return await response.json() as ProfileConfigResponse;
}

function profileName(response: ProfileConfigResponse): string {
  return (response.profile as { personal: { full_name: string } }).personal.full_name;
}

async function restoreProfile(page: Page, original: ProfileConfigResponse, origin: string) {
  const current = await readProfile(page);
  const response = await page.request.patch("/v1/profile", {
    headers: { origin, "sec-fetch-site": "same-origin" },
    data: { profile: original.profile, expectedProfileVersion: current.profileVersion },
  });
  expect(response.ok(), await response.text()).toBe(true);
}

async function observeNativeStream(page: Page) {
  await page.addInitScript(() => {
    const state = window as Window & { streamOpens?: number; streamErrors?: number };
    state.streamOpens = 0;
    state.streamErrors = 0;
    const NativeEventSource = window.EventSource;
    class ObservedEventSource extends NativeEventSource {
      constructor(url: string | URL, options?: EventSourceInit) {
        super(url, options);
        this.addEventListener("open", () => { state.streamOpens! += 1; });
        this.addEventListener("error", () => { state.streamErrors! += 1; });
      }
    }
    window.EventSource = ObservedEventSource;
  });
}

async function waitForNativeOpen(page: Page) {
  await page.waitForFunction(() => (window as Window & { streamOpens?: number }).streamOpens! > 0);
}

function latestProfileEventId(): number {
  const db = new Database(loadE2eDbPath(), { readonly: true });
  try {
    return (db.prepare("SELECT COALESCE(MAX(event_id), 0) AS id FROM job_events WHERE event_type = 'ProfileUpdated'").get() as { id: number }).id;
  } finally {
    db.close();
  }
}

test("first connection reconciles a write committed before the server cursor", async ({ page, baseURL }, testInfo) => {
  await page.setViewportSize({ width: 1440, height: 1000 });
  const origin = new URL(baseURL!).origin;
  const original = await readProfile(page);
  const baseline = await writeProfile(page, origin, original, "Synthetic Initial Candidate");
  const streamGate = gate();
  let attempts = 0;
  let held = 0;
  let profileReads = 0;
  const errors: string[] = [];
  const consoleErrors: string[] = [];
  const streamEvents: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  page.on("console", (message) => {
    if (message.type() === "error" && !message.text().includes("net::ERR_FAILED")) consoleErrors.push(message.text());
  });
  page.on("request", (request) => {
    if (new URL(request.url()).pathname === "/v1/profile" && request.method() === "GET") profileReads++;
  });
  await observeNativeStream(page);
  const cdp = await page.context().newCDPSession(page);
  await cdp.send("Network.enable");
  cdp.on("Network.eventSourceMessageReceived", (event) => streamEvents.push(event.eventName));
  await page.route("**/v1/events/stream**", async (route) => {
    attempts++;
    const url = new URL(route.request().url());
    expect(url.searchParams.has("since")).toBe(false);
    if (attempts <= 2) {
      await route.abort("failed").catch(() => undefined);
      return;
    }
    held++;
    await streamGate.promise;
    await route.continue().catch(() => undefined);
  });

  try {
    await page.goto("/profile", { waitUntil: "domcontentloaded" });
    await expect(page).toHaveTitle(/JobCtrl/);
    const name = page.getByLabel("Full name", { exact: true });
    await expect(name).toHaveValue("Synthetic Initial Candidate", { timeout: 30_000 });
    await page.waitForFunction(() => (window as Window & { streamErrors?: number }).streamErrors! > 0);
    await expect.poll(() => held, { timeout: 15_000 }).toBeGreaterThan(0);
    const beforeEvent = latestProfileEventId();
    const changed = await writeProfile(page, origin, baseline, "Synthetic Canonical Candidate");
    expect(changed.profileVersion).toBeGreaterThan(baseline.profileVersion!);
    expect(latestProfileEventId()).toBeGreaterThan(beforeEvent);
    const readsBeforeOpen = profileReads;
    expect(await name.inputValue()).toBe("Synthetic Initial Candidate");
    streamGate.release();
    await waitForNativeOpen(page);
    await expect(name).toHaveValue("Synthetic Canonical Candidate", { timeout: 15_000 });
    expect(profileReads).toBeGreaterThan(readsBeforeOpen);
    expect(streamEvents).not.toContain("ProfileUpdated");
    expect(errors).toEqual([]);
    expect(consoleErrors).toEqual([]);
    await expect(page.locator("vite-error-overlay")).toHaveCount(0);
    await page.screenshot({ path: testInfo.outputPath("first-open-reconciled.png") });
  } finally {
    streamGate.release();
    await restoreProfile(page, original, origin);
  }
});

test("first connection waits for an initial profile read and preserves its loader", async ({ page, baseURL }) => {
  const origin = new URL(baseURL!).origin;
  const original = await readProfile(page);
  const baseline = await writeProfile(page, origin, original, "Synthetic Pending Candidate");
  const streamGate = gate();
  const readGate = gate();
  const readCaptured = gate();
  let intercepted = false;
  let streamRequests = 0;
  let profileReads = 0;
  await observeNativeStream(page);
  await page.route("**/v1/events/stream**", async (route) => {
    streamRequests++;
    await streamGate.promise;
    await route.continue().catch(() => undefined);
  });
  await page.route("**/v1/profile", async (route: Route) => {
    if (route.request().method() === "GET") {
      profileReads++;
      if (!intercepted) {
        intercepted = true;
        const response = await route.fetch();
        expect(profileName(await response.json() as ProfileConfigResponse)).toBe("Synthetic Pending Candidate");
        readCaptured.release();
        await readGate.promise;
        await route.fulfill({ response });
        return;
      }
    }
    await route.continue();
  });
  try {
    await page.goto("/profile", { waitUntil: "domcontentloaded" });
    await readCaptured.promise;
    await expect.poll(() => streamRequests).toBeGreaterThan(0);
    const beforeEvent = latestProfileEventId();
    await writeProfile(page, origin, baseline, "Synthetic Newest Candidate");
    expect(latestProfileEventId()).toBeGreaterThan(beforeEvent);
    streamGate.release();
    await waitForNativeOpen(page);
    expect(profileReads).toBe(1);
    readGate.release();
    await expect(page.getByLabel("Full name", { exact: true })).toHaveValue("Synthetic Newest Candidate", { timeout: 30_000 });
    expect(profileReads).toBeGreaterThan(1);
  } finally {
    streamGate.release();
    readGate.release();
    await restoreProfile(page, original, origin);
  }
});

test("first connection retains a pending profile edit while reading the canonical update", async ({ page, baseURL }, testInfo) => {
  await page.setViewportSize({ width: 1440, height: 1000 });
  const origin = new URL(baseURL!).origin;
  const original = await readProfile(page);
  const baseline = await writeProfile(page, origin, original, "Synthetic Draft Baseline");
  const streamGate = gate();
  const saveGate = gate();
  const saveStarted = gate();
  let streamRequests = 0;
  await observeNativeStream(page);
  await page.route("**/v1/events/stream**", async (route) => {
    streamRequests++;
    await streamGate.promise;
    await route.continue().catch(() => undefined);
  });
  await page.route("**/v1/profile", async (route) => {
    if (route.request().method() === "PATCH") {
      saveStarted.release();
      await saveGate.promise;
    }
    await route.continue().catch(() => undefined);
  });
  try {
    await page.goto("/profile", { waitUntil: "domcontentloaded" });
    const name = page.getByLabel("Full name", { exact: true });
    await expect(name).toHaveValue("Synthetic Draft Baseline", { timeout: 30_000 });
    await expect.poll(() => streamRequests).toBeGreaterThan(0);
    await name.fill("Synthetic Unsaved Draft");
    await expect(page.getByText("Unsaved changes", { exact: true })).toBeVisible();
    const conflictedSave = page.waitForResponse((response) =>
      new URL(response.url()).pathname === "/v1/profile" && response.request().method() === "PATCH" && response.status() === 409,
    );
    await page.getByRole("button", { name: "Save changes", exact: true }).click();
    await saveStarted.promise;
    await expect(page.getByRole("button", { name: "Saving changes", exact: true })).toBeVisible();
    const changed = await writeProfile(page, origin, baseline, "Synthetic Saved Elsewhere");
    const refreshed = page.waitForResponse((response) =>
      new URL(response.url()).pathname === "/v1/profile" && response.request().method() === "GET" && response.ok(),
    );
    streamGate.release();
    await waitForNativeOpen(page);
    const response = await refreshed;
    const canonical = await response.json() as ProfileConfigResponse;
    expect(canonical.profileVersion).toBe(changed.profileVersion);
    expect(profileName(canonical)).toBe("Synthetic Saved Elsewhere");
    await expect(name).toHaveValue("Synthetic Unsaved Draft");
    await expect(page.getByRole("button", { name: "Saving changes", exact: true })).toBeVisible();
    await expect(page.getByRole("button", { name: "Rebase edits onto saved profile" })).toBeVisible();
    await page.screenshot({ path: testInfo.outputPath("first-open-pending-draft.png") });
    saveGate.release();
    expect((await conflictedSave).status()).toBe(409);
    await expect(name).toHaveValue("Synthetic Unsaved Draft");
  } finally {
    streamGate.release();
    saveGate.release();
    await restoreProfile(page, original, origin);
  }
});

test("first open merges missed durable Apply history with an event arriving during refresh", async ({ page }, testInfo) => {
  await page.setViewportSize({ width: 1440, height: 1000 });
  const db = new Database(loadE2eDbPath());
  const streamGate = gate();
  const readGate = gate();
  const readCaptured = gate();
  const jobId = "00000000-0000-4000-8000-00000000a484";
  const runId = "qa-lagged-apply-run";
  const workflowMessage = "Synthetic Apply workflow started";
  let workflowEventId: number | bigint | undefined;
  let streams = 0;
  const streamEvents: Array<{ eventName: string; data: string }> = [];
  await observeNativeStream(page);
  const cdp = await page.context().newCDPSession(page);
  await cdp.send("Network.enable");
  cdp.on("Network.eventSourceMessageReceived", (event) => streamEvents.push({ eventName: event.eventName, data: event.data }));
  await page.route("**/v1/events/stream**", async (route) => {
    streams++;
    await streamGate.promise;
    await route.continue().catch(() => undefined);
  });
  try {
    db.prepare("INSERT INTO jobs (tenant_id, job_id, url, title, company, site, discovered_at) VALUES ('local', ?, 'https://example.test/qa-apply', 'Synthetic job', 'Synthetic', 'test', ?)")
      .run(jobId, "2026-05-04T12:00:00Z");
    db.prepare("INSERT INTO job_stage_states (tenant_id, job_id, stage, state, updated_at) VALUES ('local', ?, 'apply', 'running', ?)")
      .run(jobId, "2026-05-04T12:00:00Z");
    const startedAt = "2026-05-04T12:00:00Z";
    db.prepare(`INSERT INTO workflow_run_projections
      (workflow_id, tenant_id, workflow_type, status, input_summary_json, retryable, started_at, events_json)
      VALUES (?, 'local', 'ApplyWorkflow', 'in_progress', '{}', 0, ?, ?)`)
      .run(runId, startedAt, JSON.stringify([{ eventType: "WorkflowStarted", occurredAt: startedAt,
        status: "in_progress", message: workflowMessage }]));
    workflowEventId = db.prepare(`INSERT INTO job_events
      (tenant_id, job_id, identity_version, stage, event_type, level, message, occurred_at, payload_json)
      VALUES ('local', NULL, 1, 'workflow', 'WorkflowStarted', 'info', ?, ?, ?)`)
      .run(workflowMessage, startedAt, JSON.stringify({ workflowId: runId, workflowType: "ApplyWorkflow",
        status: "in_progress", startedAt, message: workflowMessage })).lastInsertRowid;
    const insert = db.prepare(`INSERT INTO job_events
      (tenant_id, job_id, identity_version, stage, event_type, level, message, occurred_at, payload_json)
      VALUES ('local', ?, 1, 'apply', ?, 'info', ?, ?, ?)`);
    insert.run(jobId, "ApplyRunStarted", "Synthetic Apply start", "2026-05-04T12:00:00Z", JSON.stringify({ run_id: runId }));
    const writeSaga = (count: number) => {
      const result = spawnSync("uv", ["--project", "workers/automation", "run", "--locked", "--no-sync", "python",
        fileURLToPath(new URL("../fixtures/write-apply-saga-event.py", import.meta.url)), loadE2eDbPath(), jobId, runId, String(count)], {
        cwd: fileURLToPath(new URL("../../../../", import.meta.url)), encoding: "utf8", timeout: 30_000,
      });
      expect(result.status, result.stderr).toBe(0);
    };
    const initialRead = page.waitForResponse((response) =>
      new URL(response.url()).pathname === `/v1/workflow-runs/${runId}` && response.ok(), { timeout: 30_000 });
    await page.goto(`/jobs/${jobId}/run/${runId}`, { waitUntil: "domcontentloaded" });
    expect((await (await initialRead).json()).events).toEqual(expect.arrayContaining([
      expect.objectContaining({ eventType: "WorkflowStarted", message: workflowMessage }),
    ]));
    await expect(page.getByText(workflowMessage)).toBeVisible({ timeout: 30_000 });
    await expect.poll(() => streams).toBeGreaterThan(0);
    writeSaga(1);
    expect(db.prepare("SELECT 1 FROM apply_run_projections WHERE tenant_id = 'local' AND run_id = ?").get(runId)).toBeUndefined();
    await page.route(`**/v1/workflow-runs/${runId}**`, async (route) => {
      const response = await route.fetch();
      readCaptured.release();
      await readGate.promise;
      await route.fulfill({ response }).catch(() => undefined);
    });
    streamGate.release();
    await waitForNativeOpen(page);
    await readCaptured.promise;
    writeSaga(2);
    await expect(page.getByText("Live synthetic Apply event")).toBeVisible({ timeout: 15_000 });
    const liveFrame = streamEvents.find((event) => event.eventName === "ApplyRunEventRecorded" && event.data.includes("Live synthetic Apply event"));
    expect(liveFrame).toBeDefined();
    expect(liveFrame!.data).not.toContain("private_synthetic_canary");
    readGate.release();
    await expect(page.getByText("Missed synthetic Apply event")).toBeVisible({ timeout: 15_000 });
    await expect(page.getByText("Live synthetic Apply event")).toHaveCount(1);
    const detail = await (await page.request.get(`/v1/workflow-runs/${runId}?jobId=${jobId}`)).json();
    expect(detail.applyEvents).toEqual(expect.arrayContaining([
      expect.objectContaining({ runEventId: 1, message: "Missed synthetic Apply event" }),
      expect.objectContaining({ runEventId: 2, message: "Live synthetic Apply event" }),
    ]));
    expect(db.prepare("SELECT event_type FROM job_events WHERE tenant_id = 'local' AND job_id = ? AND event_type IN ('SagaStarted', 'BrowserLaunched') ORDER BY event_id").all(jobId))
      .toEqual([{ event_type: "SagaStarted" }, { event_type: "BrowserLaunched" }]);
    await page.screenshot({ path: testInfo.outputPath("first-open-apply-timeline.png") });
  } finally {
    streamGate.release();
    readGate.release();
    db.prepare("DELETE FROM job_events WHERE tenant_id = 'local' AND job_id = ?").run(jobId);
    if (workflowEventId !== undefined) db.prepare("DELETE FROM job_events WHERE event_id = ?").run(workflowEventId);
    db.prepare("DELETE FROM apply_run_projections WHERE tenant_id = 'local' AND run_id = ?").run(runId);
    db.prepare("DELETE FROM workflow_run_projections WHERE tenant_id = 'local' AND workflow_id = ?").run(runId);
    db.prepare("DELETE FROM job_stage_states WHERE tenant_id = 'local' AND job_id = ?").run(jobId);
    db.prepare("DELETE FROM jobs WHERE tenant_id = 'local' AND job_id = ?").run(jobId);
    db.close();
  }
});

test("first open preserves a resume-template draft when another version is saved", async ({ page, baseURL }, testInfo) => {
  await page.setViewportSize({ width: 1440, height: 1000 });
  const origin = new URL(baseURL!).origin;
  const headers = { origin, "sec-fetch-site": "same-origin" };
  const initial = await (await page.request.get("/v1/resume-templates")).json();
  const sample = initial.templates[0];
  const created = await page.request.post("/v1/resume-templates", {
    headers,
    data: { displayName: "Synthetic Test Template", theme: sample.activeVersion.theme, layout: sample.activeVersion.layout },
  });
  expect(created.ok(), await created.text()).toBe(true);
  const createdTemplate = (await created.json()).template;
  const templateId = createdTemplate.templateId as string;
  const streamGate = gate();
  let streams = 0;
  await observeNativeStream(page);
  await page.route("**/v1/events/stream**", async (route) => {
    streams++;
    await streamGate.promise;
    await route.continue().catch(() => undefined);
  });
  try {
    await page.goto("/preferences", { waitUntil: "domcontentloaded" });
    const controls = page.getByRole("group", { name: "Template settings" });
    await expect(controls).toBeVisible({ timeout: 30_000 });
    await controls.getByLabel("Template", { exact: true }).click();
    await page.getByRole("option", { name: "Synthetic Test Template" }).click();
    const name = controls.getByLabel("Name", { exact: true });
    await expect(name).toHaveValue("Synthetic Test Template");
    await name.fill("Synthetic Unsaved Template");
    await controls.getByLabel("Font scale", { exact: true }).fill("1.1");
    await expect.poll(() => streams).toBeGreaterThan(0);
    const changed = await page.request.post("/v1/resume-templates", {
      headers,
      data: { templateId, expectedVersionId: createdTemplate.activeVersion.versionId, displayName: "Synthetic Saved Elsewhere", theme: createdTemplate.activeVersion.theme, layout: createdTemplate.activeVersion.layout },
    });
    expect(changed.ok(), await changed.text()).toBe(true);
    const refreshed = page.waitForResponse((response) =>
      new URL(response.url()).pathname === "/v1/resume-templates" && response.request().method() === "GET" && response.ok(),
    );
    streamGate.release();
    await waitForNativeOpen(page);
    const canonical = await (await refreshed).json();
    expect(canonical.templates.find((template: { templateId: string }) => template.templateId === templateId).displayName).toBe("Synthetic Saved Elsewhere");
    await expect(name).toHaveValue("Synthetic Unsaved Template");
    await expect(controls.getByLabel("Font scale", { exact: true })).toHaveValue("1.1");
    await page.screenshot({ path: testInfo.outputPath("first-open-template-draft.png") });
    await controls.getByRole("button", { name: "Keep draft and review latest version" }).click();
    const saved = page.waitForResponse((response) =>
      new URL(response.url()).pathname === "/v1/resume-templates" && response.request().method() === "POST" && response.ok(),
    );
    await controls.getByRole("button", { name: "save version" }).click();
    const result = await (await saved).json();
    expect(result.template.displayName).toBe("Synthetic Unsaved Template");
    expect(result.template.activeVersion.theme.fontScale).toBe(1.1);
    await expect(name).toHaveValue("Synthetic Unsaved Template");
  } finally {
    streamGate.release();
    const db = new Database(loadE2eDbPath());
    try {
      db.transaction(() => {
        db.prepare("DELETE FROM resume_template_versions WHERE tenant_id = 'local' AND template_id = ?").run(templateId);
        db.prepare("DELETE FROM resume_templates WHERE tenant_id = 'local' AND template_id = ?").run(templateId);
        db.prepare("DELETE FROM job_events WHERE tenant_id = 'local' AND event_type = 'ResumeTemplateVersionSaved' AND json_valid(payload_json) AND json_extract(payload_json, '$.templateId') = ?").run(templateId);
      })();
    } finally { db.close(); }
  }
});
