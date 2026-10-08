import Database from "better-sqlite3";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { expect, it, vi } from "vitest";
import { buildApp } from "../src/server.js";
import { initializeExactDatabase } from "./exact-schema.js";
import { bindDecision, recordModelDecision } from "./semantic-fixtures.js";

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
