/**
 * JSON-RPC adapter tests (Phase 9 / S-34).
 *
 * The adapter is exercised through the public ``createActionDispatcher``
 * factory using a fake in-memory ``JsonRpcDispatcher`` so we don't need
 * to spawn the Python worker subprocess in CI.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it, vi } from "vitest";

import { DEFAULT_PIPELINE_LLM_MODEL, PIPELINE_ACTION_JOB_KEY, type ActionCommandPayload } from "../src/contracts.js";
import {
  buildActionResponse,
  createActionDispatcher,
  createContactResearchStarter,
  type ActionDispatchResult,
  type JsonRpcDispatcherFactory,
} from "../src/local-actions.js";
import type {
  JsonRpcDispatcher,
} from "../src/json-rpc-adapter.js";
import type { JsonRpcResponse, RpcMethod } from "../src/contracts.js";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const CANONICAL_JOB_ID = "11111111-1111-4111-8111-111111111111";

class FakeDispatcher implements JsonRpcDispatcher {
  public readonly calls: Array<{ method: RpcMethod; params: Record<string, unknown> }> = [];
  private response: JsonRpcResponse | null = null;

  setResponse(response: JsonRpcResponse): void {
    this.response = response;
  }

  async call(method: RpcMethod, params: Record<string, unknown>): Promise<JsonRpcResponse> {
    this.calls.push({ method, params });
    if (this.response) return this.response;
    const result = method === "cancel_run" ? { runId: "run-1", status: "canceling" }
      : method === "analyze_job" ? { jobId: CANONICAL_JOB_ID, generation: 1, cacheKey: "synthetic", cached: false, legsAttempted: 1, legsSucceeded: 1, degraded: false }
      : method === "run_stage" && params.awaitResult ? { runId: "run-fake", result: { stages_completed: ["score", "tailor", "cover"], stages_failed: [], failure: null, error_code: null } }
      : { runId: "run-fake" };
    return { jsonrpc: "2.0", id: 1, result };
  }

  async close(): Promise<void> {
    /* no-op */
  }
}

describe("createContactResearchStarter (JSON-RPC adapter)", () => {
  it("dispatches only the canonical JobId to the worker", async () => {
    const fake = new FakeDispatcher();
    fake.setResponse({
      jsonrpc: "2.0",
      id: 1,
      result: {
        runId: "run-contact",
        workflowId: "contact-research-task-1",
        firstExecutionRunId: "run-contact",
      },
    });
    const factory = vi.fn<JsonRpcDispatcherFactory>(() => fake);
    const starter = createContactResearchStarter(undefined, factory);

    const result = await starter(
      {
        taskId: "task-1",
        employer: "Acme",
        jobId: CANONICAL_JOB_ID,
        sources: [
          {
            category: "public_web_page",
            url: "https://example.com/team",
            label: "Team",
          },
        ],
      },
      { appDir: "/tmp", dbPath: "/tmp/jobctrl.db" },
    );

    expect(fake.calls).toEqual([
      {
        method: "run_contact_research",
        params: {
          tenantId: "local",
          expectedAppDir: "/tmp",
          expectedDbPath: "/tmp/jobctrl.db",
          taskId: "task-1",
          employer: "Acme",
          jobId: CANONICAL_JOB_ID,
          sources: [
            {
              category: "public_web_page",
              url: "https://example.com/team",
              label: "Team",
            },
          ],
          llmModel: DEFAULT_PIPELINE_LLM_MODEL,
        },
      },
    ]);
    expect(result).toEqual({
      runId: "run-contact",
      workflowId: "contact-research-task-1",
      firstExecutionRunId: "run-contact",
      status: "queued",
    });
  });
});

describe("createActionDispatcher (JSON-RPC adapter)", () => {
  it("maps learning rederivation to one runtime-scoped synchronous RPC", async () => {
    const fake = new FakeDispatcher();
    const recommendationId = `learning-recommendation:${"a".repeat(64)}`;
    fake.setResponse({
      jsonrpc: "2.0",
      id: 1,
      result: {
        status: "succeeded",
        recommendationCount: 1,
        recommendationIds: [recommendationId],
      },
    });
    const dispatcher = createActionDispatcher(fake);

    const result = await dispatcher(
      { action: "rederive_learning_recommendations", jobKey: "learning" },
      { appDir: "/tmp/jobctrl", dbPath: "/tmp/jobctrl/jobctrl.db" },
    );

    expect(fake.calls).toEqual([
      {
        method: "rederive_learning_recommendations",
        params: {
          tenantId: "local",
          expectedAppDir: "/tmp/jobctrl",
          expectedDbPath: "/tmp/jobctrl/jobctrl.db",
        },
      },
    ]);
    expect(result).toEqual({
      status: "succeeded",
      result: {
        status: "succeeded",
        recommendationCount: 1,
        recommendationIds: [recommendationId],
      },
    });
  });

  it("preserves the cancel_run RPC canceling status and run id", async () => {
    const fake = new FakeDispatcher();
    fake.setResponse({
      jsonrpc: "2.0",
      id: 1,
      result: { runId: "workflow-run-1", status: "canceling" },
    });
    const dispatcher = createActionDispatcher(fake);

    const result = await dispatcher(
      { action: "cancel", jobKey: PIPELINE_ACTION_JOB_KEY, runId: "workflow-run-1" },
      { appDir: "/tmp", dbPath: "/tmp/jobctrl.db" },
    );

    expect(fake.calls).toEqual([
      {
        method: "cancel_run",
        params: {
          tenantId: "local",
          runId: "workflow-run-1",
          requestedBy: "local_operator",
          source: "jobctrl_api",
          reason: "Canceled from JobCtrl.",
        },
      },
    ]);
    expect(result).toEqual({
      status: "canceling",
      runId: "workflow-run-1",
      result: { runId: "workflow-run-1", status: "canceling" },
    });
  });

  it("maps an apply action to the apply RPC method", async () => {
    const fake = new FakeDispatcher();
    const dispatcher = createActionDispatcher(fake);

    const result = await dispatcher(
      {
        action: "apply",
        jobKey: CANONICAL_JOB_ID,
        jobId: CANONICAL_JOB_ID,
        limit: 1,
        dryRun: true,
        model: "default",
      },
      { appDir: "/tmp", dbPath: "/tmp/jobctrl.db" },
    );

    expect(fake.calls).toHaveLength(1);
    expect(fake.calls[0]?.method).toBe("apply");
    expect(fake.calls[0]?.params).toMatchObject({
      tenantId: "local",
      expectedAppDir: "/tmp",
      expectedDbPath: "/tmp/jobctrl.db",
      jobId: CANONICAL_JOB_ID,
      limit: 1,
      dryRun: true,
      model: "default",
      headless: false,
    });
    expect(result).toMatchObject({ status: "queued", runId: "run-fake" });
  });

  it("maps a retry-stage with runAfter for apply", async () => {
    const fake = new FakeDispatcher();
    const dispatcher = createActionDispatcher(fake);

    const result = await dispatcher(
      {
        action: "retry_stage",
        jobKey: CANONICAL_JOB_ID,
        jobId: CANONICAL_JOB_ID,
        stage: "apply",
        runAfter: true,
        dryRun: true,
        limit: 1,
      },
      { appDir: "/tmp", dbPath: "/tmp/jobctrl.db" },
    );

    expect(fake.calls[0]?.method).toBe("apply");
    expect(result.status).toBe("queued");
  });

  it("maps a retry-stage with runAfter for preparation into a job-scoped pipeline run", async () => {
    const fake = new FakeDispatcher();
    const dispatcher = createActionDispatcher(fake);

    const result = await dispatcher(
      {
        action: "retry_stage",
        jobKey: CANONICAL_JOB_ID,
        jobId: CANONICAL_JOB_ID,
        stage: "enrich",
        stages: ["enrich", "score", "tailor", "cover"],
        runAfter: true,
        dryRun: true,
        limit: 1,
      },
      { appDir: "/tmp", dbPath: "/tmp/jobctrl.db" },
    );

    expect(fake.calls[0]).toEqual({
      method: "run_stage",
      params: expect.objectContaining({
        tenantId: "local",
        expectedAppDir: "/tmp",
        expectedDbPath: "/tmp/jobctrl.db",
        jobId: CANONICAL_JOB_ID,
        stage: "enrich",
        stages: ["enrich", "score", "tailor", "cover"],
        limit: 1,
        dryRun: true,
      }),
    });
    expect(result.status).toBe("queued");
  });

  it("maps a tailor retry with runAfter through cover for the same job", async () => {
    const fake = new FakeDispatcher();
    const dispatcher = createActionDispatcher(fake);

    await dispatcher(
      {
        action: "retry_stage",
        jobKey: CANONICAL_JOB_ID,
        jobId: CANONICAL_JOB_ID,
        stage: "tailor",
        runAfter: true,
        dryRun: true,
        limit: 1,
      },
      { appDir: "/tmp", dbPath: "/tmp/jobctrl.db" },
    );

    expect(fake.calls[0]).toEqual({
      method: "run_stage",
      params: expect.objectContaining({
        jobId: CANONICAL_JOB_ID,
        stage: "tailor",
        stages: ["tailor", "cover"],
        limit: 1,
        dryRun: true,
      }),
    });
  });

  it("maps a global run-stage workflow start to a queued action", async () => {
    const fake = new FakeDispatcher();
    fake.setResponse({
      jsonrpc: "2.0",
      id: 1,
      result: {
        runId: "pipeline-wf",
        workflowId: "pipeline-wf",
        firstExecutionRunId: "first-exec-run-id",
      },
    } as JsonRpcResponse);
    const dispatcher = createActionDispatcher(fake);

    const result = await dispatcher(
      {
        action: "run_stage",
        jobKey: "pipeline",
        stage: "score",
        limit: 20,
        workers: 4,
        minScore: 8,
        tailorModels: [],
        validationMode: "strict",
        dryRun: true,
        rescore: true,
        retailor: false,
      },
      { appDir: "/tmp", dbPath: "/tmp/jobctrl.db" },
    );

    expect(fake.calls).toHaveLength(1);
    expect(fake.calls[0]).toEqual({
      method: "run_stage",
      params: {
        tenantId: "local",
        expectedAppDir: "/tmp",
        expectedDbPath: "/tmp/jobctrl.db",
        stage: "score",
        stages: ["score"],
        limit: 20,
        workers: 4,
        minScore: 8,
        validationMode: "strict",
        dryRun: true,
        rescore: true,
        retailor: false,
        tailorModels: [],
        headless: false,
        model: "default",
        llmModel: DEFAULT_PIPELINE_LLM_MODEL,
        continuous: false,
      },
    });
    expect(result).toMatchObject({
      status: "queued",
      runId: "pipeline-wf",
      result: {
        runId: "pipeline-wf",
        workflowId: "pipeline-wf",
        firstExecutionRunId: "first-exec-run-id",
      },
    });
  });

  it("maps preparation maintenance actions to current-policy RPC methods", async () => {
    const fake = new FakeDispatcher();
    const dispatcher = createActionDispatcher(fake);
    const context = { appDir: "/tmp", dbPath: "/tmp/jobctrl.db" };

    await dispatcher(
      {
        action: "rescore_job",
        jobKey: CANONICAL_JOB_ID,
        jobId: CANONICAL_JOB_ID,
        dryRun: true,
        reason: "policy refresh",
      },
      context,
    );
    await dispatcher(
      {
        action: "rescore_jobs_not_on_current_scoring_policy",
        jobKey: "pipeline",
        jobIds: [CANONICAL_JOB_ID],
        limit: 10,
        dryRun: true,
      },
      context,
    );
    await dispatcher(
      {
        action: "tailor_job",
        jobKey: CANONICAL_JOB_ID,
        jobId: CANONICAL_JOB_ID,
        dryRun: true,
        reason: "manual_tailor",
        tailorModels: ["gemini:test"],
        tailorJudgeModel: "judge:test",
      },
      context,
    );
    await dispatcher(
      {
        action: "retailor_job",
        jobKey: CANONICAL_JOB_ID,
        jobId: CANONICAL_JOB_ID,
        dryRun: true,
        suppressExistingArtifacts: false,
        tailorModels: ["gemini:test"],
        tailorJudgeModel: "judge:test",
      },
      context,
    );
    await dispatcher(
      {
        action: "retailor_current_policy",
        jobKey: "pipeline",
        jobIds: [CANONICAL_JOB_ID],
        limit: 5,
        dryRun: false,
      },
      context,
    );

    expect(fake.calls).toEqual([
      {
        method: "rescore_job",
        params: {
          tenantId: "local",
          expectedAppDir: "/tmp",
          expectedDbPath: "/tmp/jobctrl.db",
          jobId: CANONICAL_JOB_ID,
          dryRun: true,
          reason: "policy refresh",
        },
      },
      {
        method: "rescore_jobs_not_on_current_scoring_policy",
        params: {
          tenantId: "local",
          expectedAppDir: "/tmp",
          expectedDbPath: "/tmp/jobctrl.db",
          limit: 10,
          jobIds: [CANONICAL_JOB_ID],
          dryRun: true,
        },
      },
      {
        method: "tailor_job",
        params: {
          tenantId: "local",
          expectedAppDir: "/tmp",
          expectedDbPath: "/tmp/jobctrl.db",
          jobId: CANONICAL_JOB_ID,
          dryRun: true,
          allowLowFitOverride: true,
          reason: "manual_tailor",
          tailorModels: ["gemini:test"],
          tailorJudgeModel: "judge:test",
        },
      },
      {
        method: "retailor_job",
        params: {
          tenantId: "local",
          expectedAppDir: "/tmp",
          expectedDbPath: "/tmp/jobctrl.db",
          jobId: CANONICAL_JOB_ID,
          dryRun: true,
          suppressExistingArtifacts: false,
          tailorModels: ["gemini:test"],
          tailorJudgeModel: "judge:test",
        },
      },
      {
        method: "retailor_current_policy",
        params: {
          tenantId: "local",
          expectedAppDir: "/tmp",
          expectedDbPath: "/tmp/jobctrl.db",
          limit: 5,
          jobIds: [CANONICAL_JOB_ID],
          dryRun: false,
          suppressExistingArtifacts: false,
          tailorModels: [],
        },
      },
    ]);
  });

  it("dispatches canonical job ids for direct rescore and retailor actions", async () => {
    const fake = new FakeDispatcher();
    const dispatcher = createActionDispatcher(fake);
    const context = { appDir: "/tmp", dbPath: "/tmp/jobctrl.db" };

    await dispatcher(
      {
        action: "rescore_job",
        jobKey: CANONICAL_JOB_ID,
        jobId: CANONICAL_JOB_ID,
        dryRun: true,
      },
      context,
    );
    await dispatcher(
      {
        action: "retailor_job",
        jobKey: CANONICAL_JOB_ID,
        jobId: CANONICAL_JOB_ID,
        suppressExistingArtifacts: true,
        tailorModels: [],
      },
      context,
    );

    expect(fake.calls).toEqual([
      {
        method: "rescore_job",
        params: {
          tenantId: "local",
          expectedAppDir: "/tmp",
          expectedDbPath: "/tmp/jobctrl.db",
          jobId: CANONICAL_JOB_ID,
          dryRun: true,
        },
      },
      {
        method: "retailor_job",
        params: {
          tenantId: "local",
          expectedAppDir: "/tmp",
          expectedDbPath: "/tmp/jobctrl.db",
          jobId: CANONICAL_JOB_ID,
          dryRun: false,
          suppressExistingArtifacts: true,
          tailorModels: [],
        },
      },
    ]);
  });

  it("fails closed when job-scoped actions lack a canonical job id", async () => {
    const fake = new FakeDispatcher();
    const dispatcher = createActionDispatcher(fake);
    const context = { appDir: "/tmp", dbPath: "/tmp/jobctrl.db" };

    const commands: ActionCommandPayload[] = [
      { action: "retry_stage", jobKey: "https://example.com/jobs/legacy", stage: "score", runAfter: true },
      { action: "run_stage", jobKey: "https://example.com/jobs/legacy", stage: "score" },
      { action: "rescore_job", jobKey: "https://example.com/jobs/legacy" },
      { action: "tailor_job", jobKey: "https://example.com/jobs/legacy" },
      { action: "retailor_job", jobKey: "https://example.com/jobs/legacy" },
      { action: "analyze_job", jobKey: "https://example.com/jobs/legacy" },
      { action: "generate_interview_prep", jobKey: "https://example.com/jobs/legacy" },
      { action: "apply", jobKey: "https://example.com/jobs/legacy" },
    ];

    for (const command of commands) {
      const result = await dispatcher(command, context);
      expect(result).toMatchObject({
        status: "failed",
        message: "Job-scoped actions require a canonical jobId.",
      });
    }

    expect(fake.calls).toEqual([]);
  });

  it("surfaces workflow start identifiers for preparation maintenance actions", async () => {
    const fake = new FakeDispatcher();
    const dispatcher = createActionDispatcher(fake);
    const context = { appDir: "/tmp", dbPath: "/tmp/jobctrl.db" };
    const commands: ActionCommandPayload[] = [
      {
        action: "rescore_job",
        jobKey: CANONICAL_JOB_ID,
        jobId: CANONICAL_JOB_ID,
      },
      {
        action: "rescore_jobs_not_on_current_scoring_policy",
        jobKey: "pipeline",
      },
      {
        action: "retailor_job",
        jobKey: CANONICAL_JOB_ID,
        jobId: CANONICAL_JOB_ID,
      },
      {
        action: "retailor_current_policy",
        jobKey: "pipeline",
      },
    ];

    for (const command of commands) {
      fake.setResponse({
        jsonrpc: "2.0",
        id: 1,
        result: {
          runId: `${command.action}-run`,
          workflowId: `${command.action}-workflow`,
          firstExecutionRunId: `${command.action}-first-execution`,
        },
      } as JsonRpcResponse);

      const result = await dispatcher(command, context);
      const response = buildActionResponse(command, result);

      expect(response).toMatchObject({
        status: "queued",
        runId: `${command.action}-run`,
        actionId: `${command.action}-run`,
        workflowId: `${command.action}-workflow`,
        firstExecutionRunId: `${command.action}-first-execution`,
      });
    }
  });

  it("maps refresh_compensation and surfaces it as a completed synchronous action", async () => {
    const fake = new FakeDispatcher();
    fake.setResponse({
      jsonrpc: "2.0",
      id: 1,
      result: {
        ok: true,
        status: "succeeded",
        postingUrl: "https://example.com/jobs/current",
        postedFactsRefreshed: 1,
        reportedObservationsLoaded: 2,
        estimatesRefreshed: 1,
        marketRefreshSkipped: false,
        tenantId: "local",
      },
    } as JsonRpcResponse);
    const dispatcher = createActionDispatcher(fake);
    const command: ActionCommandPayload = {
      action: "refresh_compensation",
      jobKey: CANONICAL_JOB_ID,
      observationsJsonPath: "/tmp/reported-compensation.json",
    };

    const result = await dispatcher(command, { appDir: "/tmp", dbPath: "/tmp/jobctrl.db" });

    expect(fake.calls).toEqual([
      {
        method: "refresh_compensation",
        params: {
          tenantId: "local",
          expectedAppDir: "/tmp",
          expectedDbPath: "/tmp/jobctrl.db",
          jobId: CANONICAL_JOB_ID,
          observationsJsonPath: "/tmp/reported-compensation.json",
        },
      },
    ]);
    expect(result).toMatchObject({
      status: "succeeded",
      result: expect.objectContaining({ postedFactsRefreshed: 1, estimatesRefreshed: 1 }),
    });
  });

  it("maps all-jobs refresh_compensation without a jobId", async () => {
    const fake = new FakeDispatcher();
    fake.setResponse({
      jsonrpc: "2.0",
      id: 1,
      result: {
        ok: true,
        status: "succeeded",
        postingUrl: null,
        postedFactsRefreshed: 12,
        reportedObservationsLoaded: 4,
        estimatesRefreshed: 12,
        marketRefreshSkipped: false,
        tenantId: "local",
      },
    } as JsonRpcResponse);
    const dispatcher = createActionDispatcher(fake);

    const result = await dispatcher(
      {
        action: "refresh_compensation",
        jobKey: PIPELINE_ACTION_JOB_KEY,
        includeEuroTopTech: false,
        euroTopTechMaxPages: 3,
      },
      { appDir: "/tmp", dbPath: "/tmp/jobctrl.db" },
    );

    expect(fake.calls).toEqual([
      {
        method: "refresh_compensation",
        params: {
          tenantId: "local",
          expectedAppDir: "/tmp",
          expectedDbPath: "/tmp/jobctrl.db",
          allJobs: true,
          includeEuroTopTech: false,
          euroTopTechMaxPages: 3,
        },
      },
    ]);
    expect(result).toMatchObject({
      status: "succeeded",
      result: expect.objectContaining({ postingUrl: null, postedFactsRefreshed: 12, estimatesRefreshed: 12 }),
    });
  });

  it("maps explicit interview prep generation to the workflow RPC", async () => {
    const fake = new FakeDispatcher();
    const dispatcher = createActionDispatcher(fake);

    const result = await dispatcher(
      {
        action: "generate_interview_prep",
        jobKey: CANONICAL_JOB_ID,
        jobId: CANONICAL_JOB_ID,
        llmModel: "gpt-test",
      },
      { appDir: "/tmp", dbPath: "/tmp/jobctrl.db" },
    );

    expect(fake.calls).toEqual([
      {
        method: "generate_interview_prep",
        params: {
          tenantId: "local",
          expectedAppDir: "/tmp",
          expectedDbPath: "/tmp/jobctrl.db",
          jobId: CANONICAL_JOB_ID,
          llmModel: "gpt-test",
        },
      },
    ]);
    expect(result).toMatchObject({ status: "queued", runId: "run-fake" });
  });

  it("maps employer analysis by canonical job ID without a URL-shaped RPC param", async () => {
    const fake = new FakeDispatcher();
    const dispatcher = createActionDispatcher(fake);

    await dispatcher(
      {
        action: "analyze_job",
        jobKey: CANONICAL_JOB_ID,
        jobId: CANONICAL_JOB_ID,
        retailor: true,
      },
      { appDir: "/tmp", dbPath: "/tmp/jobctrl.db" },
    );

    expect(fake.calls).toEqual([
      {
        method: "analyze_job",
        params: {
          tenantId: "local",
          expectedAppDir: "/tmp",
          expectedDbPath: "/tmp/jobctrl.db",
          jobId: CANONICAL_JOB_ID,
          force: true,
        },
      },
    ]);
    expect(fake.calls[0]?.params).not.toHaveProperty("jobUrl");
  });

  it("dispatches only RPC methods registered by the Python worker", async () => {
    const registeredWorkerMethods = new Set(
      [
        ...fs
          .readFileSync(
            path.join(
              REPO_ROOT,
              "workers/automation/src/jobctrl/infrastructure/rpc/handlers.py",
            ),
            "utf8",
          )
          .matchAll(/server\.register\(\s*"([^"]+)"/g),
      ].map((match) => match[1]),
    );
    const fake = new FakeDispatcher();
    const dispatcher = createActionDispatcher(fake);
    const context = { appDir: "/tmp", dbPath: "/tmp/jobctrl.db" };

    await dispatcher({ action: "run_stage", jobKey: "pipeline", stage: "score" }, context);
    await dispatcher(
      {
        action: "retry_stage",
        jobKey: CANONICAL_JOB_ID,
        jobId: CANONICAL_JOB_ID,
        stage: "apply",
        runAfter: true,
      },
      context,
    );
    await dispatcher({ action: "apply", jobKey: CANONICAL_JOB_ID, jobId: CANONICAL_JOB_ID }, context);
    await dispatcher({ action: "cancel", jobKey: "pipeline", runId: "run-1" }, context);
    await dispatcher({ action: "rescore_job", jobKey: CANONICAL_JOB_ID, jobId: CANONICAL_JOB_ID }, context);
    await dispatcher({ action: "refresh_compensation", jobKey: CANONICAL_JOB_ID }, context);
    await dispatcher(
      { action: "generate_interview_prep", jobKey: CANONICAL_JOB_ID, jobId: CANONICAL_JOB_ID },
      context,
    );
    await dispatcher(
      {
        action: "rescore_jobs_not_on_current_scoring_policy",
        jobKey: "pipeline",
      },
      context,
    );
    await dispatcher({ action: "retailor_job", jobKey: CANONICAL_JOB_ID, jobId: CANONICAL_JOB_ID }, context);
    await dispatcher({ action: "retailor_current_policy", jobKey: "pipeline" }, context);

    const dispatchedMethods = [...new Set(fake.calls.map((call) => call.method))];
    const unregisteredMethods = dispatchedMethods.filter((method) => !registeredWorkerMethods.has(method));
    expect(unregisteredMethods).toEqual([]);
  });

  it("creates the production JSON-RPC dispatcher with the API runtime appDir", async () => {
    const fake = new FakeDispatcher();
    const factory = vi.fn<JsonRpcDispatcherFactory>(() => fake);
    const dispatcher = createActionDispatcher(undefined, factory);

    await dispatcher(
      {
        action: "run_stage",
        jobKey: "pipeline",
        stage: "discover",
        dryRun: false,
      },
      { appDir: "/tmp/jobctrl-runtime", dbPath: "/tmp/jobctrl-runtime/jobctrl.db" },
    );

    expect(factory).toHaveBeenCalledWith({
      appDir: "/tmp/jobctrl-runtime",
      dbPath: "/tmp/jobctrl-runtime/jobctrl.db",
    });
    expect(fake.calls[0]?.method).toBe("run_stage");
  });

  it("passes selected canonical job IDs through global run-stage RPC", async () => {
    const fake = new FakeDispatcher();
    const dispatcher = createActionDispatcher(fake);

    await dispatcher(
      {
        action: "run_stage",
        jobKey: "pipeline",
        jobIds: [CANONICAL_JOB_ID],
        stage: "score",
        stages: ["score", "tailor", "cover"],
        limit: 2,
        workers: 14,
      },
      { appDir: "/tmp", dbPath: "/tmp/jobctrl.db" },
    );

    expect(fake.calls[0]).toEqual({
      method: "run_stage",
      params: expect.objectContaining({
        jobIds: [CANONICAL_JOB_ID],
        stage: "score",
        stages: ["score", "tailor", "cover"],
        limit: 2,
        workers: 14,
      }),
    });
  });

  it("passes a durable condition-recovery reason through global run-stage RPC", async () => {
    const fake = new FakeDispatcher();
    const dispatcher = createActionDispatcher(fake);

    await dispatcher(
      {
        action: "run_stage",
        jobKey: "pipeline",
        jobIds: [CANONICAL_JOB_ID],
        stage: "enrich",
        stages: ["enrich", "score", "tailor", "cover"],
        reason: "condition_resolved:authenticated_linkedin_browser_unavailable:abc123",
      },
      { appDir: "/tmp", dbPath: "/tmp/jobctrl.db" },
    );

    expect(fake.calls[0]?.params).toMatchObject({
      reason: "condition_resolved:authenticated_linkedin_browser_unavailable:abc123",
    });
  });

  it("waits for profile continuations so revisions cannot overlap", async () => {
    const fake = new FakeDispatcher();
    const dispatch = createActionDispatcher(fake);

    await dispatch(
      {
        action: "run_stage",
        jobKey: PIPELINE_ACTION_JOB_KEY,
        stage: "score",
        stages: ["score", "tailor", "cover"],
        reason: "profile_updated:42",
      },
      { appDir: "/tmp", dbPath: "/tmp/jobctrl.db" },
    );

    expect(fake.calls).toEqual([
      {
        method: "run_stage",
        params: expect.objectContaining({
          reason: "profile_updated:42",
          awaitResult: true,
        }),
      },
    ]);
  });

  it("passes selected discovery source IDs through global run-stage RPC", async () => {
    const fake = new FakeDispatcher();
    const dispatcher = createActionDispatcher(fake);

    await dispatcher(
      {
        action: "run_stage",
        jobKey: "pipeline",
        stage: "discover",
        stages: ["discover"],
        limit: 25,
        sourceIds: ["jobspy:linkedin"],
      },
      { appDir: "/tmp", dbPath: "/tmp/jobctrl.db" },
    );

    expect(fake.calls[0]).toEqual({
      method: "run_stage",
      params: expect.objectContaining({
        stage: "discover",
        stages: ["discover"],
        limit: 25,
        sourceIds: ["jobspy:linkedin"],
      }),
    });
  });

  it("passes tailoring model controls through run-stage RPC without reusing apply model", async () => {
    const fake = new FakeDispatcher();
    const dispatcher = createActionDispatcher(fake);

    await dispatcher(
      {
        action: "run_stage",
        jobKey: "pipeline",
        stage: "tailor",
        stages: ["tailor"],
        tailorModels: ["local:draft-a", "openai:draft-b"],
        tailorJudgeModel: "gemini:judge-c",
        model: "sonnet",
      },
      { appDir: "/tmp", dbPath: "/tmp/jobctrl.db" },
    );

    expect(fake.calls[0]?.method).toBe("run_stage");
    expect(fake.calls[0]?.params).toMatchObject({
      stage: "tailor",
      stages: ["tailor"],
      model: "sonnet",
      llmModel: DEFAULT_PIPELINE_LLM_MODEL,
      tailorModels: ["local:draft-a", "openai:draft-b"],
      tailorJudgeModel: "gemini:judge-c",
    });
  });

  it("maps a failed global run-stage LocalActionResult error into the action message", async () => {
    const fake = new FakeDispatcher();
    fake.setResponse({
      jsonrpc: "2.0",
      id: 1,
      result: {
        ok: false,
        action_id: "act-worker-score",
        stage: "score",
        status: "failed",
        started_at: "2026-05-10T11:00:00.000Z",
        finished_at: "2026-05-10T11:00:01.000Z",
        duration_ms: 1000,
        dry_run: true,
        result: {},
        error: "Scoring worker unavailable.",
      },
    } as JsonRpcResponse);
    const dispatcher = createActionDispatcher(fake);
    const command = {
      action: "run_stage" as const,
      jobKey: "pipeline",
      stage: "score" as const,
      dryRun: true,
    };

    const result = await dispatcher(command, { appDir: "/tmp", dbPath: "/tmp/jobctrl.db" });
    const response = buildActionResponse(command, result);

    expect(result).toMatchObject({
      actionId: "act-worker-score",
      status: "failed",
      message: "Scoring worker unavailable.",
      result: {
        status: "failed",
        error: "Scoring worker unavailable.",
      },
    });
    expect(response).toMatchObject({
      actionId: "act-worker-score",
      runId: "act-worker-score",
      status: "failed",
      message: "Scoring worker unavailable.",
    });
  });

  it("maps nested failed run-stage result errors into the dashboard action message", async () => {
    const fake = new FakeDispatcher();
    fake.setResponse({
      jsonrpc: "2.0",
      id: 1,
      result: {
        ok: false,
        action_id: "act-worker-score",
        stage: "score",
        status: "failed",
        started_at: "2026-05-10T11:00:00.000Z",
        finished_at: "2026-05-10T11:00:01.000Z",
        duration_ms: 1000,
        dry_run: false,
        result: {
          errors: {
            score: "error: scoring unavailable",
          },
        },
        error: null,
      },
    } as JsonRpcResponse);
    const dispatcher = createActionDispatcher(fake);
    const command = {
      action: "run_stage" as const,
      jobKey: "pipeline",
      stage: "score" as const,
      dryRun: false,
    };

    const result = await dispatcher(command, { appDir: "/tmp", dbPath: "/tmp/jobctrl.db" });
    const response = buildActionResponse(command, result);

    expect(result).toMatchObject({
      actionId: "act-worker-score",
      status: "failed",
      message: "error: scoring unavailable",
      result: {
        status: "failed",
        result: {
          errors: {
            score: "error: scoring unavailable",
          },
        },
      },
    });
    expect(response).toMatchObject({
      actionId: "act-worker-score",
      runId: "act-worker-score",
      status: "failed",
      message: "error: scoring unavailable",
    });
  });

  it("maps a global apply action without passing the pipeline command key as a jobUrl", async () => {
    const fake = new FakeDispatcher();
    const dispatcher = createActionDispatcher(fake);

    await dispatcher(
      {
        action: "apply",
        jobKey: "pipeline",
        stage: "apply",
        limit: 10,
        workers: 2,
        minScore: 9,
        dryRun: true,
        model: "sonnet",
        headless: true,
        continuous: true,
      },
      { appDir: "/tmp", dbPath: "/tmp/jobctrl.db" },
    );

    expect(fake.calls).toHaveLength(1);
    expect(fake.calls[0]?.method).toBe("apply");
    expect(fake.calls[0]?.params).toEqual({
      tenantId: "local",
      expectedAppDir: "/tmp",
      expectedDbPath: "/tmp/jobctrl.db",
      limit: 10,
      workers: 2,
      minScore: 9,
      dryRun: true,
      model: "sonnet",
      headless: true,
      continuous: true,
    });
  });

  it("returns reset for retry_stage without runAfter (no RPC call)", async () => {
    const fake = new FakeDispatcher();
    const dispatcher = createActionDispatcher(fake);

    const result = await dispatcher(
      {
        action: "retry_stage",
        jobKey: CANONICAL_JOB_ID,
        jobId: CANONICAL_JOB_ID,
        stage: "apply",
        runAfter: false,
        dryRun: true,
        limit: 1,
      },
      { appDir: "/tmp", dbPath: "/tmp/jobctrl.db" },
    );

    expect(fake.calls).toHaveLength(0);
    expect(result).toMatchObject({ status: "reset" });
  });

  it("returns unsupported for generate_materials (not in RPC method set)", async () => {
    const fake = new FakeDispatcher();
    const dispatcher = createActionDispatcher(fake);

    const result = await dispatcher(
      {
        action: "generate_materials",
        jobKey: "https://example.com/jobs/x",
        stages: ["tailor"],
        limit: 1,
        dryRun: true,
      },
      { appDir: "/tmp", dbPath: "/tmp/jobctrl.db" },
    );

    expect(fake.calls).toHaveLength(0);
    expect(result).toMatchObject({
      status: "unsupported",
      message: "No job-scoped local command is available for this action.",
    });
  });

  it("propagates RPC errors as failed status", async () => {
    const fake = new FakeDispatcher();
    fake.setResponse({
      jsonrpc: "2.0",
      id: 1,
      error: { code: -32602, message: "Invalid params: missing jobId" },
    } as JsonRpcResponse);
    const dispatcher = createActionDispatcher(fake);

    const result = await dispatcher(
      {
        action: "apply",
        jobKey: CANONICAL_JOB_ID,
        jobId: CANONICAL_JOB_ID,
        limit: 1,
        dryRun: true,
      },
      { appDir: "/tmp", dbPath: "/tmp/jobctrl.db" },
    );

    expect(result).toMatchObject({
      status: "failed",
      message: "Invalid params: missing jobId",
    });
  });

  it("rejects an apply acknowledgment without a runId", async () => {
    const fake = new FakeDispatcher();
    fake.setResponse({
      jsonrpc: "2.0",
      id: 1,
      result: {},
    } as JsonRpcResponse);
    const dispatcher = createActionDispatcher(fake);

    await expect(dispatcher(
      {
        action: "apply",
        jobKey: CANONICAL_JOB_ID,
        jobId: CANONICAL_JOB_ID,
        limit: 1,
        dryRun: true,
      },
      { appDir: "/tmp", dbPath: "/tmp/jobctrl.db" },
    )).rejects.toThrow("Invalid JSON-RPC result");
  });

  it("includes tenantId in every dispatched RPC call", async () => {
    const fake = new FakeDispatcher();
    const dispatcher = createActionDispatcher(fake);
    await dispatcher(
      {
        action: "apply",
        jobKey: CANONICAL_JOB_ID,
        jobId: CANONICAL_JOB_ID,
        limit: 1,
        dryRun: true,
      },
      { appDir: "/tmp", dbPath: "/tmp/jobctrl.db" },
    );
    expect(fake.calls[0]?.params).toHaveProperty("tenantId", "local");
  });
});

describe("SubprocessJsonRpcAdapter per-request timeout", () => {
  it("rejects a call whose worker never responds", async () => {
    const { SubprocessJsonRpcAdapter } = await import("../src/json-rpc-adapter.js");
    const os = await import("node:os");
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "jobctrl-rpc-timeout-"));
    // A worker stand-in that reads stdin forever and never writes a response.
    const script = path.join(dir, "hang.sh");
    fs.writeFileSync(script, "#!/bin/sh\nexec cat >/dev/null\n", { mode: 0o755 });

    const adapter = new SubprocessJsonRpcAdapter({
      uvBinary: script,
      projectDir: dir,
      appDir: dir,
      requestTimeoutMs: 100,
    });
    try {
      await expect(adapter.call("run_stage", { tenantId: "local", stage: "score" })).rejects.toThrow(/timed out/);
    } finally {
      await adapter.close();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("shared enforcing RPC boundary", () => {
  it("requires the verification provider before injected transport", async () => {
    const { callRpc } = await import("../src/json-rpc-adapter.js");
    const fake = new FakeDispatcher();
    await expect(callRpc(fake, "provider_verify", {} as never)).rejects.toMatchObject({ phase: "params" });
    expect(fake.calls).toEqual([]);
  });

  it("requires the verification provider before worker resolution", async () => {
    const { SubprocessJsonRpcAdapter } = await import("../src/json-rpc-adapter.js");
    const resolve = vi.fn(() => { throw new Error("must not resolve a command"); });
    const adapter = new SubprocessJsonRpcAdapter({ pythonRuntime: { id: "unused", resolve } });
    try {
      await expect(adapter.call("provider_verify", {} as never)).rejects.toMatchObject({ phase: "params" });
      expect(resolve).not.toHaveBeenCalled();
    } finally { await adapter.close(); }
  });

  it.each([
    { stage: "score", workers: 0 },
    { stage: "score", minScore: 11 },
    { stage: "score", unexpected: true },
    { stage: "score", jobId: CANONICAL_JOB_ID, jobIds: [CANONICAL_JOB_ID] },
    { stage: "discover", sourceIds: ["same", "same"] },
    { stage: "score", sourceIds: ["jobspy:indeed"] },
  ])("rejects invalid input before an injected transport: %j", async (params) => {
    const { callRpc } = await import("../src/json-rpc-adapter.js");
    const fake = new FakeDispatcher();
    await expect(callRpc(fake, "run_stage", params as never)).rejects.toMatchObject({ phase: "params" });
    expect(fake.calls).toEqual([]);
  });

  it("rejects invalid parameters before spawning the worker", async () => {
    const { SubprocessJsonRpcAdapter } = await import("../src/json-rpc-adapter.js");
    const resolve = vi.fn(() => { throw new Error("must not resolve a command"); });
    const adapter = new SubprocessJsonRpcAdapter({ pythonRuntime: { id: "unused", resolve } });
    try {
      await expect(adapter.call("run_stage", { stage: "score", workers: 0 })).rejects.toMatchObject({ phase: "params" });
      expect(resolve).not.toHaveBeenCalled();
    } finally { await adapter.close(); }
  });

  it.each([
    { runId: "only-an-ack" },
    { runId: "malformed", result: { stages_completed: "score" } },
    { runId: "wrong-family", result: { families_completed: [], families_failed: [], preparation_started: 0, enrichment_status: "succeeded", enrichment_site_errors: {}, compensation_refresh_status: "succeeded", compensation_estimates_written: 0, compensation_refresh_warnings: [], failure: null, error_code: null } },
  ])("rejects invalid awaited profile completion %j", async (result) => {
    const fake = new FakeDispatcher();
    fake.setResponse({ jsonrpc: "2.0", id: 1, result });
    await expect(createActionDispatcher(fake)({ action: "run_stage", jobKey: "pipeline", stage: "score", reason: "profile_updated:42" }, { appDir: "/synthetic", dbPath: "/synthetic/jobs.db" })).rejects.toMatchObject({ phase: "result" });
  });

  it("distinguishes a terminal failed profile completion from uncertain dispatch", async () => {
    const fake = new FakeDispatcher();
    fake.setResponse({ jsonrpc: "2.0", id: 1, result: { runId: "failed", result: { stages_completed: [], stages_failed: ["score"], failure: "Synthetic stage failure", error_code: "synthetic" } } });
    await expect(createActionDispatcher(fake)({ action: "run_stage", jobKey: "pipeline", stage: "score", reason: "profile_updated:42" }, { appDir: "/synthetic", dbPath: "/synthetic/jobs.db" })).resolves.toMatchObject({
      status: "failed",
      completedWorkflowFailure: { runId: "failed", errorCode: "synthetic" },
    });
    fake.setResponse({ jsonrpc: "2.0", id: 1, error: { code: -32603, message: "Synthetic transport failure" } });
    const uncertain = await createActionDispatcher(fake)({ action: "run_stage", jobKey: "pipeline", stage: "score", reason: "profile_updated:42" }, { appDir: "/synthetic", dbPath: "/synthetic/jobs.db" });
    expect(uncertain.status).toBe("failed");
    expect(uncertain).not.toHaveProperty("completedWorkflowFailure");
  });
});

describe("subprocess response settlement", () => {
  function adapterFor(script: string) {
    return import("../src/json-rpc-adapter.js").then(({ SubprocessJsonRpcAdapter }) => new SubprocessJsonRpcAdapter({
      requestTimeoutMs: 2000,
      pythonRuntime: { id: "synthetic-node-wire", resolve: () => ({ executable: process.execPath, argv: ["-e", script], cwd: REPO_ROOT, env: process.env }) },
    }));
  }

  it("correlates reversed replies while ignoring progress notifications", async () => {
    const adapter = await adapterFor(`const readline=require('node:readline');const requests=[];const emit=x=>console.log(JSON.stringify(x));readline.createInterface({input:process.stdin}).on('line',line=>{requests.push(JSON.parse(line));if(requests.length===2){emit({jsonrpc:'2.0',method:'progress',params:{step:1}});for(const r of requests.reverse())emit({jsonrpc:'2.0',id:r.id,result:{status:'succeeded',pdfPath:r.params.pdfPath}})}});`);
    try {
      const results = await Promise.all([
        adapter.call("render_resume_pdf", { htmlPath: "/synthetic/first.html", pdfPath: "/synthetic/first.pdf" }),
        adapter.call("render_resume_pdf", { htmlPath: "/synthetic/second.html", pdfPath: "/synthetic/second.pdf" }),
      ]);
      expect(results.map(response => response.result?.pdfPath)).toEqual(["/synthetic/first.pdf", "/synthetic/second.pdf"]);
      expect(results.map(response => response.id)).toEqual([1, 2]);
    } finally { await adapter.close(); }
  });

  it.each(["invalid_result", "invalid_envelope", "rpc_error"])("settles %s distinctly", async (mode) => {
    const adapter = await adapterFor(`const readline=require('node:readline');readline.createInterface({input:process.stdin}).on('line',line=>{const r=JSON.parse(line);const response=${JSON.stringify(mode)}==='invalid_envelope'?{jsonrpc:'2.0',id:r.id,result:{},error:{code:-32603,message:'both'}}:${JSON.stringify(mode)}==='rpc_error'?{jsonrpc:'2.0',id:r.id,error:{code:-32602,message:'synthetic invalid parameters',data:{reason:'synthetic'}}}:{jsonrpc:'2.0',id:r.id,result:{status:'succeeded'}};console.log(JSON.stringify(response));});`);
    try {
      const response = adapter.call("render_resume_pdf", { htmlPath: "/synthetic/in.html", pdfPath: "/synthetic/out.pdf" });
      if (mode === "rpc_error") await expect(response).resolves.toMatchObject({ error: { code: -32602, message: "synthetic invalid parameters", data: { reason: "synthetic" } } });
      else await expect(response).rejects.toMatchObject({ name: "RpcContractError", phase: "result" });
    } finally { await adapter.close(); }
  });

  it("rejects pending work on close", async () => {
    const adapter = await adapterFor("process.stdin.resume();");
    const result = adapter.call("render_resume_pdf", { htmlPath: "/synthetic/in.html", pdfPath: "/synthetic/out.pdf" });
    const assertion = expect(result).rejects.toThrow("Adapter closed before response");
    await adapter.close();
    await assertion;
  });
});
