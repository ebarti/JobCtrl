import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import Database from "better-sqlite3";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { CredentialStore } from "../src/credentials.js";
import { SubprocessJsonRpcAdapter } from "../src/json-rpc-adapter.js";
import { AUTOMATION_PROJECT_DIR } from "../src/python-runtime.js";
import { buildApp } from "../src/server.js";
import { initializeExactDatabase } from "./exact-schema.js";

const JOB = "3f2504e0-4f89-41d3-9a0c-0305e82c3301";
const PRIVATE_BODY = "Synthetic private body: the project is proceeding.";
const cleanup: Array<() => Promise<void>> = [];

afterEach(async () => {
  for (const close of cleanup.splice(0)) await close();
});

function fixture(mode: string, withAnchor = true) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "jobctrl-gmail-rpc-test-"));
  const dbPath = path.join(root, "jobctrl.db");
  const python = process.env.JOBCTRL_GMAIL_QA_PYTHON ?? path.join(AUTOMATION_PROJECT_DIR, ".venv/bin/python");
  expect(fs.existsSync(python), "A locked worker interpreter is required for this RPC test").toBe(true);
  fs.writeFileSync(path.join(root, ".gmail-feedback-synthetic"), "owned synthetic Gmail fixture");
  fs.writeFileSync(path.join(root, "gmail-mode.txt"), mode);
  initializeExactDatabase(dbPath);
  const db = new Database(dbPath);
  if (withAnchor) {
    db.prepare(
      `INSERT INTO jobs(tenant_id,job_id,url,title,company,site,applied_at,apply_status,discovered_at)
       VALUES('local',?,'https://jobs.example.com/platform','Platform','ExampleCo','ExampleCo',
              '2026-06-01T10:00:00+00:00','applied','2026-05-31T10:00:00+00:00')`,
    ).run(JOB);
  }
  db.close();
  const worker = new SubprocessJsonRpcAdapter({
    appDir: root,
    requestTimeoutMs: 10_000,
    pythonRuntime: {
      id: `owned-gmail-rpc:${root}`,
      resolve: () => ({
        executable: python,
        argv: ["-u", "-m", "tests.gmail_feedback_rpc_fixture"],
        cwd: AUTOMATION_PROJECT_DIR,
        env: {
          PATH: process.env.PATH, HOME: root, TMPDIR: root, JOBCTRL_DIR: root,
          JOBCTRL_GMAIL_DIR: path.join(root, "no-credentials"),
          LANGFUSE_DISABLE: "1", PYTHONNOUSERSITE: "1",
        },
      }),
    },
  });
  const forbidden = vi.fn(async () => { throw new Error("Credential access is forbidden in this test"); });
  const credentialStore: CredentialStore = { list: forbidden, set: forbidden, delete: forbidden, applyBatch: forbidden };
  const app = buildApp({ appDir: root, dbPath, configPath: path.join(root, "config.json"),
    providerDispatcher: worker, credentialStore });
  cleanup.push(async () => {
    await app.close();
    await worker.drain();
    fs.rmSync(root, { recursive: true, force: true });
  });
  return { app, root, dbPath, forbidden };
}

async function scan(app: ReturnType<typeof buildApp>) {
  return app.inject({ method: "POST", url: "/v1/outcomes/gmail/scan", payload: {
    recipientEmail: "candidate@example.com", limit: 1, maxResultsPerAnchor: 5, windowDays: 7,
  } });
}

describe("Gmail feedback HTTP and registered Python RPC", () => {
  it.each(["linked", "unrelated"])("uses the %s source-bound decision and keeps raw mail private", async mode => {
    const { app, root, dbPath, forbidden } = fixture(mode);
    const response = await scan(app);
    expect(response.statusCode, response.body).toBe(200);
    const linked = mode === "linked";
    expect(response.json()).toMatchObject({ ok: true, scannedAnchorCount: 1, searchedMessageCount: 1,
      linkedEvidenceCount: Number(linked), unlinkedCandidateCount: Number(!linked) });
    expect(response.body).not.toContain(PRIVATE_BODY);
    const requests = fs.readFileSync(path.join(root, "gmail-searches.jsonl"), "utf8").trim().split("\n")
      .map(line => JSON.parse(line) as Record<string, string>);
    expect(requests).toEqual([{ q: 'to:"candidate@example.com" after:1780307999 before:1780912801', maxResults: "5" }]);
    if (linked) {
      expect(response.json().evidence[0].jobId).toBe(JOB);
      const duplicate = await scan(app);
      expect(duplicate.statusCode).toBe(200);
      expect(duplicate.json()).toMatchObject({ duplicateMessageCount: 1, linkedEvidenceCount: 0 });
      fs.writeFileSync(path.join(root, "gmail-mode.txt"), "provider_failure");
      const failed = await scan(app);
      expect(failed.statusCode).toBe(503);
      expect(failed.json().failureCode).toBe("gmail_provider_unavailable");
      expect(failed.body).not.toContain(PRIVATE_BODY);
    }
    const db = new Database(dbPath, { readonly: true });
    expect(db.prepare("SELECT COUNT(*) AS n FROM application_email_evidence").get()).toEqual({ n: Number(linked) });
    expect(db.prepare("SELECT COUNT(*) AS n FROM application_outcome_suggestions").get()).toEqual({ n: Number(linked) });
    expect(db.prepare("SELECT COUNT(*) AS n FROM semantic_entity_bindings").get()).toEqual({ n: linked ? 2 : 0 });
    db.close();
    expect(forbidden).not.toHaveBeenCalled();
  }, 20_000);

  it("makes no Gmail request with no anchors or invalid input", async () => {
    const { app, root, forbidden } = fixture("linked", false);
    const empty = await scan(app);
    expect(empty.statusCode, empty.body).toBe(200);
    expect(empty.json()).toMatchObject({ ok: true, scannedAnchorCount: 0, searchedMessageCount: 0 });
    expect(fs.existsSync(path.join(root, "gmail-searches.jsonl"))).toBe(false);
    const invalid = await app.inject({ method: "POST", url: "/v1/outcomes/gmail/scan",
      payload: { recipientEmail: 'candidate@example.com"}OR{from:other' } });
    expect(invalid.statusCode).toBe(400);
    expect(fs.existsSync(path.join(root, "gmail-searches.jsonl"))).toBe(false);
    expect(forbidden).not.toHaveBeenCalled();
  }, 20_000);

  it.each([
    ["provider_failure", "gmail_provider_unavailable"],
    ["model_unavailable", "provider_unavailable"],
  ])("reports %s as a safe typed failure", async (mode, failureCode) => {
    const { app, forbidden } = fixture(mode);
    const response = await scan(app);
    expect(response.statusCode, response.body).toBe(503);
    expect(response.json()).toMatchObject({ ok: false, error: "gmail_feedback_scan_failed", failureCode });
    expect(response.body).not.toContain(PRIVATE_BODY);
    expect(forbidden).not.toHaveBeenCalled();
  }, 20_000);
});
