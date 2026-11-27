import { action, completed, expect, json, test, type ApplicationStack } from "../harness/fixtures.js";
import { baseline, createBaseline } from "./core-data.js";
import { replyRoleTarget } from "./discovery-role-scope-data.js";
import { linkedinCard } from "./linkedin-data.js";
import { modelSources } from "./requirements-data.js";

test.use({ features: "profile,jobs,discovery" });

const listingPath = "/jobstreaming/linkedin/jobs-guest/jobs/api/seeMoreJobPostings/search";
const detailPath = (id: number) => `/jobstreaming/linkedin/jobs/view/${id}`;
const description = (text: string) => `<div class="show-more-less-html__markup"><p>${text}</p></div>`;

function nextBoardRequest(app: ApplicationStack) {
  return app.external.next({ timeout: 30_000, match: (call) => call.path.startsWith("/jobstreaming/linkedin/") });
}

async function listingFor(app: ApplicationStack, location: string) {
  const call = await nextBoardRequest(app);
  const url = new URL(call.path, "http://localhost");
  expect(url.pathname).toBe(listingPath);
  expect(url.searchParams.get("location")).toBe(location);
  return call;
}

async function serveDetail(app: ApplicationStack, id: number, text: string) {
  const call = await nextBoardRequest(app);
  expect(call.path).toBe(detailPath(id));
  call.raw(description(text));
}

async function decideRole(app: ApplicationStack, descriptionText: string, verdict: "match" | "mismatch") {
  const call = await app.external.next({ match: (request) => request.body?.["operation"] === "discovery.role_target_match" });
  expect(modelSources(call).find((source) => source.source_id === "posting:description")?.text).toContain(descriptionText);
  replyRoleTarget(call, verdict);
}

test("overlapping LinkedIn locations reuse an excluded posting's successful detail after worker replacement", async ({ api, app, page }) => {
  const { profile } = await createBaseline(api, { ...baseline, experience: {
    target_role: "Synthetic systems engineer", target_locations: "Madrid\nValencia",
  } });
  const saved = await json<{ revision: number }>(api, "get", "/v1/discovery/settings");
  await json(api, "patch", "/v1/discovery/settings", { expectedRevision: saved.revision, boards: ["linkedin"], hoursOld: 0, newJobLimit: 5 });
  const controls = { queries: [], locations: [], expectedProfileVersion: profile.profileVersion };
  await page.goto("/jobs");
  const original = await action(api, "discovery.search", controls);
  const repeated = 7861, initiallyEmpty = 7862;
  const both = linkedinCard(repeated) + linkedinCard(initiallyEmpty);
  (await listingFor(app, "Madrid")).raw(both);
  await serveDetail(app, repeated, "Review supplier contracts.");
  await decideRole(app, "Review supplier contracts.", "mismatch");
  await serveDetail(app, initiallyEmpty, "");

  (await listingFor(app, "Valencia")).raw("Busy", { status: 429, headers: { "Retry-After": "8" } });
  await expect.poll(async () => (await json<{ events: unknown[] }>(api, "get",
    `/v1/events?aggregateId=${original.runId}&type=DiscoverySourceRateLimited`)).events.length).toBe(1);
  await expect(page.getByRole("region", { name: "Job search progress" }).getByRole("button", { name: "Request stop" })).toBeVisible();
  const worker = await app.restartWorker();
  expect(worker.current).not.toBe(worker.previous);

  (await listingFor(app, "Valencia")).raw(both);
  await serveDetail(app, initiallyEmpty, "Reconcile supplier invoices.");
  await decideRole(app, "Reconcile supplier invoices.", "mismatch");
  expect((await completed(api, original.runId)).result).toMatchObject({ newJobs: 0, failures: [],
    postings: { received: 4, excluded: 4, pending: 0 },
    roleTargetObservations: { mismatch: 3, posting_description_missing: 1 } });
  expect((await app.discoveryCheckpoint(original.runId)).receiptKeys).toHaveLength(4);
  expect(app.external.calls.filter((call) => call.path.includes("/jobs/view/")).map((call) => call.path))
    .toEqual([detailPath(repeated), detailPath(initiallyEmpty), detailPath(initiallyEmpty)]);

  const fresh = await action(api, "discovery.search", { ...controls, locations: ["Madrid"] });
  (await listingFor(app, "Madrid")).raw(linkedinCard(repeated));
  await serveDetail(app, repeated, "Design durable workflow software.");
  await decideRole(app, "Design durable workflow software.", "match");
  expect((await completed(api, fresh.runId)).result).toMatchObject({ newJobs: 1, failures: [], roleTargetObservations: { match: 1 } });
  const { jobs } = await json<{ jobs: { description: string }[] }>(api, "get", "/v1/jobs");
  expect(jobs).toHaveLength(1);
  expect(jobs[0]!.description).toContain("Design durable workflow software.");
});
