import { describe, expect, it } from "vitest";

import type { JsonRpcResponse, RpcMethod } from "../src/contracts.js";
import {
  createWorkerJobUrlImporter,
  JobUrlImportError,
} from "../src/job-url-import-worker.js";
import type { JsonRpcDispatcher } from "../src/json-rpc-adapter.js";

class FakeDispatcher implements JsonRpcDispatcher {
  readonly calls: Array<{ method: RpcMethod; params: Record<string, unknown> }> = [];

  constructor(private readonly response: JsonRpcResponse) {}

  async call(method: RpcMethod, params: Record<string, unknown>): Promise<JsonRpcResponse> {
    this.calls.push({ method, params });
    return this.response;
  }

  async close(): Promise<void> {}
}

const context = { appDir: "/tmp/jobctrl", dbPath: "/tmp/jobctrl/jobctrl.db" };
const input = { url: "https://example.com/jobs/42" };

function response(result: object): JsonRpcResponse {
  return {
    jsonrpc: "2.0",
    id: 1,
    result: {
      runId: "job-url-import-run",
      workflowId: "job-url-import-workflow",
      firstExecutionRunId: "job-url-import-run",
      result,
    },
  };
}

describe("createWorkerJobUrlImporter", () => {
  it("awaits the worker workflow and maps an imported job", async () => {
    const dispatcher = new FakeDispatcher(
      response({
        status: "succeeded",
        outcome: "imported",
        job_id: "7bf7e789-8a2f-45e4-8c41-00e71525d05c",
        item_id: null,
        reason: null,
        imported_at: "2026-08-13T15:00:00Z",
        already_existed: false,
        error: null,
        error_code: null,
      }),
    );
    const importer = createWorkerJobUrlImporter({ dispatcherFactory: () => dispatcher });

    await expect(importer(input, context)).resolves.toEqual({
      ok: true,
      status: "imported",
      jobKey: "7bf7e789-8a2f-45e4-8c41-00e71525d05c",
      importedAt: "2026-08-13T15:00:00Z",
      alreadyExisted: false,
    });
    expect(dispatcher.calls).toEqual([
      {
        method: "job_url_import",
        params: {
          tenantId: "local",
          url: input.url,
          expectedAppDir: context.appDir,
          expectedDbPath: context.dbPath,
          awaitResult: true,
        },
      },
    ]);
  });

  it("maps an inaccessible page to Manual Capture", async () => {
    const dispatcher = new FakeDispatcher(
      response({
        status: "succeeded",
        outcome: "manual_capture_required",
        job_id: null,
        item_id: "manual:abc",
        reason: "login_required",
        imported_at: null,
        already_existed: false,
        error: null,
        error_code: null,
      }),
    );
    const importer = createWorkerJobUrlImporter({ dispatcherFactory: () => dispatcher });

    await expect(importer(input, context)).resolves.toEqual({
      ok: true,
      status: "manual_capture_required",
      itemId: "manual:abc",
      reason: "login_required",
    });
  });

  it("preserves a robots-denied Manual Capture reason", async () => {
    const dispatcher = new FakeDispatcher(
      response({
        status: "succeeded",
        outcome: "manual_capture_required",
        job_id: null,
        item_id: "manual:robots",
        reason: "robots_disallowed",
        imported_at: null,
        already_existed: false,
        error: null,
        error_code: null,
      }),
    );
    const importer = createWorkerJobUrlImporter({ dispatcherFactory: () => dispatcher });

    await expect(importer(input, context)).resolves.toEqual({
      ok: true,
      status: "manual_capture_required",
      itemId: "manual:robots",
      reason: "robots_disallowed",
    });
  });

  it("maps an unsafe URL rejection to a stable client error", async () => {
    const dispatcher = new FakeDispatcher(
      response({
        status: "failed",
        outcome: null,
        job_id: null,
        item_id: null,
        reason: null,
        imported_at: null,
        already_existed: false,
        error: "private worker detail",
        error_code: "invalid_url",
      }),
    );
    const importer = createWorkerJobUrlImporter({ dispatcherFactory: () => dispatcher });

    await expect(importer(input, context)).rejects.toMatchObject({
      name: "JobUrlImportError",
      statusCode: 400,
      message: "Only public HTTP or HTTPS job URLs can be imported.",
    } satisfies Partial<JobUrlImportError>);
  });

  it("rejects malformed worker output without exposing it", async () => {
    const dispatcher = new FakeDispatcher(response({ status: "succeeded", job_id: "secret" }));
    const importer = createWorkerJobUrlImporter({ dispatcherFactory: () => dispatcher });

    await expect(importer(input, context)).rejects.toMatchObject({
      name: "JobUrlImportError",
      statusCode: 500,
      message: "Job import returned an invalid worker result.",
    } satisfies Partial<JobUrlImportError>);
  });
});
