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

import { DEFAULT_PIPELINE_LLM_MODEL, type ActionCommandPayload } from "../src/contracts.js";
import {
  buildActionResponse,
  createActionDispatcher,
  type ActionDispatchResult,
  type JsonRpcDispatcherFactory,
} from "../src/local-actions.js";
import type {
  JsonRpcDispatcher,
} from "../src/json-rpc-adapter.js";
import type { JsonRpcResponse, RpcMethod } from "../src/contracts.js";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");

class FakeDispatcher implements JsonRpcDispatcher {
  public readonly calls: Array<{ method: RpcMethod; params: Record<string, unknown> }> = [];
  private response: JsonRpcResponse = {
    jsonrpc: "2.0",
    id: 1,
    result: { runId: "run-fake" },
  } as JsonRpcResponse;

  setResponse(response: JsonRpcResponse): void {
    this.response = response;
  }

  async call(method: RpcMethod, params: Record<string, unknown>): Promise<JsonRpcResponse> {
    this.calls.push({ method, params });
    return this.response;
  }

  async close(): Promise<void> {
    /* no-op */
  }
}

describe("createActionDispatcher (JSON-RPC adapter)", () => {
  it("maps an apply action to the apply RPC method", async () => {
    const fake = new FakeDispatcher();
    const dispatcher = createActionDispatcher(fake);

    const result = await dispatcher(
      {
        action: "apply",
        jobKey: "https://example.com/jobs/x",
        limit: 1,
        dryRun: true,
        model: "default",
      },
      { appDir: "/tmp", dbPath: "/tmp/jobhunter.db" },
    );

    expect(fake.calls).toHaveLength(1);
    expect(fake.calls[0]?.method).toBe("apply");
    expect(fake.calls[0]?.params).toMatchObject({
      tenantId: "local",
      expectedAppDir: "/tmp",
      expectedDbPath: "/tmp/jobhunter.db",
      jobUrl: "https://example.com/jobs/x",
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
        jobKey: "https://example.com/jobs/x",
        stage: "apply",
        runAfter: true,
        dryRun: true,
        limit: 1,
      },
      { appDir: "/tmp", dbPath: "/tmp/jobhunter.db" },
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
        jobKey: "https://example.com/jobs/x",
        stage: "enrich",
        stages: ["enrich", "score", "tailor", "cover"],
        runAfter: true,
        dryRun: true,
        limit: 1,
      },
      { appDir: "/tmp", dbPath: "/tmp/jobhunter.db" },
    );

    expect(fake.calls[0]).toEqual({
      method: "run_stage",
      params: expect.objectContaining({
        tenantId: "local",
        expectedAppDir: "/tmp",
        expectedDbPath: "/tmp/jobhunter.db",
        jobUrl: "https://example.com/jobs/x",
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
        jobKey: "https://example.com/jobs/x",
        stage: "tailor",
        runAfter: true,
        dryRun: true,
        limit: 1,
      },
      { appDir: "/tmp", dbPath: "/tmp/jobhunter.db" },
    );

    expect(fake.calls[0]).toEqual({
      method: "run_stage",
      params: expect.objectContaining({
        jobUrl: "https://example.com/jobs/x",
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
        validationMode: "strict",
        dryRun: true,
        rescore: true,
        retailor: false,
      },
      { appDir: "/tmp", dbPath: "/tmp/jobhunter.db" },
    );

    expect(fake.calls).toHaveLength(1);
    expect(fake.calls[0]).toEqual({
      method: "run_stage",
      params: {
        tenantId: "local",
        expectedAppDir: "/tmp",
        expectedDbPath: "/tmp/jobhunter.db",
        stage: "score",
        stages: ["score"],
        limit: 20,
        workers: 4,
        minScore: 8,
        validationMode: "strict",
        dryRun: true,
        rescore: true,
        retailor: false,
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
    const context = { appDir: "/tmp", dbPath: "/tmp/jobhunter.db" };

    await dispatcher(
      {
        action: "rescore_job",
        jobKey: "https://example.com/jobs/current",
        dryRun: true,
        reason: "policy refresh",
      },
      context,
    );
    await dispatcher(
      {
        action: "rescore_jobs_not_on_current_scoring_policy",
        jobKey: "pipeline",
        jobKeys: ["https://example.com/jobs/stale"],
        limit: 10,
        dryRun: true,
      },
      context,
    );
    await dispatcher(
      {
        action: "tailor_job",
        jobKey: "https://example.com/jobs/current",
        dryRun: true,
        reason: "manual_tailor",
        tailorModels: ["gemini:test"],
        tailorJudgeModel: "judge:test",
        tailorJudgeMinScore: 0.82,
      },
      context,
    );
    await dispatcher(
      {
        action: "retailor_job",
        jobKey: "https://example.com/jobs/current",
        dryRun: true,
        suppressExistingArtifacts: false,
        tailorModels: ["gemini:test"],
        tailorJudgeModel: "judge:test",
        tailorJudgeMinScore: 0.82,
      },
      context,
    );
    await dispatcher(
      {
        action: "retailor_current_policy",
        jobKey: "pipeline",
        jobKeys: ["https://example.com/jobs/current"],
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
          expectedDbPath: "/tmp/jobhunter.db",
          jobUrl: "https://example.com/jobs/current",
          dryRun: true,
          reason: "policy refresh",
        },
      },
      {
        method: "rescore_jobs_not_on_current_scoring_policy",
        params: {
          tenantId: "local",
          expectedAppDir: "/tmp",
          expectedDbPath: "/tmp/jobhunter.db",
          limit: 10,
          jobUrls: ["https://example.com/jobs/stale"],
          dryRun: true,
        },
      },
      {
        method: "tailor_job",
        params: {
          tenantId: "local",
          expectedAppDir: "/tmp",
          expectedDbPath: "/tmp/jobhunter.db",
          jobUrl: "https://example.com/jobs/current",
          dryRun: true,
          allowLowFitOverride: true,
          reason: "manual_tailor",
          tailorModels: ["gemini:test"],
          tailorJudgeModel: "judge:test",
          tailorJudgeMinScore: 0.82,
        },
      },
      {
        method: "retailor_job",
        params: {
          tenantId: "local",
          expectedAppDir: "/tmp",
          expectedDbPath: "/tmp/jobhunter.db",
          jobUrl: "https://example.com/jobs/current",
          dryRun: true,
          suppressExistingArtifacts: false,
          tailorModels: ["gemini:test"],
          tailorJudgeModel: "judge:test",
          tailorJudgeMinScore: 0.82,
        },
      },
      {
        method: "retailor_current_policy",
        params: {
          tenantId: "local",
          expectedAppDir: "/tmp",
          expectedDbPath: "/tmp/jobhunter.db",
          limit: 5,
          jobUrls: ["https://example.com/jobs/current"],
          dryRun: false,
          suppressExistingArtifacts: false,
        },
      },
    ]);
  });

  it("surfaces workflow start identifiers for preparation maintenance actions", async () => {
    const fake = new FakeDispatcher();
    const dispatcher = createActionDispatcher(fake);
    const context = { appDir: "/tmp", dbPath: "/tmp/jobhunter.db" };
    const commands: ActionCommandPayload[] = [
      {
        action: "rescore_job",
        jobKey: "https://example.com/jobs/current",
      },
      {
        action: "rescore_jobs_not_on_current_scoring_policy",
        jobKey: "pipeline",
      },
      {
        action: "retailor_job",
        jobKey: "https://example.com/jobs/current",
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

  it("dispatches only RPC methods registered by the Python worker", async () => {
    const registeredWorkerMethods = new Set(
      [
        ...fs
          .readFileSync(
            path.join(
              REPO_ROOT,
              "workers/automation/src/jobhunter/infrastructure/rpc/handlers.py",
            ),
            "utf8",
          )
          .matchAll(/server\.register\(\s*"([^"]+)"/g),
      ].map((match) => match[1]),
    );
    const fake = new FakeDispatcher();
    const dispatcher = createActionDispatcher(fake);
    const context = { appDir: "/tmp", dbPath: "/tmp/jobhunter.db" };

    await dispatcher({ action: "run_stage", jobKey: "pipeline", stage: "score" }, context);
    await dispatcher(
      {
        action: "retry_stage",
        jobKey: "https://example.com/jobs/current",
        stage: "apply",
        runAfter: true,
      },
      context,
    );
    await dispatcher({ action: "apply", jobKey: "https://example.com/jobs/current" }, context);
    await dispatcher({ action: "cancel", jobKey: "pipeline", runId: "run-1" }, context);
    await dispatcher({ action: "rescore_job", jobKey: "https://example.com/jobs/current" }, context);
    await dispatcher(
      {
        action: "rescore_jobs_not_on_current_scoring_policy",
        jobKey: "pipeline",
      },
      context,
    );
    await dispatcher({ action: "retailor_job", jobKey: "https://example.com/jobs/current" }, context);
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
      { appDir: "/tmp/jobhunter-runtime", dbPath: "/tmp/jobhunter-runtime/jobhunter.db" },
    );

    expect(factory).toHaveBeenCalledWith({
      appDir: "/tmp/jobhunter-runtime",
      dbPath: "/tmp/jobhunter-runtime/jobhunter.db",
    });
    expect(fake.calls[0]?.method).toBe("run_stage");
  });

  it("passes selected job URLs through global run-stage RPC", async () => {
    const fake = new FakeDispatcher();
    const dispatcher = createActionDispatcher(fake);

    await dispatcher(
      {
        action: "run_stage",
        jobKey: "pipeline",
        jobKeys: ["https://example.com/jobs/a", "https://example.com/jobs/b"],
        stage: "score",
        stages: ["score", "tailor", "cover"],
        limit: 2,
        workers: 14,
      },
      { appDir: "/tmp", dbPath: "/tmp/jobhunter.db" },
    );

    expect(fake.calls[0]).toEqual({
      method: "run_stage",
      params: expect.objectContaining({
        jobUrls: ["https://example.com/jobs/a", "https://example.com/jobs/b"],
        stage: "score",
        stages: ["score", "tailor", "cover"],
        limit: 2,
        workers: 14,
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
        tailorJudgeMinScore: 0.9,
        model: "sonnet",
      },
      { appDir: "/tmp", dbPath: "/tmp/jobhunter.db" },
    );

    expect(fake.calls[0]?.method).toBe("run_stage");
    expect(fake.calls[0]?.params).toMatchObject({
      stage: "tailor",
      stages: ["tailor"],
      model: "sonnet",
      llmModel: DEFAULT_PIPELINE_LLM_MODEL,
      tailorModels: ["local:draft-a", "openai:draft-b"],
      tailorJudgeModel: "gemini:judge-c",
      tailorJudgeMinScore: 0.9,
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

    const result = await dispatcher(command, { appDir: "/tmp", dbPath: "/tmp/jobhunter.db" });
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

    const result = await dispatcher(command, { appDir: "/tmp", dbPath: "/tmp/jobhunter.db" });
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
      { appDir: "/tmp", dbPath: "/tmp/jobhunter.db" },
    );

    expect(fake.calls).toHaveLength(1);
    expect(fake.calls[0]?.method).toBe("apply");
    expect(fake.calls[0]?.params).toEqual({
      tenantId: "local",
      expectedAppDir: "/tmp",
      expectedDbPath: "/tmp/jobhunter.db",
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
        jobKey: "https://example.com/jobs/x",
        stage: "apply",
        runAfter: false,
        dryRun: true,
        limit: 1,
      },
      { appDir: "/tmp", dbPath: "/tmp/jobhunter.db" },
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
      { appDir: "/tmp", dbPath: "/tmp/jobhunter.db" },
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
      error: { code: -32602, message: "Invalid params: missing jobUrl" },
    } as JsonRpcResponse);
    const dispatcher = createActionDispatcher(fake);

    const result = await dispatcher(
      {
        action: "apply",
        jobKey: "https://example.com/jobs/y",
        limit: 1,
        dryRun: true,
      },
      { appDir: "/tmp", dbPath: "/tmp/jobhunter.db" },
    );

    expect(result).toMatchObject({
      status: "failed",
      message: "Invalid params: missing jobUrl",
    });
  });

  it("does not require runId on apply response", async () => {
    const fake = new FakeDispatcher();
    fake.setResponse({
      jsonrpc: "2.0",
      id: 1,
      result: {},
    } as JsonRpcResponse);
    const dispatcher = createActionDispatcher(fake);

    const result: ActionDispatchResult = await dispatcher(
      {
        action: "apply",
        jobKey: "https://example.com/jobs/y",
        limit: 1,
        dryRun: true,
      },
      { appDir: "/tmp", dbPath: "/tmp/jobhunter.db" },
    );

    expect(result.status).toBe("queued");
    expect(result.runId).toBeUndefined();
  });

  it("includes tenantId in every dispatched RPC call", async () => {
    const fake = new FakeDispatcher();
    const dispatcher = createActionDispatcher(fake);
    await dispatcher(
      {
        action: "apply",
        jobKey: "https://example.com/jobs/z",
        limit: 1,
        dryRun: true,
      },
      { appDir: "/tmp", dbPath: "/tmp/jobhunter.db" },
    );
    expect(fake.calls[0]?.params).toHaveProperty("tenantId", "local");
  });
});
