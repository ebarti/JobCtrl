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
  RefreshCompensationParamsSchema,
  RefreshCompensationResultSchema,
  RescoreJobParamsSchema,
  RescoreJobsNotOnCurrentScoringPolicyParamsSchema,
  RetailorCurrentPolicyParamsSchema,
  RetailorJobParamsSchema,
  RpcMethods,
  TailorJobParamsSchema,
} from "../src/contracts.js";

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
      expectedAppDir: "/tmp/jobctl",
      expectedDbPath: "/tmp/jobctl/jobctl.db",
    });

    expect(parsed).toEqual({
      tenantId: "local",
      expectedAppDir: "/tmp/jobctl",
      expectedDbPath: "/tmp/jobctl/jobctl.db",
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
