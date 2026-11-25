import { action, completed, expect, json, modelCall, test, type ApplicationStack, type ExternalCall } from "../harness/fixtures.js";
import { createBaseline } from "./core-data.js";
import { indeedPage } from "./indeed-data.js";
import { catalogMatching } from "./requirements-data.js";
import { qualificationBatchDecision, qualificationBindings } from "./qualification-data.js";
import { respondProducer } from "./preparation-cohort-data.js";
import { servePostingAssessment } from "./search-assessment-data.js";
import type { NormalizedSnapshot } from "./consolidation-data.js";
import type { FitState } from "./fit-data.js";

function matching(app: ApplicationStack, predicate: (call: ExternalCall) => boolean): ApplicationStack {
  return { ...app, external: { ...app.external, next: (options) => app.external.next({ ...options, match: predicate }) } };
}

test("overlapping jobs share one paid qualification while an unrelated demand finishes", async ({ api, app }) => {
  const { library } = await createBaseline(api);
  const settings = await json<{ revision: number; laneConcurrency: Record<string, number> }>(api, "get", "/v1/settings");
  await json(api, "patch", "/v1/settings", { expectedRevision: settings.revision, dailyBudgetUsd: 0,
    laneConcurrency: { ...settings.laneConcurrency, scoring: 4 } });
  const first = { job_key: "owned-concurrent-a", url: "https://www.indeed.com/viewjob?jk=owned-concurrent-a", title: "Synthetic First Engineer",
    company: "Synthetic Company", description: "Maintain durable workflow recovery.", location: "Madrid" };
  const twin = { ...first, job_key: "owned-concurrent-b", url: "https://www.indeed.com/viewjob?jk=owned-concurrent-b", title: "Synthetic Second Engineer" };
  const other = { ...first, job_key: "owned-concurrent-c", url: "https://www.indeed.com/viewjob?jk=owned-concurrent-c",
    title: "Synthetic Third Engineer", description: "Design controlled supplier payments." };
  const jobs = [first, twin, other];
  const search = await action(api, "discovery.search", { boards: ["indeed"], queries: ["Synthetic Engineer"],
    locations: ["Madrid"], newJobLimit: 3, hoursOld: 0 });
  const board = await app.external.next();
  expect(board.path).toBe("/jobstreaming/indeed");
  board.respond(indeedPage({ jobs, cursor: null, complete: true }));
  const pages = await Promise.all(jobs.map((job) => app.external.next({ match: (call) =>
    call.path === "/posting-page" && call.body["url"] === job.url })));
  const model = matching(app, (call) => call.path === "/model" && call.body["operation"] !== "fit.qualification-batch");
  const currentJobs = (await json<{ jobs: { url: string; job_id: string }[] }>(api, "get", "/v1/jobs")).jobs;
  const id = (url: string) => currentJobs.find((job) => job.url === url)!.job_id;
  const readFit = (url: string) => json<FitState>(api, "get", `/v1/jobs/${id(url)}/fit`);
  const readRequirement = async (url: string) =>
    (await json<NormalizedSnapshot>(api, "get", `/v1/jobs/${id(url)}/requirements`)).requirements[0]!.requirement_id;

  // All three jobs are admitted. Hold the first actual provider call open.
  await servePostingAssessment(model, library, first, { pageRequest: pages[0]!, qualificationExpected: false });
  const held = await modelCall(app, "fit.qualification-batch");
  const sharedRequirement = await readRequirement(first.url);
  expect(qualificationBindings(held)[0]!.requirement_id).toBe(sharedRequirement);

  respondProducer(pages[1]!, [twin]);
  for (const operation of ["page_interpretation", "posting_extraction", "description_quality"]) {
    respondProducer(await modelCall(model, operation), [twin]);
  }
  const catalog = await modelCall(model, "requirements.match_catalog");
  catalog.reply(catalogMatching(catalog, { capability: { verdict: "equivalent", requirementId: sharedRequirement } }));
  const twinRunning = async () => {
    const run = await json<{ steps: { jobId: string; stage: string; status: string }[] }>(api, "get", `/v1/preparation/runs/${search.runId}`);
    return run.steps.find((step) => step.jobId === id(twin.url) && step.stage === "fit")?.status;
  };
  await expect.poll(twinRunning).toBe("running");

  // An unrelated, independent scoring call must complete while the equivalent
  // job waits. This establishes real overlap and excludes a global Fit lock.
  await servePostingAssessment(model, library, other, { pageRequest: pages[2]!, qualificationExpected: false });
  const otherCall = await app.external.next({ match: (call) => call.body["operation"] === "fit.qualification-batch"
    && qualificationBindings(call)[0]?.requirement_id !== sharedRequirement });
  expect(qualificationBindings(otherCall)[0]!.requirement_id).toBe(await readRequirement(other.url));
  const achievement = library.roles[0]!.achievements[0]!;
  const answer = (call: ExternalCall) => call.reply(qualificationBatchDecision(call, () => ({
    achievementIds: [achievement.achievement_id], evidenceSourceIds: [`evidence:${achievement.source_refs[0]!.source_id}`],
  })));
  answer(otherCall);
  await expect.poll(async () => (await readFit(other.url)).current).toBe(true);
  expect(held.closed).not.toBe(true);
  const billedShared = () => app.external.calls.filter((call) => call.body["operation"] === "fit.qualification-batch"
    && qualificationBindings(call)[0]?.requirement_id === sharedRequirement);
  expect(billedShared()).toHaveLength(1);
  answer(held);
  expect((await completed(api, search.runId)).result).toMatchObject({ preparation: { assessedJobs: 3, failedJobs: 0 } });
  const accepted = (await readFit(first.url)).score.assessments[0]!;
  const reused = (await readFit(twin.url)).score.assessments[0]!;
  expect(reused.assessment_id).toBe(accepted.assessment_id);
  expect(reused.provenance.receipt_id).toBe(accepted.provenance.receipt_id);
  expect(billedShared()).toHaveLength(1);
});
