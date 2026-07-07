import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

import type {
  ManualCaptureImportRequest,
  ManualCaptureImportResponse,
} from "./contracts.js";

const API_SRC_DIR = path.dirname(fileURLToPath(import.meta.url));
const AUTOMATION_PROJECT_DIR = path.resolve(API_SRC_DIR, "../../../workers/automation");

export interface ManualCaptureImportContext {
  appDir: string;
  dbPath: string;
}

export type ManualCaptureImporter = (
  itemId: string,
  input: ManualCaptureImportRequest,
  context: ManualCaptureImportContext,
) => Promise<ManualCaptureImportResponse>;

export interface WorkerManualCaptureImporterOptions {
  projectDir?: string;
  uvBinary?: string;
}

export class ManualCaptureImportError extends Error {
  readonly statusCode: number;

  constructor(message: string, statusCode: number) {
    super(message);
    this.name = "ManualCaptureImportError";
    this.statusCode = statusCode;
  }
}

export function createWorkerManualCaptureImporter(
  options: WorkerManualCaptureImporterOptions = {},
): ManualCaptureImporter {
  const projectDir = options.projectDir ?? AUTOMATION_PROJECT_DIR;
  const uvBinary = options.uvBinary ?? "uv";

  return async (itemId, input, context) => {
    const output = await runWorkerImport(
      {
        itemId,
        ...input,
      },
      {
        appDir: context.appDir,
        dbPath: context.dbPath,
        projectDir,
        uvBinary,
      },
    );
    return workerOutputToResponse(output, input);
  };
}

interface WorkerRunOptions extends ManualCaptureImportContext {
  projectDir: string;
  uvBinary: string;
}

function runWorkerImport(
  payload: Record<string, unknown>,
  options: WorkerRunOptions,
): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const child = spawn(
      options.uvBinary,
      [
        "--project",
        options.projectDir,
        "run",
        "python",
        "-m",
        "jobctrl.discovery.manual_capture_import",
        "--db-path",
        options.dbPath,
      ],
      {
        cwd: options.appDir,
        env: {
          ...process.env,
          JOBCTRL_DIR: options.appDir,
        },
        stdio: ["pipe", "pipe", "pipe"],
      },
    );
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk: string) => {
      stderr += chunk;
    });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code !== 0) {
        const message = stderr.trim() || stdout.trim() || `Worker exited with code ${code ?? "unknown"}.`;
        reject(new ManualCaptureImportError(message, manualCaptureErrorStatus(message)));
        return;
      }
      try {
        const line = stdout
          .trim()
          .split("\n")
          .findLast((candidate) => candidate.trim().startsWith("{"));
        if (!line) {
          throw new Error("Worker did not return a JSON object.");
        }
        const parsed: unknown = JSON.parse(line);
        if (!isRecord(parsed)) {
          throw new Error("Worker response was not a JSON object.");
        }
        resolve(parsed);
      } catch (error) {
        reject(
          new ManualCaptureImportError(
            error instanceof Error ? error.message : "Unable to parse worker response.",
            500,
          ),
        );
      }
    });
    child.stdin.end(`${JSON.stringify(payload)}\n`);
  });
}

function workerOutputToResponse(
  output: Record<string, unknown>,
  input: ManualCaptureImportRequest,
): ManualCaptureImportResponse {
  const retryContext = isRecord(output.retryContext) ? output.retryContext : {};
  const provenance = isRecord(retryContext.manual_capture_provenance)
    ? retryContext.manual_capture_provenance
    : {};
  const captureClient = optionalText(provenance.capture_client ?? provenance.captureClient);
  const extensionVersion = optionalText(provenance.extension_version ?? provenance.extensionVersion);
  return {
    ok: true,
    itemId: requiredText(output.itemId, "itemId"),
    jobKey: optionalText(output.jobId),
    importedAt: requiredText(output.importedAt, "importedAt"),
    provenance: {
      sourceKind: "user_mediated_capture",
      originatingUrl: requiredText(
        provenance.originating_url ?? provenance.originatingUrl,
        "originatingUrl",
      ),
      captureMode: input.captureMode,
      futureManualActionRequired: input.futureManualActionRequired,
      ...(captureClient ? { captureClient } : {}),
      ...(extensionVersion ? { extensionVersion } : {}),
    },
  };
}

function manualCaptureErrorStatus(message: string): number {
  return /was not found|not found/i.test(message) ? 404 : 500;
}

function requiredText(value: unknown, name: string): string {
  if (typeof value === "string" && value.trim()) {
    return value;
  }
  throw new ManualCaptureImportError(`Worker response missing ${name}.`, 500);
}

function optionalText(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value : null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
