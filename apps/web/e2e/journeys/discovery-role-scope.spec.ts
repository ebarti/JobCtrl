import { indeedPage } from "./indeed-data.js";
import { action, completed, expect, json, terminal, test } from "../harness/fixtures.js";
import { baseline, createBaseline } from "./core-data.js";
import { serveRoleTarget } from "./discovery-role-scope-data.js";

test.use({ features: "profile,jobs,discovery" });

type Scope = { verdict: string; targetPlanId: string; profileRevision: number; provenance: { receipt_id: string; lane: string } };
type Job = { job_id: string; revision: number; title: string; provenance: { roleTargetMatch?: Scope } };
type Review = { decision: Scope | null; jobId: string; postingRevision: number };

test("saved role targets require cited scope before a provider listing spends capacity and allow a source-bound review of saved jobs", async ({ api, app }) => {
  const { profile } = await createBaseline(api, { ...baseline, experience: { target_role: "Synthetic systems leadership", target_locations: "Madrid" } });
  const settings = await json<{ revision: number }>(api, "get", "/v1/discovery/settings");
  await json(api, "patch", "/v1/discovery/settings", { expectedRevision: settings.revision, boards: ["indeed"], hoursOld: 0, newJobLimit: 1 });
  const controls = { queries: [], locations: [], expectedProfileVersion: profile.profileVersion };
  const listing = (id: string) => ({ job_key: id, title: "Synthetic position " + id, company: "Synthetic Employer",
    description: "The synthetic responsibilities for " + id, location: "Madrid", url: "https://www.indeed.com/viewjob?jk=" + id });
  const search = await action(api, "discovery.search", controls);
  const board = await app.external.next();
  expect(board.path).toBe("/jobstreaming/indeed");
  board.respond(indeedPage({ jobs: [{ ...listing("listing-only"), description: "" }, listing("one"), listing("two"), listing("three")], cursor: null, complete: true }));
  await serveRoleTarget(app, "mismatch");
  await serveRoleTarget(app, "unknown");
  await serveRoleTarget(app, "match");
  const done = await completed(api, search.runId);
  expect(done.result).toMatchObject({ newJobs: 1, observedJobs: 1,
    roleTargetObservations: { posting_description_missing: 1, mismatch: 1, unknown: 1, match: 1 } });
  const { jobs } = await json<{ jobs: Job[] }>(api, "get", "/v1/jobs");
  expect(jobs.map((job) => job.title)).toEqual(["Synthetic position three"]);
  const job = jobs[0]!;
  expect(job.provenance.roleTargetMatch).toMatchObject({ verdict: "match", profileRevision: profile.profileVersion, provenance: { lane: "discovery" } });
  const status = await app.discoveryCheckpoint(search.runId);
  expect(status.receipts).toEqual({ accepted: 1, filtered: 3 });
  const path = `/v1/discovery/runs/${search.runId}/jobs/${job.job_id}/role-target`;
  const beforeReview = app.external.calls.length;
  const details = await json<Review>(api, "get", path);
  expect(details.decision?.provenance.receipt_id).toBe(job.provenance.roleTargetMatch?.provenance.receipt_id);
  const review = await json<Review>(api, "post", path, { expectedPostingRevision: job.revision });
  expect(review).toEqual(details);
  expect((await api.post(path, { data: { expectedPostingRevision: job.revision + 1 } })).status()).toBe(409);
  expect(app.external.calls).toHaveLength(beforeReview);

  const invalidResults = ["missing_field", "unknown_verdict", "foreign_source", "extra_field", "nonverbatim", "title_only"] as const;
  for (const invalid of invalidResults) {
    const refused = await action(api, "discovery.search", controls);
    const secondBoard = await app.external.next();
    secondBoard.respond(indeedPage({ jobs: [listing("invalid-evidence")], cursor: null, complete: true }));
    await serveRoleTarget(app, "match", invalid);
    expect(await terminal(api, refused.runId)).toMatchObject({ status: "failed" });
  }
  const previous = await json<{ jobs: Job[] }>(api, "get", "/v1/jobs");
  expect(previous.jobs).toEqual(jobs);
  expect(await json<Review>(api, "get", path)).toEqual(review);

  // A later, revision-bound provider detail needs its own judgment. This
  // exercises the post-search path used for rows without a prior scope result.
  const changed = await json<Job>(api, "post", "/v1/jobs/capture", {
    ...listing("three"), source_id: "manual", captureId: "role-update",
    description: "The provider has published materially different responsibilities here.",
    expectedRevision: job.revision,
  });
  expect(changed.job_id).toEqual(job.job_id);
  expect(changed.revision).toBeGreaterThan(job.revision);
  expect((await json<Review>(api, "get", path)).decision).toBeNull();
  const pending = json<Review>(api, "post", path, { expectedPostingRevision: changed.revision });
  await serveRoleTarget(app, "mismatch");
  const updated = await pending;
  expect(updated).toMatchObject({ jobId: changed.job_id, postingRevision: changed.revision, decision: { verdict: "mismatch" } });
  expect((await json<Review>(api, "get", path)).decision).toEqual(updated.decision);
  expect((await json<{ jobs: Job[] }>(api, "get", "/v1/jobs")).jobs.map(({ job_id }) => job_id)).toEqual([job.job_id]);

  // Explicit one-run queries can deliberately explore a different target.
  const explicit = await action(api, "discovery.search", { queries: ["exploratory"], locations: ["Madrid"] });
  (await app.external.next()).respond(indeedPage({ jobs: [listing("exploratory")], cursor: null, complete: true }));
  expect((await completed(api, explicit.runId)).result).toMatchObject({ newJobs: 1 });
  expect(app.external.calls.filter((call) => call.body["operation"] === "discovery.role_target_match")).toHaveLength(4 + invalidResults.length);
});

test("the same saved role and posting honor the opposite external scope decision", async ({ api, app }) => {
  const { profile } = await createBaseline(api, { ...baseline, experience: { target_role: "Synthetic systems leadership", target_locations: "Madrid" } });
  const settings = await json<{ revision: number }>(api, "get", "/v1/discovery/settings");
  await json(api, "patch", "/v1/discovery/settings", { expectedRevision: settings.revision, boards: ["indeed"], hoursOld: 0, newJobLimit: 1 });
  const search = await action(api, "discovery.search", { queries: [], locations: [], expectedProfileVersion: profile.profileVersion });
  (await app.external.next()).respond(indeedPage({ jobs: [{ job_key: "three", title: "Synthetic position three", company: "Synthetic Employer",
    description: "The synthetic responsibilities for three", location: "Madrid", url: "https://www.indeed.com/viewjob?jk=three" }], cursor: null, complete: true }));
  await serveRoleTarget(app, "mismatch");
  expect((await completed(api, search.runId)).result).toMatchObject({ newJobs: 0, roleTargetObservations: { mismatch: 1 } });
  expect((await json<{ jobs: Job[] }>(api, "get", "/v1/jobs")).jobs).toEqual([]);
});
