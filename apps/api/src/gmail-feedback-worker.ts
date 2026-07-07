import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

import type {
  ApplicationOutcomeKind,
  GmailOutcomeScanRequest,
  GmailOutcomeScanResponse,
} from "./contracts.js";
import { APPLICATION_OUTCOME_KINDS } from "./contracts.js";

const API_SRC_DIR = path.dirname(fileURLToPath(import.meta.url));
const AUTOMATION_PROJECT_DIR = path.resolve(API_SRC_DIR, "../../../workers/automation");

export interface GmailFeedbackScanContext {
  appDir: string;
  dbPath: string;
}

export type GmailFeedbackScanner = (
  input: GmailOutcomeScanRequest,
  context: GmailFeedbackScanContext,
) => Promise<unknown>;

export interface WorkerGmailFeedbackScannerOptions {
  projectDir?: string;
  uvBinary?: string;
}

export class GmailFeedbackScanError extends Error {
  readonly statusCode: number;

  constructor(message: string, statusCode: number) {
    super(message);
    this.name = "GmailFeedbackScanError";
    this.statusCode = statusCode;
  }
}

export function createWorkerGmailFeedbackScanner(
  options: WorkerGmailFeedbackScannerOptions = {},
): GmailFeedbackScanner {
  const projectDir = options.projectDir ?? AUTOMATION_PROJECT_DIR;
  const uvBinary = options.uvBinary ?? "uv";

  return async (input, context) =>
    runWorkerScan(input, {
      appDir: context.appDir,
      dbPath: context.dbPath,
      projectDir,
      uvBinary,
    });
}

export function sanitizeGmailFeedbackScanResponse(output: unknown): GmailOutcomeScanResponse {
  const record = isRecord(output) ? output : {};
  return {
    ok: true,
    scannedAnchorCount: numberValue(record.scannedAnchorCount),
    searchedMessageCount: numberValue(record.searchedMessageCount),
    linkedEvidenceCount: numberValue(record.linkedEvidenceCount),
    suggestionsCreatedCount: numberValue(record.suggestionsCreatedCount),
    duplicateMessageCount: numberValue(record.duplicateMessageCount),
    unlinkedCandidateCount: numberValue(record.unlinkedCandidateCount),
    evidence: arrayValue(record.evidence).map((item) => {
      const evidence = isRecord(item) ? item : {};
      return {
        evidenceId: textValue(evidence.evidenceId, "evidenceId"),
        jobKey: textValue(evidence.jobKey, "jobKey"),
        providerMessageId: textValue(evidence.providerMessageId, "providerMessageId"),
        linkConfidence: numberValue(evidence.linkConfidence),
      };
    }),
    suggestions: arrayValue(record.suggestions).map((item) => {
      const suggestion = isRecord(item) ? item : {};
      return {
        suggestionId: textValue(suggestion.suggestionId, "suggestionId"),
        evidenceId: textValue(suggestion.evidenceId, "evidenceId"),
        jobKey: textValue(suggestion.jobKey, "jobKey"),
        kind: outcomeKind(suggestion.kind),
        confidence: numberValue(suggestion.confidence),
      };
    }),
  };
}

interface WorkerRunOptions extends GmailFeedbackScanContext {
  projectDir: string;
  uvBinary: string;
}

function runWorkerScan(
  payload: GmailOutcomeScanRequest,
  options: WorkerRunOptions,
): Promise<GmailOutcomeScanResponse> {
  return new Promise((resolve, reject) => {
    const child = spawn(
      options.uvBinary,
      [
        "--project",
        options.projectDir,
        "run",
        "python",
        "-m",
        "jobctl.infrastructure.gmail.feedback",
        "--db-path",
        options.dbPath,
      ],
      {
        cwd: options.appDir,
        env: {
          ...process.env,
          JOBCTL_DIR: options.appDir,
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
        const parsed = tryParseWorkerOutput(stdout);
        const message =
          (isRecord(parsed) && optionalText(parsed.message)) ||
          stderr.trim() ||
          stdout.trim() ||
          `Worker exited with code ${code ?? "unknown"}.`;
        reject(new GmailFeedbackScanError(message, gmailFeedbackErrorStatus(message)));
        return;
      }
      try {
        const parsed = parseWorkerOutput(stdout);
        if (!isRecord(parsed)) {
          throw new Error("Worker response was not a JSON object.");
        }
        if (parsed.ok === false) {
          const message = optionalText(parsed.message) ?? "Gmail feedback scan failed.";
          throw new GmailFeedbackScanError(message, gmailFeedbackErrorStatus(message));
        }
        resolve(sanitizeGmailFeedbackScanResponse(parsed));
      } catch (error) {
        reject(
          error instanceof GmailFeedbackScanError
            ? error
            : new GmailFeedbackScanError(
                error instanceof Error ? error.message : "Unable to parse worker response.",
                500,
              ),
        );
      }
    });
    child.stdin.end(`${JSON.stringify(payload)}\n`);
  });
}

function parseWorkerOutput(stdout: string): unknown {
  const line = stdout
    .trim()
    .split("\n")
    .findLast((candidate) => candidate.trim().startsWith("{"));
  if (!line) {
    throw new Error("Worker did not return a JSON object.");
  }
  return JSON.parse(line) as unknown;
}

function tryParseWorkerOutput(stdout: string): unknown {
  try {
    return parseWorkerOutput(stdout);
  } catch {
    return null;
  }
}

function gmailFeedbackErrorStatus(message: string): number {
  if (/recipient email|input must be a JSON object|application hints/i.test(message)) {
    return 400;
  }
  if (/gmail auth|oauth|token|credentials|unauth/i.test(message)) {
    return 503;
  }
  return 500;
}

function numberValue(value: unknown): number {
  const parsed = Number(value ?? 0);
  return Number.isFinite(parsed) ? parsed : 0;
}

function textValue(value: unknown, name: string): string {
  if (typeof value === "string" && value.trim()) {
    return value;
  }
  throw new GmailFeedbackScanError(`Worker response missing ${name}.`, 500);
}

function optionalText(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value : null;
}

function arrayValue(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function outcomeKind(value: unknown): ApplicationOutcomeKind {
  return APPLICATION_OUTCOME_KINDS.includes(value as ApplicationOutcomeKind)
    ? (value as ApplicationOutcomeKind)
    : "unknown";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
