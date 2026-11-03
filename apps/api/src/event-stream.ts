import fs from "node:fs";
import { offerEventReferences } from "./offers.js";
import { screeningEventReferences } from "./screening-answers.js";
import { applyTimelineEnvelope } from "./apply-event-stream.js";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";

import { LOCAL_TENANT, applyEventReferences } from "@jobctrl/domain-types";

import { createRetainedDatabase, databaseExists, SUPPORTED_SCHEMA_VERSION, type SqliteDatabase } from "./db.js";
import { resolveLoopbackCorsOrigin } from "./local-origin.js";
import { hasExactV15SchemaManifest } from "./schema-manifest.js";

const POLL_DEFAULT_MS = 250;
const KEEPALIVE_DEFAULT_MS = 15_000;
const HEARTBEAT_DEFAULT_MS = 30_000;
const EVENT_BATCH_LIMIT = 1000;
const RETRY_BASELINE_MS = 5_000;

export interface EventStreamOptions {
  readonly dbPath: string;
  readonly pollIntervalMs?: number;
  readonly keepaliveIntervalMs?: number;
  readonly heartbeatIntervalMs?: number;
  readonly databaseRetryIntervalMs?: number;
}

interface EventRow {
  readonly event_id: number;
  readonly tenant_id: string;
  readonly job_id: string | null;
  readonly stage: string | null;
  readonly event_type: string | null;
  readonly level: string | null;
  readonly message: string | null;
  readonly payload_json: string | null;
  readonly occurred_at: string | null;
}

interface Subscriber {
  readonly id: symbol;
  readonly tenantId: string;
  readonly reply: FastifyReply;
  cursor: number;
  readonly keepaliveTimer: NodeJS.Timeout;
  readonly heartbeatTimer: NodeJS.Timeout;
}

export function registerEventStreamRoute(app: FastifyInstance, options: EventStreamOptions): void {
  const pollIntervalMs = clampPositive(
    parseEnvInt(process.env.JOBCTRL_API_SSE_POLL_MS, options.pollIntervalMs ?? POLL_DEFAULT_MS),
  );
  const keepaliveIntervalMs = clampPositive(options.keepaliveIntervalMs ?? KEEPALIVE_DEFAULT_MS);
  const heartbeatIntervalMs = clampPositive(options.heartbeatIntervalMs ?? HEARTBEAT_DEFAULT_MS);
  const databaseRetryIntervalMs = clampPositive(options.databaseRetryIntervalMs ?? RETRY_BASELINE_MS);

  const subscribers = new Map<symbol, Subscriber>();
  const retainedDb = createRetainedDatabase(options.dbPath);
  let boundDbIdentity: string | null = null;
  let boundDb: SqliteDatabase | null = null;
  let boundSchemaStamp: string | null = null;
  let workspaceChanged = false;
  let unavailable = false;
  let nextRetryAt = 0;
  let pollHandle: NodeJS.Timeout | null = null;

  function pathIdentity(): string {
    const stat = fs.statSync(options.dbPath);
    return `${stat.dev}:${stat.ino}:${stat.birthtimeMs}`;
  }

  function schemaStamp(connection: SqliteDatabase): string {
    return `${connection.pragma("schema_version", { simple: true })}:${connection.pragma("user_version", { simple: true })}`;
  }

  function verifyBoundDb(): void {
    if (!boundDb || !boundDbIdentity) throw new Error("Event database is unavailable");
    if (pathIdentity() !== boundDbIdentity || schemaStamp(boundDb) !== boundSchemaStamp) {
      // A changed file or schema cannot establish event-history continuity.
      workspaceChanged = true;
      throw new Error("Event database identity changed");
    }
  }

  function getDb(): SqliteDatabase | null {
    if (boundDb) {
      // Keep the accepted handle across read failures: reopening could bind a
      // replacement file to a stale pre-open pathname stat.
      verifyBoundDb();
      return boundDb;
    }
    if (!databaseExists(options.dbPath)) return null;
    const connection = retainedDb.open();
    const identity = retainedDb.identity();
    const stamp = schemaStamp(connection);
    // Path checks cannot identify an A → B → A swap during the SQLite open.
    // Database replacement and restore require a stopped runtime.
    if (
      pathIdentity() !== identity
      || connection.pragma("user_version", { simple: true }) !== SUPPORTED_SCHEMA_VERSION
      || !hasExactV15SchemaManifest(connection)
      || schemaStamp(connection) !== stamp
      || pathIdentity() !== identity
    ) {
      throw new Error("Event database changed while opening");
    }
    boundDbIdentity = identity;
    boundSchemaStamp = stamp;
    boundDb = connection;
    return connection;
  }

  function maxEventId(connection: SqliteDatabase, tenantId: string): number {
    const row = connection
      .prepare(
        "SELECT COALESCE(MAX(event_id), 0) AS max_id FROM job_events "
          + "WHERE tenant_id = ?",
      )
      .get(tenantId) as { max_id: number | bigint | string } | undefined;
    return row ? Number(row.max_id) : 0;
  }

  function tailEvents(connection: SqliteDatabase, tenantId: string, after: number): EventRow[] {
    return connection
      .prepare(
        "SELECT event_id, tenant_id, job_id, stage, event_type, level, message, payload_json, occurred_at "
          + "FROM job_events "
          + "WHERE event_id > ? "
          + "  AND tenant_id = ? "
          + "ORDER BY event_id ASC LIMIT ?",
      )
      .all(after, tenantId, EVENT_BATCH_LIMIT) as EventRow[];
  }

  function poll(): void {
    if (subscribers.size === 0 || workspaceChanged || (unavailable && Date.now() < nextRetryAt)) {
      return;
    }
    try {
      const connection = getDb();
      if (!connection) {
        if (unavailable) nextRetryAt = Date.now() + databaseRetryIntervalMs;
        return;
      }
      const minCursorByTenant = new Map<string, number>();
      for (const sub of subscribers.values()) {
        const previous = minCursorByTenant.get(sub.tenantId);
        if (previous === undefined || sub.cursor < previous) {
          minCursorByTenant.set(sub.tenantId, sub.cursor);
        }
      }

      for (const [tenantId, minCursor] of minCursorByTenant) {
        const rows = tailEvents(connection, tenantId, minCursor);
        // Discard a batch if its post-read path or schema differs from the bound snapshot.
        verifyBoundDb();
        for (const sub of subscribers.values()) {
          if (sub.tenantId !== tenantId) continue;
          for (const row of rows) {
            if (row.event_id <= sub.cursor) continue;
            writeEventRow(sub.reply, row);
            sub.cursor = row.event_id;
          }
        }
      }
      if (unavailable) {
        verifyBoundDb();
        unavailable = false;
        app.log.info("Event stream database recovered");
        for (const sub of subscribers.values()) writeHeartbeat(sub.reply, sub.cursor);
      }
    } catch {
      markUnavailable();
    }
  }

  function markUnavailable(): void {
    if (workspaceChanged || !boundDb) closeDb();
    if (workspaceChanged) {
      // Recovery must be offline: an old cursor cannot be applied to a new history.
      unavailable = true;
      stopPolling();
      app.log.warn("Event stream database identity changed; stopped runtime recovery required");
      for (const sub of subscribers.values()) writeUnavailable(sub.reply, "event_stream_workspace_changed");
      return;
    }
    nextRetryAt = Date.now() + databaseRetryIntervalMs;
    if (unavailable) return;
    unavailable = true;
    // Never include the exception: SQLite errors can contain local paths or data.
    app.log.warn("Event stream unavailable; retrying database access");
    for (const sub of subscribers.values()) writeUnavailable(sub.reply, "event_stream_unavailable");
  }

  function startPolling(): void {
    if (pollHandle !== null || workspaceChanged) {
      return;
    }
    pollHandle = setInterval(poll, pollIntervalMs);
    // Don't keep the Node event loop alive for SSE polling alone — the
    // Fastify server is the lifecycle anchor.
    pollHandle.unref?.();
  }

  function stopPolling(): void {
    if (pollHandle === null) {
      return;
    }
    clearInterval(pollHandle);
    pollHandle = null;
  }

  function closeDb(): void {
    try {
      retainedDb.close();
    } catch {
      // best-effort
    }
    boundDb = null;
  }

  function detach(sub: Subscriber): void {
    if (!subscribers.has(sub.id)) {
      return;
    }
    clearInterval(sub.keepaliveTimer);
    clearInterval(sub.heartbeatTimer);
    subscribers.delete(sub.id);
    if (subscribers.size === 0) {
      stopPolling();
    }
  }

  // SSE replies are hijacked and otherwise keep the HTTP server open. End
  // them before Fastify waits for outstanding connections during shutdown.
  app.addHook("preClose", async () => {
    stopPolling();
    for (const sub of subscribers.values()) {
      clearInterval(sub.keepaliveTimer);
      clearInterval(sub.heartbeatTimer);
      try {
        sub.reply.raw.end();
      } catch {
        // best-effort
      }
    }
    subscribers.clear();
  });
  app.addHook("onClose", async () => { closeDb(); });

  app.get("/v1/events/stream", async (request, reply) => {
    const tenantId = resolveTenantId(request);
    const requestedResume = parseResumePosition(request);
    const corsOrigin = resolveLoopbackCorsOrigin(request.headers.origin);
    const headers: Record<string, string> = {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      "X-Accel-Buffering": "no",
      Connection: "keep-alive",
    };
    if (corsOrigin) {
      headers["Access-Control-Allow-Origin"] = corsOrigin;
      headers.Vary = "Origin";
    }

    reply.hijack();
    reply.raw.writeHead(200, headers);
    reply.raw.write(`retry: ${RETRY_BASELINE_MS}\n\n`);

    let cursor = requestedResume;
    if (cursor === null) {
      try {
        const shouldAttempt = !workspaceChanged && (!unavailable || Date.now() >= nextRetryAt);
        const connection = shouldAttempt ? getDb() : null;
        if (shouldAttempt && !connection && unavailable) nextRetryAt = Date.now() + databaseRetryIntervalMs;
        if (connection) {
          cursor = maxEventId(connection, tenantId);
          verifyBoundDb();
        } else {
          cursor = 0;
        }
      } catch {
        markUnavailable();
        cursor = 0;
      }
    }

    const id = Symbol("sse-subscriber");
    const sub: Subscriber = {
      id,
      tenantId,
      reply,
      cursor,
      keepaliveTimer: setInterval(() => {
        writeRaw(reply, ": keepalive\n\n");
      }, keepaliveIntervalMs),
      heartbeatTimer: setInterval(() => {
        if (unavailable) return;
        try {
          if (boundDb) verifyBoundDb();
          writeHeartbeat(reply, sub.cursor);
        } catch {
          markUnavailable();
        }
      }, heartbeatIntervalMs),
    };
    sub.keepaliveTimer.unref?.();
    sub.heartbeatTimer.unref?.();
    subscribers.set(id, sub);
    if (unavailable) writeUnavailable(reply, workspaceChanged ? "event_stream_workspace_changed" : "event_stream_unavailable");
    startPolling();

    request.raw.on("close", () => detach(sub));
    request.raw.on("error", () => detach(sub));
  });
}

function resolveTenantId(request: FastifyRequest): string {
  // Local-mode contract (target §7.8): the tenant resolves to
  // LOCAL_TENANT regardless of the query string.  Hosted-mode wiring
  // will read the tenant from the JWT and reject mismatched query
  // values; that swap is named in target §9.4 and out of scope here.
  const query = request.query as Record<string, unknown> | undefined;
  const requested = typeof query?.tenantId === "string" ? query.tenantId.trim() : "";
  return requested.length > 0 && requested === LOCAL_TENANT ? requested : LOCAL_TENANT;
}

function parseResumePosition(request: FastifyRequest): number | null {
  const headerValue = request.headers["last-event-id"];
  const headerString = Array.isArray(headerValue) ? headerValue[0] : headerValue;
  const fromHeader = parseNonNegativeInt(headerString);
  if (fromHeader !== null) {
    return fromHeader;
  }
  const query = request.query as Record<string, unknown> | undefined;
  const sinceRaw = typeof query?.since === "string" ? query.since : undefined;
  return parseNonNegativeInt(sinceRaw);
}

function parseNonNegativeInt(value: string | undefined): number | null {
  if (value === undefined) {
    return null;
  }
  const trimmed = value.trim();
  if (trimmed.length === 0) {
    return null;
  }
  const parsed = Number.parseInt(trimmed, 10);
  if (!Number.isFinite(parsed) || parsed < 0) {
    return null;
  }
  return parsed;
}

function parseEnvInt(raw: string | undefined, fallback: number): number {
  if (raw === undefined) {
    return fallback;
  }
  const parsed = Number.parseInt(raw.trim(), 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function clampPositive(value: number): number {
  return value > 0 ? value : POLL_DEFAULT_MS;
}

function writeEventRow(reply: FastifyReply, row: EventRow): void {
  const eventType = row.event_type ?? "";
  if (eventType.length === 0) {
    return;
  }
  const envelope = canonicalSseEnvelope(row);
  if (envelope === null) {
    return;
  }
  const timeline = applyTimelineEnvelope(row, envelope);
  if (timeline) {
    // Keep the original cursor until the original frame is dispatched. A
    // disconnect between frames replays this summary rather than skipping it.
    writeRaw(reply, `event: ApplyRunEventRecorded\n${formatDataField(JSON.stringify(timeline))}\n\n`);
  }
  const dataLine = formatDataField(JSON.stringify(envelope));
  writeRaw(
    reply,
    `id: ${row.event_id}\nevent: ${eventType}\n${dataLine}\n\n`,
  );
}

function canonicalSseEnvelope(row: EventRow): Record<string, unknown> | null {
  let payload: unknown;
  try {
    payload = JSON.parse(row.payload_json ?? "{}");
  } catch {
    return null;
  }
  if (!isRecord(payload)) {
    return null;
  }
  // Historical rows retain private previews for canonical Apply Review.
  // Replay emits references only, including legacy wrapped publisher events.
  payload = applyEventReferences(row.event_type, payload);
  if (!isRecord(payload)) return null;
  if (row.event_type === "OfferRecordChanged") {
    payload = offerEventReferences(payload);
    if (!isRecord(payload)) return null;
  }
  if (
    row.event_type === "CompanyBriefingRecorded" ||
    row.event_type === "CareerLearningRecorded" ||
    row.event_type === "ArchivedSmartPostingPrepared" ||
    row.event_type === "PostingSnapshotStatePersisted" ||
    row.event_type === "LegacyEvidenceReviewRecorded"
  ) return null;
  if (row.event_type === "ScreeningAnswerRecorded") {
    payload = screeningEventReferences(payload);
    if (!isRecord(payload)) return null;
  }
  const legacyJobAliases = ["jobKey", "job_key", "jobUrl", "job_url", "job_id"];
  if (legacyJobAliases.some((key) => Object.hasOwn(payload, key))) {
    return null;
  }
  if (Object.hasOwn(payload, "occurred_at")) {
    return null;
  }
  if (payload.tenantId !== undefined && payload.tenantId !== row.tenant_id) {
    return null;
  }
  if (row.job_id === null) {
    if (Object.hasOwn(payload, "jobId")) {
      return null;
    }
    return {
      tenantId: row.tenant_id,
      occurredAt: row.occurred_at,
      payload: { ...payload, tenantId: row.tenant_id },
    };
  }
  if (payload.jobId !== undefined && payload.jobId !== row.job_id) {
    return null;
  }
  return {
    tenantId: row.tenant_id,
    jobId: row.job_id,
    occurredAt: row.occurred_at,
    payload: { ...payload, tenantId: row.tenant_id, jobId: row.job_id },
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function writeUnavailable(reply: FastifyReply, code: "event_stream_unavailable" | "event_stream_workspace_changed"): void {
  // An empty id resets the EventSource cursor before a changed workspace can restart.
  const resetCursor = code === "event_stream_workspace_changed" ? "id:\n" : "";
  writeRaw(reply, `${resetCursor}event: error\ndata: {"code":"${code}"}\n\n`);
}

function writeHeartbeat(reply: FastifyReply, watermark: number): void {
  const data = JSON.stringify({ watermark });
  writeRaw(reply, `event: heartbeat\ndata: ${data}\n\n`);
}

function formatDataField(payload: string): string {
  // SSE splits the data field on raw newlines.  payload_json is
  // produced by JSON.stringify() upstream, which encodes embedded
  // newlines as `\\n` literals — so a single `data:` line is correct.
  // We split defensively in case a future writer inserts raw newlines.
  if (!payload.includes("\n")) {
    return `data: ${payload}`;
  }
  return payload
    .split("\n")
    .map((line) => `data: ${line}`)
    .join("\n");
}

function writeRaw(reply: FastifyReply, chunk: string): void {
  try {
    reply.raw.write(chunk);
  } catch {
    // Subscriber is detached on the request 'close' handler.
  }
}
