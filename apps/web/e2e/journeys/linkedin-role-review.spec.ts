import { action, completed, expect, json, modelCall, terminal, test, type ExternalCall } from "../harness/fixtures.js";
import { baseline, createBaseline } from "./core-data.js";
import { replyRoleTarget, roleTargetStream, serveRoleTarget } from "./discovery-role-scope-data.js";
import { linkedinCard } from "./linkedin-data.js";

for (const detailInFlight of [false, true]) {
  test(`stop during role review ${detailInFlight ? "retains no jobs after an in-flight detail" : "prevents a paced detail from starting"}`, async ({ api, app }) => {
    const { profile } = await createBaseline(api, { ...baseline, experience: {
      target_role: "Synthetic systems engineer", target_locations: "Madrid",
    } });
    const saved = await json<{ revision: number }>(api, "get", "/v1/discovery/settings");
    await json(api, "patch", "/v1/discovery/settings", { expectedRevision: saved.revision, boards: ["linkedin"], hoursOld: 0, newJobLimit: 3 });
    const { runId } = await action(api, "discovery.search", { queries: [], locations: [], expectedProfileVersion: profile.profileVersion });
    const listing = await app.external.next();
    listing.raw(linkedinCard(1280) + linkedinCard(1281) + linkedinCard(1282));
    const firstDetail = await app.external.next();
    expect(firstDetail.path).toBe("/jobstreaming/linkedin/jobs/view/1280");
    const detailBody = '<div class="show-more-less-html__markup"><p>Build reliable synthetic systems.</p></div>';
    firstDetail.raw(detailBody);
    const heldReview = await modelCall(roleTargetStream(app), "discovery.role_target_match");
    const secondDetail = { match: (call: ExternalCall) => call.path === "/jobstreaming/linkedin/jobs/view/1281" };
    const heldDetail = detailInFlight ? await app.external.next(secondDetail) : null;
    await json(api, "post", `/v1/action-runs/${runId}/cancel`, {});
    if (heldDetail) heldDetail.raw(detailBody);
    else await expect(app.external.next({ ...secondDetail, timeout: 6_000 })).rejects.toThrow("No external request arrived");
    replyRoleTarget(heldReview, "match");
    expect((await terminal(api, runId)).status).toBe("cancelled");
    expect((await json<{ jobs: unknown[] }>(api, "get", "/v1/jobs")).jobs).toEqual([]);
    expect(app.external.calls.filter((call) => call.path.includes("/jobs/view/"))).toHaveLength(detailInFlight ? 2 : 1);
    expect(app.external.calls.filter((call) => call.body?.["operation"] === "discovery.role_target_match")).toHaveLength(1);
  });
}

test.describe("LinkedIn posting eligibility", () => {
  test.use({ features: "profile,jobs,discovery" });

  test("an invalid next card lets other search locations finish", async ({ api, app }) => {
    const { profile } = await createBaseline(api, { ...baseline, experience: {
      target_role: "Synthetic systems engineer", target_locations: "Madrid\nValencia",
    } });
    const saved = await json<{ revision: number }>(api, "get", "/v1/discovery/settings");
    await json(api, "patch", "/v1/discovery/settings", { expectedRevision: saved.revision, boards: ["linkedin"], hoursOld: 0, newJobLimit: 4 });
    const { runId } = await action(api, "discovery.search", { queries: [], locations: [], expectedProfileVersion: profile.profileVersion });
    for (const [location, id] of [["Madrid", 1287], ["Valencia", 1289]] as const) {
      const listing = await app.external.next({ timeout: 12_000 });
      expect(new URL(listing.path, "http://localhost").searchParams.get("location")).toBe(location);
      const invalid = location === "Madrid" ? linkedinCard(1288).replace("Synthetic Systems Engineer", "X".repeat(2001)) : "";
      listing.raw(linkedinCard(id) + invalid);
      const detail = await app.external.next();
      expect(detail.path).toBe(`/jobstreaming/linkedin/jobs/view/${id}`);
      detail.raw(`<div class="show-more-less-html__markup"><p>Maintain systems ${id}.</p></div>`);
      await serveRoleTarget(roleTargetStream(app), "match");
    }
    expect((await completed(api, runId)).result).toMatchObject({ newJobs: 2, status: "partial",
      failures: [expect.objectContaining({ code: "invalid_posting" })] });
  });

  test("looking ahead skips a saved identity and an exact title exclusion", async ({ api, app }) => {
    const { profile } = await createBaseline(api, { ...baseline, experience: {
      target_role: "Synthetic systems engineer", target_locations: "Madrid",
    } });
    await json(api, "post", "/v1/jobs/capture", { url: "https://www.linkedin.com/jobs/view/1284",
      title: "Previously saved synthetic role", company: "Synthetic Board Company", description: "Previously accepted description." });
    const saved = await json<{ revision: number }>(api, "get", "/v1/discovery/settings");
    await json(api, "patch", "/v1/discovery/settings", { expectedRevision: saved.revision, boards: ["linkedin"],
      exactTitleExclusions: ["Excluded synthetic role"], hoursOld: 0, newJobLimit: 4 });
    const search = await action(api, "discovery.search", { queries: [], locations: [], expectedProfileVersion: profile.profileVersion });
    const listing = await app.external.next();
    listing.raw(linkedinCard(1283) + linkedinCard(1284) + linkedinCard(1285)
      + linkedinCard(1286).replace("Synthetic Systems Engineer", "Excluded synthetic role"));
    for (const id of [1283, 1285]) {
      const detail = await app.external.next();
      expect(detail.path).toBe(`/jobstreaming/linkedin/jobs/view/${id}`);
      detail.raw(`<div class="show-more-less-html__markup"><p>Maintain synthetic workflow ${id}.</p></div>`);
      await serveRoleTarget(roleTargetStream(app), "match");
    }
    expect((await completed(api, search.runId)).result).toMatchObject({ newJobs: 2, observedJobs: 3,
      postings: { received: 4, saved: 2, duplicate: 1, excluded: 1 } });
    expect(app.external.calls.filter((call) => call.path.includes("/jobs/view/"))).toHaveLength(2);
  });
});
