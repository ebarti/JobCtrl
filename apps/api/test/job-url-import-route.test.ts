import { describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  JobUrlImportError,
  type JobUrlImporter,
} from "../src/job-url-import-worker.js";
import { buildApp } from "../src/server.js";
import { initializeExactV7Database } from "./v7-schema.js";

function fixture(): { dbPath: string; dir: string; cleanup: () => void } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "jobctrl-job-url-import-"));
  const dbPath = path.join(dir, "jobctrl.db");
  initializeExactV7Database(dbPath);
  return {
    dbPath,
    dir,
    cleanup: () => fs.rmSync(dir, { recursive: true, force: true }),
  };
}

describe("POST /v1/jobs/import-url", () => {
  it("returns the imported canonical job", async () => {
    const { dbPath, dir, cleanup } = fixture();
    const jobUrlImporter = vi.fn<JobUrlImporter>(async () => ({
      ok: true,
      status: "imported",
      jobKey: "7bf7e789-8a2f-45e4-8c41-00e71525d05c",
      importedAt: "2026-08-13T15:00:00Z",
      alreadyExisted: false,
    }));
    const app = buildApp({
      dbPath,
      configPath: path.join(dir, "config.json"),
      jobUrlImporter,
      jobUrlValidator: async () => ({ allowed: true }),
      requireHealthyWorkerForActions: false,
    });
    try {
      const response = await app.inject({
        method: "POST",
        url: "/v1/jobs/import-url",
        payload: { url: "https://example.com/jobs/42" },
      });
      expect(response.statusCode).toBe(200);
      expect(response.json()).toMatchObject({ status: "imported" });
      expect(jobUrlImporter).toHaveBeenCalledWith(
        { url: "https://example.com/jobs/42" },
        { appDir: dir, dbPath },
      );
    } finally {
      await app.close();
      cleanup();
    }
  });

  it("accepts a second import while the first import is still running", async () => {
    const { dbPath, dir, cleanup } = fixture();
    const pending = new Map<
      string,
      (value: Awaited<ReturnType<JobUrlImporter>>) => void
    >();
    const jobUrlImporter = vi.fn<JobUrlImporter>(
      (input) =>
        new Promise((resolve) => {
          pending.set(input.url, resolve);
        }),
    );
    const app = buildApp({
      dbPath,
      configPath: path.join(dir, "config.json"),
      jobUrlImporter,
      jobUrlValidator: async () => ({ allowed: true }),
      requireHealthyWorkerForActions: false,
    });
    try {
      const first = app.inject({
        method: "POST",
        url: "/v1/jobs/import-url",
        payload: { url: "https://example.com/jobs/first" },
      });
      await vi.waitFor(() => expect(jobUrlImporter).toHaveBeenCalledTimes(1));
      const second = app.inject({
        method: "POST",
        url: "/v1/jobs/import-url",
        payload: { url: "https://example.com/jobs/second" },
      });
      await vi.waitFor(() => expect(jobUrlImporter).toHaveBeenCalledTimes(2));

      pending.get("https://example.com/jobs/second")?.({
        ok: true,
        status: "imported",
        jobKey: "22222222-2222-4222-8222-222222222222",
        importedAt: "2026-08-13T15:00:01Z",
        alreadyExisted: false,
      });
      expect((await second).statusCode).toBe(200);
      pending.get("https://example.com/jobs/first")?.({
        ok: true,
        status: "imported",
        jobKey: "11111111-1111-4111-8111-111111111111",
        importedAt: "2026-08-13T15:00:02Z",
        alreadyExisted: false,
      });
      expect((await first).statusCode).toBe(200);
    } finally {
      await app.close();
      cleanup();
    }
  });

  it("returns the Manual Capture fallback without changing the outcome", async () => {
    const { dbPath, dir, cleanup } = fixture();
    const jobUrlImporter = vi.fn<JobUrlImporter>(async () => ({
      ok: true,
      status: "manual_capture_required",
      itemId: "manual:robots",
      reason: "robots_disallowed",
    }));
    const app = buildApp({
      dbPath,
      configPath: path.join(dir, "config.json"),
      jobUrlImporter,
      jobUrlValidator: async () => ({ allowed: true }),
      requireHealthyWorkerForActions: false,
    });
    try {
      const response = await app.inject({
        method: "POST",
        url: "/v1/jobs/import-url",
        payload: { url: "https://example.com/jobs/robots-denied" },
      });
      expect(response.statusCode).toBe(200);
      expect(response.json()).toEqual({
        ok: true,
        status: "manual_capture_required",
        itemId: "manual:robots",
        reason: "robots_disallowed",
      });
    } finally {
      await app.close();
      cleanup();
    }
  });

  it("validates the URL before dispatch", async () => {
    const { dbPath, dir, cleanup } = fixture();
    const jobUrlImporter = vi.fn<JobUrlImporter>();
    const app = buildApp({
      dbPath,
      configPath: path.join(dir, "config.json"),
      jobUrlImporter,
      jobUrlValidator: async () => ({ allowed: true }),
      requireHealthyWorkerForActions: false,
    });
    try {
      const response = await app.inject({
        method: "POST",
        url: "/v1/jobs/import-url",
        payload: { url: "not a URL" },
      });
      expect(response.statusCode).toBe(400);
      expect(jobUrlImporter).not.toHaveBeenCalled();
    } finally {
      await app.close();
      cleanup();
    }
  });

  it("rejects embedded credentials before worker dispatch", async () => {
    const { dbPath, dir, cleanup } = fixture();
    const jobUrlImporter = vi.fn<JobUrlImporter>();
    const app = buildApp({
      dbPath,
      configPath: path.join(dir, "config.json"),
      jobUrlImporter,
      jobUrlValidator: async () => ({ allowed: true }),
      requireHealthyWorkerForActions: false,
    });
    try {
      const response = await app.inject({
        method: "POST",
        url: "/v1/jobs/import-url",
        payload: { url: "https://user:password@example.com/jobs/42" },
      });
      expect(response.statusCode).toBe(400);
      expect(jobUrlImporter).not.toHaveBeenCalled();
    } finally {
      await app.close();
      cleanup();
    }
  });

  it.each(["http://127.0.0.1/private", "http://192.168.1.23/jobs/internal"])(
    "rejects a private URL before worker dispatch: %s",
    async (url) => {
      const { dbPath, dir, cleanup } = fixture();
      const jobUrlImporter = vi.fn<JobUrlImporter>();
      const app = buildApp({
        dbPath,
        configPath: path.join(dir, "config.json"),
        jobUrlImporter,
        requireHealthyWorkerForActions: false,
      });
      try {
        const response = await app.inject({
          method: "POST",
          url: "/v1/jobs/import-url",
          payload: { url },
        });
        expect(response.statusCode).toBe(400);
        expect(response.json()).toMatchObject({
          ok: false,
          error: "invalid_job_url",
        });
        expect(jobUrlImporter).not.toHaveBeenCalled();
      } finally {
        await app.close();
        cleanup();
      }
    },
  );

  it("rejects a hostname resolving private before worker dispatch", async () => {
    const { dbPath, dir, cleanup } = fixture();
    const jobUrlImporter = vi.fn<JobUrlImporter>();
    const app = buildApp({
      dbPath,
      configPath: path.join(dir, "config.json"),
      jobUrlImporter,
      jobUrlValidator: async () => ({
        allowed: false,
        reason: "URL host resolves to a non-public address.",
      }),
      requireHealthyWorkerForActions: false,
    });
    try {
      const response = await app.inject({
        method: "POST",
        url: "/v1/jobs/import-url",
        payload: { url: "https://jobs.internal.example/role" },
      });
      expect(response.statusCode).toBe(400);
      expect(jobUrlImporter).not.toHaveBeenCalled();
    } finally {
      await app.close();
      cleanup();
    }
  });

  it("fails fast without dispatch when the worker is unavailable", async () => {
    const { dbPath, dir, cleanup } = fixture();
    const jobUrlImporter = vi.fn<JobUrlImporter>();
    const app = buildApp({
      dbPath,
      configPath: path.join(dir, "config.json"),
      jobUrlImporter,
      jobUrlValidator: async () => ({ allowed: true }),
    });
    try {
      const response = await app.inject({
        method: "POST",
        url: "/v1/jobs/import-url",
        payload: { url: "https://example.com/jobs/42" },
      });
      expect(response.statusCode).toBe(503);
      expect(response.json()).toMatchObject({
        ok: false,
        error: "worker_runtime_unavailable",
      });
      expect(jobUrlImporter).not.toHaveBeenCalled();
    } finally {
      await app.close();
      cleanup();
    }
  });

  it("does not expose worker details when import fails", async () => {
    const { dbPath, dir, cleanup } = fixture();
    const jobUrlImporter: JobUrlImporter = async () => {
      throw new JobUrlImportError("Job import could not be completed.", 500);
    };
    const app = buildApp({
      dbPath,
      configPath: path.join(dir, "config.json"),
      jobUrlImporter,
      jobUrlValidator: async () => ({ allowed: true }),
      requireHealthyWorkerForActions: false,
    });
    try {
      const response = await app.inject({
        method: "POST",
        url: "/v1/jobs/import-url",
        payload: { url: "https://example.com/jobs/42" },
      });
      expect(response.statusCode).toBe(500);
      expect(response.json()).toEqual({
        ok: false,
        error: "job_url_import_failed",
        message: "Job import could not be completed.",
      });
    } finally {
      await app.close();
      cleanup();
    }
  });
});
