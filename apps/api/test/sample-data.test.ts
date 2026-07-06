import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { JobListQuerySchema } from "../src/contracts.js";
import { getJobDetail, listJobs } from "../src/read-model.js";
import {
  clearSampleData,
  isSampleJob,
  loadSampleData,
  readSampleDataStatus,
  SAMPLE_JOB_URLS,
  sampleDataTtfvProbe,
} from "../src/sample-data.js";
import { buildApp, type BuildAppOptions } from "../src/server.js";

let tempDir = "";
let dbPath = "";
let options: BuildAppOptions;

beforeEach(() => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "jobhunter-sample-data-"));
  dbPath = path.join(tempDir, "jobhunter.db");
  options = {
    appDir: tempDir,
    dbPath,
    settingsPath: path.join(tempDir, "dashboard.json"),
    actionDispatcher: vi.fn(async () => ({ status: "queued" as const, runId: "unexpected-run" })),
  };
});

afterEach(() => {
  fs.rmSync(tempDir, { force: true, recursive: true });
});

describe("first-run sample data", () => {
  it("loads scored synthetic jobs, exposes real projections and artifacts, and clears them", () => {
    const db = new Database(dbPath);
    try {
      expect(readSampleDataStatus(db)).toMatchObject({
        state: "not_initialized",
        canLoad: false,
        sampleJobCount: 0,
      });

      const loaded = loadSampleData(db, tempDir);
      expect(loaded).toMatchObject({
        ok: true,
        loaded: true,
        cleared: false,
        status: {
          state: "loaded",
          sampleJobCount: 2,
          canClear: true,
        },
      });
      expect(isSampleJob(db, SAMPLE_JOB_URLS[0])).toBe(true);

      const jobs = listJobs(db, JobListQuerySchema.parse({}));
      expect(jobs.items).toHaveLength(2);
      expect(jobs.items.map((job) => job.isSample)).toEqual([true, true]);
      expect(jobs.items[0]).toMatchObject({
        jobKey: SAMPLE_JOB_URLS[0],
        title: "Director of Platform Engineering",
        fitScore: 9,
        isSample: true,
      });

      const detail = getJobDetail(db, SAMPLE_JOB_URLS[0]);
      expect(detail).toMatchObject({
        ok: true,
        job: {
          jobKey: SAMPLE_JOB_URLS[0],
          isSample: true,
          title: "Director of Platform Engineering",
        },
      });

      const probe = sampleDataTtfvProbe(db);
      expect(probe.mode).toBe("synthetic_sample");
      expect(probe.ttfv1).toMatchObject({ passed: true, job: { jobKey: SAMPLE_JOB_URLS[0], fitScore: 9 } });
      expect(probe.ttfv2.passed).toBe(true);
      expect(probe.ttfv2.artifactId).toBe("sample-platform-resume-pdf");
      expect(probe.ttfv2.artifactBytes).toBeGreaterThan(0);

      const cleared = clearSampleData(db, tempDir);
      expect(cleared).toMatchObject({
        ok: true,
        loaded: false,
        cleared: true,
        status: {
          state: "empty",
          sampleJobCount: 0,
          jobCount: 0,
        },
      });
      expect(fs.existsSync(path.join(tempDir, "sample-data", "first-run-ttfv-v1"))).toBe(false);

      const noOpClear = clearSampleData(db, tempDir);
      expect(noOpClear).toMatchObject({
        ok: true,
        cleared: false,
        message: "No sample data was loaded.",
      });
    } finally {
      db.close();
    }
  });

  it("loads sample data through the API and blocks sample jobs from submission paths", async () => {
    new Database(dbPath).close();
    const app = buildApp(options);
    try {
      const load = await app.inject({ method: "POST", url: "/v1/sample-data/load" });
      expect(load.statusCode, load.body).toBe(200);
      expect(load.json()).toMatchObject({
        ok: true,
        loaded: true,
        status: {
          state: "loaded",
          sampleJobCount: 2,
        },
      });

      const probe = await app.inject({ method: "GET", url: "/v1/sample-data/ttfv-probe" });
      expect(probe.statusCode, probe.body).toBe(200);
      expect(probe.json()).toMatchObject({
        mode: "synthetic_sample",
        ttfv1: { passed: true },
        ttfv2: { passed: true, artifactId: "sample-platform-resume-pdf" },
      });

      const jobKey = encodeURIComponent(SAMPLE_JOB_URLS[0]);
      const apply = await app.inject({
        method: "POST",
        url: `/v1/jobs/${jobKey}/actions/apply`,
        payload: { dryRun: false },
      });
      expect(apply.statusCode, apply.body).toBe(409);
      expect(apply.json()).toMatchObject({
        ok: false,
        error: "sample_job_apply_blocked",
      });

      const approveSubmit = await app.inject({
        method: "POST",
        url: `/v1/jobs/${jobKey}/apply-review/decision`,
        payload: { decision: "approve_submit" },
      });
      expect(approveSubmit.statusCode, approveSubmit.body).toBe(409);
      expect(approveSubmit.json()).toMatchObject({
        ok: false,
        error: "sample_job_apply_blocked",
      });

      expect(options.actionDispatcher).not.toHaveBeenCalled();
    } finally {
      await app.close();
    }
  });
});
