import { action, completed, expect, json, test } from "../harness/fixtures.js";
import { baseline, createBaseline } from "./core-data.js";
import { roleTargetStream, serveRoleTarget } from "./discovery-role-scope-data.js";
import { linkedinCard } from "./linkedin-data.js";

test.use({ features: "profile,jobs,discovery" });

test("LinkedIn copies with one Ashby requisition share a job while distinct requisitions stay separate", async ({ api, app }) => {
  const { profile } = await createBaseline(api, { ...baseline, experience: {
    target_role: "Synthetic systems engineer", target_locations: "Madrid",
  } });
  const settings = await json<{ revision: number }>(api, "get", "/v1/discovery/settings");
  await json(api, "patch", "/v1/discovery/settings", {
    expectedRevision: settings.revision, boards: ["linkedin"], hoursOld: 0, newJobLimit: 3,
  });
  const first = "https://jobs.ashbyhq.com/synthetic/00000000-0000-4000-8000-000000000001";
  const second = "https://jobs.ashbyhq.com/synthetic/00000000-0000-4000-8000-000000000002";
  const search = await action(api, "discovery.search", { queries: [], locations: [], expectedProfileVersion: profile.profileVersion });
  const listing = await app.external.next();
  listing.raw([1294, 1295, 1296].map(linkedinCard).join(""));
  for (const [id, url, description] of [
    [1294, `${first}/application?utm_source=linkedin`, "Keep the telemetry systems available."],
    [1295, `${first}?utm_source=other`, "Maintain the telemetry platform."],
    [1296, second, "Keep the telemetry systems available."],
  ] as const) {
    const detail = await app.external.next({ match: (call) => call.path === `/jobstreaming/linkedin/jobs/view/${id}` });
    detail.raw(`<div class="show-more-less-html__markup"><p>${description}</p></div><code id="applyUrl">https://www.linkedin.com/redir/redirect?url=${encodeURIComponent(url)}</code>`);
    if (id === 1294) await serveRoleTarget(roleTargetStream(app), "match");
  }

  expect((await completed(api, search.runId)).result).toMatchObject({
    status: "completed", newJobs: 2, observedJobs: 3,
    postings: { received: 3, saved: 2, duplicate: 1 },
  });
  const { jobs } = await json<{ jobs: { job_id: string; application_url: string; revision: number }[] }>(api, "get", "/v1/jobs");
  expect(jobs.map((job) => job.application_url).sort()).toEqual([`${first}/application?utm_source=linkedin`, second]);
  const canonical = jobs.find((job) => job.application_url.startsWith(first))!;
  const history = await json<{ observations: { observed_url: string }[]; snapshots: unknown[] }>(api, "get", `/v1/jobs/${canonical.job_id}/snapshots`);
  expect(history.snapshots).toHaveLength(1);
  expect(history.observations.map((item) => item.observed_url).sort())
    .toEqual(["https://www.linkedin.com/jobs/view/1294", "https://www.linkedin.com/jobs/view/1295"]);
  expect(app.external.calls.filter((call) => call.body?.["operation"] === "discovery.role_target_match")).toHaveLength(1);
});
