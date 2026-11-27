import { action, completed, expect, json, modelCall, test } from "../harness/fixtures.js";
import { createBaseline } from "./core-data.js";
import { posting, respondProducer } from "./preparation-cohort-data.js";
import { catalogMatching, EXTRACTION_PROMPT_VERSION, modelSources, typedExtraction } from "./requirements-data.js";
import { serveQualification } from "./search-assessment-data.js";

test("an unfinished optional preference leaves the supported Fit demands assessable", async ({ api, app }) => {
  const { library } = await createBaseline(api);
  const demand = "Inspect telemetry for early signs of equipment failure.";
  const fragment = "Familiarity with";
  const description = `Required:\n${demand}\n\nNice to have:\n${fragment}\n\nBenefits: Flexible working hours.`;
  const source = { ...posting(1), description };
  const job = await json<{ job_id: string; revision: number }>(api, "post", "/v1/jobs/capture", {
    url: source.url, title: source.title, company: source.company, description,
  });
  const run = await action(api, "preparation.run", { recipe: "assess", job_ids: [job.job_id], scope: "selected" });
  respondProducer(await modelCall(app, "jobs.role_analysis"), [source]);
  const extraction = await modelCall(app, "requirements.extract");
  expect(extraction.body["prompt_version"]).toBe(EXTRACTION_PROMPT_VERSION);
  expect(extraction.body["instructions"]).toContain("Omit an incomplete optional fragment with no independently assessable meaning.");
  expect(modelSources(extraction).map((item) => item.text)).toEqual([description]);
  extraction.reply(typedExtraction(extraction, { requirements: [{ localId: "telemetry", text: demand, category: "skill" }] }));
  const matching = await modelCall(app, "requirements.match_catalog");
  matching.reply(catalogMatching(matching, { telemetry: { verdict: "new" } }));
  await serveQualification(app, library);
  expect(await completed(api, run.runId)).toMatchObject({ status: "succeeded" });
  const fit = await json(api, "get", `/v1/jobs/${job.job_id}/fit`);
  expect(fit).toMatchObject({ current: true, score: { score: 10, assessments: [expect.any(Object)] } });
  const stored = await json(api, "get", `/v1/jobs/${job.job_id}`);
  expect(stored).toMatchObject({ revision: job.revision, description });
  expect(app.external.calls.filter((call) => call.body["operation"] === "requirements.extract")).toHaveLength(1);
});
