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

  constructor(message: string, statusCode: number) {
    super(message);
    this.name = "GmailFeedbackScanError";
    this.statusCode = statusCode;
  }
}

// Runs the bounded Gmail outcome scan through the long-lived JSON-RPC worker
// child instead of a bespoke one-shot subprocess with stdout line-parsing.
// Auth failures still travel as { ok: false, message } inside the result so
// the status mapping below stays behavior-identical.
export function createWorkerGmailFeedbackScanner(dispatcher: JsonRpcDispatcher): GmailFeedbackScanner {
  return async (input, context) => {
    let response: Awaited<ReturnType<JsonRpcDispatcher["call"]>>;
    try {
      response = await dispatcher.call(RpcMethods.GmailFeedbackScan, {
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
      // Transport-level failures (spawn/write errors, the request timeout,
      // child exit) reject instead of returning a JSON-RPC error envelope;
      // keep them on the route's typed error path.
      const message = `Gmail feedback scan failed: ${error instanceof Error ? error.message : String(error)}`;
      throw new GmailFeedbackScanError(message, gmailFeedbackErrorStatus(message));
    }
    if (response.error) {
      // The RPC server hides handler exceptions behind a generic "Internal
      // error" message with the cause in error.data; the handler converts
      // scan failures to ok:false, so this path is dispatch-level only.
      const message =
        optionalText(response.error.data) ?? optionalText(response.error.message) ?? "Gmail feedback scan failed.";
      throw new GmailFeedbackScanError(message, gmailFeedbackErrorStatus(message));
    }
    const parsed = response.result;
    if (!isRecord(parsed)) {
      throw new GmailFeedbackScanError("Worker response was not a JSON object.", 500);
    }
    if (parsed.ok === false) {
      const message = optionalText(parsed.message) ?? "Gmail feedback scan failed.";
      throw new GmailFeedbackScanError(message, gmailFeedbackErrorStatus(message));
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
