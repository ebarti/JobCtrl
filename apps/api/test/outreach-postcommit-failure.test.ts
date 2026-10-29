import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { JobCtrlApiClient, JobCtrlApiError } from "@jobctrl/api-client";
import Database from "better-sqlite3";
import { expect, it, vi } from "vitest";

import { buildApp } from "../src/server.js";
import { initializeExactDatabase } from "./exact-schema.js";

it("marks a real post-commit projection failure as an unconfirmed revision", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "jobctrl-postcommit-revision-"));
  const dbPath = path.join(dir, "synthetic.db");
  initializeExactDatabase(dbPath);
  const db = new Database(dbPath);
  db.prepare("INSERT INTO outreach_threads (tenant_id,thread_id,contact_id,created_at,updated_at) VALUES ('local','thread-1','contact-1','2026-01-01','2026-01-01')").run();
  let calls = 0;
  const app = buildApp({
    dbPath, configPath: path.join(dir, "config.json"), requireHealthyWorkerForActions: false,
    outreachDraftGenerator: async (input) => {
      calls += 1;
      const writer = new Database(dbPath);
      try {
        writer.prepare("INSERT INTO outreach_drafts (tenant_id,draft_id,thread_id,generation,kind,status,body_text,gate_results_json,provenance_json,created_at) VALUES ('local','draft-1','thread-1',1,'intro_request','candidate',?,'{}','[]','2026-01-01')").run(input.editedBodyText);
        writer.exec("CREATE TRIGGER synthetic_projection_failure BEFORE INSERT ON outreach_thread_projections BEGIN SELECT RAISE(ABORT,'synthetic projection failure'); END");
      } finally { writer.close(); }
      return { threadId: input.threadId, contactId: "contact-1", jobId: null, draftId: "draft-1", generation: 1,
        kind: "intro_request", status: "candidate", gatePassed: true };
    },
  });
  const realFetch = globalThis.fetch;
  const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation((input, init) => {
    const headers = new Headers(init?.headers);
    headers.set("origin", "http://127.0.0.1:5173");
    return realFetch(input, { ...init, headers });
  });
  try {
    const address = await app.listen({ host: "127.0.0.1", port: 0 });
    const client = new JobCtrlApiClient(address);
    const error = await client.reviseOutreachDraft("thread-1", { editedBodyText: "Synthetic committed revision" })
      .then(() => null, (reason: unknown) => reason);
    expect(error).toBeInstanceOf(JobCtrlApiError);
    expect(error).toMatchObject({ status: 500, writeOutcomeUnknown: true, responseBody: { error: "db_write_failed" } });
    expect(calls).toBe(1);
    expect(db.prepare("SELECT body_text FROM outreach_drafts ORDER BY generation").all()).toEqual([
      { body_text: "Synthetic committed revision" },
    ]);
  } finally {
    fetchSpy.mockRestore();
    await app.close();
    db.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
