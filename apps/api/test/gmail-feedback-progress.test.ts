import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";

import { GmailOutcomeScanFailureSchema } from "../src/contracts.js";
import { SubprocessJsonRpcAdapter } from "../src/json-rpc-adapter.js";
import { AUTOMATION_PROJECT_DIR, type PythonRuntimeCommandResolver } from "../src/python-runtime.js";
import { buildApp } from "../src/server.js";

const JOB_ID = "3f2504e0-4f89-41d3-9a0c-0305e82c3301";
const PRIVATE_CANARY = "owned private message and note canary";

describe("Gmail feedback committed progress", () => {
  it("preserves a committed prefix over the registered RPC and HTTP boundary and deduplicates retry", async () => {
    const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "jobctrl-gmail-progress-"));
    const dbPath = path.join(workspace, "jobctrl.db");
    const python = process.env.JOBCTRL_GMAIL_QA_PYTHON ?? path.join(AUTOMATION_PROJECT_DIR, ".venv", "bin", "python");
    const env: NodeJS.ProcessEnv = {
      PATH: process.env.PATH,
      HOME: workspace,
      JOBCTRL_DIR: workspace,
      JOBCTRL_CONFIG_PATH: path.join(workspace, "config.json"),
      JOBCTRL_RUNTIME_MODE: "source",
      LANGFUSE_DISABLE: "1",
      PYTHONPATH: [path.join(AUTOMATION_PROJECT_DIR, "src"), AUTOMATION_PROJECT_DIR].join(path.delimiter),
    };
    const seed = spawnSync(python, ["-m", "tests.gmail_feedback_progress_rpc", "seed"], {
      cwd: AUTOMATION_PROJECT_DIR, env, encoding: "utf8", timeout: 20_000,
    });
    expect(seed.status, seed.stderr).toBe(0);
    const runtime: PythonRuntimeCommandResolver = {
      id: "gmail-feedback-progress-fixture",
      resolve: () => ({
        executable: python, argv: ["-m", "tests.gmail_feedback_progress_rpc"],
        cwd: AUTOMATION_PROJECT_DIR, env,
      }),
    };
    const dispatcher = new SubprocessJsonRpcAdapter({ appDir: workspace, pythonRuntime: runtime, requestTimeoutMs: 20_000 });
    const app = buildApp({
      dbPath, configPath: path.join(workspace, "config.json"), providerDispatcher: dispatcher,
      requireHealthyWorkerForActions: false,
    });
    try {
      const failed = await app.inject({
        method: "POST", url: "/v1/outcomes/gmail/scan", payload: { limit: 1 },
      });
      expect(failed.statusCode, failed.body).toBe(503);
      expect(GmailOutcomeScanFailureSchema.safeParse(failed.json()).success).toBe(true);
      expect(failed.json()).toMatchObject({
        ok: false, status: "unavailable", failureCode: "gmail_transport_error",
        progress: {
          scannedAnchorCount: 1, searchedMessageCount: 2, linkedEvidenceCount: 1,
          suggestionsCreatedCount: 1, duplicateMessageCount: 0,
        },
      });
      expect(failed.body).not.toContain(PRIVATE_CANARY);
      const firstEvidence = failed.json().progress.evidence[0].evidenceId as string;
      const firstSuggestion = failed.json().progress.suggestions[0].suggestionId as string;

      const read = await app.inject({ method: "GET", url: `/v1/jobs/${JOB_ID}/outcomes` });
      expect(read.statusCode, read.body).toBe(200);
      expect(read.json().suggestions.map((item: { suggestionId: string }) => item.suggestionId)).toContain(firstSuggestion);

      const retry = await app.inject({ method: "POST", url: "/v1/outcomes/gmail/scan", payload: { limit: 1 } });
      expect(retry.statusCode, retry.body).toBe(200);
      expect(retry.json()).toMatchObject({ ok: true, duplicateMessageCount: 1, linkedEvidenceCount: 1, suggestionsCreatedCount: 1 });
      expect(retry.body).not.toContain(PRIVATE_CANARY);

      const db = new Database(dbPath, { readonly: true });
      try {
        const evidence = db.prepare("SELECT evidence_id, provider_message_id FROM application_email_evidence").all() as
          { evidence_id: string; provider_message_id: string }[];
        const suggestions = db.prepare("SELECT suggestion_id, evidence_id FROM application_outcome_suggestions").all() as
          { suggestion_id: string; evidence_id: string }[];
        expect(evidence).toHaveLength(2);
        expect(suggestions).toHaveLength(2);
        expect(evidence.find((row) => row.provider_message_id === "first")?.evidence_id).toBe(firstEvidence);
        expect(suggestions.find((row) => row.evidence_id === firstEvidence)?.suggestion_id).toBe(firstSuggestion);
        const events = db.prepare("SELECT message, payload_json FROM job_events").all();
        expect(JSON.stringify(events)).not.toContain(PRIVATE_CANARY);
      } finally {
        db.close();
      }
    } finally {
      await app.close();
      await dispatcher.close();
      fs.rmSync(workspace, { recursive: true, force: true });
    }
  });
});
