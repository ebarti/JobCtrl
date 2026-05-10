/**
 * JSON-RPC adapter tests (Phase 9 / S-34).
 *
 * The adapter is exercised through the public ``createActionDispatcher``
 * factory using a fake in-memory ``JsonRpcDispatcher`` so we don't need
 * to spawn the Python worker subprocess in CI.
 */
import { describe, expect, it, vi } from "vitest";

import {
  createActionDispatcher,
  type ActionDispatchResult,
} from "../src/local-actions.js";
import type {
  JsonRpcDispatcher,
} from "../src/json-rpc-adapter.js";
import type { JsonRpcResponse, RpcMethod } from "../src/contracts.js";

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
        model: "haiku",
      },
      { appDir: "/tmp" },
    );

    expect(fake.calls).toHaveLength(1);
    expect(fake.calls[0]?.method).toBe("apply");
    expect(fake.calls[0]?.params).toMatchObject({
      tenantId: "local",
      jobUrl: "https://example.com/jobs/x",
      limit: 1,
      dryRun: true,
      model: "haiku",
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
      { appDir: "/tmp" },
    );

    expect(fake.calls[0]?.method).toBe("apply");
    expect(result.status).toBe("queued");
  });

  it("maps a global run-stage action to the run_stage RPC method", async () => {
    const fake = new FakeDispatcher();
    fake.setResponse({
      jsonrpc: "2.0",
      id: 1,
      result: {
        ok: true,
        action_id: "act-worker-score",
        stage: "score",
        status: "dry_run",
        started_at: "2026-05-10T11:00:00.000Z",
        finished_at: "2026-05-10T11:00:00.000Z",
        duration_ms: 0,
        dry_run: true,
        result: { planned: 3 },
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
      { appDir: "/tmp" },
    );

    expect(fake.calls).toHaveLength(1);
    expect(fake.calls[0]).toEqual({
      method: "run_stage",
      params: {
        tenantId: "local",
        stage: "score",
        limit: 20,
        workers: 4,
        minScore: 8,
        validationMode: "strict",
        dryRun: true,
        rescore: true,
        retailor: false,
      },
    });
    expect(result).toMatchObject({
      actionId: "act-worker-score",
      status: "dry_run",
      result: {
        status: "dry_run",
        result: { planned: 3 },
      },
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
      { appDir: "/tmp" },
    );

    expect(fake.calls).toHaveLength(1);
    expect(fake.calls[0]?.method).toBe("apply");
    expect(fake.calls[0]?.params).toEqual({
      tenantId: "local",
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
      { appDir: "/tmp" },
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
      { appDir: "/tmp" },
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
      { appDir: "/tmp" },
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
      { appDir: "/tmp" },
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
      { appDir: "/tmp" },
    );
    expect(fake.calls[0]?.params).toHaveProperty("tenantId", "local");
  });
});
