import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";

import { readWorkerRuntimeTelemetry } from "../src/worker-runtime-telemetry.js";
import { initializeExactV7Database } from "./v7-schema.js";

const fixtures: Fixture[] = [];

afterEach(() => {
  for (const fixture of fixtures.splice(0)) {
    fixture.db.close();
    fs.rmSync(fixture.directory, { recursive: true, force: true });
  }
});

describe("worker runtime telemetry", () => {
  it("sums exact multi-process capacity without deriving busy slots from 20 details", () => {
    const fixture = createFixture();
    const now = new Date("2026-07-14T10:00:30.000Z");
    insertHeartbeat(fixture, {
      workerId: "worker-a",
      lastSeenAt: "2026-07-14T10:00:20.000Z",
      configuredSlots: 16,
      activeSlots: 13,
      executorThreads: 18,
      details: activeDetails(13, 0),
      queueObservation: availableObservation("2026-07-14T10:00:19.000Z", 11, 3),
    });
    insertHeartbeat(fixture, {
      workerId: "worker-b",
      lastSeenAt: "2026-07-14T10:00:25.000Z",
      configuredSlots: 16,
      activeSlots: 12,
      executorThreads: 18,
      details: activeDetails(12, 13),
      queueObservation: availableObservation("2026-07-14T10:00:24.000Z", 7, 2),
    });

    const snapshot = readWorkerRuntimeTelemetry(fixture.dbPath, { now });

    expect(snapshot.status).toBe("available");
    expect(snapshot.freshWorkerCount).toBe(2);
    expect(snapshot.configuredSlots).toBe(32);
    expect(snapshot.activeSlots).toBe(25);
    expect(snapshot.availableSlots).toBe(7);
    expect(snapshot.activeDetails).toHaveLength(20);
    expect(snapshot.activeDetailsTotal).toBe(25);
    expect(snapshot.activeDetailsTruncated).toBe(true);
    expect(snapshot.activeCountsByType).toEqual({ score_job: 25 });
    expect(snapshot.executorThreads).toBe(36);
    expect(snapshot.slotSaturation).toBe(25 / 32);
    expect(snapshot.activityDurationsByType.score_job).toEqual({
      completedCount: 4,
      totalDurationMs: 10_000,
      maxDurationMs: 3_000,
    });
    expect(snapshot.activeDetails[0]).toMatchObject({
      workflowRef: `prep-preparation:${"0".repeat(64)}`,
      executionRef: "00000000-0000-4000-8000-000000000000",
    });
    expect(snapshot.taskQueueObservation).toMatchObject({
      status: "available",
      observedAt: "2026-07-14T10:00:24.000Z",
      activity: { approximateBacklogCount: 7, pollerCount: 2 },
    });
  });

  it("includes non-allowlisted activities in mixed-worker slot occupancy only", () => {
    const fixture = createFixture();
    const now = new Date("2026-07-14T10:00:30.000Z");
    insertHeartbeat(fixture, {
      workerId: "worker-a",
      lastSeenAt: "2026-07-14T10:00:20.000Z",
      configuredSlots: 4,
      activeSlots: 2,
      executorThreads: 6,
      details: activeDetails(1, 0),
      activeDetailsTotal: 1,
      counts: { score_job: 1 },
      queueObservation: availableObservation("2026-07-14T10:00:19.000Z", 0, 1),
    });
    insertHeartbeat(fixture, {
      workerId: "worker-b",
      lastSeenAt: "2026-07-14T10:00:25.000Z",
      configuredSlots: 4,
      activeSlots: 3,
      executorThreads: 6,
      details: activeDetails(2, 1),
      activeDetailsTotal: 2,
      counts: { score_job: 2 },
      queueObservation: availableObservation("2026-07-14T10:00:24.000Z", 0, 1),
    });

    const snapshot = readWorkerRuntimeTelemetry(fixture.dbPath, { now });

    expect(snapshot).toMatchObject({
      status: "available",
      configuredSlots: 8,
      activeSlots: 5,
      availableSlots: 3,
      activeDetailsTotal: 3,
      activeDetailsTruncated: false,
      activeCountsByType: { score_job: 3 },
    });
    expect(snapshot.activeDetails).toHaveLength(3);
    expect(JSON.stringify(snapshot)).not.toContain("unallowlisted");
  });

  it("excludes a crashed stale process and reports stale when no process remains fresh", () => {
    const fixture = createFixture();
    const now = new Date("2026-07-14T10:02:00.000Z");
    insertHeartbeat(fixture, {
      workerId: "fresh-worker",
      lastSeenAt: "2026-07-14T10:01:45.000Z",
      configuredSlots: 8,
      activeSlots: 3,
      executorThreads: 10,
      details: activeDetails(3, 0),
      queueObservation: availableObservation("2026-07-14T10:01:44.000Z", 4, 1),
    });
    insertHeartbeat(fixture, {
      workerId: "crashed-worker",
      lastSeenAt: "2026-07-14T09:55:00.000Z",
      configuredSlots: 64,
      activeSlots: 64,
      executorThreads: 66,
      details: activeDetails(20, 20),
      queueObservation: availableObservation("2026-07-14T09:54:59.000Z", 999, 99),
    });

    const live = readWorkerRuntimeTelemetry(fixture.dbPath, { now });
    expect(live).toMatchObject({
      status: "available",
      freshWorkerCount: 1,
      staleWorkerCount: 1,
      configuredSlots: 8,
      activeSlots: 3,
      availableSlots: 5,
    });

    const afterCrash = readWorkerRuntimeTelemetry(fixture.dbPath, {
      now: new Date("2026-07-14T10:03:00.000Z"),
    });
    expect(afterCrash.status).toBe("stale");
    expect(afterCrash.configuredSlots).toBe(0);
    expect(afterCrash.activeSlots).toBe(0);
    expect(afterCrash.staleWorkerCount).toBe(2);
    expect(afterCrash.taskQueueObservation.status).toBe("stale");
  });

  it("keeps unavailable queue statistics explicit and rejects invalid capacity", () => {
    const fixture = createFixture();
    const now = new Date("2026-07-14T10:00:30.000Z");
    insertHeartbeat(fixture, {
      workerId: "worker-a",
      lastSeenAt: "2026-07-14T10:00:25.000Z",
      configuredSlots: 4,
      activeSlots: 4,
      executorThreads: 6,
      details: activeDetails(4, 0),
      queueObservation: {
        status: "unavailable",
        observedAt: "2026-07-14T10:00:24.000Z",
        reasonCode: "describe_task_queue_unavailable",
      },
    });

    const available = readWorkerRuntimeTelemetry(fixture.dbPath, { now });
    expect(available.activeSlots).toBeLessThanOrEqual(available.configuredSlots);
    expect(available.taskQueueObservation).toEqual({
      status: "unavailable",
      observedAt: "2026-07-14T10:00:24.000Z",
      reasonCode: "describe_task_queue_unavailable",
    });

    fixture.db
      .prepare(
        "UPDATE worker_runtime_heartbeats SET active_activity_count = 5 WHERE worker_id = 'worker-a'",
      )
      .run();
    insertHeartbeat(fixture, {
      workerId: "worker-b",
      lastSeenAt: "2026-07-14T10:00:26.000Z",
      configuredSlots: 8,
      activeSlots: 2,
      executorThreads: 10,
      details: activeDetails(2, 10),
      queueObservation: availableObservation("2026-07-14T10:00:25.000Z", 2, 1),
    });
    const invalid = readWorkerRuntimeTelemetry(fixture.dbPath, { now });
    expect(invalid.status).toBe("unavailable");
    expect(invalid.reason).toBe("invalid_capacity");
    expect(invalid.invalidWorkerCount).toBe(1);
    expect(invalid.freshWorkerCount).toBe(2);
    expect(invalid.configuredSlots).toBe(0);
    expect(invalid.activeSlots).toBeLessThanOrEqual(invalid.configuredSlots);

    fixture.db
      .prepare(
        `UPDATE worker_runtime_heartbeats
         SET max_concurrent_activities = 0,
             active_activity_count = 0,
             active_activity_counts_json = '{}',
             active_activity_details_total = 0
         WHERE worker_id = 'worker-a'`,
      )
      .run();
    const nonPositiveConfigured = readWorkerRuntimeTelemetry(fixture.dbPath, { now });
    expect(nonPositiveConfigured.status).toBe("unavailable");
    expect(nonPositiveConfigured.reason).toBe("invalid_capacity");
  });

  it("never passes arbitrary heartbeat JSON through the read boundary", () => {
    const fixture = createFixture();
    const canary = "https://jobs.example/private?secret=resume-prompt-provider-artifact";
    const details = activeDetails(1, 0);
    const firstDetail = details[0];
    if (!firstDetail) {
      throw new Error("fixture must include one active detail");
    }
    const taintedDetail = { ...firstDetail, ignoredPayload: canary };
    insertHeartbeat(fixture, {
      workerId: "worker-a",
      lastSeenAt: "2026-07-14T10:00:25.000Z",
      configuredSlots: 4,
      activeSlots: 1,
      executorThreads: 6,
      details: [taintedDetail],
      queueObservation: {
        ...availableObservation("2026-07-14T10:00:24.000Z", 0, 1),
        ignoredProviderOutput: canary,
      },
      counts: { score_job: 1, [canary]: 999 },
    });

    const snapshot = readWorkerRuntimeTelemetry(fixture.dbPath, {
      now: new Date("2026-07-14T10:00:30.000Z"),
    });

    expect(JSON.stringify(snapshot)).not.toContain(canary);
    expect(snapshot.activeCountsByType).toEqual({ score_job: 1 });
    expect(snapshot.activeDetails[0]).not.toHaveProperty("ignoredPayload");
  });
});

interface Fixture {
  directory: string;
  dbPath: string;
  db: Database.Database;
}

function createFixture(): Fixture {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "jobctrl-worker-runtime-"));
  const dbPath = path.join(directory, "jobctrl.db");
  initializeExactV7Database(dbPath);
  const db = new Database(dbPath);
  const fixture = { directory, dbPath, db };
  fixtures.push(fixture);
  return fixture;
}

function insertHeartbeat(
  fixture: Fixture,
  input: {
    workerId: string;
    lastSeenAt: string;
    configuredSlots: number;
    activeSlots: number;
    executorThreads: number;
    details: unknown[];
    activeDetailsTotal?: number;
    queueObservation: Record<string, unknown>;
    counts?: Record<string, number>;
  },
): void {
  const activeDetailsTotal = input.activeDetailsTotal ?? input.activeSlots;
  fixture.db
    .prepare(
      `INSERT INTO worker_runtime_heartbeats (
         worker_id, component, pid, hostname, app_dir, db_path, task_queue,
         started_at, last_seen_at, max_concurrent_activities,
         activity_executor_max_workers, active_activity_count,
         active_activity_counts_json, active_activity_details_json,
         active_activity_details_total, active_activity_details_truncated,
         activity_duration_summary_json, task_queue_observation_json,
         heartbeat_schema_version
       ) VALUES (?, 'temporal-worker', 100, 'localhost', ?, ?, 'jobctrl-default', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 2)`,
    )
    .run(
      input.workerId,
      fixture.directory,
      fixture.dbPath,
      input.lastSeenAt,
      input.lastSeenAt,
      input.configuredSlots,
      input.executorThreads,
      input.activeSlots,
      JSON.stringify(input.counts ?? { score_job: input.activeSlots }),
      JSON.stringify(input.details),
      activeDetailsTotal,
      Number(activeDetailsTotal > input.details.length),
      JSON.stringify({
        score_job: {
          completedCount: 2,
          totalDurationMs: 5_000,
          maxDurationMs: 3_000,
        },
      }),
      JSON.stringify(input.queueObservation),
    );
}

function activeDetails(count: number, offset: number): Record<string, unknown>[] {
  return Array.from({ length: count }, (_, index) => {
    const sequence = offset + index;
    const hex = sequence.toString(16).padStart(24, "0");
    const workflowHash = sequence.toString(16).padStart(64, "0");
    const runSuffix = sequence.toString(16).padStart(12, "0");
    return {
      activityType: "score_job",
      operationalRef: { kind: "job-scoring", opaqueId: `op_${hex}` },
      workflowRef: `prep-preparation:${workflowHash}`,
      executionRef: `00000000-0000-4000-8000-${runSuffix}`,
      attempt: 1,
      startedAt: new Date(Date.parse("2026-07-14T09:00:00.000Z") + sequence * 1_000).toISOString(),
    };
  });
}

function availableObservation(
  observedAt: string,
  approximateBacklogCount: number,
  pollerCount: number,
): Record<string, unknown> {
  const stats = {
    pollerCount,
    approximateBacklogCount,
    approximateBacklogAgeSeconds: 12.5,
    tasksAddRate: 2.5,
    tasksDispatchRate: 2,
  };
  return { status: "available", observedAt, workflow: stats, activity: stats };
}
