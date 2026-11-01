import { callRpc, RpcContractError } from "./json-rpc-adapter.js";
import type {
  JobUrlImportCompletedResponse,
  JobUrlImportExecution,
  JobUrlImportStatusResponse,
  JobUrlImportRequest,
  JobUrlImportResponse,
  JobUrlImportWorkflowResult,
} from "./contracts.js";
import { JobUrlImportStatusParamsSchema, JobUrlImportWorkflowResultSchema } from "./contracts.js";
import {
  getDefaultJsonRpcDispatcher,
  type JsonRpcDispatcher,
} from "./json-rpc-adapter.js";
import { createSourcePythonRuntime, type PythonRuntimeCommandResolver } from "./python-runtime.js";

export interface JobUrlImportContext {
  appDir: string;
  dbPath: string;
}

export type JobUrlImporter = (
  input: JobUrlImportRequest,
  context: JobUrlImportContext,
) => Promise<JobUrlImportResponse>;

export interface WorkerJobUrlImporterOptions {
  projectDir?: string;
  uvBinary?: string;
  pythonRuntime?: PythonRuntimeCommandResolver;
  dispatcherFactory?: (context: JobUrlImportContext) => JsonRpcDispatcher;
}

export class JobUrlImportError extends Error {
  readonly statusCode: number;
  readonly failureCode?: string;

  constructor(message: string, statusCode: number, failureCode?:string) {
    super(message);
    this.name = "JobUrlImportError";
    this.statusCode = statusCode;
    if (failureCode !== undefined) this.failureCode = failureCode;
  }
}

export function createWorkerJobUrlImporter(
  options: WorkerJobUrlImporterOptions = {},
): JobUrlImporter {
  const pythonRuntime =
    options.pythonRuntime ??
    createSourcePythonRuntime({
      ...(options.projectDir ? { projectDir: options.projectDir } : {}),
      ...(options.uvBinary ? { uvBinary: options.uvBinary } : {}),
    });
  const dispatcherFactory =
    options.dispatcherFactory ??
    ((context: JobUrlImportContext) =>
      getDefaultJsonRpcDispatcher({ appDir: context.appDir, pythonRuntime }));

  return async (input, context) => {
    let response;
    try {
      response = await callRpc(dispatcherFactory(context), "job_url_import", {
        tenantId: "local",
        url: input.url,
        expectedAppDir: context.appDir,
        expectedDbPath: context.dbPath,
        awaitResult: input.awaitResult ?? true,
      });
    } catch (error) {
      if (error instanceof RpcContractError && error.phase === "result") throw invalidResult();
      throw new JobUrlImportError("Job import is temporarily unavailable.", 503);
    }
    if (response.error) {
      throw new JobUrlImportError("Job import could not be completed.", 500);
    }
    if (input.awaitResult === false) {
      const value = response.result;
      const execution = JobUrlImportStatusParamsSchema.safeParse({
        tenantId: "local", expectedAppDir: context.appDir, expectedDbPath: context.dbPath,
        workflowId: isRecord(value) ? value.workflowId : undefined,
        executionId: isRecord(value) ? value.firstExecutionRunId : undefined,
      });
      if (!execution.success) throw invalidResult();
      return { ok: true, status: "started", workflowId: execution.data.workflowId, executionId: execution.data.executionId };
    }
    return completedImportResult(extractWorkflowResult(response.result));
  };
}

export type JobUrlImportStatusReader = (
  execution: JobUrlImportExecution, context: JobUrlImportContext,
) => Promise<JobUrlImportStatusResponse>;

export function createWorkerJobUrlImportStatusReader(
  options: WorkerJobUrlImporterOptions = {},
): JobUrlImportStatusReader {
  const pythonRuntime = options.pythonRuntime ?? createSourcePythonRuntime({
    ...(options.projectDir ? { projectDir: options.projectDir } : {}),
    ...(options.uvBinary ? { uvBinary: options.uvBinary } : {}),
  });
  const dispatcherFactory = options.dispatcherFactory ?? ((context: JobUrlImportContext) =>
    getDefaultJsonRpcDispatcher({ appDir: context.appDir, pythonRuntime }));
  return async (execution, context) => {
    let response;
    try {
      response = await callRpc(dispatcherFactory(context), "job_url_import_status", {
        tenantId: "local", expectedAppDir: context.appDir, expectedDbPath: context.dbPath, ...execution,
      });
    } catch {
      throw new JobUrlImportError("Import status is temporarily unavailable. The import may still be running.", 503);
    }
    if (response.error || !response.result) {
      throw new JobUrlImportError("Import status is temporarily unavailable. The import may still be running.", 503);
    }
    const result = response.result;
    if (result.workflowId !== execution.workflowId || result.executionId !== execution.executionId) throw invalidResult();
    if (result.status === "pending") return { ok: true, status: "pending", ...execution };
    if (result.status === "succeeded") {
      if (!result.result) throw invalidResult();
      try {
        return completedImportResult(result.result);
      } catch (error) {
        if (!(error instanceof JobUrlImportError)) throw error;
        return { ok: true, status: "failed", ...execution, message: error.message,
          ...(error.failureCode ? { failureCode: error.failureCode } : {}) };
      }
    }
    const messages = {
      failed: "The import stopped before completing. Review its run for details.",
      canceled: "This import was canceled.",
      timed_out: "This import exceeded its workflow deadline.",
      terminated: "This import was terminated.",
    };
    return { ok: true, status: result.status, ...execution, message: messages[result.status] };
  };
}

function completedImportResult(workflowResult: JobUrlImportWorkflowResult): JobUrlImportCompletedResponse {
  if (workflowResult.status === "failed") {
    if (workflowResult.error_code === "invalid_url") {
      throw new JobUrlImportError("Only public HTTP or HTTPS job URLs can be imported.", 400);
    }
    const code = workflowResult.error_code?.replace(/^semantic_determination_/, "");
    const safeCodes = ["provider_unavailable", "provider_error", "provider_non_retryable", "budget_denied", "malformed_json", "schema_violation", "foreign_source_id", "non_verbatim_quote", "mismatched_value"];
    if (code && safeCodes.includes(code)) {
      throw new JobUrlImportError(`Job interpretation unavailable: ${code}. Resolve the model or budget failure and retry import.`, 503, code);
    }
    throw new JobUrlImportError("Job import could not be completed.", 500);
  }
  if (workflowResult.outcome === "imported") {
    return { ok: true, status: "imported", jobKey: workflowResult.job_id,
      importedAt: workflowResult.imported_at, alreadyExisted: workflowResult.already_existed };
  }
  return { ok: true, status: "manual_capture_required", itemId: workflowResult.item_id, reason: workflowResult.reason };
}

function extractWorkflowResult(result: unknown): JobUrlImportWorkflowResult {
  if (!isRecord(result)) {
    throw invalidResult();
  }
  const parsed = JobUrlImportWorkflowResultSchema.safeParse(result.result);
  if (!parsed.success) {
    throw invalidResult();
  }
  return parsed.data;
}

function invalidResult(): JobUrlImportError {
  return new JobUrlImportError("Job import returned an invalid worker result.", 500);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
