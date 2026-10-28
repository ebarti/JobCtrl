import Database from "better-sqlite3";
import { expect, it } from "vitest";

import { getWorkflowRunDetail } from "../src/read-model.js";
import { createQaWorkspace, QA_PLATFORM_JOB_ID, QA_RISK_JOB_ID, removeQaWorkspace } from "./qa-seed.js";

it("reads current Apply event history only for the workflow's tenant, run, and job", () => {
  const workspace = createQaWorkspace();
  const db = new Database(workspace.dbPath);
  try {
    db.prepare(`INSERT INTO jobs (tenant_id, job_id, url, title, company, site, discovered_at)
      VALUES ('other', ?, 'https://example.test/other-tenant', 'Synthetic', 'Synthetic', 'test', ?)`)
      .run(QA_PLATFORM_JOB_ID, "2026-05-04T12:00:00Z");
    const insert = db.prepare(`INSERT INTO job_events
      (tenant_id, job_id, identity_version, stage, event_type, level, message, occurred_at, payload_json)
      VALUES (?, ?, 1, 'apply', ?, 'info', ?, ?, ?)`);
    const recorded = insert.run("local", QA_PLATFORM_JOB_ID, "SagaStarted", "Missed synthetic event",
      "2026-05-04T12:00:01Z", JSON.stringify({ run_id: "qa-run-1", event_id: 1, privatePayload: "do-not-expose" }));
    insert.run("other", QA_PLATFORM_JOB_ID, "SagaStarted", "Wrong tenant", "2026-05-04T12:00:02Z", JSON.stringify({ run_id: "qa-run-1", event_id: 1 }));
    insert.run("local", QA_RISK_JOB_ID, "SagaStarted", "Wrong job", "2026-05-04T12:00:03Z", JSON.stringify({ run_id: "qa-run-1", event_id: 2 }));
    insert.run("local", QA_PLATFORM_JOB_ID, "SagaStarted", "Wrong run", "2026-05-04T12:00:04Z", JSON.stringify({ run_id: "another-run", event_id: 3 }));
    insert.run("local", QA_PLATFORM_JOB_ID, "SagaStarted", "Malformed", "2026-05-04T12:00:05Z", "not-json");

    const detail = getWorkflowRunDetail(db, "qa-run-1") as unknown as { events: unknown[]; applyEvents?: unknown[] };
    expect(detail.events).toEqual(expect.arrayContaining([expect.objectContaining({ eventType: "WorkflowStarted" })]));
    expect(detail.applyEvents).toEqual([{
      sourceEventId: String(recorded.lastInsertRowid),
      runEventId: 1,
      at: "2026-05-04T12:00:01Z",
      type: "SagaStarted",
      level: "info",
      message: "Missed synthetic event",
    }]);
    expect(JSON.stringify(detail.applyEvents)).not.toContain("do-not-expose");
    expect(getWorkflowRunDetail(db, "qa-run-1", QA_RISK_JOB_ID)?.applyEvents).toEqual([]);
    const plan = db.prepare(`EXPLAIN QUERY PLAN SELECT event_id FROM job_events INDEXED BY idx_job_events_job_time
      WHERE tenant_id = ? AND job_id = ? AND stage = 'apply'`).all("local", QA_PLATFORM_JOB_ID) as Array<{ detail: string }>;
    expect(plan.some((row) => row.detail.includes("idx_job_events_job_time") && row.detail.includes("job_id=?"))).toBe(true);
  } finally {
    db.close();
    removeQaWorkspace(workspace);
  }
});

it("uses the route job with a matching durable start while the Apply projection lags", () => {
  const workspace = createQaWorkspace();
  const db = new Database(workspace.dbPath);
  try {
    db.prepare("DELETE FROM apply_run_projections WHERE tenant_id = 'local' AND run_id = 'qa-run-1'").run();
    const insert = db.prepare(`INSERT INTO job_events
      (tenant_id, job_id, identity_version, stage, event_type, level, message, occurred_at, payload_json)
      VALUES ('local', ?, 1, 'apply', ?, 'info', ?, ?, ?)`);
    insert.run(QA_PLATFORM_JOB_ID, "SagaStarted", "Synthetic run event", "2026-05-04T12:00:01Z", JSON.stringify({ run_id: "qa-run-1", event_id: 1 }));
    expect(getWorkflowRunDetail(db, "qa-run-1", QA_PLATFORM_JOB_ID)?.applyEvents).toEqual([]);
    insert.run(QA_PLATFORM_JOB_ID, "ApplyRunStarted", "Synthetic start", "2026-05-04T12:00:00Z", JSON.stringify({ run_id: "qa-run-1" }));
    const first = getWorkflowRunDetail(db, "qa-run-1", QA_PLATFORM_JOB_ID);
    expect(first?.applyEvents?.map((event) => event.message)).toEqual(["Synthetic run event", "Synthetic start"]);
    expect(getWorkflowRunDetail(db, "qa-run-1")?.applyEvents).toEqual([]);
    expect(getWorkflowRunDetail(db, "qa-run-1", QA_RISK_JOB_ID)?.applyEvents).toEqual([]);
    insert.run(QA_RISK_JOB_ID, "ApplyRunStarted", "Ambiguous start", "2026-05-04T12:00:02Z", JSON.stringify({ run_id: "qa-run-1" }));
    expect(getWorkflowRunDetail(db, "qa-run-1", QA_PLATFORM_JOB_ID)?.applyEvents?.map((event) => event.message))
      .toEqual(["Synthetic run event", "Synthetic start"]);
  } finally {
    db.close();
    removeQaWorkspace(workspace);
  }
});
