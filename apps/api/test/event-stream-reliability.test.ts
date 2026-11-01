import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createConnection } from "node:net";
import { Writable } from "node:stream";
import Database from "better-sqlite3";
import { EventSource } from "eventsource";
import Fastify, { type FastifyRequest } from "fastify";
import { afterEach, expect, it, vi } from "vitest";
import { openDatabase, openReadOnlyDatabase } from "../src/db.js";
import { registerEventStreamRoute } from "../src/event-stream.js";
import { initializeExactDatabase } from "./exact-schema.js";

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function waitFor(assertion: () => void, timeoutMs = 3_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try { assertion(); return; } catch { await sleep(10); }
  }
  assertion();
}

async function openStream(url: string, headers?: Record<string, string>) {
  const controller = new AbortController();
  const response = await fetch(url, { ...(headers ? { headers } : {}), signal: controller.signal });
  expect(response.status).toBe(200);
  const reader = response.body!.getReader();
  let received = "";
  const pump = (async () => {
    try {
      const decoder = new TextDecoder();
      for (;;) {
        const next = await reader.read();
        if (next.done) break;
        received += decoder.decode(next.value, { stream: true });
      }
    } catch (error) {
      if (!controller.signal.aborted) throw error;
    }
  })();
  return {
    text: () => received,
    async close() { controller.abort(); await pump; },
  };
}

function insertEvent(db: Database.Database, id: number, tenant: string, marker: string): void {
  db.prepare(`INSERT INTO job_events (
    event_id, tenant_id, job_id, identity_version, stage, event_type, level, message, occurred_at, payload_json
  ) VALUES (?, ?, NULL, 1, NULL, 'ProfileUpdated', 'info', NULL, ?, ?)`)
    .run(id, tenant, "2026-10-28T12:00:00Z", JSON.stringify({ tenantId: tenant, marker }));
}

function makeValidDatabase(dbPath: string): void {
  initializeExactDatabase(dbPath);
  const db = new Database(dbPath);
  try {
    insertEvent(db, 1, "local", "before-cursor");
    insertEvent(db, 2, "other", "foreign-tenant-canary");
    insertEvent(db, 3, "local", "after-cursor");
    insertEvent(db, 4, "local", "after-second-cursor");
  } finally { db.close(); }
}

function descriptorsFor(dbPath: string): number {
  const target = fs.statSync(dbPath);
  let count = 0;
  for (let fd = 3; fd < 1024; fd++) {
    try {
      const stat = fs.fstatSync(fd);
      if (stat.dev === target.dev && stat.ino === target.ino) count++;
    } catch { /* closed descriptor */ }
  }
  return count;
}

const directories: string[] = [];
function workspace(): { dir: string; dbPath: string } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "jobctrl-sse-reliability-"));
  directories.push(dir);
  return { dir, dbPath: path.join(dir, "workspace.db") };
}

afterEach(() => {
  vi.restoreAllMocks();
  for (const dir of directories.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

it.each(["incompatible", "corrupt", "open-failing"] as const)(
  "keeps active streams bounded and recovers cursors after an absent database becomes %s",
  async (kind) => {
    const { dir, dbPath } = workspace();
    let logs = "";
    const logStream = new Writable({ write(chunk, _encoding, done) { logs += String(chunk); done(); } });
    const app = Fastify({ logger: { stream: logStream } });
    app.get("/health", async () => ({ ok: true }));
    registerEventStreamRoute(app, {
      dbPath, pollIntervalMs: 10, databaseRetryIntervalMs: 60,
      heartbeatIntervalMs: 30, keepaliveIntervalMs: 30,
    });
    const streams: Array<Awaited<ReturnType<typeof openStream>>> = [];
    try {
      await app.listen({ host: "127.0.0.1", port: 0 });
      const address = app.server.address();
      if (!address || typeof address === "string") throw new Error("no listener");
      const base = `http://127.0.0.1:${address.port}`;
      const first = await openStream(`${base}/v1/events/stream?since=1`);
      streams.push(first);
      await waitFor(() => expect(first.text()).toContain("event: heartbeat"));
      expect(first.text()).not.toContain("event: error");

      if (kind === "incompatible") {
        const db = new Database(dbPath);
        db.pragma("user_version = 1");
        db.close();
      } else if (kind === "corrupt") {
        fs.writeFileSync(dbPath, "synthetic-private-canary".repeat(200));
      } else {
        fs.writeFileSync(dbPath, "synthetic-private-canary".repeat(200));
        fs.chmodSync(dbPath, 0);
        expect(() => openDatabase(dbPath)).toThrow();
      }

      await waitFor(() => expect(first.text()).toContain('event: error\ndata: {"code":"event_stream_unavailable"}'));
      const second = await openStream(`${base}/v1/events/stream?since=0`, { "Last-Event-ID": "3" });
      streams.push(second);
      await waitFor(() => expect(second.text()).toContain("event: error"));
      await sleep(220); // Exercise several real retry callbacks and heartbeat deadlines.
      const afterError = first.text().split("event: error")[1];
      expect(afterError).not.toContain("event: heartbeat");
      expect(first.text().match(/event: error/g)).toHaveLength(1);
      expect(second.text().match(/event: error/g)).toHaveLength(1);
      expect(first.text()).not.toContain('id:\nevent: error');
      expect(second.text()).not.toContain('id:\nevent: error');
      expect((await fetch(`${base}/health`)).status).toBe(200);
      expect(logs).not.toContain("synthetic-private-canary");
      expect(logs).not.toContain(dbPath);
      expect(descriptorsFor(dbPath)).toBe(0);
      expect(first.text()).not.toContain("synthetic-private-canary");
      expect(second.text()).not.toContain("synthetic-private-canary");

      const replacement = path.join(dir, "replacement.db");
      makeValidDatabase(replacement);
      fs.renameSync(replacement, dbPath);
      await waitFor(() => expect(first.text()).toContain("after-second-cursor"));
      await waitFor(() => expect(second.text()).toContain("after-second-cursor"));
      expect(first.text()).toContain("after-cursor");
      expect(first.text()).not.toContain("before-cursor");
      expect(first.text()).not.toContain("foreign-tenant-canary");
      expect(second.text()).not.toContain("after-cursor");
      expect(second.text()).not.toContain("foreign-tenant-canary");
      expect(first.text().split("event: error")[1]).toContain("event: heartbeat");
      expect(second.text().split("event: error")[1]).toContain('"watermark":4');
      expect(first.text().match(/event: ProfileUpdated/g)).toHaveLength(2);
      expect(second.text().match(/event: ProfileUpdated/g)).toHaveLength(1);
    } finally {
      await Promise.all(streams.map((stream) => stream.close()));
      await app.close();
    }
  },
);

it("signals failure to a new no-cursor subscriber and resumes after restoration", async () => {
  const { dir, dbPath } = workspace();
  const invalid = new Database(dbPath);
  invalid.pragma("user_version = 1");
  invalid.close();
  const app = Fastify();
  registerEventStreamRoute(app, { dbPath, pollIntervalMs: 10, databaseRetryIntervalMs: 60, heartbeatIntervalMs: 30 });
  let stream: Awaited<ReturnType<typeof openStream>> | undefined;
  try {
    await app.listen({ host: "127.0.0.1", port: 0 });
    const address = app.server.address();
    if (!address || typeof address === "string") throw new Error("no listener");
    stream = await openStream(`http://127.0.0.1:${address.port}/v1/events/stream`);
    await waitFor(() => expect(stream!.text()).toContain("event: error"));
    const replacement = path.join(dir, "replacement.db");
    makeValidDatabase(replacement);
    fs.renameSync(replacement, dbPath);
    await waitFor(() => expect(stream!.text()).toContain("after-second-cursor"));
    expect(stream.text()).toContain("before-cursor");
    expect(stream.text()).not.toContain("foreign-tenant-canary");
  } finally {
    await stream?.close();
    await app.close();
  }
});

it("preserves the healthy tail and requires a fresh subscription after stopped recovery", async () => {
  const { dir, dbPath } = workspace();
  makeValidDatabase(dbPath);
  const app = Fastify();
  registerEventStreamRoute(app, { dbPath, pollIntervalMs: 10, databaseRetryIntervalMs: 60, heartbeatIntervalMs: 30 });
  let restarted: ReturnType<typeof Fastify> | undefined;
  let stream: Awaited<ReturnType<typeof openStream>> | undefined;
  let fresh: Awaited<ReturnType<typeof openStream>> | undefined;
  try {
    await app.listen({ host: "127.0.0.1", port: 0 });
    const address = app.server.address();
    if (!address || typeof address === "string") throw new Error("no listener");
    stream = await openStream(`http://127.0.0.1:${address.port}/v1/events/stream`);
    await waitFor(() => expect(stream!.text()).toContain('"watermark":4'));
    expect(stream.text()).not.toContain("before-cursor");
    expect(stream.text()).not.toContain("after-cursor");
    const writer = new Database(dbPath);
    insertEvent(writer, 5, "local", "after-healthy-tail");
    writer.close();
    await waitFor(() => expect(stream!.text()).toContain("after-healthy-tail"));
    const invalidPath = path.join(dir, "incompatible.db");
    const invalid = new Database(invalidPath);
    invalid.pragma("user_version = 1");
    invalid.close();
    fs.renameSync(invalidPath, dbPath);
    await waitFor(() => expect(stream!.text()).toContain('"code":"event_stream_workspace_changed"'));
    const replacement = path.join(dir, "replacement.db");
    makeValidDatabase(replacement);
    const replacementWriter = new Database(replacement);
    insertEvent(replacementWriter, 5, "local", "after-healthy-tail");
    insertEvent(replacementWriter, 6, "local", "different-history");
    replacementWriter.close();
    fs.renameSync(replacement, dbPath);
    const unchangedBytes = fs.readFileSync(dbPath);
    await waitFor(() => expect(stream!.text()).toContain('"code":"event_stream_workspace_changed"'));
    const afterChange = stream.text().split('"code":"event_stream_workspace_changed"')[1]!;
    await sleep(150);
    expect(stream.text()).not.toContain("different-history");
    expect(stream.text().split('"code":"event_stream_workspace_changed"')[1]).not.toContain("event: heartbeat");
    expect(afterChange).not.toContain("event: heartbeat");
    expect(fs.readFileSync(dbPath)).toEqual(unchangedBytes);

    await stream.close();
    stream = undefined;
    await app.close();
    restarted = Fastify();
    registerEventStreamRoute(restarted, { dbPath, pollIntervalMs: 10, heartbeatIntervalMs: 30 });
    await restarted.listen({ host: "127.0.0.1", port: 0 });
    const freshAddress = restarted.server.address();
    if (!freshAddress || typeof freshAddress === "string") throw new Error("no listener");
    fresh = await openStream(`http://127.0.0.1:${freshAddress.port}/v1/events/stream`);
    await waitFor(() => expect(fresh!.text()).toContain('"watermark":6'));
    expect(fresh.text()).not.toContain("different-history");
    const freshWriter = new Database(dbPath);
    insertEvent(freshWriter, 7, "local", "fresh-subscription-event");
    freshWriter.close();
    await waitFor(() => expect(fresh!.text()).toContain("fresh-subscription-event"));
    expect(fresh.text()).not.toContain("foreign-tenant-canary");
  } finally {
    await stream?.close();
    await fresh?.close();
    await app.close();
    await restarted?.close();
  }
});

it("stops retrying when the last subscriber disconnects", async () => {
  const { dbPath } = workspace();
  const invalid = new Database(dbPath);
  invalid.pragma("user_version = 1");
  invalid.close();
  const app = Fastify();
  registerEventStreamRoute(app, { dbPath, pollIntervalMs: 10, databaseRetryIntervalMs: 40 });
  const pragma = vi.spyOn(Database.prototype, "pragma");
  let stream: Awaited<ReturnType<typeof openStream>> | undefined;
  try {
    await app.listen({ host: "127.0.0.1", port: 0 });
    const address = app.server.address();
    if (!address || typeof address === "string") throw new Error("no listener");
    stream = await openStream(`http://127.0.0.1:${address.port}/v1/events/stream?since=0`);
    await waitFor(() => expect(pragma.mock.calls.length).toBeGreaterThanOrEqual(3));
    await stream.close();
    stream = undefined;
    await sleep(60); // Allow the HTTP close event to reach the server.
    const attempts = pragma.mock.calls.length;
    await sleep(160);
    expect(pragma.mock.calls.length).toBe(attempts);
  } finally {
    await stream?.close();
    await app.close();
  }
});

it("closes both database kinds after repeated corrupt-schema validation failures", () => {
  const { dbPath } = workspace();
  fs.writeFileSync(dbPath, "synthetic-private-canary".repeat(200));
  expect(descriptorsFor(dbPath)).toBe(0);
  for (let i = 0; i < 20; i++) {
    expect(() => openDatabase(dbPath)).toThrow();
    expect(() => openReadOnlyDatabase(dbPath)).toThrow();
  }
  expect(descriptorsFor(dbPath)).toBe(0);
});

it("reports a timer query failure and resumes the live cursor on the same stream", async () => {
  const { dbPath } = workspace();
  makeValidDatabase(dbPath);
  const app = Fastify();
  registerEventStreamRoute(app, { dbPath, pollIntervalMs: 10, databaseRetryIntervalMs: 60, heartbeatIntervalMs: 30 });
  let stream: Awaited<ReturnType<typeof openStream>> | undefined;
  try {
    await app.listen({ host: "127.0.0.1", port: 0 });
    const address = app.server.address();
    if (!address || typeof address === "string") throw new Error("no listener");
    stream = await openStream(`http://127.0.0.1:${address.port}/v1/events/stream?since=3`);
    await waitFor(() => expect(stream!.text()).toContain("after-second-cursor"));
    const prepare = Database.prototype.prepare;
    const failing = vi.spyOn(Database.prototype, "prepare").mockImplementation(function (this: Database.Database, sql: string) {
      if (sql.startsWith("SELECT event_id, tenant_id")) throw new Error("sensitive query failure");
      return prepare.call(this, sql);
    } as typeof prepare);
    await waitFor(() => expect(stream!.text()).toContain("event: error"));
    failing.mockRestore();
    const db = new Database(dbPath);
    insertEvent(db, 5, "local", "after-query-recovery");
    db.close();
    await waitFor(() => expect(stream!.text()).toContain("after-query-recovery"));
    await waitFor(() => expect(stream!.text().split("event: error")[1]).toContain("event: heartbeat"));
    expect(stream.text().match(/after-second-cursor/g)).toHaveLength(1);
    expect(stream.text()).not.toContain("sensitive query failure");
    expect(stream.text()).not.toContain("foreign-tenant-canary");
  } finally {
    await stream?.close();
    await app.close();
  }
});

it("keeps the full API subprocess alive and recovers the actual SSE route", async () => {
  const { dir, dbPath } = workspace();
  const source = `
    import { buildApp } from './src/server.ts';
    import path from 'node:path';
    const dir = process.env.SSE_QA_DIR;
    const app = buildApp({dbPath:path.join(dir,'workspace.db'), appDir:dir,
      configPath:path.join(dir,'config.json'), runtimeEnvironment:{}});
    await app.listen({host:'127.0.0.1', port:0});
    console.log('PORT=' + app.server.address().port);
    process.stdin.once('data', async () => { process.stdin.pause(); await app.close(); });
  `;
  const child: ChildProcessWithoutNullStreams = spawn(process.execPath, ["--import", "tsx", "--input-type=module", "-e", source], {
    cwd: path.resolve(import.meta.dirname, ".."),
    env: { ...process.env, SSE_QA_DIR: dir, JOBCTRL_API_SSE_POLL_MS: "20" },
    stdio: "pipe",
  });
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (chunk) => { stdout += String(chunk); });
  child.stderr.on("data", (chunk) => { stderr += String(chunk); });
  let stream: Awaited<ReturnType<typeof openStream>> | undefined;
  try {
    await waitFor(() => expect(stdout).toMatch(/PORT=\d+/), 8_000);
    const port = Number(stdout.match(/PORT=(\d+)/)![1]);
    stream = await openStream(`http://127.0.0.1:${port}/v1/events/stream?since=1`);
    const invalid = new Database(dbPath);
    invalid.pragma("user_version = 1");
    invalid.close();
    await waitFor(() => expect(stream!.text()).toContain("event: error"));
    expect(child.exitCode).toBeNull();
    const health = await fetch(`http://127.0.0.1:${port}/v1/health`);
    // The health route rejects the incompatible schema, but the API still responds.
    expect(health.status).toBe(500);
    const replacement = path.join(dir, "replacement.db");
    makeValidDatabase(replacement);
    fs.renameSync(replacement, dbPath);
    await waitFor(() => expect(stream!.text()).toContain("after-second-cursor"), 7_000);
    expect(stream.text()).not.toContain("before-cursor");
    expect(stream.text()).not.toContain("foreign-tenant-canary");
    expect((await fetch(`http://127.0.0.1:${port}/v1/health`)).status).toBe(200);
    child.stdin.end("stop\n");
    await waitFor(() => expect(child.exitCode).toBe(0), 4_000);
    const listenerResult = await new Promise<string>((resolve) => {
      const socket = createConnection({ host: "127.0.0.1", port });
      socket.once("connect", () => { socket.destroy(); resolve("connected"); });
      socket.once("error", (error: NodeJS.ErrnoException) => resolve(error.code ?? "error"));
      socket.setTimeout(1_000, () => { socket.destroy(); resolve("timeout"); });
    });
    expect(listenerResult).toBe("ECONNREFUSED");
    await stream.close();
    stream = undefined;
    expect(stderr).not.toContain("IncompatibleSchemaVersionError");
  } finally {
    await stream?.close();
    if (child.exitCode === null && child.signalCode === null) {
      child.kill("SIGKILL");
      await new Promise<void>((resolve) => child.once("exit", () => resolve()));
    }
  }
}, 20_000);

it.each(["lower", "higher"] as const)("keeps existing and new subscribers degraded when a valid replacement has %s event IDs", async (kind) => {
  const { dir, dbPath } = workspace();
  makeValidDatabase(dbPath);
  const app = Fastify();
  registerEventStreamRoute(app, { dbPath, pollIntervalMs: 10, databaseRetryIntervalMs: 60, heartbeatIntervalMs: 30 });
  const streams: Array<Awaited<ReturnType<typeof openStream>>> = [];
  try {
    await app.listen({ host: "127.0.0.1", port: 0 });
    const address = app.server.address();
    if (!address || typeof address === "string") throw new Error("no listener");
    const base = `http://127.0.0.1:${address.port}`;
    const existing = await openStream(`${base}/v1/events/stream`);
    streams.push(existing);
    await waitFor(() => expect(existing.text()).toContain('"watermark":4'));
    const beforeReplacement = existing.text().length;
    const replacement = path.join(dir, "different-history.db");
    initializeExactDatabase(replacement);
    const writer = new Database(replacement);
    insertEvent(writer, kind === "lower" ? 1 : 40, "local", "different-history-canary");
    writer.close();
    fs.renameSync(replacement, dbPath);
    await waitFor(() => expect(existing.text().slice(beforeReplacement)).toContain('"code":"event_stream_workspace_changed"'), 800);
    const newcomer = await openStream(`${base}/v1/events/stream?since=0`);
    streams.push(newcomer);
    await waitFor(() => expect(newcomer.text()).toContain('"code":"event_stream_workspace_changed"'));
    await sleep(150);
    expect(existing.text().match(/event_stream_workspace_changed/g)).toHaveLength(1);
    expect(newcomer.text().match(/event_stream_workspace_changed/g)).toHaveLength(1);
    expect(existing.text()).toContain('id:\nevent: error\ndata: {"code":"event_stream_workspace_changed"}');
    expect(newcomer.text()).toContain('id:\nevent: error\ndata: {"code":"event_stream_workspace_changed"}');
    expect(existing.text().slice(beforeReplacement)).not.toContain("event: heartbeat");
    expect(existing.text().slice(beforeReplacement)).not.toContain("different-history-canary");
    expect(newcomer.text()).not.toContain("different-history-canary");
    expect(newcomer.text()).not.toContain("event: heartbeat");
  } finally {
    await Promise.all(streams.map((stream) => stream.close()));
    await app.close();
  }
});

it("keeps retrying at the bounded cadence if an incompatible database disappears", async () => {
  const { dir, dbPath } = workspace();
  const invalid = new Database(dbPath);
  invalid.pragma("user_version = 1");
  invalid.close();
  const app = Fastify();
  registerEventStreamRoute(app, { dbPath, pollIntervalMs: 5, databaseRetryIntervalMs: 100, heartbeatIntervalMs: 30 });
  let stream: Awaited<ReturnType<typeof openStream>> | undefined;
  try {
    await app.listen({ host: "127.0.0.1", port: 0 });
    const address = app.server.address();
    if (!address || typeof address === "string") throw new Error("no listener");
    stream = await openStream(`http://127.0.0.1:${address.port}/v1/events/stream?since=0`);
    await waitFor(() => expect(stream!.text()).toContain("event: error"));
    fs.unlinkSync(dbPath);
    const exists = vi.spyOn(fs, "existsSync");
    await sleep(260);
    const attempts = exists.mock.calls.filter(([candidate]) => candidate === dbPath).length;
    expect(attempts).toBeGreaterThan(0);
    expect(attempts).toBeLessThanOrEqual(3);
    exists.mockRestore();
    const replacement = path.join(dir, "replacement.db");
    makeValidDatabase(replacement);
    fs.renameSync(replacement, dbPath);
    await waitFor(() => expect(stream!.text()).toContain("after-second-cursor"));
    expect(stream.text().split("event: error")[1]).toContain("event: heartbeat");
  } finally {
    await stream?.close();
    await app.close();
  }
});


it("clears the native reconnect cursor after a detected workspace change", async () => {
  const { dir, dbPath } = workspace();
  initializeExactDatabase(dbPath);
  const initial = new Database(dbPath);
  insertEvent(initial, 99, "local", "old-tail");
  initial.close();
  const firstApp = Fastify();
  registerEventStreamRoute(firstApp, { dbPath, pollIntervalMs: 10, heartbeatIntervalMs: 30 });
  let secondApp: ReturnType<typeof Fastify> | undefined;
  const sources: EventSource[] = [];
  try {
    await firstApp.listen({ host: "127.0.0.1", port: 0 });
    const address = firstApp.server.address();
    if (!address || typeof address === "string") throw new Error("no listener");
    const url = `http://127.0.0.1:${address.port}/v1/events/stream`;
    const first = new EventSource(url);
    sources.push(first);
    let opens = 0;
    let changed = false;
    const received: string[] = [];
    first.addEventListener("open", () => { opens++; });
    first.addEventListener("error", (event) => {
      const data = (event as MessageEvent).data;
      if (typeof data === "string" && data.includes("event_stream_workspace_changed")) changed = true;
    });
    first.addEventListener("ProfileUpdated", (event) => {
      received.push(JSON.parse((event as MessageEvent).data).payload.marker as string);
    });
    await waitFor(() => expect(opens).toBe(1));
    const oldWriter = new Database(dbPath);
    insertEvent(oldWriter, 100, "local", "old-event-100");
    oldWriter.close();
    await waitFor(() => expect(received).toContain("old-event-100"));

    const explicit = new EventSource(`${url}?since=100`);
    sources.push(explicit);
    let explicitOpens = 0;
    let explicitChanged = false;
    const explicitEvents: string[] = [];
    explicit.addEventListener("open", () => { explicitOpens++; });
    explicit.addEventListener("error", (event) => {
      const data = (event as MessageEvent).data;
      if (typeof data === "string" && data.includes("event_stream_workspace_changed")) explicitChanged = true;
    });
    explicit.addEventListener("ProfileUpdated", (event) => {
      explicitEvents.push(JSON.parse((event as MessageEvent).data).payload.marker as string);
    });
    await waitFor(() => expect(explicitOpens).toBe(1));
    const nextOldWriter = new Database(dbPath);
    insertEvent(nextOldWriter, 101, "local", "old-event-101");
    nextOldWriter.close();
    await waitFor(() => expect(explicitEvents).toContain("old-event-101"));
    await waitFor(() => expect(received).toContain("old-event-101"));

    const replacement = path.join(dir, "new-history.db");
    initializeExactDatabase(replacement);
    const replacementWriter = new Database(replacement);
    insertEvent(replacementWriter, 1, "local", "new-tail");
    replacementWriter.close();
    fs.renameSync(replacement, dbPath);
    await waitFor(() => expect(changed && explicitChanged).toBe(true));
    await firstApp.close();

    const requests: Array<{ since: string | null; lastEventId: string | undefined }> = [];
    secondApp = Fastify();
    secondApp.addHook("onRequest", async (request: FastifyRequest) => {
      requests.push({
        since: new URL(request.url, "http://127.0.0.1").searchParams.get("since"),
        lastEventId: request.headers["last-event-id"] as string | undefined,
      });
    });
    registerEventStreamRoute(secondApp, { dbPath, pollIntervalMs: 10, heartbeatIntervalMs: 30 });
    await secondApp.listen({ host: "127.0.0.1", port: address.port });
    await waitFor(() => expect(opens).toBe(2), 8_000);
    await waitFor(() => expect(explicitOpens).toBe(2), 8_000);
    expect(requests).toContainEqual({ since: null, lastEventId: undefined });
    expect(requests).toContainEqual({ since: "100", lastEventId: undefined });
    const newWriter = new Database(dbPath);
    insertEvent(newWriter, 2, "local", "new-event-2");
    newWriter.close();
    await waitFor(() => expect(received).toContain("new-event-2"));
    await sleep(150);
    expect(explicitEvents).not.toContain("new-event-2");

    // A caller-supplied URL cursor survives native reconnect and must be removed.
    explicit.close();
    const fresh = new EventSource(url);
    sources.push(fresh);
    let freshOpen = false;
    const freshEvents: string[] = [];
    fresh.addEventListener("open", () => { freshOpen = true; });
    fresh.addEventListener("ProfileUpdated", (event) => {
      freshEvents.push(JSON.parse((event as MessageEvent).data).payload.marker as string);
    });
    await waitFor(() => expect(freshOpen).toBe(true));
    const freshWriter = new Database(dbPath);
    insertEvent(freshWriter, 3, "local", "new-event-3");
    freshWriter.close();
    await waitFor(() => expect(freshEvents).toContain("new-event-3"));
  } finally {
    for (const source of sources) source.close();
    await firstApp.close();
    await secondApp?.close();
  }
}, 20_000);


it("preserves the native reconnect cursor across an ordinary same-database restart", async () => {
  const { dbPath } = workspace();
  initializeExactDatabase(dbPath);
  const initial = new Database(dbPath);
  insertEvent(initial, 99, "local", "old-tail");
  initial.close();
  const firstApp = Fastify();
  registerEventStreamRoute(firstApp, { dbPath, pollIntervalMs: 10 });
  let secondApp: ReturnType<typeof Fastify> | undefined;
  let source: EventSource | undefined;
  try {
    await firstApp.listen({ host: "127.0.0.1", port: 0 });
    const address = firstApp.server.address();
    if (!address || typeof address === "string") throw new Error("no listener");
    source = new EventSource(`http://127.0.0.1:${address.port}/v1/events/stream`);
    let opens = 0;
    const received: string[] = [];
    source.addEventListener("open", () => { opens++; });
    source.addEventListener("ProfileUpdated", (event) => {
      received.push(JSON.parse((event as MessageEvent).data).payload.marker as string);
    });
    await waitFor(() => expect(opens).toBe(1));
    const writer = new Database(dbPath);
    insertEvent(writer, 100, "local", "before-restart");
    writer.close();
    await waitFor(() => expect(received).toContain("before-restart"));
    await firstApp.close();
    let lastEventId: string | undefined;
    secondApp = Fastify();
    secondApp.addHook("onRequest", async (request: FastifyRequest) => {
      lastEventId = request.headers["last-event-id"] as string | undefined;
    });
    registerEventStreamRoute(secondApp, { dbPath, pollIntervalMs: 10 });
    await secondApp.listen({ host: "127.0.0.1", port: address.port });
    await waitFor(() => expect(opens).toBe(2), 8_000);
    expect(lastEventId).toBe("100");
    const next = new Database(dbPath);
    insertEvent(next, 101, "local", "after-restart");
    next.close();
    await waitFor(() => expect(received).toContain("after-restart"));
    expect(received.filter((value) => value === "before-restart")).toHaveLength(1);
  } finally {
    source?.close();
    await firstApp.close();
    await secondApp?.close();
  }
}, 15_000);

it("does not publish replacement history when the database changes between stat and open", async () => {
  const { dir, dbPath } = workspace();
  initializeExactDatabase(dbPath);
  const original = new Database(dbPath);
  insertEvent(original, 1, "local", "original-history");
  original.close();
  const replacement = path.join(dir, "replacement-race.db");
  initializeExactDatabase(replacement);
  const other = new Database(replacement);
  insertEvent(other, 2, "local", "replacement-history-canary");
  other.close();

  const app = Fastify();
  app.get("/health", async () => ({ ok: true }));
  registerEventStreamRoute(app, { dbPath, pollIntervalMs: 10, databaseRetryIntervalMs: 180, heartbeatIntervalMs: 30 });
  let stream: Awaited<ReturnType<typeof openStream>> | undefined;
  try {
    await app.listen({ host: "127.0.0.1", port: 0 });
    const address = app.server.address();
    if (!address || typeof address === "string") throw new Error("no listener");
    stream = await openStream(`http://127.0.0.1:${address.port}/v1/events/stream?since=0`);
    await waitFor(() => expect(stream!.text()).toContain("original-history"));
    const prepare = Database.prototype.prepare;
    const failure = vi.spyOn(Database.prototype, "prepare").mockImplementation(function (this: Database.Database, sql: string) {
      if (sql.startsWith("SELECT event_id, tenant_id")) throw new Error("synthetic query failure");
      return prepare.call(this, sql);
    } as typeof prepare);
    await waitFor(() => expect(stream!.text()).toContain('"code":"event_stream_unavailable"'));
    failure.mockRestore();
    const afterFailure = stream.text().length;
    const originalStat = fs.statSync;
    let switched = false;
    const stat = vi.spyOn(fs, "statSync").mockImplementation(((candidate: fs.PathLike, ...options: unknown[]) => {
      const result = originalStat.call(fs, candidate, ...options as []);
      if (candidate === dbPath && !switched) {
        switched = true;
        fs.renameSync(replacement, dbPath);
      }
      return result;
    }) as typeof fs.statSync);
    await waitFor(() => expect(stream!.text()).toContain('"code":"event_stream_workspace_changed"'));
    expect(switched).toBe(true);
    await sleep(150);
    const afterFailureFrames = stream.text().slice(afterFailure);
    expect(afterFailureFrames).not.toContain("replacement-history-canary");
    expect(afterFailureFrames).not.toContain("event: heartbeat");
    expect((await fetch(`http://127.0.0.1:${address.port}/health`)).status).toBe(200);
    stat.mockRestore();
    expect(descriptorsFor(dbPath)).toBe(0);
  } finally {
    await stream?.close();
    await app.close();
  }
});

it("refuses the first admission if the path changes while SQLite opens", async () => {
  const { dir, dbPath } = workspace();
  initializeExactDatabase(dbPath);
  const replacement = path.join(dir, "first-open-replacement.db");
  initializeExactDatabase(replacement);
  const writer = new Database(replacement);
  insertEvent(writer, 1, "local", "first-admitted-event");
  writer.close();
  const app = Fastify();
  registerEventStreamRoute(app, { dbPath, pollIntervalMs: 10, databaseRetryIntervalMs: 1000, heartbeatIntervalMs: 30 });
  let stream: Awaited<ReturnType<typeof openStream>> | undefined;
  try {
    await app.listen({ host: "127.0.0.1", port: 0 });
    const address = app.server.address();
    if (!address || typeof address === "string") throw new Error("no listener");
    const originalStat = fs.statSync;
    let switched = false;
    const stat = vi.spyOn(fs, "statSync").mockImplementation(((candidate: fs.PathLike, ...options: unknown[]) => {
      const result = originalStat.call(fs, candidate, ...options as []);
      if (candidate === dbPath && !switched) {
        switched = true;
        fs.renameSync(replacement, dbPath);
      }
      return result;
    }) as typeof fs.statSync);
    stream = await openStream(`http://127.0.0.1:${address.port}/v1/events/stream?since=0`);
    await waitFor(() => expect(stream!.text()).toContain('"code":"event_stream_unavailable"'));
    expect(switched).toBe(true);
    await sleep(100);
    expect(stream.text()).not.toContain("first-admitted-event");
    expect(stream.text()).not.toContain("event: heartbeat");
    stat.mockRestore();
    await waitFor(() => expect(stream!.text()).toContain("first-admitted-event"));
    await waitFor(() => expect(stream!.text()).toContain("event: heartbeat"));
  } finally {
    await stream?.close();
    await app.close();
  }
});

it("discards a batch when the path changes after the query but before publication", async () => {
  const { dir, dbPath } = workspace();
  initializeExactDatabase(dbPath);
  const seed = new Database(dbPath);
  insertEvent(seed, 1, "local", "original-history");
  seed.close();
  const replacement = path.join(dir, "post-query-replacement.db");
  initializeExactDatabase(replacement);
  const other = new Database(replacement);
  insertEvent(other, 3, "local", "replacement-history-canary");
  other.close();
  const app = Fastify();
  registerEventStreamRoute(app, { dbPath, pollIntervalMs: 10, heartbeatIntervalMs: 5000 });
  let stream: Awaited<ReturnType<typeof openStream>> | undefined;
  try {
    await app.listen({ host: "127.0.0.1", port: 0 });
    const address = app.server.address();
    if (!address || typeof address === "string") throw new Error("no listener");
    stream = await openStream(`http://127.0.0.1:${address.port}/v1/events/stream?since=0`);
    await waitFor(() => expect(stream!.text()).toContain("original-history"));
    const before = stream.text().length;
    const prepare = Database.prototype.prepare;
    let switched = false;
    const read = vi.spyOn(Database.prototype, "prepare").mockImplementation(function (this: Database.Database, sql: string) {
      const statement = prepare.call(this, sql);
      if (!switched && sql.startsWith("SELECT event_id, tenant_id")) {
        return { all(after: number, tenantId: string, limit: number) {
          const rows = statement.all([after, tenantId, limit]);
          switched = true;
          fs.renameSync(replacement, dbPath);
          return rows;
        } } as unknown as ReturnType<typeof prepare>;
      }
      return statement;
    } as typeof prepare);
    const writer = new Database(dbPath);
    insertEvent(writer, 2, "local", "unpublished-original-event");
    writer.close();
    await waitFor(() => expect(stream!.text()).toContain('"code":"event_stream_workspace_changed"'));
    expect(switched).toBe(true);
    await sleep(100);
    expect(stream.text().slice(before)).not.toContain("unpublished-original-event");
    expect(stream.text().slice(before)).not.toContain("replacement-history-canary");
    expect(stream.text().slice(before)).not.toContain("event: heartbeat");
    read.mockRestore();
  } finally {
    await stream?.close();
    await app.close();
  }
});

it("refuses an initial cursor snapshot if the database changes during the max-id read", async () => {
  const { dir, dbPath } = workspace();
  makeValidDatabase(dbPath);
  const replacement = path.join(dir, "max-id-replacement.db");
  initializeExactDatabase(replacement);
  const other = new Database(replacement);
  insertEvent(other, 1, "local", "replacement-history-canary");
  other.close();
  const app = Fastify();
  registerEventStreamRoute(app, { dbPath, pollIntervalMs: 10, heartbeatIntervalMs: 30 });
  let stream: Awaited<ReturnType<typeof openStream>> | undefined;
  try {
    await app.listen({ host: "127.0.0.1", port: 0 });
    const address = app.server.address();
    if (!address || typeof address === "string") throw new Error("no listener");
    const prepare = Database.prototype.prepare;
    let switched = false;
    const read = vi.spyOn(Database.prototype, "prepare").mockImplementation(function (this: Database.Database, sql: string) {
      const statement = prepare.call(this, sql);
      if (!switched && sql.startsWith("SELECT COALESCE(MAX(event_id)")) {
        return { get(tenantId: string) {
          const row = statement.get(tenantId);
          switched = true;
          fs.renameSync(replacement, dbPath);
          return row;
        } } as unknown as ReturnType<typeof prepare>;
      }
      return statement;
    } as typeof prepare);
    stream = await openStream(`http://127.0.0.1:${address.port}/v1/events/stream`);
    await waitFor(() => expect(stream!.text()).toContain('"code":"event_stream_workspace_changed"'));
    expect(switched).toBe(true);
    await sleep(100);
    expect(stream.text()).not.toContain("event: heartbeat");
    expect(stream.text()).not.toContain("replacement-history-canary");
    read.mockRestore();
  } finally {
    await stream?.close();
    await app.close();
  }
});

it("checks the bound database before an independent heartbeat", async () => {
  const { dir, dbPath } = workspace();
  makeValidDatabase(dbPath);
  const replacement = path.join(dir, "heartbeat-replacement.db");
  initializeExactDatabase(replacement);
  const app = Fastify();
  registerEventStreamRoute(app, { dbPath, pollIntervalMs: 5000, heartbeatIntervalMs: 30 });
  let stream: Awaited<ReturnType<typeof openStream>> | undefined;
  try {
    await app.listen({ host: "127.0.0.1", port: 0 });
    const address = app.server.address();
    if (!address || typeof address === "string") throw new Error("no listener");
    stream = await openStream(`http://127.0.0.1:${address.port}/v1/events/stream`);
    await waitFor(() => expect(stream!.text()).toContain('"watermark":4'));
    const before = stream.text().length;
    fs.renameSync(replacement, dbPath);
    await waitFor(() => expect(stream!.text()).toContain('"code":"event_stream_workspace_changed"'), 1000);
    await sleep(100);
    expect(stream.text().slice(before)).not.toContain("event: heartbeat");
  } finally {
    await stream?.close();
    await app.close();
  }
});

it("retains only one accepted connection across repeated read failures and closes it on shutdown", async () => {
  const { dbPath } = workspace();
  makeValidDatabase(dbPath);
  const app = Fastify();
  registerEventStreamRoute(app, { dbPath, pollIntervalMs: 10, databaseRetryIntervalMs: 40 });
  let stream: Awaited<ReturnType<typeof openStream>> | undefined;
  try {
    await app.listen({ host: "127.0.0.1", port: 0 });
    const address = app.server.address();
    if (!address || typeof address === "string") throw new Error("no listener");
    stream = await openStream(`http://127.0.0.1:${address.port}/v1/events/stream?since=3`);
    await waitFor(() => expect(stream!.text()).toContain("after-second-cursor"));
    const baseline = descriptorsFor(dbPath);
    expect(baseline).toBeGreaterThan(0);
    const prepare = Database.prototype.prepare;
    let failures = 0;
    const failing = vi.spyOn(Database.prototype, "prepare").mockImplementation(function (this: Database.Database, sql: string) {
      if (sql.startsWith("SELECT event_id, tenant_id")) {
        failures++;
        throw new Error("synthetic permanent read failure");
      }
      return prepare.call(this, sql);
    } as typeof prepare);
    await waitFor(() => expect(failures).toBeGreaterThanOrEqual(4));
    expect(descriptorsFor(dbPath)).toBe(baseline);
    failing.mockRestore();
    await stream.close();
    stream = undefined;
    await app.close();
    expect(descriptorsFor(dbPath)).toBe(0);
  } finally {
    await stream?.close();
    await app.close();
  }
});

it("fails closed if the accepted database schema changes on the same file", async () => {
  const { dbPath } = workspace();
  makeValidDatabase(dbPath);
  const app = Fastify();
  registerEventStreamRoute(app, { dbPath, pollIntervalMs: 10, heartbeatIntervalMs: 5000 });
  let stream: Awaited<ReturnType<typeof openStream>> | undefined;
  try {
    await app.listen({ host: "127.0.0.1", port: 0 });
    const address = app.server.address();
    if (!address || typeof address === "string") throw new Error("no listener");
    stream = await openStream(`http://127.0.0.1:${address.port}/v1/events/stream?since=3`);
    await waitFor(() => expect(stream!.text()).toContain("after-second-cursor"));
    const before = stream.text().length;
    const writer = new Database(dbPath);
    writer.exec("CREATE TABLE unexpected_schema_change(value TEXT)");
    insertEvent(writer, 5, "local", "after-invalid-schema");
    writer.close();
    await waitFor(() => expect(stream!.text()).toContain('"code":"event_stream_workspace_changed"'));
    await sleep(100);
    expect(stream.text().slice(before)).not.toContain("after-invalid-schema");
    expect(stream.text().slice(before)).not.toContain("event: heartbeat");
  } finally {
    await stream?.close();
    await app.close();
  }
});

it("does not admit a same-file schema change between validation and binding", async () => {
  const { dbPath } = workspace();
  initializeExactDatabase(dbPath);
  const writer = new Database(dbPath);
  insertEvent(writer, 1, "local", "invalid-schema-event");
  writer.close();
  const app = Fastify();
  registerEventStreamRoute(app, { dbPath, pollIntervalMs: 10, databaseRetryIntervalMs: 1000, heartbeatIntervalMs: 30 });
  let stream: Awaited<ReturnType<typeof openStream>> | undefined;
  try {
    await app.listen({ host: "127.0.0.1", port: 0 });
    const address = app.server.address();
    if (!address || typeof address === "string") throw new Error("no listener");
    const pragma = Database.prototype.pragma;
    let changed = false;
    const inject = vi.spyOn(Database.prototype, "pragma").mockImplementation(function (this: Database.Database, source: string, options?: Database.PragmaOptions) {
      if (!changed && source === "schema_version") {
        changed = true;
        const competing = new Database(dbPath);
        competing.exec("CREATE TABLE unexpected_during_open(value TEXT)");
        competing.close();
      }
      return pragma.call(this, source, options);
    } as typeof pragma);
    stream = await openStream(`http://127.0.0.1:${address.port}/v1/events/stream?since=0`);
    await waitFor(() => expect(stream!.text()).toContain('"code":"event_stream_unavailable"'), 800);
    expect(changed).toBe(true);
    await sleep(100);
    expect(stream.text()).not.toContain("invalid-schema-event");
    expect(stream.text()).not.toContain("event: heartbeat");
    inject.mockRestore();
  } finally {
    await stream?.close();
    await app.close();
  }
});
