import { action, completed, expect, json, terminal, test } from "../harness/fixtures.js";
import { indeedPage } from "./indeed-data.js";

test.use({ features: "profile,jobs,discovery", sourceRevision: "8505435bbbf11d516c4b42b83df1337643b27456" });

test("upgrading retires employer feeds while preserving saved jobs and board state", async ({ api, app }) => {
  const sourcesUrl = "/v1/discovery/sources";
  const boardId = "jobstreaming:indeed";
  const oldId = "ats:synthetic-retired";
  const oldSource = { sourceId: oldId, kind: "ats_api", displayName: "Synthetic retired employer", state: "active" };
  await json(api, "post", sourcesUrl, oldSource);
  const saved = await json<{ job_id: string }>(api, "post", "/v1/jobs/capture", {
    url: "https://example.com/jobs/older-role", title: "Previously saved technical role", company: "Synthetic employer",
    description: "Maintains the scheduling service.", source_id: oldId,
  });
  type Registry = { sources: { sourceId: string; revision: number; state: string }[] };
  const before = await json<Registry>(api, "get", sourcesUrl);
  const linkedIn = before.sources.find((s) => s.sourceId === "jobstreaming:linkedin")!;
  await json(api, "patch", sourcesUrl + "/" + linkedIn.sourceId + "/state", { state: "disabled", expectedRevision: linkedIn.revision });
  expect(before.sources.some((s) => s.sourceId === oldId)).toBe(true);

  await app.upgradeSource();
  const after = await json<Registry>(api, "get", sourcesUrl);
  expect(after.sources.map((s) => s.sourceId).sort()).toEqual(
    ["bayt", "bdjobs", "glassdoor", "google", "indeed", "linkedin", "naukri", "zip_recruiter"].map((id) => "jobstreaming:" + id),
  );
  expect(after.sources.find((s) => s.sourceId === linkedIn.sourceId)).toMatchObject({ state: "disabled", revision: linkedIn.revision + 1 });
  expect(await json(api, "get", "/v1/jobs/" + saved.job_id)).toMatchObject({ job_id: saved.job_id, title: "Previously saved technical role" });
  expect((await api.post(sourcesUrl, { data: oldSource })).status()).toBe(404);
  expect((await api.patch(sourcesUrl + "/" + oldId + "/state", { data: { expectedRevision: 1, state: "active" } })).status()).toBe(404);
  expect((await api.get("/v1/discovery/locator-candidates")).status()).toBe(404);
  const board = after.sources.find((s) => s.sourceId === boardId)!;
  const stateUrl = sourcesUrl + "/" + boardId + "/state";
  expect((await api.patch(stateUrl, { data: { expectedRevision: board.revision, state: "active", adapterConfig: { board: "alternate" } } })).status()).toBe(400);
  await json(api, "patch", stateUrl, { expectedRevision: board.revision, state: "experimental" });
  expect((await api.patch(stateUrl, { data: { expectedRevision: board.revision, state: "disabled" } })).status()).toBe(409);

  const started = await action(api, "discovery.search", { boards: ["indeed"], queries: ["Synthetic engineer"], locations: ["Madrid"], hoursOld: 0, newJobLimit: 1 });
  const call = await app.external.next();
  expect(call.path).toBe("/jobstreaming/indeed");
  call.respond(indeedPage({ jobs: [{ job_key: "sdk-upgrade", title: "Synthetic engineer", company: "Synthetic board employer", description: "Develops the scheduling service." }], cursor: null, complete: true }));
  expect((await completed(api, started.runId)).result).toMatchObject({ newJobs: 1 });
  expect(app.external.calls.map((item) => item.path)).toEqual(["/jobstreaming/indeed"]);
});

test("a restarted worker fences an unfinished search that included a retired source", async ({ api, app }) => {
  await json(api, "post", "/v1/discovery/sources", {
    sourceId: "ats:unconfigured-upgrade", kind: "ats_api", displayName: "Unconfigured synthetic ATS", state: "active",
  });
  const started = await action(api, "discovery.search", {
    boards: ["indeed"], queries: ["Synthetic engineer"], locations: ["Madrid"], hoursOld: 0, newJobLimit: 1,
  });
  const waiting = await app.external.next();
  expect(waiting.path).toBe("/jobstreaming/indeed");
  await app.upgradeSource();
  expect((await terminal(api, started.runId)).status).toBe("failed");
  const { runs } = await json<{ runs: { runId: string; status: string; failureCode: string; newJobs: number }[] }>(api, "get", "/v1/discovery/runs");
  expect(runs.find((run) => run.runId === started.runId)).toMatchObject({
    status: "failed", failureCode: "discovery_source_retired", newJobs: 0,
  });
  expect(app.external.calls.map((call) => call.path)).toEqual(["/jobstreaming/indeed"]);
});
