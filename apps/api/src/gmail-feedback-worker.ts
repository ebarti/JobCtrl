import { callRpc } from "./json-rpc-adapter.js";
import type {
  ApplicationOutcomeKind,
  GmailOutcomeScanFailure,
  GmailOutcomeScanFailureCode,
  GmailOutcomeScanProgress,
  GmailOutcomeScanRequest,
  GmailOutcomeScanResponse,
} from "./contracts.js";
import {
  APPLICATION_OUTCOME_KINDS,
  GmailOutcomeScanFailureCodeSchema,
  RpcContractError,
  RpcMethods,
} from "./contracts.js";
import type { JsonRpcDispatcher } from "./json-rpc-adapter.js";

export interface GmailFeedbackScanContext {
  appDir: string;
  dbPath: string;
}

export type GmailFeedbackScanner = (
  input: GmailOutcomeScanRequest,
  context: GmailFeedbackScanContext,
) => Promise<unknown>;

const INVALID_FAILURES = new Set<GmailOutcomeScanFailureCode>(["invalid_recipient", "invalid_scan_options", "invalid_search"]);
const UNAVAILABLE_FAILURES = new Set<GmailOutcomeScanFailureCode>([
  "gmail_auth_required", "gmail_timeout", "gmail_transport_error", "gmail_rate_limited",
  "gmail_provider_unavailable", "gmail_provider_error", "provider_unavailable", "budget_denied",
]);
const RPC_FAILURES = new Set<GmailOutcomeScanFailureCode>(["rpc_transport_error", "rpc_dispatch_error"]);

export class GmailFeedbackScanError extends Error {
  readonly statusCode: number;
  readonly response: GmailOutcomeScanFailure;

  constructor(code: GmailOutcomeScanFailureCode, progress: GmailOutcomeScanProgress | null = null, status?: GmailOutcomeScanFailure["status"]) {
    const invalid = INVALID_FAILURES.has(code);
    const unavailable = UNAVAILABLE_FAILURES.has(code) || RPC_FAILURES.has(code);
    const statusCode = invalid ? 400 : code === "runtime_mismatch" ? 409
      : code === "spend_denied" ? 429 : code === "worker_response_invalid" ? 502
      : RPC_FAILURES.has(code) ? 500 : unavailable ? 503 : 500;
    const message = code === "runtime_mismatch"
      ? "The worker is connected to a different workspace. Reconnect the worker before retrying."
      : code === "gmail_auth_required"
        ? "Gmail authorization is unavailable. Reconnect Gmail before retrying."
        : invalid
          ? "Check the recipient and bounded scan options before retrying."
          : code === "budget_denied" || code === "spend_denied"
            ? "The scan was blocked by the model spending limit. Review the budget before retrying."
            : RPC_FAILURES.has(code)
              ? "The worker connection failed. Committed progress is unknown; retry to reconcile it."
              : unavailable
                ? "The Gmail or model provider could not complete the scan. Check the connection before retrying."
                : "The scan could not complete. Retry after checking the reported failure code.";
    super(message);
    this.name = "GmailFeedbackScanError";
    this.statusCode = statusCode;
    this.response = {
      ok: false,
      error: invalid ? "invalid_gmail_feedback_scan" : "gmail_feedback_scan_failed",
      status: status ?? (invalid ? "invalid" : unavailable ? "unavailable" : "blocked"),
      failureCode: code,
      message,
      progress,
    };
  }
}

// The worker returns safe failure codes and the progress it observed. Never
// forward RPC/transport exception text or infer progress after a lost response.
export function createWorkerGmailFeedbackScanner(dispatcher: JsonRpcDispatcher): GmailFeedbackScanner {
  return async (input, context) => {
    let response: Awaited<ReturnType<JsonRpcDispatcher["call"]>>;
    try {
      response = await callRpc(dispatcher, RpcMethods.GmailFeedbackScan, {
        expectedAppDir: context.appDir,
        expectedDbPath: context.dbPath,
        ...(input.recipientEmail !== undefined ? { recipientEmail: input.recipientEmail } : {}),
        ...(input.limit !== undefined ? { limit: Number(input.limit) } : {}),
        ...(input.maxResultsPerAnchor !== undefined
          ? { maxResultsPerAnchor: Number(input.maxResultsPerAnchor) }
          : {}),
        ...(input.windowDays !== undefined ? { windowDays: Number(input.windowDays) } : {}),
      });
    } catch (error) {
      if (error instanceof RpcContractError && error.phase === "result") {
        throw new GmailFeedbackScanError("worker_response_invalid");
      }
      throw new GmailFeedbackScanError("rpc_transport_error");
    }
    if (response.error) {
      throw new GmailFeedbackScanError("rpc_dispatch_error");
    }
    const parsed = response.result;
    if (!isRecord(parsed) || typeof parsed.ok !== "boolean") {
      throw new GmailFeedbackScanError("worker_response_invalid");
    }
    if (!parsed.ok) {
      const code = GmailOutcomeScanFailureCodeSchema.safeParse(parsed.failureCode);
      let progress: GmailOutcomeScanProgress | null = null;
      try {
        progress = sanitizeProgress(parsed);
      } catch {
        // No complete progress envelope means the committed count is unknown.
      }
      const status = parsed.status === "invalid" || parsed.status === "blocked" || parsed.status === "unavailable"
        ? parsed.status : undefined;
      throw new GmailFeedbackScanError(code.success ? code.data : "gmail_scan_failed", progress, status);
    }
    return sanitizeGmailFeedbackScanResponse(parsed);
  };
}

export function sanitizeGmailFeedbackScanResponse(output: unknown): GmailOutcomeScanResponse {
  if (!isRecord(output) || output.ok !== true) throw new GmailFeedbackScanError("worker_response_invalid");
  return { ok: true, ...sanitizeProgress(output) };
}

function sanitizeProgress(output: Record<string, unknown>): GmailOutcomeScanProgress {
  return {
    scannedAnchorCount: countValue(output.scannedAnchorCount),
    searchedMessageCount: countValue(output.searchedMessageCount),
    linkedEvidenceCount: countValue(output.linkedEvidenceCount),
    suggestionsCreatedCount: countValue(output.suggestionsCreatedCount),
    duplicateMessageCount: countValue(output.duplicateMessageCount),
    unlinkedCandidateCount: countValue(output.unlinkedCandidateCount),
    evidence: arrayValue(output.evidence).map((item) => {
      const evidence = isRecord(item) ? item : {};
      return {
        evidenceId: textValue(evidence.evidenceId),
        jobId: textValue(evidence.jobId),
        providerMessageId: textValue(evidence.providerMessageId),
        linkConfidence: numberValue(evidence.linkConfidence),
      };
    }),
    suggestions: arrayValue(output.suggestions).map((item) => {
      const suggestion = isRecord(item) ? item : {};
      return {
        suggestionId: textValue(suggestion.suggestionId),
        evidenceId: textValue(suggestion.evidenceId),
        jobId: textValue(suggestion.jobId),
        kind: outcomeKind(suggestion.kind),
        confidence: numberValue(suggestion.confidence),
      };
    }),
  };
}

function countValue(value: unknown): number {
  if (typeof value === "number" && Number.isSafeInteger(value) && value >= 0) return value;
  throw new GmailFeedbackScanError("worker_response_invalid");
}

function numberValue(value: unknown): number {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  throw new GmailFeedbackScanError("worker_response_invalid");
}

function textValue(value: unknown): string {
  if (typeof value === "string" && value.trim()) return value;
  throw new GmailFeedbackScanError("worker_response_invalid");
}

function arrayValue(value: unknown): unknown[] {
  if (Array.isArray(value)) return value;
  throw new GmailFeedbackScanError("worker_response_invalid");
}

function outcomeKind(value: unknown): ApplicationOutcomeKind {
  if (APPLICATION_OUTCOME_KINDS.includes(value as ApplicationOutcomeKind)) return value as ApplicationOutcomeKind;
  throw new GmailFeedbackScanError("worker_response_invalid");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
