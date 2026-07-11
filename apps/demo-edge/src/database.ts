import {
  CONSENT_CONTRACT_VERSION,
  OPERATION_DIGEST_MAX_AGE_SECONDS,
  OPERATIONAL_RATE_LIMIT_PER_MINUTE,
  PERSISTENT_COOKIE_MAX_AGE_SECONDS,
  PRODUCT_DATA_MAX_AGE_SECONDS,
  RETENTION_SAFETY_MARGIN_SECONDS,
  TELEMETRY_GLOBAL_RATE_LIMIT_PER_MINUTE,
  TELEMETRY_RATE_LIMIT_PER_MINUTE,
  type ConsentChoice,
  type HealthResult,
  type StorageMode,
  type TelemetryEvent,
} from "./contracts.js";
import { randomId, sha256 } from "./crypto.js";

interface OperationalCounter {
  metric: "consent_choice" | "initialization_result";
  consentChoice: ConsentChoice;
  initializationResult: "not_applicable" | HealthResult;
  storageMode: "not_applicable" | StorageMode;
}

interface CountRow {
  count: number;
}

const ACTIVE_IDENTITY_EXISTS_SQL = `SELECT 1 FROM active_demo_identities
  WHERE visitor_hash = ? AND session_hash = ? AND expires_at > ?`;

export interface RetentionResult {
  operationalCounters: number;
  retryDigests: number;
  productEvents: number;
  sessionRates: number;
  globalTelemetryRates: number;
  operationalRates: number;
  activeIdentities: number;
}

function plusSeconds(now: Date, seconds: number): string {
  const result = new Date(now.getTime() + seconds * 1_000);
  return result.toISOString();
}

function boundedExpiry(now: Date, maximumAgeSeconds: number): string {
  return plusSeconds(now, maximumAgeSeconds - RETENTION_SAFETY_MARGIN_SECONDS);
}

function counterExpiry(now: Date): string {
  const dayStart = new Date(`${utcDay(now)}T00:00:00.000Z`);
  return boundedExpiry(dayStart, PRODUCT_DATA_MAX_AGE_SECONDS);
}

function utcMinute(now: Date): string {
  return now.toISOString().slice(0, 16);
}

function utcDay(now: Date): string {
  return now.toISOString().slice(0, 10);
}

async function isWithinOperationalRateLimit(env: DemoEdgeEnv, endpoint: "consent" | "health", now: Date): Promise<boolean> {
  const row = await env.DEMO_TELEMETRY_DB.prepare(
    `INSERT INTO operational_rate_windows (endpoint, window_utc, count, expires_at)
     VALUES (?, ?, 1, ?)
     ON CONFLICT(endpoint, window_utc) DO UPDATE SET
       count = operational_rate_windows.count + 1,
       expires_at = excluded.expires_at
     WHERE operational_rate_windows.count < ?
     RETURNING count`,
  ).bind(
    endpoint,
    utcMinute(now),
    boundedExpiry(now, OPERATION_DIGEST_MAX_AGE_SECONDS),
    OPERATIONAL_RATE_LIMIT_PER_MINUTE,
  ).first<CountRow>();
  return row !== null;
}

export async function isOperationalRequestAllowed(env: DemoEdgeEnv, endpoint: "consent" | "health", now = new Date()): Promise<boolean> {
  return isWithinOperationalRateLimit(env, endpoint, now);
}

export async function recordOperationalCounter(
  env: DemoEdgeEnv,
  operationKey: string,
  counter: OperationalCounter,
  now = new Date(),
): Promise<void> {
  const operationDigest = await sha256(operationKey);
  const statements = [
    env.DEMO_TELEMETRY_DB.prepare(
      "INSERT OR IGNORE INTO operational_retry_digests (operation_digest, expires_at) VALUES (?, ?)",
    ).bind(operationDigest, boundedExpiry(now, OPERATION_DIGEST_MAX_AGE_SECONDS)),
    env.DEMO_TELEMETRY_DB.prepare(
      `INSERT INTO daily_operational_counters (
        day_utc, release, consent_contract_version, metric, consent_choice,
        initialization_result, storage_mode, count, expires_at
      )
      SELECT ?, ?, ?, ?, ?, ?, ?, 1, ?
      WHERE changes() = 1
      ON CONFLICT(day_utc, release, consent_contract_version, metric, consent_choice, initialization_result, storage_mode)
      DO UPDATE SET count = daily_operational_counters.count + 1`,
    ).bind(
      utcDay(now),
      env.DEMO_RELEASE,
      CONSENT_CONTRACT_VERSION,
      counter.metric,
      counter.consentChoice,
      counter.initializationResult,
      counter.storageMode,
      counterExpiry(now),
    ),
  ];

  // D1 batch executes these statements transactionally. The second statement observes
  // changes() from the unique digest insert, so a committed retry cannot increment again.
  await env.DEMO_TELEMETRY_DB.batch(statements);
}

export async function isTelemetryRequestAllowed(
  env: DemoEdgeEnv,
  visitorHash: string,
  sessionHash: string,
  now = new Date(),
): Promise<boolean> {
  const sessionRow = await env.DEMO_TELEMETRY_DB.prepare(
    `INSERT INTO telemetry_rate_windows (session_hash, window_utc, count, expires_at)
     SELECT ?, ?, 1, ?
     WHERE EXISTS (
       ${ACTIVE_IDENTITY_EXISTS_SQL}
     )
     ON CONFLICT(session_hash, window_utc) DO UPDATE SET
       count = telemetry_rate_windows.count + 1,
       expires_at = excluded.expires_at
     WHERE telemetry_rate_windows.count < ?
     RETURNING count`,
  ).bind(
    sessionHash,
    utcMinute(now),
    boundedExpiry(now, OPERATION_DIGEST_MAX_AGE_SECONDS),
    visitorHash,
    sessionHash,
    now.toISOString(),
    TELEMETRY_RATE_LIMIT_PER_MINUTE,
  ).first<CountRow>();
  if (sessionRow === null) return false;

  const globalRow = await env.DEMO_TELEMETRY_DB.prepare(
    `INSERT INTO telemetry_global_rate_windows (window_utc, count, expires_at)
     VALUES (?, 1, ?)
     ON CONFLICT(window_utc) DO UPDATE SET
       count = telemetry_global_rate_windows.count + 1,
       expires_at = excluded.expires_at
     WHERE telemetry_global_rate_windows.count < ?
     RETURNING count`,
  ).bind(
    utcMinute(now),
    boundedExpiry(now, OPERATION_DIGEST_MAX_AGE_SECONDS),
    TELEMETRY_GLOBAL_RATE_LIMIT_PER_MINUTE,
  ).first<CountRow>();
  if (globalRow === null) return false;

  // Workers Rate Limiting counters are per edge location, so this binding is adjacent
  // abuse protection after the authoritative D1 session and global budgets.
  return (await env.TELEMETRY_EDGE_LIMITER.limit({ key: "telemetry" })).success;
}

export async function insertTelemetryEvent(
  env: DemoEdgeEnv,
  visitorHash: string,
  sessionHash: string,
  event: TelemetryEvent,
  now = new Date(),
): Promise<boolean> {
  const inserted = await env.DEMO_TELEMETRY_DB.prepare(
    `INSERT INTO consented_product_events (
      id, occurred_at, expires_at, visitor_hash, session_hash, release, consent_contract_version,
      event_name, route_name, feature_name, action_name, scenario_name, result_code, error_code,
      duration_bucket, viewport_bucket, tour_step, referrer_class, timing_metric, metric_bucket
    )
    SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
    WHERE EXISTS (
      ${ACTIVE_IDENTITY_EXISTS_SQL}
    )
    RETURNING id`,
  ).bind(
    randomId(),
    now.toISOString(),
    boundedExpiry(now, PRODUCT_DATA_MAX_AGE_SECONDS),
    visitorHash,
    sessionHash,
    env.DEMO_RELEASE,
    CONSENT_CONTRACT_VERSION,
    event.name,
    event.attributes.route ?? null,
    event.attributes.feature ?? null,
    event.attributes.action ?? null,
    event.attributes.scenario ?? null,
    event.attributes.result ?? null,
    event.attributes.errorCode ?? null,
    event.attributes.durationBucket ?? null,
    event.attributes.viewportBucket ?? null,
    event.attributes.tourStep ?? null,
    event.attributes.referrerClass ?? null,
    event.attributes.timingMetric ?? null,
    event.attributes.metricBucket ?? null,
    visitorHash,
    sessionHash,
    now.toISOString(),
  ).first<{ id: string }>();
  return inserted !== null;
}

export async function activateTelemetryIdentity(
  env: DemoEdgeEnv,
  visitorId: string,
  sessionId: string,
  now = new Date(),
): Promise<void> {
  const { visitorHash, sessionHash } = await hashTelemetryIds(visitorId, sessionId);
  await env.DEMO_TELEMETRY_DB.prepare(
    `INSERT INTO active_demo_identities (visitor_hash, session_hash, expires_at)
     VALUES (?, ?, ?)
     ON CONFLICT(visitor_hash, session_hash) DO UPDATE SET expires_at = excluded.expires_at`,
  ).bind(visitorHash, sessionHash, plusSeconds(now, PERSISTENT_COOKIE_MAX_AGE_SECONDS)).run();
}

export async function refreshTelemetryIdentity(
  env: DemoEdgeEnv,
  visitorId: string,
  sessionId: string,
  now = new Date(),
): Promise<boolean> {
  const { visitorHash, sessionHash } = await hashTelemetryIds(visitorId, sessionId);
  const refreshed = await env.DEMO_TELEMETRY_DB.prepare(
    `UPDATE active_demo_identities
     SET expires_at = ?
     WHERE visitor_hash = ? AND session_hash = ? AND expires_at > ?
     RETURNING session_hash`,
  ).bind(
    plusSeconds(now, PERSISTENT_COOKIE_MAX_AGE_SECONDS),
    visitorHash,
    sessionHash,
    now.toISOString(),
  ).first<{ session_hash: string }>();
  return refreshed !== null;
}

export async function hasActiveTelemetryVisitor(
  env: DemoEdgeEnv,
  visitorId: string,
  now = new Date(),
): Promise<boolean> {
  const visitorHash = await sha256(visitorId);
  const row = await env.DEMO_TELEMETRY_DB.prepare(
    `SELECT 1 AS active FROM active_demo_identities
     WHERE visitor_hash = ? AND expires_at > ? LIMIT 1`,
  ).bind(visitorHash, now.toISOString()).first<{ active: number }>();
  return row !== null;
}

export async function hasActiveTelemetryIdentity(
  env: DemoEdgeEnv,
  visitorId: string,
  sessionId: string,
  now = new Date(),
): Promise<boolean> {
  const { visitorHash, sessionHash } = await hashTelemetryIds(visitorId, sessionId);
  const row = await env.DEMO_TELEMETRY_DB.prepare(
    `${ACTIVE_IDENTITY_EXISTS_SQL} LIMIT 1`,
  ).bind(visitorHash, sessionHash, now.toISOString()).first<{ active: number }>();
  return row !== null;
}

export async function hashTelemetryIds(visitorId: string, sessionId: string): Promise<{ visitorHash: string; sessionHash: string }> {
  const [visitorHash, sessionHash] = await Promise.all([sha256(visitorId), sha256(sessionId)]);
  return { visitorHash, sessionHash };
}

function changedCount(result: D1Result<unknown>): number {
  return typeof result.meta.changes === "number" ? result.meta.changes : 0;
}

export async function cleanupExpiredData(env: DemoEdgeEnv, now = new Date()): Promise<RetentionResult> {
  const results = await env.DEMO_TELEMETRY_DB.batch([
    env.DEMO_TELEMETRY_DB.prepare("DELETE FROM daily_operational_counters WHERE expires_at <= ?").bind(now.toISOString()),
    env.DEMO_TELEMETRY_DB.prepare("DELETE FROM operational_retry_digests WHERE expires_at <= ?").bind(now.toISOString()),
    env.DEMO_TELEMETRY_DB.prepare("DELETE FROM consented_product_events WHERE expires_at <= ?").bind(now.toISOString()),
    env.DEMO_TELEMETRY_DB.prepare("DELETE FROM telemetry_rate_windows WHERE expires_at <= ?").bind(now.toISOString()),
    env.DEMO_TELEMETRY_DB.prepare("DELETE FROM telemetry_global_rate_windows WHERE expires_at <= ?").bind(now.toISOString()),
    env.DEMO_TELEMETRY_DB.prepare("DELETE FROM operational_rate_windows WHERE expires_at <= ?").bind(now.toISOString()),
    env.DEMO_TELEMETRY_DB.prepare("DELETE FROM active_demo_identities WHERE expires_at <= ?").bind(now.toISOString()),
  ]);
  return {
    operationalCounters: changedCount(results[0]!),
    retryDigests: changedCount(results[1]!),
    productEvents: changedCount(results[2]!),
    sessionRates: changedCount(results[3]!),
    globalTelemetryRates: changedCount(results[4]!),
    operationalRates: changedCount(results[5]!),
    activeIdentities: changedCount(results[6]!),
  };
}
