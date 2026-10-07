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

it("reads intake decisions against captured saved settings without a second model interpretation", async () => {
  const directory = fs.mkdtempSync(
    path.join(os.tmpdir(), "jobctrl-saved-target-receipt-"),
  );
  const filename = path.join(directory, "jobs.db");
  initializeExactDatabase(filename);
  const db = new Database(filename);
  const call = vi.fn(async () => {
    throw new Error("No provider call belongs in this read");
  });
  const app = buildApp({
    dbPath: filename,
    configPath: path.join(directory, "config.json"),
    providerDispatcher: { call, close: async () => undefined },
  });
  const listing = {
    listing_id: "owned-listing",
    source_id: "owned-board",
    url: "https://example.test/owned",
    title: "Synthetic title",
    company: "Synthetic employer",
    location: "Synthetic location",
    remote: null,
  };
  const sources = [{ source_id: "target:roles:0", text: "First saved target" }];
  const receipt = recordModelDecision(
    db,
    "posting_triage",
    "discovery:intake",
    {
      listings: [
        {
          listing_id: listing.listing_id,
          verdict: "admit",
          reason_code: "compatible",
          rationale: "Explicit model decision",
          citations: [
            {
              source_id: sources[0]!.source_id,
              quote: sources[0]!.text,
              exact_values: [],
            },
          ],
        },
      ],
    },
  );
  db.prepare(
    "INSERT INTO posting_triage (tenant_id,listing_id,snapshot_fingerprint,target_fingerprint,source_id,listing_json,status,reason_code,determination_id,created_at) VALUES ('local',?,?,?,?,?,'admit','compatible',?,?)",
  ).run(
    listing.listing_id,
    "a".repeat(64),
    "b".repeat(64),
    listing.source_id,
    JSON.stringify({ listing, target_sources: sources, profile_version: 7 }),
    receipt,
    "2026-10-07T00:00:00Z",
  );
  try {
    const response = await app.inject({
      method: "GET",
      url: "/v1/discovery/triage",
    });
    expect(response.statusCode, response.body).toBe(200);
    expect(response.json().rows[0]).toMatchObject({
      status: "admit",
      targetProfileVersion: 7,
      targetSources: sources,
      determination: { determination_id: receipt },
    });
    expect(call).not.toHaveBeenCalled();
    const wrongSources = [
      { source_id: "target:roles:0", text: "A different saved target" },
    ];
    db.prepare("UPDATE posting_triage SET listing_json=?").run(
      JSON.stringify({
        listing,
        target_sources: wrongSources,
        profile_version: 8,
      }),
    );
    const invalid = await app.inject({
      method: "GET",
      url: "/v1/discovery/triage",
    });
    expect(invalid.statusCode).toBe(500);
    expect(call).not.toHaveBeenCalled();
  } finally {
    await app.close();
    db.close();
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
