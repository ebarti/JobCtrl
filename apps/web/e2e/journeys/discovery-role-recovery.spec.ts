import { indeedPage } from "./indeed-data.js";
import type { APIRequestContext } from "@playwright/test";
import { action, completed, expect, json, modelCall, terminal, test, type ApplicationStack, type ExternalCall } from "../harness/fixtures.js";
import { baseline, createBaseline } from "./core-data.js";
import { citeSources } from "./requirements-data.js";
import { serveRoleTarget } from "./discovery-role-scope-data.js";

test.use({ features: "profile,jobs,discovery" });

async function setup(api: APIRequestContext) {
  const { profile } = await createBaseline(api, { ...baseline, experience: { target_role: "Synthetic engineering lead", target_locations: "Madrid" } });
  const policy = await json<{ revision: number }>(api, "get", "/v1/settings");
  await json(api, "patch", "/v1/settings", { expectedRevision: policy.revision, dailyBudgetUsd: 0 });
  const saved = await json<{ revision: number }>(api, "get", "/v1/discovery/settings");
  await json(api, "patch", "/v1/discovery/settings", { expectedRevision: saved.revision, boards: ["indeed"], hoursOld: 0, newJobLimit: 1 });
  return { queries: [], locations: [], expectedProfileVersion: profile.profileVersion };
}

function listing(id: string) {
  return { job_key: id, title: "Synthetic position " + id, company: "Synthetic employer",
    description: "Synthetic responsibilities for " + id, location: "Madrid", url: "https://www.indeed.com/viewjob?jk=" + id };
}

async function board(app: ApplicationStack, id: string) {
  const call = await app.external.next({ timeout: 50_000 });
  expect(call.path).toBe("/jobstreaming/indeed");
  call.respond(indeedPage({ jobs: [listing(id)], cursor: null, complete: true }));
}

function reply(call: ExternalCall) {
  expect(call.body["operation"]).toBe("discovery.role_target_match");
  call.reply({ verdict: "match", citations: citeSources(call, ["target:roles", "posting:description"]), rationale: "Synthetic decision over the offered sources." });
}

test("a saved role search never dispatches a second paid decision after losing its worker during provider execution", async ({ api, app }) => {
  test.setTimeout(110_000);
  const controls = await setup(api);
  const { runId } = await action(api, "discovery.search", controls);
  await board(app, "interrupted");
  const interrupted = await modelCall(app, "discovery.role_target_match");
  try {
    await app.restartWorker();
    await board(app, "interrupted");
    const done = terminal(api, runId);
    const duplicate = await Promise.race([done.then(() => null), app.external.next({ timeout: 45_000 })]);
    // Complete an unexpected dispatch so its erroneous terminal publication
    // is visible alongside the call count instead of masking it with a timeout.
    if (duplicate) reply(duplicate);
    const status = (await done).status;
    const calls = app.external.calls.filter((call) => call.body?.["operation"] === "discovery.role_target_match").length;
    const { total } = await json<{ total: number }>(api, "get", "/v1/jobs");
    expect({ calls, status, total }).toEqual({ calls: 1, status: "failed", total: 0 });
    const { runs } = await json<{ runs: { runId: string; failures: { code: string }[] }[] }>(api, "get", "/v1/discovery/runs");
    expect(runs.find((run) => run.runId === runId)?.failures).toContainEqual(expect.objectContaining({ code: "discovery_role_call_unsettled" }));
  } finally {
    if (!interrupted.closed) interrupted.disconnect();
  }
});

test("a durable saved role search waits for an unrelated historical review to release the discovery lane", async ({ api, app }) => {
  test.setTimeout(80_000);
  const controls = await setup(api);
  const first = await action(api, "discovery.search", controls);
  await board(app, "holder");
  await serveRoleTarget(app, "match");
  await completed(api, first.runId);
  const { jobs } = await json<{ jobs: { job_id: string; revision: number }[] }>(api, "get", "/v1/jobs");
  const saved = jobs[0]!;
  const changed = await json<{ revision: number }>(api, "post", "/v1/jobs/capture", {
    ...listing("holder"), source_id: "manual", captureId: "held-role-source",
    description: "New synthetic responsibilities for the held review.", expectedRevision: saved.revision,
  });
  const path = `/v1/discovery/runs/${first.runId}/jobs/${saved.job_id}/role-target`;
  const data = { expectedPostingRevision: changed.revision };
  const review = api.post(path, { data, timeout: 70_000 });
  const held = await modelCall(app, "discovery.role_target_match");
  try {
    const concurrent = await api.post(path, { data, timeout: 3000 });
    expect(concurrent.status()).toBe(409);
    expect((await concurrent.json()).error.code).toBe("discovery_role_call_unsettled");
    const search = await action(api, "discovery.search", controls);
    await board(app, "waiting");
    const query = new URLSearchParams({ aggregateId: search.runId, type: "DiscoveryRoleTargetWaiting" });
    await expect.poll(async () => {
      const { events } = await json<{ events: { payload: { reason: string } }[] }>(api, "get", `/v1/events?${query}`);
      if (events.some((event) => event.payload.reason === "model_lane_busy")) return "waiting";
      const { runs } = await json<{ runs: { runId: string; status: string }[] }>(api, "get", "/v1/discovery/runs");
      return runs.find((run) => run.runId === search.runId)?.status;
    }, { timeout: 6000 }).toBe("waiting");
    expect(app.external.calls.filter((call) => call.body?.["operation"] === "discovery.role_target_match")).toHaveLength(2);
    reply(held);
    expect((await review).ok()).toBe(true);
    await serveRoleTarget(app, "match");
    expect((await completed(api, search.runId)).result).toMatchObject({ newJobs: 1, observedJobs: 1, failures: [] });
    // The same historical request resolves its own paid result.
    expect((await api.post(path, { data })).ok()).toBe(true);
    expect(app.external.calls.filter((call) => call.body?.["operation"] === "discovery.role_target_match")).toHaveLength(3);
    const revised = await json<{ revision: number }>(api, "post", "/v1/jobs/capture", {
      ...listing("holder"), source_id: "manual", captureId: "refused-role-source",
      description: "A third synthetic posting revision for explicit review.", expectedRevision: changed.revision,
    });
    const refuseData = { expectedPostingRevision: revised.revision };
    const refuse = api.post(path, { data: refuseData });
    await serveRoleTarget(app, "match", "unknown_verdict");
    const previous = await refuse;
    expect(previous.status()).toBe(502);
    const replayed = await api.post(path, { data: refuseData });
    expect(replayed.status()).toBe(previous.status());
    expect((await replayed.json()).error.code).toBe((await previous.json()).error.code);
    expect((await json<{ decision: unknown }>(api, "get", path)).decision).toBeNull();
    expect(app.external.calls.filter((call) => call.body?.["operation"] === "discovery.role_target_match")).toHaveLength(4);
  } finally {
    if (!held.closed) held.disconnect();
    await review.catch(() => {});
  }
});
