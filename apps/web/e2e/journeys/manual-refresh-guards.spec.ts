import {
  test,
  expect,
  json,
  modelCall,
  completed,
  terminal,
} from "../harness/fixtures.js";
import { createPosting, type Profile } from "./core-data.js";
import {
  createScoredFit,
  groupedCoverageDecision,
  impactPartition,
  refreshPayload,
  startRefresh,
  type FitState,
  type PendingRefresh,
  type RefreshOperation,
} from "./fit-data.js";
import {
  catalogMatching,
  citeSources,
  modelSources,
} from "./requirements-data.js";

for (const defect of [
  "missing requirement",
  "unknown verdict",
  "foreign citation",
  "non-verbatim citation",
  "stale requirement revision",
] as const) {
  test(`manual selection ${defect} cannot replace accepted scores or fall back to per-requirement selection`, async ({
    api,
    app,
  }) => {
    const seed = await createScoredFit(
      api,
      app,
      `selector-${defect.replaceAll(" ", "-")}`,
      {
        twoRequirements: true,
        missingOwnership: true,
      },
    );
    const current = await json<Profile>(api, "get", "/v1/profile");
    await json(api, "patch", "/v1/profile", {
      expectedProfileVersion: current.profileVersion,
      profile: {
        ...current.profile,
        personal: {
          ...current.profile.personal,
          full_name: "Synthetic Selector Source Change",
        },
      },
    });
    const pending = await json<PendingRefresh>(
      api,
      "get",
      "/v1/fit/refresh/pending",
    );
    const before = app.external.calls.length;
    const run = await startRefresh(
      api,
      refreshPayload(pending),
      `selector-defect-${defect}`,
    );
    const selector = await modelCall(app, "fit.catalog-impact");
    const value = impactPartition(
      selector,
      Object.fromEntries(
        seed.requirements.requirements.map((row) => [
          row.requirement_id,
          "unchanged" as const,
        ]),
      ),
    );
    const first = value.requirements[0]!;
    if (defect === "missing requirement")
      selector.reply({ requirements: value.requirements.slice(1) });
    if (defect === "unknown verdict")
      selector.reply({
        requirements: [
          { ...first, verdict: "not_relevant" },
          ...value.requirements.slice(1),
        ],
      });
    if (defect === "foreign citation")
      selector.reply({
        requirements: [
          {
            ...first,
            citations: [
              {
                source_id: "before:foreign-baseline:unrecorded",
                quote: "Unrecorded factual source",
              },
              ...first.citations.slice(1),
            ],
          },
          ...value.requirements.slice(1),
        ],
      });
    if (defect === "non-verbatim citation")
      selector.reply({
        requirements: [
          {
            ...first,
            citations: [
              {
                ...first.citations[0]!,
                quote:
                  "Invented quote that is not present in the requirement source.",
              },
              ...first.citations.slice(1),
            ],
          },
          ...value.requirements.slice(1),
        ],
      });
    if (defect === "stale requirement revision")
      selector.reply({
        requirements: [
          { ...first, requirement_revision: "999" },
          ...value.requirements.slice(1),
        ],
      });
    const expectedCode = {
      "missing requirement": "fit_refresh_partition_invalid",
      "unknown verdict": "model_schema_violation",
      "foreign citation": "fit_foreign_source_id",
      "non-verbatim citation": "fit_non_verbatim_quote",
      "stale requirement revision": "fit_requirement_binding_invalid",
    }[defect];
    expect(await terminal(api, run.runId)).toMatchObject({
      status: "failed",
      errorCode: expectedCode,
    });
    expect(
      await json<RefreshOperation>(
        api,
        "get",
        `/v1/fit/refresh/operations/${run.runId}`,
      ),
    ).toMatchObject({
      status: "failed",
      factual_published: false,
      counters: { model_calls: 1 },
    });
    expect(
      (await json<FitState>(api, "get", `/v1/jobs/${seed.posting.job_id}/fit`))
        .score,
    ).toEqual(seed.fit.score);
    expect(
      app.external.calls
        .slice(before)
        .filter((call) => call.path === "/model")
        .map((call) => call.body["operation"]),
    ).toEqual(["fit.catalog-impact"]);
  });
}

test("a manual refresh publishes only its selected scored jobs while canonical qualification stays shared", async ({
  api,
  app,
}) => {
  const seed = await createScoredFit(api, app, "selected-job-first");
  const second = await createPosting(api, "selected-job-second");
  const extracting = api.post(`/v1/jobs/${second.job_id}/requirements`, {
    data: { expected_posting_revision: second.revision, expected_revision: 0 },
  });
  const extraction = await modelCall(app, "requirements.extract");
  const source = modelSources(extraction)[0]!;
  extraction.reply({
    status: "complete",
    requirements: [
      {
        local_id: "recovery",
        text: source.text,
        definition: "Implement and maintain durable workflow recovery.",
        qualifiers: [],
        scope: "resume",
        tier: "must_have",
        weight: 1,
        support: "supported",
        spans: [{ source_id: source.source_id, quote: source.text }],
      },
    ],
    reason:
      "Explicit source-bound requirement for a second independently selected job.",
    citations: citeSources(extraction, [source.source_id]),
  });
  const matching = await modelCall(app, "requirements.match_catalog");
  matching.reply(
    catalogMatching(matching, {
      recovery: {
        verdict: "equivalent",
        requirementId: seed.requirements.requirements[0]!.requirement_id,
      },
    }),
  );
  expect((await extracting).status()).toBe(200);
  const secondFit = await json<FitState>(
    api,
    "post",
    `/v1/jobs/${second.job_id}/fit/assess`,
    {
      expected_revision: 0,
      prepare_coverage: false,
      prepare_wording: false,
    },
  );
  const current = await json<Profile>(api, "get", "/v1/profile");
  await json(api, "patch", "/v1/profile", {
    expectedProfileVersion: current.profileVersion,
    profile: {
      ...current.profile,
      personal: {
        ...current.profile.personal,
        full_name: "Synthetic Selected Job Update",
      },
    },
  });
  const pending = await json<PendingRefresh>(
    api,
    "get",
    "/v1/fit/refresh/pending",
  );
  expect(pending.available_job_ids.toSorted()).toEqual(
    [seed.posting.job_id, second.job_id].toSorted(),
  );
  const run = await startRefresh(
    api,
    refreshPayload(pending, [seed.posting.job_id]),
    "selected-job-only",
  );
  const selector = await modelCall(app, "fit.catalog-impact");
  selector.reply(
    impactPartition(selector, {
      [seed.requirements.requirements[0]!.requirement_id]: "unchanged",
    }),
  );
  const achievement = seed.library.roles[0]!.achievements[0]!;
  const coverage = await modelCall(app, "fit.wording-coverage-grouped");
  coverage.reply(
    groupedCoverageDecision(coverage, {
      evidenceSourceId: `evidence:${achievement.source_refs[0]!.source_id}`,
      status: "covered",
      action: "reuse_approved",
      reusableVariantId: achievement.baseline_variant_id,
    }),
  );
  await completed(api, run.runId);
  const result = await json<RefreshOperation>(
    api,
    "get",
    `/v1/fit/refresh/operations/${run.runId}`,
  );
  expect(result.job_ids).toEqual([seed.posting.job_id]);
  expect(result.counters.requirements_assessed).toBe(0);
  expect(
    (await json<FitState>(api, "get", `/v1/jobs/${seed.posting.job_id}/fit`))
      .current,
  ).toBe(true);
  const retainedSecond = await json<FitState>(
    api,
    "get",
    `/v1/jobs/${second.job_id}/fit`,
  );
  expect(retainedSecond.score).toEqual(secondFit.score);
  expect(retainedSecond.current).toBe(false);
});
