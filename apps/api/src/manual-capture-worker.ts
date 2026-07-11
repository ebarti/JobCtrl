import type {
  ManualCaptureImportRequest,
  ManualCaptureImportResponse,
  ManualCaptureImportWorkflowResult,
} from "./contracts.js";
import { ManualCaptureImportWorkflowResultSchema } from "./contracts.js";
import {
  getDefaultJsonRpcDispatcher,
  type JsonRpcDispatcher,
} from "./json-rpc-adapter.js";
import { createSourcePythonRuntime, type PythonRuntimeCommandResolver } from "./python-runtime.js";

export interface ManualCaptureImportContext {
  appDir: string;
  dbPath: string;
}

export type ManualCaptureImporter = (
  itemId: string,
  input: ManualCaptureImportRequest,
  context: ManualCaptureImportContext,
) => Promise<ManualCaptureImportResponse>;

export type ManualCaptureJsonRpcDispatcherFactory = (
  context: ManualCaptureImportContext,
) => JsonRpcDispatcher;

export interface WorkerManualCaptureImporterOptions {
  projectDir?: string;
  uvBinary?: string;
  pythonRuntime?: PythonRuntimeCommandResolver;
  /** Test seam for the long-lived JSON-RPC dispatcher. */
  dispatcherFactory?: ManualCaptureJsonRpcDispatcherFactory;
}

export class ManualCaptureImportError extends Error {
  readonly statusCode: number;

  constructor(message: string, statusCode: number) {
    super(message);
    this.name = "ManualCaptureImportError";
    this.statusCode = statusCode;
  }
}

/**
 * Production importer for user-mediated captures.
 *
 * Importing routes through the long-lived ``jobctrl rpc`` process, which starts
 * and awaits the supervised Temporal workflow. The REST endpoint remains
 * synchronous so its pre-existing public material/provenance response stays
 * unchanged.
 */
export function createWorkerManualCaptureImporter(
  options: WorkerManualCaptureImporterOptions = {},
): ManualCaptureImporter {
  const pythonRuntime =
    options.pythonRuntime ??
    createSourcePythonRuntime({
      ...(options.projectDir ? { projectDir: options.projectDir } : {}),
      ...(options.uvBinary ? { uvBinary: options.uvBinary } : {}),
    });
  const dispatcherFactory =
    options.dispatcherFactory ??
    ((context: ManualCaptureImportContext) =>
      getDefaultJsonRpcDispatcher({
        appDir: context.appDir,
        pythonRuntime,
      }));

  return async (itemId, input, context) => {
    let response;
    try {
      response = await dispatcherFactory(context).call("manual_capture_import", {
        tenantId: "local",
        itemId,
        captureMode: input.captureMode,
        ...(input.contentText !== undefined ? { contentText: input.contentText } : {}),
        ...(input.contentHtmlBase64 !== undefined ? { contentHtmlBase64: input.contentHtmlBase64 } : {}),
        ...(input.capturedUrl !== undefined ? { capturedUrl: input.capturedUrl } : {}),
        ...(input.note !== undefined ? { note: input.note } : {}),
        futureManualActionRequired: input.futureManualActionRequired,
        expectedAppDir: context.appDir,
        expectedDbPath: context.dbPath,
        awaitResult: true,
      });
    } catch {
      // JSON-RPC transport rejection means the local RPC/Temporal runtime could
      // not accept the import. Never expose command lines, worker logs, or input.
      throw new ManualCaptureImportError("Manual capture import is temporarily unavailable.", 503);
    }

    if (response.error) {
      throw jsonRpcImportError(response.error.message, response.error.data);
    }

    const workflowResult = extractWorkflowResult(response.result);
    if (workflowResult.status === "failed") {
      throw workflowImportError(workflowResult.error_code);
    }
    return workflowResultToResponse(workflowResult, input);
  };
}

function extractWorkflowResult(result: unknown): ManualCaptureImportWorkflowResult {
  if (!isRecord(result)) {
    throw invalidWorkflowResultError();
  }
  const parsed = ManualCaptureImportWorkflowResultSchema.safeParse(result.result);
  if (!parsed.success) {
    throw invalidWorkflowResultError();
  }
  return parsed.data;
}

function workflowResultToResponse(
  result: ManualCaptureImportWorkflowResult,
  input: ManualCaptureImportRequest,
): ManualCaptureImportResponse {
  const itemId = requiredText(result.item_id);
  const jobKey = requiredText(result.job_id);
  const importedAt = requiredText(result.imported_at);
  const provenance = recordValue(result.retry_context.manual_capture_provenance);
  if (!provenance) {
    throw invalidWorkflowResultError();
  }
  const originatingUrl = requiredText(provenance.originating_url ?? provenance.originatingUrl);
  const captureClient = optionalText(provenance.capture_client ?? provenance.captureClient);
  const extensionVersion = optionalText(provenance.extension_version ?? provenance.extensionVersion);
  return {
    ok: true,
    itemId,
    jobKey,
    importedAt,
    provenance: {
      sourceKind: "user_mediated_capture",
      originatingUrl,
      captureMode: input.captureMode,
      futureManualActionRequired: input.futureManualActionRequired,
      ...(captureClient ? { captureClient } : {}),
      ...(extensionVersion ? { extensionVersion } : {}),
    },
  };
}

function jsonRpcImportError(message: unknown, data: unknown): ManualCaptureImportError {
  if (hasTemporalUnavailableSignal(message) || hasTemporalUnavailableSignal(data)) {
    return new ManualCaptureImportError("Manual capture import is temporarily unavailable.", 503);
  }
  // JSON-RPC errors identify a failed start/wait, but their data may contain
  // runtime details. The HTTP contract deliberately returns a stable message.
  return new ManualCaptureImportError("Manual capture import could not be completed.", 500);
}

function workflowImportError(errorCode: string | null): ManualCaptureImportError {
  switch (errorCode) {
    case "not_found":
      return new ManualCaptureImportError("Manual capture item was not found.", 404);
    case "capture_replay_mismatch":
      return new ManualCaptureImportError(
        "This capture conflicts with an already imported item. Submit the original capture again or create a new capture.",
        409,
      );
    default:
      if (hasTemporalUnavailableSignal(errorCode)) {
        return new ManualCaptureImportError("Manual capture import is temporarily unavailable.", 503);
      }
      return new ManualCaptureImportError("Manual capture import could not be completed.", 500);
  }
}

function invalidWorkflowResultError(): ManualCaptureImportError {
  return new ManualCaptureImportError("Manual capture workflow returned an invalid result.", 500);
}

function requiredText(value: unknown): string {
  if (typeof value === "string" && value.trim()) {
    return value;
  }
  throw invalidWorkflowResultError();
}

function optionalText(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value : null;
}

function recordValue(value: unknown): Record<string, unknown> | null {
  return isRecord(value) ? value : null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function hasTemporalUnavailableSignal(value: unknown): boolean {
  if (typeof value === "string") {
    return /(?:temporal|econnrefused|connection refused|failed to connect|service unavailable|unavailable|deadline exceeded)/i.test(
      value,
    );
  }
  if (Array.isArray(value)) {
    return value.some(hasTemporalUnavailableSignal);
  }
  return isRecord(value) && Object.values(value).some(hasTemporalUnavailableSignal);
}
