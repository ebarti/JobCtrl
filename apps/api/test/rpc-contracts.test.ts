/**
 * RPC contract schema coverage — keeps the TS contract package in sync with
 * the Python worker handler set.  Each new RPC method gets a parse + reject
 * pair here so type drift between TS and Python surfaces in CI.
 */
import { describe, expect, it } from "vitest";

import {
  CancelRunParamsSchema,
  CancelRunResultSchema,
  DEFAULT_PIPELINE_LLM_MODEL,
  GenerateInterviewPrepRequestSchema,
  GenerateInterviewPrepParamsSchema,
  ManualCaptureImportParamsSchema,
  ManualCaptureImportWorkflowResultSchema,
  ProviderModelCatalogResultSchema,
  RefreshCompensationParamsSchema,
  RefreshCompensationResultSchema,
  RescoreJobParamsSchema,
  RescoreJobsNotOnCurrentScoringPolicyParamsSchema,
  RetailorCurrentPolicyParamsSchema,
  RetailorJobParamsSchema,
  RpcMethods,
  SettingsUpdateRequestSchema,
  TailorJobParamsSchema,
} from "../src/contracts.js";

const CANONICAL_JOB_ID = "11111111-1111-4111-8111-111111111111";

describe("cancel_run RPC contract", () => {
  it("registers cancel_run in RpcMethods", () => {
    expect(RpcMethods.CancelRun).toBe("cancel_run");
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

  it("parses and defaults rescore_job request payloads", () => {
    const parsed = RescoreJobParamsSchema.parse({
      jobUrl: "https://example.test/job/1",
    });

    expect(parsed).toEqual({
      tenantId: "local",
      jobUrl: "https://example.test/job/1",
      dryRun: false,
    });
    expect(RescoreJobParamsSchema.parse({ jobId: CANONICAL_JOB_ID })).toEqual({
      tenantId: "local",
      jobId: CANONICAL_JOB_ID,
      dryRun: false,
    });
  });

  it("parses and rejects refresh_compensation payloads", () => {
    const params = RefreshCompensationParamsSchema.parse({
      jobUrl: "https://example.test/job/1",
      observationsJsonPath: "/tmp/reported-compensation.json",
      includeEuroTopTech: true,
      euroTopTechMaxPages: 3,
    });

    expect(params).toEqual({
      tenantId: "local",
      jobUrl: "https://example.test/job/1",
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
      RefreshCompensationParamsSchema.parse({ jobUrl: "https://example.test/job/1", allJobs: true }),
    ).toThrow();
    expect(() => RefreshCompensationParamsSchema.parse({ jobUrl: "", observationsJsonPath: "" })).toThrow();

    expect(
      RefreshCompensationResultSchema.parse({
        ok: true,
        status: "succeeded",
        jobUrl: "https://example.test/job/1",
        postedFactsRefreshed: 1,
        reportedObservationsLoaded: 2,
        estimatesRefreshed: 1,
        tenantId: "local",
      }),
    ).toEqual({
      ok: true,
      status: "succeeded",
      jobUrl: "https://example.test/job/1",
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
        jobUrl: null,
        postedFactsRefreshed: 2,
        reportedObservationsLoaded: 0,
        estimatesRefreshed: 2,
        tenantId: "local",
      }),
    ).toMatchObject({
      jobUrl: null,
      postedFactsRefreshed: 2,
      estimatesRefreshed: 2,
    });
  });

  it("parses and rejects stored interview prep generation payloads", () => {
    const parsed = GenerateInterviewPrepParamsSchema.parse({
      jobUrl: "https://example.test/job/interview",
      expectedAppDir: "/tmp/jobctrl",
      expectedDbPath: "/tmp/jobctrl/jobctrl.db",
    });

    expect(parsed).toEqual({
      tenantId: "local",
      expectedAppDir: "/tmp/jobctrl",
      expectedDbPath: "/tmp/jobctrl/jobctrl.db",
      jobUrl: "https://example.test/job/interview",
      llmModel: DEFAULT_PIPELINE_LLM_MODEL,
    });
    expect(() => GenerateInterviewPrepParamsSchema.parse({})).toThrow();
    expect(() => GenerateInterviewPrepParamsSchema.parse({ jobUrl: "" })).toThrow();
  });

  it("parses the REST generate-interview-prep request body", () => {
    expect(GenerateInterviewPrepRequestSchema.parse({})).toEqual({});
    expect(GenerateInterviewPrepRequestSchema.parse({ llmModel: "gpt-test" })).toEqual({
      llmModel: "gpt-test",
    });
    expect(() => GenerateInterviewPrepRequestSchema.parse({ llmModel: "" })).toThrow();
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
      jobUrls: [],
      dryRun: false,
    });
  });

  it("rejects invalid bulk rescore request payloads", () => {
    expect(() =>
      RescoreJobsNotOnCurrentScoringPolicyParamsSchema.parse({ limit: 0 }),
    ).toThrow();
    expect(() =>
      RescoreJobsNotOnCurrentScoringPolicyParamsSchema.parse({ jobUrls: [""] }),
    ).toThrow();
  });

  it("parses and defaults retailor_job request payloads", () => {
    const parsed = RetailorJobParamsSchema.parse({
      jobUrl: "https://example.test/job/1",
    });

    expect(parsed).toEqual({
      tenantId: "local",
      jobUrl: "https://example.test/job/1",
      dryRun: false,
      suppressExistingArtifacts: true,
      tailorModels: [],
    });
    expect(RetailorJobParamsSchema.parse({ jobId: CANONICAL_JOB_ID })).toEqual({
      tenantId: "local",
      jobId: CANONICAL_JOB_ID,
      dryRun: false,
      suppressExistingArtifacts: true,
      tailorModels: [],
    });
  });

  it("parses and defaults tailor_job request payloads", () => {
    const parsed = TailorJobParamsSchema.parse({
      jobUrl: "https://example.test/job/1",
    });

    expect(parsed).toEqual({
      tenantId: "local",
      jobUrl: "https://example.test/job/1",
      dryRun: false,
      allowLowFitOverride: true,
      tailorModels: [],
    });
  });

  it("rejects invalid tailor_job request payloads", () => {
    expect(() => TailorJobParamsSchema.parse({})).toThrow();
    expect(() =>
      TailorJobParamsSchema.parse({
        jobUrl: "https://example.test/job/1",
        tailorJudgeMinScore: 1.1,
      }),
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
    expect(() =>
      RetailorJobParamsSchema.parse({
        jobUrl: "https://example.test/job/1",
        tailorJudgeMinScore: 1.1,
      }),
    ).toThrow();
  });

  it("parses and defaults bulk retailor request payloads", () => {
    const parsed = RetailorCurrentPolicyParamsSchema.parse({});

    expect(parsed).toEqual({
      tenantId: "local",
      limit: 100,
      jobUrls: [],
      dryRun: false,
      suppressExistingArtifacts: true,
      tailorModels: [],
    });
  });

  it("rejects invalid bulk retailor request payloads", () => {
    expect(() => RetailorCurrentPolicyParamsSchema.parse({ limit: 0 })).toThrow();
    expect(() =>
      RetailorCurrentPolicyParamsSchema.parse({
        tailorModels: ["a", "b", "c", "d", "e", "f"],
      }),
    ).toThrow();
  });
});
