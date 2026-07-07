import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";

import { LOCAL_TENANT } from "@jobctrl/domain-types";

import { databaseExists, openDatabase, type SqliteDatabase } from "./db.js";
import { resolveLoopbackCorsOrigin } from "./local-origin.js";

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
}

interface EventRow {
  readonly event_id: number;
  readonly event_type: string | null;
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

  const subscribers = new Map<symbol, Subscriber>();
  let db: SqliteDatabase | null = null;
  let indexEnsured = false;
  let pollHandle: NodeJS.Timeout | null = null;

  function getDb(): SqliteDatabase | null {
    if (db) {
      return db;
    }
    if (!databaseExists(options.dbPath)) {
      return null;
    }
    db = openDatabase(options.dbPath);
    return db;
  }

  function ensureIndex(connection: SqliteDatabase): void {
    if (indexEnsured) {
      return;
    }
    try {
      // The `job_events` table is created by the Python worker
      // (`workers/automation/src/jobctrl/database.py`); the API may
      // start before any worker run materialises it.  The CREATE INDEX
      // requires the base table — we swallow the error and retry on
      // the next subscriber connect so the SSE route still serves
      // keepalive/heartbeat traffic until the worker bootstraps.
      connection.exec(
        "CREATE INDEX IF NOT EXISTS idx_job_events_tenant_eid "
          + "ON job_events(COALESCE(JSON_EXTRACT(payload_json, '$.tenantId'), 'local'), event_id)",
      );
      indexEnsured = true;
    } catch {
      indexEnsured = false;
    }
  }

  function maxEventId(connection: SqliteDatabase, tenantId: string): number {
    try {
      const row = connection
        .prepare(
          "SELECT COALESCE(MAX(event_id), 0) AS max_id FROM job_events "
            + "WHERE COALESCE(JSON_EXTRACT(payload_json, '$.tenantId'), 'local') = ?",
        )
        .get(tenantId) as { max_id: number | bigint | string } | undefined;
      return row ? Number(row.max_id) : 0;
    } catch {
      return 0;
    }
  }

  function tailEvents(connection: SqliteDatabase, tenantId: string, after: number): EventRow[] {
    try {
      return connection
        .prepare(
          "SELECT event_id, event_type, payload_json, occurred_at "
            + "FROM job_events "
            + "WHERE event_id > ? "
            + "  AND COALESCE(JSON_EXTRACT(payload_json, '$.tenantId'), 'local') = ? "
            + "ORDER BY event_id ASC LIMIT ?",
        )
        .all(after, tenantId, EVENT_BATCH_LIMIT) as EventRow[];
    } catch {
      return [];
    }
  }

  function poll(): void {
    if (subscribers.size === 0) {
      return;
    }
    const connection = getDb();
    if (!connection) {
      return;
    }
    ensureIndex(connection);

    const minCursorByTenant = new Map<string, number>();
    for (const sub of subscribers.values()) {
      const previous = minCursorByTenant.get(sub.tenantId);
      if (previous === undefined || sub.cursor < previous) {
        minCursorByTenant.set(sub.tenantId, sub.cursor);
      }
    }

    for (const [tenantId, minCursor] of minCursorByTenant) {
      const rows = tailEvents(connection, tenantId, minCursor);
      if (rows.length === 0) {
        continue;
      }
      for (const sub of subscribers.values()) {
        if (sub.tenantId !== tenantId) {
          continue;
        }
        for (const row of rows) {
          if (row.event_id <= sub.cursor) {
            continue;
          }
          writeEventRow(sub.reply, row);
          sub.cursor = row.event_id;
        }
      }
    }
  }

  function startPolling(): void {
    if (pollHandle !== null) {
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
    if (!db) {
      return;
    }
    try {
      db.close();
    } catch {
      // best-effort
    }
    db = null;
    indexEnsured = false;
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

  app.addHook("onClose", async () => {
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
    closeDb();
  });

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

    const connection = getDb();
    let cursor = requestedResume;
    if (cursor === null && connection) {
      ensureIndex(connection);
      cursor = maxEventId(connection, tenantId);
    } else if (cursor === null) {
      cursor = 0;
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
        writeHeartbeat(reply, sub.cursor);
      }, heartbeatIntervalMs),
    };
    sub.keepaliveTimer.unref?.();
    sub.heartbeatTimer.unref?.();
    subscribers.set(id, sub);
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
  const dataLine = formatDataField(row.payload_json ?? "{}");
  writeRaw(
    reply,
    `id: ${row.event_id}\nevent: ${eventType}\n${dataLine}\n\n`,
  );
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
