import type {
  JobUrlImportRequest,
  JobUrlImportResponse,
  JobUrlImportWorkflowResult,
} from "./contracts.js";
import { JobUrlImportWorkflowResultSchema } from "./contracts.js";
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

  constructor(message: string, statusCode: number) {
    super(message);
    this.name = "JobUrlImportError";
    this.statusCode = statusCode;
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
      response = await dispatcherFactory(context).call("job_url_import", {
        tenantId: "local",
        url: input.url,
        expectedAppDir: context.appDir,
        expectedDbPath: context.dbPath,
        awaitResult: true,
      });
    } catch {
      throw new JobUrlImportError("Job import is temporarily unavailable.", 503);
    }
    if (response.error) {
      throw new JobUrlImportError("Job import could not be completed.", 500);
    }
    const workflowResult = extractWorkflowResult(response.result);
    if (workflowResult.status === "failed") {
      if (workflowResult.error_code === "invalid_url") {
        throw new JobUrlImportError("Only public HTTP or HTTPS job URLs can be imported.", 400);
      }
      throw new JobUrlImportError("Job import could not be completed.", 500);
    }
    if (workflowResult.outcome === "imported") {
      return {
        ok: true,
        status: "imported",
        jobKey: workflowResult.job_id,
        importedAt: workflowResult.imported_at,
        alreadyExisted: workflowResult.already_existed,
      };
    }
    return {
      ok: true,
      status: "manual_capture_required",
      itemId: workflowResult.item_id,
      reason: workflowResult.reason,
    };
  };
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
