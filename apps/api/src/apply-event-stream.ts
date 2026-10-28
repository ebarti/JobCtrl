import { isPrivateApplyEvent } from "@jobctrl/domain-types";

/** Project a durable Apply saga row to the browser's existing live-event contract. */
export function applyTimelineEnvelope(
  row: {
    readonly tenant_id: string;
    readonly job_id: string | null;
    readonly stage: string | null;
    readonly event_type: string | null;
    readonly level: string | null;
    readonly message: string | null;
    readonly occurred_at: string | null;
  },
  canonical: Record<string, unknown>,
): Record<string, unknown> | null {
  if (row.stage !== "apply" || !row.job_id || !row.event_type || row.event_type === "ApplyRunEventRecorded") return null;
  const payload = canonical.payload;
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) return null;
  const data = payload as Record<string, unknown>;
  const snakeRun = data.run_id;
  const camelRun = data.runId;
  if (snakeRun !== undefined && camelRun !== undefined && snakeRun !== camelRun) return null;
  const runId = snakeRun ?? camelRun;
  const snakeId = data.event_id;
  const camelId = data.eventId;
  if (snakeId !== undefined && camelId !== undefined && snakeId !== camelId) return null;
  const eventId = snakeId ?? camelId;
  if (typeof runId !== "string" || !runId.trim() || typeof eventId !== "number" || !Number.isSafeInteger(eventId) || eventId <= 0) return null;
  return {
    tenantId: row.tenant_id,
    jobId: row.job_id,
    occurredAt: row.occurred_at,
    payload: {
      tenantId: row.tenant_id,
      jobId: row.job_id,
      runId,
      event: { event_id: eventId, event_type: row.event_type, occurred_at: row.occurred_at, level: row.level ?? "info",
        message: isPrivateApplyEvent(row.event_type, data) ? null : row.message },
    },
  };
}
