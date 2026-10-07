import Database from "better-sqlite3";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { expect, it, vi } from "vitest";
import { buildApp } from "../src/server.js";
import { initializeExactDatabase } from "./exact-schema.js";
import { bindDecision, recordModelDecision } from "./semantic-fixtures.js";

it.each([
  ["budget_denied", 429],
  ["provider_unavailable", 503],
  ["provider_error", 502],
  ["malformed_json", 502],
  ["schema_violation", 502],
  ["foreign_source_id", 502],
  ["non_verbatim_quote", 502],
  ["mismatched_value", 502],
  ["authored_preferences_missing", 400],
  ["stale_profile_version", 409],
  ["stale_preferences_determination", 409],
  ["private provider source text", 503],
] as const)("preserves search-preference failure %s and accepted receipts", async (code, status) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "jobctrl-preference-failure-"));
  const filename = path.join(directory, "jobs.db");
  initializeExactDatabase(filename);
  const db = new Database(filename);
  const id = recordModelDecision(db, "search_preferences", "discovery:preferences", {
    roles: [], places: [], work_models: [], conditions: [], rationale: "Explicit synthetic proposal",
  });
  bindDecision(db, "confirmed_search_preferences", "discovery:preferences", "owned-version", "search_preferences", id);
  const before = db.prepare("SELECT * FROM semantic_determinations").all();
  const bindings = db.prepare("SELECT * FROM semantic_entity_bindings").all();
  const call = vi.fn(async () => ({
    jsonrpc: "2.0" as const, id: 1, error: { code: -32602, message: code },
  }));
  const app = buildApp({ dbPath: filename, configPath: path.join(directory, "config.json"),
    providerDispatcher: { call, close: async () => undefined },
  });
  try {
    const response = await app.inject({ method: "POST", url: "/v1/discovery/preferences",
      payload: { operation: "prepare", expectedProfileVersion: 1 },
    });
    expect(response.statusCode, response.body).toBe(status);
    expect(response.json()).toMatchObject({ ok: false,
      error: code === "private provider source text" ? "search_preferences_unavailable" : code,
    });
    expect(response.body).not.toContain("private provider source text");
    expect(call).toHaveBeenCalledTimes(1);
    expect(db.prepare("SELECT * FROM semantic_determinations").all()).toEqual(before);
    expect(db.prepare("SELECT * FROM semantic_entity_bindings").all()).toEqual(bindings);
  } finally {
    await app.close();
    db.close();
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

it("exposes a failed Gmail link and clears its status after a newer accepted attempt", async () => {
  const directory = fs.mkdtempSync(
    path.join(os.tmpdir(), "jobctrl-semantic-read-status-"),
  );
  const filename = path.join(directory, "jobs.db");
  initializeExactDatabase(filename);
  const db = new Database(filename);
  const app = buildApp({
    dbPath: filename,
    configPath: path.join(directory, "config.json"),
  });
  try {
    db.prepare(
      "INSERT INTO semantic_stage_states VALUES ('local','message-owned','message_link',?,'blocked','provider_unavailable',NULL,'2026-10-07T00:00:00Z')",
    ).run("a".repeat(64));
    const unavailable = await app.inject({
      method: "GET",
      url: "/v1/outcomes",
    });
    expect(unavailable.statusCode, unavailable.body).toBe(200);
    expect(unavailable.json()).toMatchObject({
      suggestions: [],
      interpretationStatus: {
        status: "unavailable",
        failureCode: "provider_unavailable",
      },
    });
    const accepted = recordModelDecision(db, "message_link", "message-owned", {
      decision: "unrelated",
      application_id: null,
      confidence: 0.9,
      citations: [
        {
          source_id: "message_headers",
          quote: "Synthetic header",
          exact_values: [],
        },
      ],
      rationale: "Explicit unrelated verdict",
    });
    db.prepare(
      "INSERT INTO semantic_stage_states VALUES ('local','message-owned','message_link',?,'accepted',NULL,?,'2026-10-07T00:01:00Z')",
    ).run(accepted, accepted);
    const recovered = await app.inject({ method: "GET", url: "/v1/outcomes" });
    expect(recovered.statusCode, recovered.body).toBe(200);
    expect(recovered.json()).toMatchObject({
      suggestions: [],
      interpretationStatus: { status: "not_requested", failureCode: null },
    });
    // A foreign tenant's failure cannot affect the local dashboard.
    db.prepare(
      "INSERT INTO semantic_stage_states VALUES ('foreign','message-foreign','message_link',?,'blocked','budget_denied',NULL,'2026-10-07T00:02:00Z')",
    ).run("c".repeat(64));
    expect(
      (await app.inject({ method: "GET", url: "/v1/outcomes" })).json()
        .interpretationStatus.failureCode,
    ).toBeNull();
  } finally {
    await app.close();
    db.close();
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
