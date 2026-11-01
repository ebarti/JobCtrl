/** References for broad Apply delivery; canonical review retains private sources. */
const PRIVATE_CARRIERS = new Set(["AgentResult", "AssistantText", "ToolUse", "ApplyTerminalDetermination"]);
const REFERENCES = ["tenantId", "jobId", "job_id", "run_id", "runId", "event_id", "eventId",
  "stage", "level", "apply_status", "determination_id", "attempt_number", "attemptNumber"];
const AMBIGUOUS = "email_send_outcome_ambiguous";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function isPrivateApplyEvent(eventType: unknown, payload: Record<string, unknown> = {}): boolean {
  if (typeof eventType !== "string") return false;
  if (eventType.startsWith("EmailApplication") || PRIVATE_CARRIERS.has(eventType)) return true;
  if (eventType !== "ApplicationFailed") return false;
  const result = isRecord(payload.result) ? payload.result : {};
  // Exact historical producer code, not a semantic classification of error prose.
  return [payload.reason, payload.error, result.reason, result.error].some((value) =>
    typeof value === "string" && (value === AMBIGUOUS || value.startsWith(`${AMBIGUOUS}:`)));
}

export function applyEventReferences(eventType: unknown, payload: Record<string, unknown>): Record<string, unknown> {
  if (eventType === "ApplyRunEventRecorded" && isRecord(payload.event)) {
    const event = payload.event;
    if (isPrivateApplyEvent(event.event_type ?? event.eventType, isRecord(event.payload) ? event.payload : event)) {
      return { ...Object.fromEntries(REFERENCES.filter((key) => Object.hasOwn(payload, key)).map((key) => [key, payload[key]])),
        event: Object.fromEntries(["event_id", "eventId", "event_type", "eventType", "occurred_at", "occurredAt", "level"]
          .filter((key) => Object.hasOwn(event, key)).map((key) => [key, event[key]])) };
    }
  }
  if (!isPrivateApplyEvent(eventType, payload)) return payload;
  const safe = Object.fromEntries(REFERENCES.filter((key) => Object.hasOwn(payload, key)).map((key) => [key, payload[key]]));
  if (eventType === "ApplicationFailed") {
    safe.reason = AMBIGUOUS;
    if (isRecord(payload.result)) safe.result = { kind: "failed", error: AMBIGUOUS, retryable: false };
    else if (payload.result === "failed" || payload.result === "needs_verification") safe.result = payload.result;
  }
  return safe;
}
