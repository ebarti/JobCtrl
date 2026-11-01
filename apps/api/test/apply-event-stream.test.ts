import Fastify from "fastify";
import Database from "better-sqlite3";
import { expect, it } from "vitest";

import { applyTimelineEnvelope } from "../src/apply-event-stream.js";
import { registerEventStreamRoute } from "../src/event-stream.js";
import { createQaWorkspace, QA_PLATFORM_JOB_ID, removeQaWorkspace } from "./qa-seed.js";

it("projects only safe summaries with consistent run and event identities", () => {
  const row = { tenant_id: "local", job_id: QA_PLATFORM_JOB_ID, stage: "apply", event_type: "SagaStarted",
    level: "info", message: "Synthetic saga", occurred_at: "2026-05-04T12:00:00Z" };
  const canonical = { payload: { tenantId: "local", jobId: row.job_id, run_id: "run-a", event_id: 1, secret: "private-canary" } };
  expect(applyTimelineEnvelope(row, canonical)).toEqual({
    tenantId: "local", jobId: row.job_id, occurredAt: row.occurred_at,
    payload: { tenantId: "local", jobId: row.job_id, runId: "run-a", event: {
      event_id: 1, event_type: "SagaStarted", occurred_at: row.occurred_at, level: "info", message: "Synthetic saga",
    } },
  });
  expect(JSON.stringify(applyTimelineEnvelope(row, canonical))).not.toContain("private-canary");
  for (const payload of [
    { ...canonical.payload, runId: "run-b" },
    { ...canonical.payload, eventId: 2 },
    { ...canonical.payload, event_id: 0 },
    { ...canonical.payload, run_id: "" },
  ]) expect(applyTimelineEnvelope(row, { payload })).toBeNull();
  expect(applyTimelineEnvelope({ ...row, job_id: null }, canonical)).toBeNull();
  expect(applyTimelineEnvelope({ ...row, stage: "score" }, canonical)).toBeNull();
  expect(applyTimelineEnvelope({ ...row, event_type: "ApplyRunEventRecorded" }, canonical)).toBeNull();
});

it("sends a safe timeline frame before the durable cursor and replays it from the prior cursor", async () => {
  const workspace = createQaWorkspace();
  const db = new Database(workspace.dbPath);
  const app = Fastify();
  registerEventStreamRoute(app, { dbPath: workspace.dbPath, pollIntervalMs: 5 });
  const readers: ReadableStreamDefaultReader<Uint8Array>[] = [];
  try {
    const base = await app.listen({ host: "127.0.0.1", port: 0 });
    const cursor = (db.prepare("SELECT COALESCE(MAX(event_id), 0) AS id FROM job_events").get() as { id: number }).id;
    db.prepare("INSERT INTO jobs (tenant_id, job_id, url, title, site, discovered_at) VALUES ('other', ?, 'https://example.test/other', 'Synthetic', 'test', ?)")
      .run(QA_PLATFORM_JOB_ID, "2026-05-04T12:00:00Z");
    const insert = db.prepare(`INSERT INTO job_events
      (tenant_id, job_id, identity_version, stage, event_type, level, message, occurred_at, payload_json)
      VALUES (?, ?, 1, 'apply', 'SagaStarted', 'info', ?, ?, ?)`);
    insert.run("other", QA_PLATFORM_JOB_ID, "Other tenant", "2026-05-04T12:00:00Z", JSON.stringify({ run_id: "run-a", event_id: 1 }));
    insert.run("local", QA_PLATFORM_JOB_ID, "Conflicting tenant", "2026-05-04T12:00:00Z", JSON.stringify({ tenantId: "other", run_id: "run-a", event_id: 1 }));
    insert.run("local", QA_PLATFORM_JOB_ID, "Conflicting job", "2026-05-04T12:00:00Z", JSON.stringify({ jobId: "wrong-job", run_id: "run-a", event_id: 1 }));
    const saved = insert.run("local", QA_PLATFORM_JOB_ID, "Synthetic live saga", "2026-05-04T12:00:01Z",
      JSON.stringify({ run_id: "run-a", event_id: 1, secret: "private-saga-payload" }));

    async function readUntil(complete: (wire: string) => boolean): Promise<string> {
      const response = await fetch(`${base}/v1/events/stream`, { headers: { "Last-Event-ID": String(cursor) } });
      const reader = response.body!.getReader();
      readers.push(reader);
      const decoder = new TextDecoder();
      let wire = "";
      while (!complete(wire)) {
        const next = await Promise.race([reader.read(), new Promise<never>((_, reject) => setTimeout(() => reject(new Error("SSE timed out")), 3000))]);
        if (next.done) throw new Error("SSE closed before the event");
        wire += decoder.decode(next.value, { stream: true });
      }
      return wire;
    }

    const interrupted = await readUntil((wire) => {
      const at = wire.indexOf("event: ApplyRunEventRecorded\n");
      return at >= 0 && wire.indexOf("\n\n", at) >= 0;
    });
    const first = interrupted.indexOf("event: ApplyRunEventRecorded\n");
    const prefix = interrupted.slice(0, interrupted.indexOf("\n\n", first) + 2);
    expect(prefix).not.toContain("id:");
    await readers.pop()!.cancel();

    {
      const wire = await readUntil((value) => value.includes(`id: ${saved.lastInsertRowid}\n`));
      const synthetic = wire.indexOf("event: ApplyRunEventRecorded\n");
      const original = wire.indexOf(`id: ${saved.lastInsertRowid}\nevent: SagaStarted\n`);
      expect(synthetic).toBeGreaterThanOrEqual(0);
      expect(original).toBeGreaterThan(synthetic);
      const frame = wire.slice(synthetic, wire.indexOf("\n\n", synthetic));
      expect(frame).not.toContain("id:");
      expect(JSON.parse(frame.split("\n").find((line) => line.startsWith("data: "))!.slice(6))).toMatchObject({
        tenantId: "local", jobId: QA_PLATFORM_JOB_ID,
        payload: { runId: "run-a", jobId: QA_PLATFORM_JOB_ID, event: { event_id: 1, event_type: "SagaStarted", message: "Synthetic live saga" } },
      });
      expect(frame).not.toContain("private-saga-payload");
      expect(wire).not.toContain("Other tenant");
      expect(wire).not.toContain("Conflicting tenant");
      expect(wire).not.toContain("Conflicting job");
      await readers.pop()!.cancel();
    }
  } finally {
    for (const reader of readers) await reader.cancel().catch(() => undefined);
    await app.close();
    db.close();
    removeQaWorkspace(workspace);
  }
});
