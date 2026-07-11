import { describe, expect, it } from "vitest";

import type {
  JsonRpcResponse,
  ManualCaptureImportRequest,
  RpcMethod,
} from "../src/contracts.js";
import {
  createWorkerManualCaptureImporter,
  ManualCaptureImportError,
} from "../src/manual-capture-worker.js";
import type { JsonRpcDispatcher } from "../src/json-rpc-adapter.js";

class FakeDispatcher implements JsonRpcDispatcher {
  readonly calls: Array<{ method: RpcMethod; params: Record<string, unknown> }> = [];

  constructor(private readonly response: JsonRpcResponse) {}

  async call(method: RpcMethod, params: Record<string, unknown>): Promise<JsonRpcResponse> {
    this.calls.push({ method, params });
    return this.response;
  }

  async close(): Promise<void> {
    // No subprocess is started by this isolated importer test.
  }
}

const context = { appDir: "/tmp/jobctrl", dbPath: "/tmp/jobctrl/jobctrl.db" };

const input: ManualCaptureImportRequest = {
  captureMode: "pasted_text",
  contentText: "Visible user-provided posting text.",
  contentHtmlBase64: "PG1haW4+Sm9iPC9tYWluPg==",
  capturedUrl: "https://example.test/jobs/1",
  note: "Captured after sign in.",
  futureManualActionRequired: true,
};

function successResponse(): JsonRpcResponse {
  return {
    jsonrpc: "2.0",
    id: 1,
    result: {
      runId: "manual-capture-import-local-manual-1",
      workflowId: "manual-capture-import-local-manual-1",
      firstExecutionRunId: "run-1",
      result: {
        status: "succeeded",
        item_id: "manual-1",
        job_id: "https://example.test/jobs/1",
        imported_at: "2026-07-10T10:00:00Z",
        retry_context: {
          manual_capture_provenance: {
            originating_url: "https://example.test/jobs/1",
            capture_client: "browser_extension",
            extension_version: "0.3.0",
          },
        },
        error: null,
        error_code: null,
      },
    },
  };
}

function failureResponse(errorCode: string | null): JsonRpcResponse {
  return {
    jsonrpc: "2.0",
    id: 1,
    result: {
      runId: "manual-capture-import-local-manual-1",
      workflowId: "manual-capture-import-local-manual-1",
      firstExecutionRunId: "run-1",
      result: {
        status: "failed",
        item_id: null,
        job_id: null,
        imported_at: null,
        retry_context: {},
        error: "Internal worker detail that must not reach the HTTP response.",
        error_code: errorCode,
      },
    },
  };
}

function importerFor(response: JsonRpcResponse): {
  importer: ReturnType<typeof createWorkerManualCaptureImporter>;
  dispatcher: FakeDispatcher;
} {
  const dispatcher = new FakeDispatcher(response);
  return {
    importer: createWorkerManualCaptureImporter({ dispatcherFactory: () => dispatcher }),
    dispatcher,
  };
}

describe("createWorkerManualCaptureImporter", () => {
  it("calls manual_capture_import with the complete awaited workflow contract and preserves the public response", async () => {
    const { importer, dispatcher } = importerFor(successResponse());

    await expect(importer("manual-1", input, context)).resolves.toEqual({
      ok: true,
      itemId: "manual-1",
      jobKey: "https://example.test/jobs/1",
      importedAt: "2026-07-10T10:00:00Z",
      provenance: {
        sourceKind: "user_mediated_capture",
        originatingUrl: "https://example.test/jobs/1",
        captureMode: "pasted_text",
        futureManualActionRequired: true,
        captureClient: "browser_extension",
        extensionVersion: "0.3.0",
      },
    });
    expect(dispatcher.calls).toEqual([
      {
        method: "manual_capture_import",
        params: {
          tenantId: "local",
          itemId: "manual-1",
          captureMode: "pasted_text",
          contentText: "Visible user-provided posting text.",
          contentHtmlBase64: "PG1haW4+Sm9iPC9tYWluPg==",
          capturedUrl: "https://example.test/jobs/1",
          note: "Captured after sign in.",
          futureManualActionRequired: true,
          expectedAppDir: "/tmp/jobctrl",
          expectedDbPath: "/tmp/jobctrl/jobctrl.db",
          awaitResult: true,
        },
      },
    ]);
  });

  it("maps a JSON-RPC workflow start error to a stable importer error", async () => {
    const { importer } = importerFor({
      jsonrpc: "2.0",
      id: 1,
      error: {
        code: -32603,
        message: "Internal error",
        data: "private worker stack trace",
      },
    });

    await expect(importer("manual-1", input, context)).rejects.toMatchObject({
      name: "ManualCaptureImportError",
      statusCode: 500,
      message: "Manual capture import could not be completed.",
    } satisfies Partial<ManualCaptureImportError>);
  });

  it("rejects a missing nested workflow result without exposing it", async () => {
    const { importer } = importerFor({
      jsonrpc: "2.0",
      id: 1,
      result: { runId: "manual-capture-import-local-manual-1" },
    });

    await expect(importer("manual-1", input, context)).rejects.toMatchObject({
      name: "ManualCaptureImportError",
      statusCode: 500,
      message: "Manual capture workflow returned an invalid result.",
    } satisfies Partial<ManualCaptureImportError>);
  });

  it("rejects a malformed nested workflow result without exposing it", async () => {
    const { importer } = importerFor({
      jsonrpc: "2.0",
      id: 1,
      result: {
        runId: "manual-capture-import-local-manual-1",
        result: {
          status: "succeeded",
          item_id: "manual-1",
          job_id: "https://example.test/jobs/1",
          imported_at: null,
          retry_context: {},
          error: null,
          error_code: null,
        },
      },
    });

    await expect(importer("manual-1", input, context)).rejects.toMatchObject({
      name: "ManualCaptureImportError",
      statusCode: 500,
      message: "Manual capture workflow returned an invalid result.",
    } satisfies Partial<ManualCaptureImportError>);
  });

  it("maps an awaited not-found result to the existing 404 route semantics", async () => {
    const { importer } = importerFor(failureResponse("not_found"));

    await expect(importer("manual-1", input, context)).rejects.toMatchObject({
      name: "ManualCaptureImportError",
      statusCode: 404,
      message: "Manual capture item was not found.",
    } satisfies Partial<ManualCaptureImportError>);
  });

  it("maps the confirmed replay mismatch code to conflict semantics", async () => {
    const { importer } = importerFor(failureResponse("capture_replay_mismatch"));

    await expect(importer("manual-1", input, context)).rejects.toMatchObject({
      name: "ManualCaptureImportError",
      statusCode: 409,
    } satisfies Partial<ManualCaptureImportError>);
  });

  it("maps an unclassified non-retryable workflow failure to the safe 500 semantics", async () => {
    const { importer } = importerFor(failureResponse("manual_capture_invalid_input"));

    await expect(importer("manual-1", input, context)).rejects.toMatchObject({
      name: "ManualCaptureImportError",
      statusCode: 500,
      message: "Manual capture import could not be completed.",
    } satisfies Partial<ManualCaptureImportError>);
  });

  it("maps Temporal unavailability to a stable service-unavailable importer error", async () => {
    const { importer } = importerFor({
      jsonrpc: "2.0",
      id: 1,
      error: {
        code: -32603,
        message: "Internal error",
        data: "TEMPORAL_UNAVAILABLE",
      },
    });

    await expect(importer("manual-1", input, context)).rejects.toMatchObject({
      name: "ManualCaptureImportError",
      statusCode: 503,
      message: "Manual capture import is temporarily unavailable.",
    } satisfies Partial<ManualCaptureImportError>);
  });
});
