import { createHash } from "node:crypto";
import careerLearningSchemaHashes from "./fixtures/career-learning-endpoint-hashes.json" with { type: "json" };
import providerEndpointSpecs from "./fixtures/provider-endpoint-specs.json" with { type: "json" };
/**
 * RPC contract schema coverage — keeps the TS contract package in sync with
 * the Python worker handler set.  Each new RPC method gets a parse + reject
 * pair here so type drift between TS and Python surfaces in CI.
 */
import { describe, expect, expectTypeOf, it } from "vitest";
import type { AnalyzeJobResult, ApplyResult, RpcParams, RpcResult } from "../src/contracts.js";
import endpointSpecsFixture from "../../../packages/domain-types/test/fixtures/endpoint_specs.json" with {
  type: "json",
};

import {
  AnalyzeJobParamsSchema,
  AnalyzeJobResultSchema,
  ApplyParamsSchema,
  ApplyResultSchema,
  AvailabilityWorkflowStartSchema,
  CancelRunParamsSchema,
  CancelRunResultSchema,
  DEFAULT_PIPELINE_LLM_MODEL,
  ENDPOINTS,
  endpointSpecJsonSchemaFixture,
  GenerateInterviewPrepRequestSchema,
  GenerateInterviewPrepParamsSchema,
  ManualCaptureImportParamsSchema,
  ManualCaptureImportWorkflowResultSchema,
  JobUrlImportResultSchema,
  ManualCaptureImportResultSchema,
  ProfileImportParamsSchema,
  ProfileImportResultSchema,
  ProviderModelCatalogResultSchema,
  ProfileTargetRoleSuggestionsParamsSchema,
  ProfileUpdateRequestSchema,
  RederiveLearningRecommendationsParamsSchema,
  RederiveLearningRecommendationsResultSchema,
  RefreshCompensationParamsSchema,
  RefreshCompensationResultSchema,
  RescoreJobParamsSchema,
  RescoreJobsNotOnCurrentScoringPolicyParamsSchema,
  RetailorCurrentPolicyParamsSchema,
  RetailorJobParamsSchema,
  RpcMethods,
  RpcContracts,
  RunContactResearchParamsSchema,
  RunStageParamsSchema,
  RunStageResultSchema,
  SettingsUpdateRequestSchema,
  TailorJobParamsSchema,
  TargetRoleSuggestionResultSchema,
} from "../src/contracts.js";

const CANONICAL_JOB_ID = "11111111-1111-4111-8111-111111111111";
const ENDPOINT_DISPATCH_CONTEXT = {
  tenantId: "local",
  appDir: "/tmp/jobctrl",
  dbPath: "/tmp/jobctrl/jobctrl.db",
} as const;

describe("current RPC caller controls and dispatch results", () => {
  const ack = { runId: "workflow-1", workflowId: "workflow-1", firstExecutionRunId: "execution-1" };

  it("requires the supported provider for verification", () => {
    expect(RpcContracts.provider_verify.params.parse({ provider: "codex" })).toEqual({ provider: "codex" });
    for (const params of [{}, { provider: "claude" }, { provider: null }, { provider: "codex", unexpected: true }]) {
      expect(RpcContracts.provider_verify.params.safeParse(params).success).toBe(false);
    }
  });

  it("infers caller inputs before defaults and method-specific dispatch outputs", () => {
    const request: RpcParams<typeof RpcMethods.RunStage> = {
      stage: "discover", sourceIds: ["source-1"], awaitResult: true,
    };
    expect(RpcContracts.run_stage.params.parse(request)).toMatchObject({
      ...request, tenantId: "local", limit: 0,
    });
    expectTypeOf<RpcParams<"run_stage">["awaitResult"]>().toEqualTypeOf<boolean | undefined>();
    expectTypeOf<RpcParams<"run_stage">["refreshApplyUrl"]>().toEqualTypeOf<boolean | undefined>();
    expectTypeOf<RpcParams<"profile_import">["awaitResult"]>().toEqualTypeOf<boolean | undefined>();
    expectTypeOf<RpcResult<"analyze_job">>().toEqualTypeOf<AnalyzeJobResult>();
    expectTypeOf<RpcResult<"tailor_job">>().toEqualTypeOf<ApplyResult>();
    expectTypeOf<RpcResult<"manual_capture_import">["result"]["status"]>()
      .toEqualTypeOf<"succeeded" | "failed">();
  });

  it("preserves source filters and recovery/await controls with caller-compatible bounds", () => {
    const sourceIds = Array.from({ length: 50 }, (_, index) => `${index}`.padEnd(160, "x"));
    expect(RunStageParamsSchema.parse({ stage: "discover", sourceIds })).toMatchObject({ sourceIds });
    expect(RunStageParamsSchema.parse({ stage: "discover", sourceIds: [] }).sourceIds).toEqual([]);
    expect(RunStageParamsSchema.parse({ stage: "discover", sourceIds: [" source-1 "] }).sourceIds).toEqual(["source-1"]);
    for (const reason of ["condition_resolved:synthetic-check", "profile_updated:42", "r".repeat(400)]) {
      const params = { stage: "score", stages: ["score", "tailor", "cover"], limit: 0, retailor: true, reason, awaitResult: true };
      expect(RunStageParamsSchema.parse(params)).toMatchObject(params);
    }
    expect(RunStageParamsSchema.parse({ stage: "score", awaitResult: false }).awaitResult).toBe(false);
    // workflow_specs.py gives an explicit stages list precedence over stage.
    expect(RunStageParamsSchema.parse({ stage: "score", stages: ["discover", "score"], sourceIds: ["source-1"] }).sourceIds).toEqual(["source-1"]);
  });

  it.each([
    { sourceIds: "source-1" }, { sourceIds: [42] }, { sourceIds: [""] }, { sourceIds: [" "] },
    { sourceIds: ["x".repeat(161)] }, { sourceIds: Array.from({ length: 51 }, (_, i) => `source-${i}`) },
    { sourceIds: ["source-1", " source-1 "] }, { sourceIds: null },
    { sourceIds: ["source-1"], stages: ["score"] },
    { reason: "r".repeat(401) }, { reason: 42 }, { reason: null },
    { awaitResult: "true" }, { awaitResult: 1 }, { awaitResult: null },
    { refreshApplyUrl: "false" }, { refreshApplyUrl: 1 }, { refreshApplyUrl: null },
    { unexpected: true },
  ])("rejects malformed run_stage controls: %j", (controls) => {
    expect(RunStageParamsSchema.safeParse({ stage: "discover", ...controls }).success).toBe(false);
  });

  it("rejects source filters when the effective stage list excludes Discover", () => {
    for (const params of [
      { stage: "score" }, { stage: "discover", stages: ["score", "tailor"] },
    ]) {
      expect(RunStageParamsSchema.safeParse({ ...params, sourceIds: ["source-1"] }).success).toBe(false);
    }
  });

  it("restricts refreshApplyUrl to one selected Enrich job with limit 1", () => {
    const params = { stage: "enrich", jobId: CANONICAL_JOB_ID, limit: 1, refreshApplyUrl: true };
    expect(RunStageParamsSchema.parse(params)).toMatchObject(params);
    expect(RunStageParamsSchema.parse({ ...params, stages: ["enrich"] })).toMatchObject(params);
    expect(RunStageParamsSchema.parse({ stage: "score", refreshApplyUrl: false }).refreshApplyUrl).toBe(false);
    // Repeated stages are deduplicated by the worker; the singular stage is a fallback.
    expect(RunStageParamsSchema.parse({ ...params, stage: "score", stages: ["enrich", "enrich"] }).refreshApplyUrl).toBe(true);
    for (const change of [
      { jobId: undefined }, { limit: 0 }, { limit: 2 }, { stage: "score" },
      { stage: "discover" }, { stages: ["discover"] }, { stages: ["enrich", "score"] },
      { jobIds: [CANONICAL_JOB_ID] }, { jobId: undefined, jobIds: [CANONICAL_JOB_ID] },
      { jobIds: [] },
    ]) {
      expect(RunStageParamsSchema.safeParse({ ...params, ...change }).success).toBe(false);
    }
  });

  it("accepts profile import awaiting and cancellation audit metadata without dropping fields", () => {
    const params = { pdfPath: "/synthetic/profile.pdf", awaitResult: true };
    expect(ProfileImportParamsSchema.parse(params)).toMatchObject(params);
    expect(ProfileImportParamsSchema.parse({ ...params, awaitResult: false }).awaitResult).toBe(false);
    expect(ProfileImportParamsSchema.parse({ pdfPath: params.pdfPath })).not.toHaveProperty("awaitResult");
    const cancel = { runId: "workflow-1", requestedBy: "local_operator", source: "jobctrl_api", reason: "Canceled from JobCtrl." };
    expect(CancelRunParamsSchema.parse(cancel)).toMatchObject(cancel);
    expect(CancelRunParamsSchema.parse({ ...cancel, requestedBy: "x".repeat(160), source: "s".repeat(80), reason: "r".repeat(500) }).reason).toHaveLength(500);
    expect(CancelRunParamsSchema.parse({ runId: "workflow-1", reason: null }).reason).toBeNull();
    for (const value of ["true", 1, null]) {
      expect(ProfileImportParamsSchema.safeParse({ ...params, awaitResult: value }).success).toBe(false);
    }
    for (const change of [
      { requestedBy: "x".repeat(161) }, { requestedBy: " " }, { requestedBy: 1 },
      { source: "s".repeat(81) }, { source: " " }, { source: false },
      { reason: "r".repeat(501) }, { reason: {} }, { unexpected: true },
    ]) {
      expect(CancelRunParamsSchema.safeParse({ ...cancel, ...change }).success).toBe(false);
    }
  });

  it("preserves real awaited pipeline successes and failures, which have no status field", () => {
    // JobPipelineWorkflowResult in pipeline/workflow.py, serialized by
    // workflow_result_to_dict in workflow_specs.py (not the #954 probe's status stub).
    for (const result of [
      { stages_completed: ["score", "tailor", "cover"], stages_failed: [], failure: null, error_code: null },
      { stages_completed: ["score"], stages_failed: ["tailor"], failure: "synthetic failure", error_code: "budget_exceeded" },
      { stages_completed: [], stages_failed: [], failure: null, error_code: null },
    ]) {
      expect(RunStageResultSchema.parse({ ...ack, result })).toEqual({ ...ack, result });
      expect(ApplyResultSchema.parse({ ...ack, result })).toEqual({ ...ack, result });
    }
    expect(RunStageResultSchema.parse(ack)).toEqual(ack);
    for (const result of [
      { status: "succeeded" }, { stages_completed: [], stages_failed: [] },
      { stages_completed: [], stages_failed: ["unknown"], failure: null, error_code: null },
      null,
    ]) {
      expect(RunStageResultSchema.safeParse({ ...ack, result }).success).toBe(false);
    }
  });

  it("preserves the distinct Discover and profile import awaited payloads", () => {
    const discover = {
      families_completed: ["synthetic-source"], families_failed: [], preparation_started: 0,
      enrichment_status: "ok", enrichment_site_errors: {}, compensation_refresh_status: "skipped",
      compensation_estimates_written: 0, compensation_refresh_warnings: [], failure: null, error_code: null,
    };
    expect(RunStageResultSchema.parse({ ...ack, result: discover })).toEqual({ ...ack, result: discover });
    expect(RunStageResultSchema.parse({ ...ack, result: { ...discover, families_failed: ["synthetic-source"], failure: "synthetic failure" } })).toMatchObject({ result: { failure: "synthetic failure" } });
    for (const result of [
      { status: "succeeded", draft: { profile: {}, style: {}, source: {}, templateText: "synthetic" }, error: null, error_code: null },
      { status: "failed", draft: {}, error: "synthetic import failure", error_code: "profile_import_failed" },
    ]) {
      expect(ProfileImportResultSchema.parse({ ...ack, result })).toEqual({ ...ack, result });
    }
    expect(ProfileImportResultSchema.parse(ack)).toEqual(ack);
    expect(ProfileImportResultSchema.safeParse({ ...ack, result: { status: "succeeded" } }).success).toBe(false);
  });

  it("retains required awaited import payloads and rejects missing or malformed nested results", () => {
    const jobUrlResult = { status: "succeeded", outcome: "imported", job_id: CANONICAL_JOB_ID, item_id: null, reason: null, imported_at: "2026-10-17T00:00:00Z", already_existed: false, error: null, error_code: null };
    const captureResult = { status: "succeeded", job_id: CANONICAL_JOB_ID, item_id: "synthetic-capture", imported_at: "2026-10-17T00:00:00Z", retry_context: { synthetic: true }, error: null, error_code: null };
    for (const [schema, result] of [
      [JobUrlImportResultSchema, jobUrlResult], [ManualCaptureImportResultSchema, captureResult],
    ] as const) {
      expect(schema.parse({ ...ack, result })).toEqual({ ...ack, result });
      expect(schema.safeParse(ack).success).toBe(false);
      expect(schema.safeParse({ ...ack, result: { status: "succeeded" } }).success).toBe(false);
    }
  });

  it("keeps the supported legacy local-action and compensation sync branches", () => {
    const legacy = { ok: true, action_id: "synthetic-action", stage: "score", status: "succeeded", started_at: "2026-10-17T00:00:00Z", finished_at: "2026-10-17T00:00:01Z", duration_ms: 1000, dry_run: false, result: { nested: true }, extension: "preserved" };
    expect(RunStageResultSchema.parse(legacy)).toEqual(legacy);
    expect(RefreshCompensationResultSchema.parse(ack)).toEqual(ack);
    expect(RefreshCompensationResultSchema.parse({ ok: true, status: "succeeded", postingUrl: null, postedFactsRefreshed: 1, reportedObservationsLoaded: 0, estimatesRefreshed: 1, tenantId: "local" })).toMatchObject({ postingUrl: null, estimatesRefreshed: 1 });
    expect(ApplyResultSchema.parse({ runId: "legacy-run", firstExecutionRunId: null, extraIdentity: "preserved" })).toEqual({ runId: "legacy-run", firstExecutionRunId: null, extraIdentity: "preserved" });
    for (const schema of [ApplyResultSchema, RunStageResultSchema, ProfileImportResultSchema, RefreshCompensationResultSchema]) {
      expect(schema.safeParse({ ...ack, runId: 7 }).success).toBe(false);
      expect(schema.safeParse({ ...ack, runId: "" }).success).toBe(false);
      expect(schema.parse({ ...ack, firstExecutionRunId: null })).toEqual({ ...ack, firstExecutionRunId: null });
      for (const change of [
        { workflowId: null }, { workflowId: "" }, { workflowId: 7 },
        { firstExecutionRunId: "" }, { firstExecutionRunId: false },
      ]) {
        expect(schema.safeParse({ ...ack, ...change }).success).toBe(false);
      }
    }
  });

  it("associates workflow methods with dispatch acknowledgments rather than activity results", () => {
    for (const method of [
      RpcMethods.RescoreJob, RpcMethods.RescoreJobsNotOnCurrentScoringPolicy,
      RpcMethods.TailorJob, RpcMethods.RetailorJob, RpcMethods.RetailorCurrentPolicy,
      RpcMethods.Apply, RpcMethods.ProfileImport, RpcMethods.RefreshCompensation,
      RpcMethods.CheckPostingAvailability, RpcMethods.GenerateInterviewPrep, RpcMethods.RunContactResearch,
    ] as const) {
      expect(RpcContracts[method].result.parse(ack)).toEqual(ack);
      expect(RpcContracts[method].result.safeParse({ status: "succeeded" }).success).toBe(false);
    }
    expect(RpcContracts.analyze_job.result).toBe(AnalyzeJobResultSchema);
    expect(RpcContracts.cancel_run.params).toBe(CancelRunParamsSchema);
    expect(RpcContracts.run_stage.result).toBe(RunStageResultSchema);
    expect(AnalyzeJobResultSchema.safeParse(ack).success).toBe(false);
  });

  it("preserves availability acknowledgments when Temporal has no first execution ID", () => {
    // server.py forwards handle.first_execution_run_id, which may be None.
    const start = { ...ack, firstExecutionRunId: null };
    expect(AvailabilityWorkflowStartSchema.parse(start)).toEqual(start);
    expect(RpcContracts.check_posting_availability.result.parse(start)).toEqual(start);
    expect(AvailabilityWorkflowStartSchema.safeParse({ runId: ack.runId }).success).toBe(false);
    for (const firstExecutionRunId of ["", 7, false]) {
      expect(AvailabilityWorkflowStartSchema.safeParse({ ...ack, firstExecutionRunId }).success).toBe(false);
    }
  });
});

describe("endpoint spec fixture", () => {
  it("bounds cover-letter worker inputs and registers both checked routes", () => {
    const schema = RpcContracts[RpcMethods.RenderCoverLetterPdf].params;
    const valid = { sourcePath: "/owned/source.txt", pdfPath: "/owned/letter.pdf", textSha256: "a".repeat(64),
      rendererVersion: "playwright-cover-letter-v2", settings: { paper: "A4", fontFamily: "georgia", fontSizePt: 9, marginMm: 8, lineHeight: 1, paragraphSpacingPx: 0 } };
    expect(schema.safeParse(valid).success).toBe(true);
    for (const settings of [ { ...valid.settings, fontSizePt: Infinity }, { ...valid.settings, marginMm: "8mm" },
      { ...valid.settings, fontFamily: "Georgia; color:red" }, { ...valid.settings, paragraphSpacingPx: 25 } ]) {
      expect(schema.safeParse({ ...valid, settings }).success).toBe(false);
    }
    expect(ENDPOINTS.renderCoverLetterPreview.rpcDependencies).toEqual([RpcMethods.RenderCoverLetterPdf]);
    expect(ENDPOINTS.acceptCoverLetterPreview.method).toBe("POST");
  });
  it("adds exactly the provider family without replacing historical endpoint expectations", () => {
    const additions = Object.keys(providerEndpointSpecs).sort();
    expect(additions).toEqual(["providerModels", "providerStatus", "verifyCodexProvider"]);
    for (const name of additions) {
      expect(endpointSpecsFixture.endpoints).not.toHaveProperty(name);
    }
    expect(Object.keys(endpointSpecJsonSchemaFixture().endpoints).sort()).toEqual(
      [...Object.keys(endpointSpecsFixture.endpoints), ...additions, ...Object.keys(careerLearningSchemaHashes)].sort(),
    );
  });

  it("pins every migrated request and response JSON Schema", () => {
    const current = endpointSpecJsonSchemaFixture();
    const careerNames = Object.keys(careerLearningSchemaHashes);
    expect({ ...current, endpoints: Object.fromEntries(Object.entries(current.endpoints).filter(([name]) => !careerNames.includes(name))) }).toEqual({
      ...endpointSpecsFixture,
      endpoints: { ...endpointSpecsFixture.endpoints, ...providerEndpointSpecs },
    });
    expect(Object.fromEntries(Object.entries(current.endpoints).filter(([name]) => careerNames.includes(name)).map(([name, schema]) => [name, createHash("sha256").update(JSON.stringify(schema)).digest("hex")]))).toEqual(careerLearningSchemaHashes);
  });

  it("records the indirect worker RPCs used by merged endpoint handlers", () => {
    expect(ENDPOINTS.providerStatus.rpcDependencies).toEqual([RpcMethods.ProviderStatus]);
    expect(ENDPOINTS.providerModels.rpcDependencies).toEqual([RpcMethods.ProviderModels]);
    expect(ENDPOINTS.verifyCodexProvider.rpcDependencies).toEqual([RpcMethods.ProviderVerify]);
    expect(ENDPOINTS.renderResumeReviewDraft.rpcDependencies).toEqual([
      RpcMethods.RenderResumePdf,
    ]);
    expect(ENDPOINTS.scanGmailApplicationOutcomes.rpcDependencies).toEqual([
      RpcMethods.GmailFeedbackScan,
    ]);
  });
});

describe("learning recommendation derivation RPC contract", () => {
  it("registers bounded runtime-scoped request and result shapes", () => {
    expect(RpcMethods.RederiveLearningRecommendations).toBe(
      "rederive_learning_recommendations",
    );
    expect(
      RederiveLearningRecommendationsParamsSchema.parse({
        expectedAppDir: "/tmp/jobctrl",
        expectedDbPath: "/tmp/jobctrl/jobctrl.db",
      }),
    ).toEqual({
      tenantId: "local",
      expectedAppDir: "/tmp/jobctrl",
      expectedDbPath: "/tmp/jobctrl/jobctrl.db",
    });
    const recommendationId = `learning-recommendation:${"a".repeat(64)}`;
    expect(
      RederiveLearningRecommendationsResultSchema.parse({
        status: "succeeded",
        recommendationCount: 1,
        recommendationIds: [recommendationId],
      }),
    ).toEqual({
      status: "succeeded",
      recommendationCount: 1,
      recommendationIds: [recommendationId],
    });
    expect(() =>
      RederiveLearningRecommendationsResultSchema.parse({
        status: "succeeded",
        recommendationCount: 0,
        recommendationIds: [recommendationId],
      }),
    ).toThrow();
    expect(() =>
      RederiveLearningRecommendationsResultSchema.parse({
        status: "succeeded",
        recommendationCount: 1,
        recommendationIds: ["private free text"],
      }),
    ).toThrow();
  });
});

describe("learning recommendation review RPC contract", () => {
  it("registers runtime-scoped review params and couples decision to policy effect", () => {
    const endpoint = ENDPOINTS.reviewLearningRecommendation;
    const recommendationId = `learning-recommendation:${"a".repeat(64)}`;
    const reviewId = `learning-recommendation-review:${"b".repeat(64)}`;
    const request = endpoint.request.parse({ decision: "accepted" });
    const params = endpoint.dispatch.params(
      { request, pathParam: recommendationId },
      ENDPOINT_DISPATCH_CONTEXT,
    );
    expect(endpoint.dispatch.rpcMethod).toBe("review_learning_recommendation");
    expect(endpoint.dispatch.paramsSchema.parse(params)).toEqual(params);
    expect(params.recommendationId).toBe(recommendationId);
    expect(params.decision).toBe(request.decision);
    expect(params.expectedAppDir).toBe(ENDPOINT_DISPATCH_CONTEXT.appDir);
    expect(params.expectedDbPath).toBe(ENDPOINT_DISPATCH_CONTEXT.dbPath);
    const acceptedResult = endpoint.dispatch.result.parse({
      status: "succeeded",
      reviewId,
      recommendationId,
      revision: 1,
      decision: "accepted",
      context: "materials",
      policyKind: "tailoring_rule",
      policyVersion: 2,
      reviewedAt: "2026-08-01T12:34:56+00:00",
    });
    expect(
      endpoint.response.parse(
        endpoint.dispatch.response({
          request,
          pathParam: recommendationId,
          result: acceptedResult,
        }),
      ),
    ).toMatchObject({
      reviewId,
      recommendationId,
      decision: "accepted",
      policyVersion: 2,
      reviewedAt: "2026-08-01T12:34:56.000Z",
    });
    expect(() =>
      endpoint.dispatch.paramsSchema.parse({
        ...params,
        unexpected: true,
      }),
    ).toThrow();
    expect(() =>
      endpoint.dispatch.result.parse({
        status: "succeeded",
        reviewId,
        recommendationId,
        revision: 1,
        decision: "accepted",
        context: "materials",
        policyKind: "tailoring_rule",
        policyVersion: null,
        reviewedAt: "2026-08-01T12:34:56Z",
      }),
    ).toThrow();
    expect(() =>
      endpoint.dispatch.result.parse({
        status: "succeeded",
        reviewId,
        recommendationId,
        revision: 1,
        decision: "rejected",
        context: "materials",
        policyKind: "tailoring_rule",
        policyVersion: 2,
        reviewedAt: "2026-08-01T12:34:56Z",
      }),
    ).toThrow();
  });
});

describe("tailoring policy rollback RPC contract", () => {
  it("registers a runtime-scoped rollback with closed policy metadata", () => {
    const endpoint = ENDPOINTS.rollbackTailoringPolicy;
    const request = endpoint.request.parse({ targetVersion: 1 });
    const params = endpoint.dispatch.params(
      { request, pathParam: undefined },
      ENDPOINT_DISPATCH_CONTEXT,
    );
    expect(endpoint.dispatch.rpcMethod).toBe("rollback_tailoring_policy");
    expect(endpoint.dispatch.paramsSchema.parse(params)).toEqual(params);
    expect(params.targetVersion).toBe(request.targetVersion);
    expect(params.expectedAppDir).toBe(ENDPOINT_DISPATCH_CONTEXT.appDir);
    expect(params.expectedDbPath).toBe(ENDPOINT_DISPATCH_CONTEXT.dbPath);
    const result = endpoint.dispatch.result.parse({
      status: "succeeded",
      context: "materials",
      policyKind: "tailoring_rule",
      policyVersion: 3,
      rollbackOfVersion: 1,
      rollbackReasonCode: "user_requested",
      learnedRules: [],
      rolledBackAt: "2026-08-01T12:34:56+00:00",
    });
    expect(
      endpoint.response.parse(
        endpoint.dispatch.response({
          request,
          pathParam: undefined,
          result,
        }),
      ),
    ).toMatchObject({
      version: 3,
      rollbackOfVersion: 1,
      createdAt: "2026-08-01T12:34:56.000Z",
    });
    expect(() =>
      endpoint.request.parse({ targetVersion: 0 }),
    ).toThrow();
    expect(() =>
      endpoint.dispatch.result.parse({
        status: "succeeded",
        context: "materials",
        policyKind: "tailoring_rule",
        policyVersion: 3,
        rollbackOfVersion: 1,
        rollbackReasonCode: "private narrative",
        learnedRules: [],
        rolledBackAt: "2026-08-01T12:34:56Z",
      }),
    ).toThrow();
  });
});

describe("cancel_run RPC contract", () => {
  it("registers cancel_run in RpcMethods", () => {
    expect(RpcMethods.CancelRun).toBe("cancel_run");
  });

  it("parses bounded profile target-role suggestion RPC parameters", () => {
    expect(RpcMethods.ProfileTargetRoleSuggestions).toBe("profile_target_role_suggestions");
    expect(
      ProfileTargetRoleSuggestionsParamsSchema.parse({
        expectedAppDir: "/tmp/jobctrl",
        expectedDbPath: "/tmp/jobctrl/jobctrl.db",
        expectedProfileVersion: 4,
      }),
    ).toEqual({
      tenantId: "local",
      expectedAppDir: "/tmp/jobctrl",
      expectedDbPath: "/tmp/jobctrl/jobctrl.db",
      expectedProfileVersion: 4,
      maximumSuggestions: 3,
    });
    expect(() =>
      ProfileTargetRoleSuggestionsParamsSchema.parse({
        expectedAppDir: "/tmp/jobctrl",
        expectedDbPath: "/tmp/jobctrl/jobctrl.db",
        expectedProfileVersion: 0,
        maximumSuggestions: 9,
      }),
    ).toThrow();
    expect(
      TargetRoleSuggestionResultSchema.parse({
        profileVersion: 4,
        determinationId:"a".repeat(64),status:"pending_confirmation",
        suggestions: [
          {
            title: "Staff Platform Engineer",
            classification: "direct",
            track: "ic",
            seniority: "staff",
            evidenceIds: ["experience:role_1"],citations:[{source_id:"experience:role_1",quote:"Canonical recent title",exact_values:[]}],
            rationale: "The canonical recent title and scope support this role.",
          },
        ],
        preferenceSuggestions: [
          { location: "London", workModel: "hybrid", evidenceIds: ["experience:role_1"],citations:[{source_id:"experience:role_1",quote:"Canonical location",exact_values:[]}],rationale:"Model location suggestion" },
          { location: "", workModel: "remote", evidenceIds: ["experience:role_2"],citations:[{source_id:"experience:role_2",quote:"Canonical location",exact_values:[]}],rationale:"Model location suggestion" },
        ],
        strategy: "model",
        warnings: [],
      }),
    ).toMatchObject({ profileVersion: 4, strategy: "model" });
    expect(() => TargetRoleSuggestionResultSchema.parse({
      profileVersion: 4,
      suggestions: [],
      preferenceSuggestions: [{ location: "", workModel: "Remote/Hybrid", evidenceIds: ["experience:role_1"] }],
      strategy: "deterministic",
    })).toThrow();
    expect(() =>
      TargetRoleSuggestionResultSchema.parse({
        profileVersion: 4,
        suggestions: [
          {
            title: "Invented",
            classification: "direct",
            track: "IC",
            seniority: "Staff",
            evidenceIds: ["fabricated evidence"],
            rationale: "Unsupported.",
          },
        ],
        strategy: "model",
      }),
    ).toThrow();
    expect(ProfileUpdateRequestSchema.parse({
      profile: {},
      expectedProfileVersion: 4,
    })).toMatchObject({ expectedProfileVersion: 4 });
  });

  it("parses a known-good request payload", () => {
    const parsed = CancelRunParamsSchema.parse({
      tenantId: "local",
      runId: "wf-123",
    });
    expect(parsed).toEqual({ tenantId: "local", runId: "wf-123" });
  });

  it("defaults tenantId to 'local' when omitted", () => {
    const parsed = CancelRunParamsSchema.parse({ runId: "wf-123" });
    expect(parsed.tenantId).toBe("local");
  });

  it("rejects a request missing runId", () => {
    expect(() => CancelRunParamsSchema.parse({ tenantId: "local" })).toThrow();
  });

  it("rejects an empty runId", () => {
    expect(() =>
      CancelRunParamsSchema.parse({ tenantId: "local", runId: "" }),
    ).toThrow();
  });

  it("parses a known-good response payload", () => {
    const parsed = CancelRunResultSchema.parse({
      runId: "wf-123",
      status: "canceling",
    });
    expect(parsed).toEqual({ runId: "wf-123", status: "canceling" });
  });

  it("rejects responses with the wrong status literal", () => {
    expect(() =>
      CancelRunResultSchema.parse({ runId: "wf-123", status: "canceled" }),
    ).toThrow();
  });
});

describe("provider model contracts", () => {
  it("registers provider_models and accepts the stable sanitized catalog", () => {
    expect(RpcMethods.ProviderModels).toBe("provider_models");
    expect(
      ProviderModelCatalogResultSchema.parse({
        providers: [
          {
            provider: "codex",
            configured: true,
            ready: true,
            source: "live",
            models: [{ id: "gpt-test", displayName: "GPT Test", isDefault: true }],
          },
          {
            provider: "claude",
            configured: true,
            ready: true,
            source: "live",
            models: [{ id: "sonnet", displayName: "Sonnet" }],
          },
          {
            provider: "google",
            configured: false,
            ready: false,
            source: "live",
            models: [],
            message: "Provider is not configured.",
          },
        ],
      }).providers,
    ).toHaveLength(3);
  });

  it("rejects reordered, secret-bearing, or unready nonempty catalogs", () => {
    const providers = [
      { provider: "claude", configured: true, ready: true, source: "live", models: [] },
      { provider: "codex", configured: true, ready: true, source: "live", models: [] },
      { provider: "google", configured: false, ready: false, source: "live", models: [] },
    ];
    expect(() => ProviderModelCatalogResultSchema.parse({ providers })).toThrow();
    expect(() =>
      ProviderModelCatalogResultSchema.parse({
        providers: [
          { provider: "codex", configured: true, ready: true, source: "live", models: [], account: "secret" },
          { provider: "claude", configured: true, ready: true, source: "live", models: [] },
          {
            provider: "google",
            configured: true,
            ready: false,
            source: "live",
            models: [{ id: "gemini-test", displayName: "Gemini Test" }],
          },
        ],
      }),
    ).toThrow();
  });

  it("parses a strict trimmed preferred-model patch with nullable clears", () => {
    expect(
      SettingsUpdateRequestSchema.parse({
        preferredModels: { codex: "  gpt-test  ", claude: null },
      }),
    ).toEqual({ preferredModels: { codex: "gpt-test", claude: null } });
    expect(() =>
      SettingsUpdateRequestSchema.parse({ preferredModels: { local: "model" } }),
    ).toThrow();
    expect(() =>
      SettingsUpdateRequestSchema.parse({ preferredModels: { google: "   " } }),
    ).toThrow();
  });
});

describe("manual_capture_import RPC contract", () => {
  it("registers and parses the awaited manual-capture workflow request", () => {
    expect(RpcMethods.ManualCaptureImport).toBe("manual_capture_import");
    expect(
      ManualCaptureImportParamsSchema.parse({
        itemId: "manual-1",
        captureMode: "pasted_text",
        contentText: "User-provided posting text.",
        capturedUrl: "https://example.test/jobs/1",
        note: "Captured after sign in.",
        futureManualActionRequired: true,
        expectedAppDir: "/tmp/jobctrl",
        expectedDbPath: "/tmp/jobctrl/jobctrl.db",
        awaitResult: true,
      }),
    ).toEqual({
      tenantId: "local",
      itemId: "manual-1",
      captureMode: "pasted_text",
      contentText: "User-provided posting text.",
      capturedUrl: "https://example.test/jobs/1",
      note: "Captured after sign in.",
      futureManualActionRequired: true,
      expectedAppDir: "/tmp/jobctrl",
      expectedDbPath: "/tmp/jobctrl/jobctrl.db",
      awaitResult: true,
    });
  });

  it("requires user-mediated content and an awaited workflow result", () => {
    expect(() =>
      ManualCaptureImportParamsSchema.parse({
        itemId: "manual-1",
        captureMode: "pasted_text",
        awaitResult: true,
      }),
    ).toThrow();
    expect(() =>
      ManualCaptureImportParamsSchema.parse({
        itemId: "manual-1",
        captureMode: "pasted_text",
        contentText: "User-provided posting text.",
      }),
    ).toThrow();
  });

  it("parses the snake_case workflow result contract", () => {
    expect(
      ManualCaptureImportWorkflowResultSchema.parse({
        status: "succeeded",
        item_id: "manual-1",
        job_id: "https://example.test/jobs/1",
        imported_at: "2026-07-10T10:00:00Z",
        retry_context: { manual_capture_provenance: {} },
        error: null,
        error_code: null,
      }),
    ).toMatchObject({
      status: "succeeded",
      item_id: "manual-1",
      job_id: "https://example.test/jobs/1",
    });
  });
});

describe("run_contact_research RPC contract", () => {
  it("registers canonical job-scoped research", () => {
    expect(RpcMethods.RunContactResearch).toBe("run_contact_research");
    expect(
      RunContactResearchParamsSchema.parse({
        taskId: "contact-research-1",
        jobId: CANONICAL_JOB_ID,
      }),
    ).toMatchObject({
      tenantId: "local",
      taskId: "contact-research-1",
      jobId: CANONICAL_JOB_ID,
    });
  });

  it("accepts an employer-scoped research request", () => {
    expect(
      RunContactResearchParamsSchema.parse({
        taskId: "contact-research-1",
        employer: "Acme",
      }),
    ).toMatchObject({
      tenantId: "local",
      employer: "Acme",
    });
  });

  it("rejects URL-shaped job IDs and legacy job URLs", () => {
    expect(() =>
      RunContactResearchParamsSchema.parse({
        taskId: "contact-research-1",
        jobId: "https://example.test/jobs/1",
      }),
    ).toThrow();
    expect(() =>
      RunContactResearchParamsSchema.parse({
        taskId: "contact-research-1",
        jobUrl: "https://example.test/jobs/1",
      }),
    ).toThrow();
  });

  it("rejects research requests without an employer or job ID", () => {
    expect(() =>
      RunContactResearchParamsSchema.parse({ taskId: "contact-research-1" }),
    ).toThrow();
  });
});

describe("preparation RPC contracts", () => {
  it("registers explicit rescore and retailor methods", () => {
    expect(RpcMethods.RescoreJob).toBe("rescore_job");
    expect(RpcMethods.RescoreJobsNotOnCurrentScoringPolicy).toBe(
      "rescore_jobs_not_on_current_scoring_policy",
    );
    expect(RpcMethods.TailorJob).toBe("tailor_job");
    expect(RpcMethods.RetailorJob).toBe("retailor_job");
    expect(RpcMethods.RetailorCurrentPolicy).toBe("retailor_current_policy");
    expect(RpcMethods.RefreshCompensation).toBe("refresh_compensation");
    expect(RpcMethods.GenerateInterviewPrep).toBe("generate_interview_prep");
  });

  it("accepts global, single-job, and explicit bulk run-stage selectors by canonical ID", () => {
    expect(RunStageParamsSchema.parse({ stage: "score" })).toMatchObject({
      tenantId: "local",
      stage: "score",
    });
    expect(
      RunStageParamsSchema.parse({ stage: "score", jobId: CANONICAL_JOB_ID }),
    ).toMatchObject({ jobId: CANONICAL_JOB_ID });
    expect(
      RunStageParamsSchema.parse({ stage: "score", jobIds: [CANONICAL_JOB_ID] }),
    ).toMatchObject({ jobIds: [CANONICAL_JOB_ID] });
  });

  it("rejects URL-shaped or ambiguous run-stage selectors", () => {
    expect(() =>
      RunStageParamsSchema.parse({
        stage: "score",
        jobUrl: "https://example.test/job/1",
      }),
    ).toThrow();
    expect(() =>
      RunStageParamsSchema.parse({
        stage: "score",
        jobUrls: ["https://example.test/job/1"],
      }),
    ).toThrow();
    expect(() =>
      RunStageParamsSchema.parse({
        stage: "score",
        jobId: "https://example.test/job/1",
      }),
    ).toThrow();
    expect(() =>
      RunStageParamsSchema.parse({
        stage: "score",
        jobIds: ["https://example.test/job/1"],
      }),
    ).toThrow();
    expect(() =>
      RunStageParamsSchema.parse({
        stage: "score",
        jobId: CANONICAL_JOB_ID,
        jobIds: [CANONICAL_JOB_ID],
      }),
    ).toThrow();
  });

  it("parses and defaults rescore_job request payloads", () => {
    const parsed = RescoreJobParamsSchema.parse({
      jobId: CANONICAL_JOB_ID,
    });

    expect(parsed).toEqual({
      tenantId: "local",
      jobId: CANONICAL_JOB_ID,
      dryRun: false,
    });
  });

  it("parses and rejects refresh_compensation payloads", () => {
    const params = RefreshCompensationParamsSchema.parse({
      jobId: CANONICAL_JOB_ID,
      observationsJsonPath: "/tmp/reported-compensation.json",
      includeEuroTopTech: true,
      euroTopTechMaxPages: 3,
    });

    expect(params).toEqual({
      tenantId: "local",
      jobId: CANONICAL_JOB_ID,
      observationsJsonPath: "/tmp/reported-compensation.json",
      includeEuroTopTech: true,
      euroTopTechMaxPages: 3,
    });
    expect(RefreshCompensationParamsSchema.parse({ allJobs: true })).toEqual({
      tenantId: "local",
      allJobs: true,
    });
    expect(() => RefreshCompensationParamsSchema.parse({})).toThrow();
    expect(() =>
      RefreshCompensationParamsSchema.parse({ jobId: CANONICAL_JOB_ID, allJobs: true }),
    ).toThrow();
    expect(() => RefreshCompensationParamsSchema.parse({ jobId: "", observationsJsonPath: "" })).toThrow();
    expect(() =>
      RefreshCompensationParamsSchema.parse({ jobId: "https://example.test/job/1" }),
    ).toThrow();

    expect(
      RefreshCompensationResultSchema.parse({
        ok: true,
        status: "succeeded",
        postingUrl: "https://example.test/job/1",
        postedFactsRefreshed: 1,
        reportedObservationsLoaded: 2,
        estimatesRefreshed: 1,
        tenantId: "local",
      }),
    ).toEqual({
      ok: true,
      status: "succeeded",
      postingUrl: "https://example.test/job/1",
      postedFactsRefreshed: 1,
      reportedObservationsLoaded: 2,
      localReportedObservationsLoaded: 0,
      licensedReportedObservationsLoaded: 0,
      levelsFyiObservationsLoaded: 0,
      levelsFyiPublicObservationsLoaded: 0,
      glassdoorObservationsLoaded: 0,
      euroTopTechObservationsLoaded: 0,
      estimatesRefreshed: 1,
      marketRefreshSkipped: false,
      tenantId: "local",
    });
    expect(
      RefreshCompensationResultSchema.parse({
        ok: true,
        status: "succeeded",
        postingUrl: null,
        postedFactsRefreshed: 2,
        reportedObservationsLoaded: 0,
        estimatesRefreshed: 2,
        tenantId: "local",
      }),
    ).toMatchObject({
      postingUrl: null,
      postedFactsRefreshed: 2,
      estimatesRefreshed: 2,
    });
  });

  it("parses and rejects stored interview prep generation payloads", () => {
    const parsed = GenerateInterviewPrepParamsSchema.parse({
      jobId: CANONICAL_JOB_ID,
      expectedAppDir: "/tmp/jobctrl",
      expectedDbPath: "/tmp/jobctrl/jobctrl.db",
    });

    expect(parsed).toEqual({
      tenantId: "local",
      expectedAppDir: "/tmp/jobctrl",
      expectedDbPath: "/tmp/jobctrl/jobctrl.db",
      jobId: CANONICAL_JOB_ID,
      llmModel: DEFAULT_PIPELINE_LLM_MODEL,
    });
    expect(() => GenerateInterviewPrepParamsSchema.parse({})).toThrow();
    expect(() => GenerateInterviewPrepParamsSchema.parse({ jobUrl: "https://example.test/job/interview" })).toThrow();
    expect(() => GenerateInterviewPrepParamsSchema.parse({ jobId: "https://example.test/job/interview" })).toThrow();
  });

  it("parses the REST generate-interview-prep request body", () => {
    expect(GenerateInterviewPrepRequestSchema.parse({})).toEqual({});
    expect(GenerateInterviewPrepRequestSchema.parse({ llmModel: "gpt-test" })).toEqual({
      llmModel: "gpt-test",
    });
    expect(() => GenerateInterviewPrepRequestSchema.parse({ llmModel: "" })).toThrow();
  });

  it("keeps the conditional evidence version fence on both REST and derived RPC schemas", () => {
    const choice = { selectedQuestionIds: ["TS09"], evidenceSelections: [{ questionId: "TS09", evidenceIds: [] }], evidenceProfileVersion: 3 };
    for (const schema of [GenerateInterviewPrepRequestSchema, GenerateInterviewPrepParamsSchema]) {
      const base = schema === GenerateInterviewPrepParamsSchema ? { jobId: CANONICAL_JOB_ID } : {};
      expect(schema.parse({ ...base, ...choice })).toMatchObject(choice);
      const rawChoice = { ...choice, evidenceSelections: [{ questionId: "TS09", evidenceIds: [" raw canonical ID "] }] };
      expect(schema.parse({ ...base, ...rawChoice })).toMatchObject(rawChoice);
      expect(() => schema.parse({ ...base, selectedQuestionIds: ["A".repeat(13) + "01"] })).toThrow();
      expect(() => schema.parse({ ...base, ...choice, evidenceSelections: [{ questionId: "TS09", evidenceIds: ["x".repeat(201)] }] })).toThrow();
      const { evidenceProfileVersion: _version, ...unfenced } = choice;
      expect(() => schema.parse({ ...base, ...unfenced })).toThrow();
      expect(() => schema.parse({ ...base, ...choice, evidenceSelections: [{ questionId: "TS10", evidenceIds: [] }] })).toThrow();
      expect(() => schema.parse({ ...base, ...choice, evidenceSelections: [{ questionId: "TS09", evidenceIds: ["fact", "fact"] }] })).toThrow();
    }
  });

  it("keeps interview prep off live-assistance contract names", () => {
    const exposedNames = [
      RpcMethods.GenerateInterviewPrep,
      "generate_interview_prep",
      "/v1/jobs/:jobKey/actions/generate-interview-prep",
      ...Object.keys(GenerateInterviewPrepParamsSchema.shape),
      ...Object.keys(GenerateInterviewPrepRequestSchema.shape),
    ];
    const forbidden = /(live|in[_-]?session|stream|transcript|microphone|websocket|real[_-]?time)/i;
    expect(exposedNames.filter((name) => forbidden.test(name))).toEqual([]);
  });

  it("rejects invalid rescore_job request payloads", () => {
    expect(() => RescoreJobParamsSchema.parse({})).toThrow();
    expect(() => RescoreJobParamsSchema.parse({ jobUrl: "" })).toThrow();
    expect(() => RescoreJobParamsSchema.parse({ jobId: "https://example.test/job/1" })).toThrow();
    expect(() =>
      RescoreJobParamsSchema.parse({
        jobId: CANONICAL_JOB_ID,
        jobUrl: "https://example.test/job/1",
      }),
    ).toThrow();
  });

  it("parses and defaults bulk rescore request payloads", () => {
    const parsed = RescoreJobsNotOnCurrentScoringPolicyParamsSchema.parse({});

    expect(parsed).toEqual({
      tenantId: "local",
      limit: 100,
      jobIds: [],
      dryRun: false,
    });
  });

  it("rejects invalid bulk rescore request payloads", () => {
    expect(() =>
      RescoreJobsNotOnCurrentScoringPolicyParamsSchema.parse({ limit: 0 }),
    ).toThrow();
    expect(() =>
      RescoreJobsNotOnCurrentScoringPolicyParamsSchema.parse({ jobIds: ["https://example.test/job/1"] }),
    ).toThrow();
  });

  it("parses and defaults retailor_job request payloads", () => {
    const parsed = RetailorJobParamsSchema.parse({
      jobId: CANONICAL_JOB_ID,
    });

    expect(parsed).toEqual({
      tenantId: "local",
      jobId: CANONICAL_JOB_ID,
      dryRun: false,
      suppressExistingArtifacts: true,
      tailorModels: [],
    });
  });

  it("parses and defaults tailor_job request payloads", () => {
    const parsed = TailorJobParamsSchema.parse({
      jobId: CANONICAL_JOB_ID,
    });

    expect(parsed).toEqual({
      tenantId: "local",
      jobId: CANONICAL_JOB_ID,
      dryRun: false,
      allowLowFitOverride: true,
      tailorModels: [],
    });
  });

  it("rejects invalid tailor_job request payloads", () => {
    expect(() => TailorJobParamsSchema.parse({})).toThrow();
    expect(TailorJobParamsSchema.parse({jobId:CANONICAL_JOB_ID})).toMatchObject({jobId:CANONICAL_JOB_ID});
    expect(() =>
      TailorJobParamsSchema.parse({ jobUrl: "https://example.test/job/1" }),
    ).toThrow();
  });

  it("rejects invalid retailor_job request payloads", () => {
    expect(() => RetailorJobParamsSchema.parse({})).toThrow();
    expect(() => RetailorJobParamsSchema.parse({ jobId: "not-a-job-id" })).toThrow();
    expect(() =>
      RetailorJobParamsSchema.parse({
        jobId: CANONICAL_JOB_ID,
        jobUrl: "https://example.test/job/1",
      }),
    ).toThrow();
    expect(RetailorJobParamsSchema.parse({jobId:CANONICAL_JOB_ID})).toMatchObject({jobId:CANONICAL_JOB_ID});
  });

  it("parses and defaults bulk retailor request payloads", () => {
    const parsed = RetailorCurrentPolicyParamsSchema.parse({});

    expect(parsed).toEqual({
      tenantId: "local",
      limit: 100,
      jobIds: [],
      dryRun: false,
      suppressExistingArtifacts: true,
      tailorModels: [],
    });
  });

  it("rejects invalid bulk retailor request payloads", () => {
    expect(() => RetailorCurrentPolicyParamsSchema.parse({ limit: 0 })).toThrow();
    expect(() =>
      RetailorCurrentPolicyParamsSchema.parse({
        jobIds: ["https://example.test/job/1"],
      }),
    ).toThrow();
    expect(() =>
      RetailorCurrentPolicyParamsSchema.parse({
        tailorModels: ["a", "b", "c", "d", "e", "f"],
      }),
    ).toThrow();
  });

  it("parses canonical analyze params and results and rejects URL locators", () => {
    expect(
      AnalyzeJobParamsSchema.parse({ jobId: CANONICAL_JOB_ID }),
    ).toEqual({ tenantId: "local", jobId: CANONICAL_JOB_ID, force: false });
    expect(
      AnalyzeJobResultSchema.parse({
        jobId: CANONICAL_JOB_ID,
        generation: 2,
        cacheKey: "cache-key",
        cached: false,
        legsAttempted: 3,
        legsSucceeded: 3,
        degraded: false,
      }),
    ).toMatchObject({ jobId: CANONICAL_JOB_ID, generation: 2 });
    expect(() =>
      AnalyzeJobParamsSchema.parse({ jobUrl: "https://example.test/job/1" }),
    ).toThrow();
    expect(() =>
      AnalyzeJobParamsSchema.parse({ jobId: "https://example.test/job/1" }),
    ).toThrow();
    expect(() =>
      AnalyzeJobResultSchema.parse({
        jobUrl: "https://example.test/job/1",
        generation: 2,
        cacheKey: "cache-key",
        cached: false,
        legsAttempted: 3,
        legsSucceeded: 3,
        degraded: false,
      }),
    ).toThrow();
  });

  it("keeps global apply while requiring canonical IDs for explicit targets", () => {
    expect(ApplyParamsSchema.parse({})).toMatchObject({ tenantId: "local" });
    expect(ApplyParamsSchema.parse({ jobId: CANONICAL_JOB_ID })).toMatchObject({
      jobId: CANONICAL_JOB_ID,
    });
    expect(() =>
      ApplyParamsSchema.parse({ jobUrl: "https://example.test/job/1" }),
    ).toThrow();
    expect(() =>
      ApplyParamsSchema.parse({ jobId: "https://example.test/job/1" }),
    ).toThrow();
  });
});

// Compile-only negative calls are included by checks.api-types. Never execute.
function typedRpcNegativeCalls(dispatcher: import("../src/json-rpc-adapter.js").JsonRpcDispatcher, adapter: import("../src/json-rpc-adapter.js").SubprocessJsonRpcAdapter) {
  // @ts-expect-error missing required stage
  void dispatcher.call("run_stage", { workers: 1 });
  // @ts-expect-error method-specific params cannot be exchanged
  void dispatcher.call("render_resume_pdf", { stage: "score" });
  // @ts-expect-error unknown params are not a public fallback
  void dispatcher.call("run_stage", { stage: "score", arbitraryField: true });
  // @ts-expect-error even parameterless methods reject fields
  void dispatcher.call("provider_models", { arbitraryField: true });
  // @ts-expect-error verification requires an explicit provider
  void dispatcher.call("provider_verify", {});
  // @ts-expect-error concrete adapter requires the same verification provider
  void adapter.call("provider_verify", {});
  // @ts-expect-error unknown methods are not a public fallback
  void dispatcher.call("unregistered", {});
  // @ts-expect-error browser enable requires one of the supported selectors
  void dispatcher.call("browser_capability_enable", { capabilityId: "auto-apply-browser" });
  // @ts-expect-error semantic review requires its runtime binding
  void dispatcher.call("review_resume_edit", { draftId: "draft", revisionId: "revision" });
}
void typedRpcNegativeCalls;

async function typedRpcResult(dispatcher: import("../src/json-rpc-adapter.js").JsonRpcDispatcher) {
  const { callRpc } = await import("../src/json-rpc-adapter.js");
  // @ts-expect-error shared calls also require the verification provider
  void callRpc(dispatcher, "provider_verify", {});
  const response = await callRpc(dispatcher, "render_resume_pdf", { htmlPath: "/synthetic/in.html", pdfPath: "/synthetic/out.pdf" });
  expectTypeOf(response.result).toEqualTypeOf<RpcResult<"render_resume_pdf"> | undefined>();
  // @ts-expect-error consumed results retain the selected method's type
  void response.result?.runId;
}
void typedRpcResult;
