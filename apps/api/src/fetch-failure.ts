import { PUBLIC_FETCH_FAILURE_KINDS, type EnrichmentFetchFailure } from "./contracts.js";

const kinds = new Set<string>(PUBLIC_FETCH_FAILURE_KINDS);
const statuses = new Set(["waiting", "retry_ready", "checks_exhausted", "stopped"]);
const record = (value: unknown): Record<string, unknown> => value && typeof value === "object" && !Array.isArray(value)
  ? value as Record<string, unknown> : {};

function timestamp(value: unknown): string | null {
  if (typeof value !== "string" || value.length > 64) return null;
  const match = /^(\d{4})-(\d{2})-(\d{2})T(?:[01]\d|2[0-3]):[0-5]\d:[0-5]\d(?:\.\d+)?(?:Z|[+-](?:[01]\d|2[0-3]):[0-5]\d)$/u.exec(value);
  if (!match || match[0] !== value || !Number.isFinite(Date.parse(value))) return null;
  const [year, month, day] = match.slice(1).map(Number);
  if (!year || !month || !day || month > 12 || day > new Date(Date.UTC(year, month, 0)).getUTCDate()) return null;
  return value;
}

export function parseFetchFailure(value: unknown, recoveryValue?: unknown): EnrichmentFetchFailure | null {
  const failure = record(value);
  if (typeof failure.kind !== "string" || !kinds.has(failure.kind)) return null;
  const recovery = recoveryValue === undefined ? failure : record(recoveryValue);
  const status = recoveryValue === undefined ? recovery.recoveryStatus : recovery.status;
  const count = recovery.checkCount;
  const hasRecovery = typeof status === "string" && statuses.has(status) && typeof count === "number" && Number.isInteger(count) && count >= 1 && count <= 5;
  return {
    kind: failure.kind as EnrichmentFetchFailure["kind"],
    requestHost: typeof failure.requestHost === "string" && /^[A-Za-z0-9.:[\]-]{1,253}$/u.exec(failure.requestHost)?.[0] === failure.requestHost ? failure.requestHost : null,
    observedAt: timestamp(failure.observedAt),
    recoveryStatus: hasRecovery ? status as EnrichmentFetchFailure["recoveryStatus"] : null,
    checkCount: hasRecovery ? count : 0,
    checkedAt: hasRecovery ? timestamp(recovery.checkedAt) : null,
    nextCheckAt: hasRecovery ? timestamp(recovery.nextCheckAt) : null,
    retryEligibleAt: hasRecovery ? timestamp(recovery.retryEligibleAt) : null,
  };
}

export function fetchFailureFromStageMetadata(value: string | null): EnrichmentFetchFailure | null {
  try {
    const metadata = record(JSON.parse(value ?? "{}"));
    return parseFetchFailure(metadata.fetchFailure, metadata.fetchRecovery ?? {});
  } catch {
    return null;
  }
}
