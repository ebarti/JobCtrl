import { callRpc } from "./json-rpc-adapter.js";
import type {
  ApplicationOutcomeKind,
  GmailOutcomeScanRequest,
  GmailOutcomeScanResponse,
} from "./contracts.js";
import { APPLICATION_OUTCOME_KINDS, RpcMethods } from "./contracts.js";
import type { JsonRpcDispatcher } from "./json-rpc-adapter.js";

export interface GmailFeedbackScanContext {
  appDir: string;
  dbPath: string;
}

export type GmailFeedbackScanner = (
  input: GmailOutcomeScanRequest,
  context: GmailFeedbackScanContext,
) => Promise<unknown>;

export class GmailFeedbackScanError extends Error {
  readonly statusCode: number;
  readonly failureCode: string | undefined;

  constructor(message: string, statusCode: number, failureCode?: string) {
    super(message);
    this.name = "GmailFeedbackScanError";
    this.statusCode = statusCode;
    this.failureCode = failureCode;
  }
}

// Runs the bounded Gmail outcome scan through the long-lived JSON-RPC worker
// child instead of a bespoke one-shot subprocess with stdout line-parsing.
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
    } catch {
      // Transport-level failures (spawn/write errors, the request timeout,
      // child exit) reject instead of returning a JSON-RPC error envelope;
      // keep them on the route's typed error path.
      throw new GmailFeedbackScanError("Gmail feedback worker transport failed.", 500, "rpc_transport_error");
    }
    if (response.error) {
      // RPC error data may contain private source or provider text.
      throw new GmailFeedbackScanError("Gmail feedback worker dispatch failed.", 500, "rpc_dispatch_error");
    }
    const parsed = response.result;
    if (!isRecord(parsed)) {
      throw new GmailFeedbackScanError("Worker response was not a JSON object.", 500);
    }
    if (parsed.ok === false) {
      const code = safeFailureCode(parsed.failureCode);
      const statusCode = INVALID_FAILURES.has(code) ? 400 : UNAVAILABLE_FAILURES.has(code) ? 503 : 500;
      const message = code === "gmail_auth_required"
        ? "Gmail authentication is required; reconnect Gmail and retry."
        : `Gmail feedback scan failed (${code}).`;
      throw new GmailFeedbackScanError(message, statusCode, code);
    }
    return sanitizeGmailFeedbackScanResponse(parsed);
  };
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
        jobId: textValue(evidence.jobId, "jobId"),
        providerMessageId: textValue(evidence.providerMessageId, "providerMessageId"),
        linkConfidence: numberValue(evidence.linkConfidence),
      };
    }),
    suggestions: arrayValue(record.suggestions).map((item) => {
      const suggestion = isRecord(item) ? item : {};
      return {
        suggestionId: textValue(suggestion.suggestionId, "suggestionId"),
        evidenceId: textValue(suggestion.evidenceId, "evidenceId"),
        jobId: textValue(suggestion.jobId, "jobId"),
        kind: outcomeKind(suggestion.kind),
        confidence: numberValue(suggestion.confidence),
      };
    }),
  };
}

const INVALID_FAILURES = new Set(["invalid_recipient", "invalid_scan_options", "invalid_search"]);
const UNAVAILABLE_FAILURES = new Set([
  "gmail_auth_required", "gmail_timeout", "gmail_transport_error", "gmail_rate_limited",
  "gmail_provider_unavailable", "gmail_provider_error", "provider_unavailable", "budget_denied",
]);
const BLOCKED_FAILURES = new Set([
  "gmail_scan_failed", "provider_error", "provider_non_retryable", "malformed_json", "schema_violation",
  "source_schema_violation", "foreign_source_id", "inconsistent_verdict", "missing_evidence_citation",
  "non_verbatim_quote", "mismatched_value", "duplicate_source_id", "cache_binding_invalid",
  "cache_lock_unavailable", "persistence_error", "configuration_invalid", "message_identity_changed",
  "message_recipient_changed",
]);

function safeFailureCode(value: unknown): string {
  return typeof value === "string" &&
    (INVALID_FAILURES.has(value) || UNAVAILABLE_FAILURES.has(value) || BLOCKED_FAILURES.has(value))
    ? value : "gmail_scan_failed";
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
