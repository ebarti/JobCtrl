import { afterEach, describe, expect, it } from "vitest";
import Database from "better-sqlite3";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { buildApp } from "../src/server.js";
import { postingSourceCoordinate } from "../src/posting-source-proposals.js";
import { initializeExactDatabase } from "./exact-schema.js";

const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true }); });
const NOW = "2026-10-18T09:00:00Z";
const JOB_ID = "b0410000-0000-4000-8000-000000000001";
const evidence = {
  originJobId: JOB_ID, originPostingUrl: "https://boards.greenhouse.io/acme/jobs/123",
  inputUrl: "https://boards.greenhouse.io/acme/jobs/123", urlKind: "posting_url",
  observations: [{ observationId: "observation-1", sourceId: "manual_capture:extension", runId: "capture-run-1", observedUrl: "https://boards.greenhouse.io/acme/jobs/123", observedAt: NOW }],
  extraction: { tier: "json_ld", enrichedAt: NOW, snapshotVersion: 3, descriptionSha256: "saved-description-hash", snapshotSha256: "saved-snapshot-hash" },
  sample: { title: "Platform Engineer", company: "Synthetic Acme", descriptionExcerpt: "Build reliable synthetic systems." },
};

function workspace(allowPublic = true) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "jobctrl-1041-api-")); dirs.push(dir);
  const dbPath = path.join(dir, "jobctrl.db"); initializeExactDatabase(dbPath);
  const db = new Database(dbPath);
  const app = buildApp({ dbPath, configPath: path.join(dir, "config.json"), jobUrlValidator: async () => ({ allowed: allowPublic, reason: "Synthetic private DNS destination" }) });
  return { db, app };
}
function candidate(db: Database.Database, id = "candidate-history", url = "https://boards.greenhouse.io/acme") {
  db.prepare(`INSERT INTO source_locator_candidates (tenant_id, candidate_id, candidate_url, source_kind,
    confidence, detected_ats_kind, employer_domain_matched, manual_action_reason, discovered_at)
    VALUES ('local', ?, ?, 'ats_api', 0, 'greenhouse', 0, 'ambiguous_career_system', ?)`)
    .run(id, url, NOW);
}
function receipt(db: Database.Database, id = "candidate-history") {
  db.prepare(`INSERT INTO job_events (tenant_id, identity_version, stage, event_type, occurred_at, payload_json, entity_kind, entity_ref)
    VALUES ('local', 1, 'discover', 'SourceLocationCandidateDiscovered', ?, ?, 'discovery', 'https://boards.greenhouse.io/acme')`)
    .run(NOW, JSON.stringify({ candidateId: id, coordinateKey: "https://boards.greenhouse.io/acme", proposalOnly: true, evidence }));
}
function source(db: Database.Database, state = "active") {
  db.prepare(`INSERT INTO source_registry_entries (tenant_id, source_id, kind, display_name, owner,
    priority, state, policy_id, seed_url, created_at, updated_at)
    VALUES ('local', 'greenhouse:reviewed-alias', 'ats_api', 'Reviewed Acme', 'user',
    'preferred', ?, 'reviewed-policy', 'https://boards-api.greenhouse.io/v1/boards/acme/jobs', ?, ?)`)
    .run(state, NOW, NOW);
}

describe("posting-history source proposals", () => {
  it.each([
    ["https://boards-api.greenhouse.io/v1/boards/acme/jobs/1", "https://boards.greenhouse.io/acme"],
    ["https://job-boards.greenhouse.io/acme/jobs/2?gh_src=tracking", "https://boards.greenhouse.io/acme"],
    ["https://api.lever.co/v0/postings/acme/1", "https://jobs.lever.co/acme"],
    ["https://jobs.lever.co/acme/2/apply", "https://jobs.lever.co/acme"],
    ["https://api.eu.lever.co/v0/postings/acme/2", "https://jobs.eu.lever.co/acme"],
    ["https://api.ashbyhq.com/posting-api/job-board/Acme", "https://jobs.ashbyhq.com/Acme"],
    ["https://acme.wd5.myworkdayjobs.com/en-US/Careers/job/1", "https://acme.wd5.myworkdayjobs.com/Careers"],
    ["https://acme.wd5.myworkdayjobs.com/wday/cxs/acme/Careers/jobs", "https://acme.wd5.myworkdayjobs.com/Careers"],
  ])("parses literal board coordinates for %s", (url, expected) => {
    expect(postingSourceCoordinate(url)?.coordinateKey).toBe(expected);
  });

  it.each(["not a URL", "file:///tmp/job", "https://user:pass@jobs.lever.co/acme/1", "https://localhost/jobs",
    "https://127.0.0.1/job", "https://10.0.0.8/job", "http://169.254.169.254/latest", "https://[::1]/job",
    "https://[::ffff:127.0.0.1]/job", "https://2130706433/job", "https://0x7f000001/job", "https://127.1/job",
    "https://hiring.internal/job", "https://boards.greenhouse.io", "https://jobs.lever.co/acme%2fother/1",
    "https://jobs.lever.co:bogus/acme/1", "https://jobs.lever.co\\@localhost/acme"])("rejects malformed/private coordinate %s", (url) => {
    expect(postingSourceCoordinate(url)).toBeNull();
  });

  it.each([
    ["https://jobs.lever.co/acme/1", "https://jobs.eu.lever.co/acme/1"],
    ["https://boards.greenhouse.io/acme_team/jobs/1", "https://boards.greenhouse.io/acme-team/jobs/1"],
    ["https://www.example.com/job", "https://example.com/job"],
    ["https://foo.bar.com/job", "https://foo-bar.com/job"],
    ["https://acme.wd5.myworkdayjobs.com/Careers/job/1", "https://acme.wd5.myworkdayjobs.com/Students/job/1"],
  ])("keeps distinct literal board source IDs for %s and %s", (first, second) => {
    expect(postingSourceCoordinate(first)?.sourceId).not.toBe(postingSourceCoordinate(second)?.sourceId);
  });

  it("reads saved evidence and existing overlaps without any mutation", async () => {
    const { db, app } = workspace();
    try {
      candidate(db); receipt(db); source(db);
      const before = db.serialize();
      for (let read = 0; read < 2; read++) {
        const response = await app.inject({ method: "GET", url: "/v1/discovery/locator-candidates" });
        expect(response.statusCode, response.body).toBe(200);
        expect(response.json().candidates).toMatchObject([{ candidateId: "candidate-history", proposal: {
          coordinateKey: "https://boards.greenhouse.io/acme", sourceId: "greenhouse:acme", boardToken: "acme", completeness: "unknown",
          evidence: [evidence], overlaps: [{ sourceId: "greenhouse:reviewed-alias", state: "active" }],
        } }]);
      }
      expect(db.serialize()).toEqual(before);
    } finally { await app.close(); db.close(); }
  });

  it("records durable rejection with the reason and removes posting aliases atomically", async () => {
    const { db, app } = workspace();
    try {
      candidate(db); receipt(db); candidate(db, "posting-alias", "https://boards.greenhouse.io/acme/jobs/other");
      const response = await app.inject({ method: "POST", url: "/v1/discovery/locator-candidates/candidate-history/reject", payload: { reason: "Do not suggest this board again" } });
      expect(response.statusCode, response.body).toBe(200);
      expect(db.prepare("SELECT * FROM source_locator_candidates").all()).toEqual([]);
      const row = db.prepare("SELECT payload_json FROM job_events WHERE event_type = 'SourceLocationCandidateReviewed'").get() as { payload_json: string };
      expect(JSON.parse(row.payload_json)).toMatchObject({ coordinateKey: "https://boards.greenhouse.io/acme", decision: "reject", reason: "Do not suggest this board again" });
      expect(db.prepare("SELECT COUNT(*) AS n FROM source_registry_entries").get()).toEqual({ n: 0 });
    } finally { await app.close(); db.close(); }
  });

  it("preserves the candidate if the durable review receipt cannot be stored", async () => {
    const { db, app } = workspace();
    try {
      candidate(db); receipt(db);
      // Inject only receipt persistence failure; keep the sealed schema intact.
      const { rejectSourceLocatorCandidate } = await import("../src/discovery-controls.js");
      const realPrepare = db.prepare.bind(db);
      const prepare = db.prepare;
      db.prepare = ((sql: string) => {
        if (sql.includes("INSERT INTO job_events") && sql.includes("SourceLocationCandidateReviewed")) throw new Error("Synthetic receipt failure");
        return realPrepare(sql);
      }) as typeof db.prepare;
      expect(() => rejectSourceLocatorCandidate(db, "candidate-history")).toThrow("Synthetic receipt failure");
      db.prepare = prepare;
      expect(db.prepare("SELECT candidate_id FROM source_locator_candidates").all()).toEqual([{ candidate_id: "candidate-history" }]);
    } finally { await app.close(); db.close(); }
  });

  it("cannot enable a disabled overlap through proposal promotion", async () => {
    const { db, app } = workspace();
    try {
      candidate(db); receipt(db); source(db, "disabled");
      const before = db.serialize();
      const response = await app.inject({ method: "POST", url: "/v1/discovery/locator-candidates/candidate-history/promote", payload: {} });
      expect(response.statusCode, response.body).toBe(409);
      expect(db.serialize()).toEqual(before);
    } finally { await app.close(); db.close(); }
  });

  it("revalidates public destinations before enabling a reviewed source", async () => {
    const { db, app } = workspace(false);
    try {
      candidate(db); receipt(db);
      const before = db.serialize();
      const response = await app.inject({ method: "POST", url: "/v1/discovery/locator-candidates/candidate-history/promote", payload: {} });
      expect(response.statusCode, response.body).toBe(400);
      expect(response.json().error).toBe("invalid_source_candidate");
      expect(db.serialize()).toEqual(before);
    } finally { await app.close(); db.close(); }
  });

  it("explicit promotion reuses an existing source without rewriting its reviewed configuration", async () => {
    const { db, app } = workspace();
    try {
      candidate(db); receipt(db); source(db);
      const before = db.prepare("SELECT * FROM source_registry_entries").all();
      const response = await app.inject({ method: "POST", url: "/v1/discovery/locator-candidates/candidate-history/promote", payload: { reason: "Reviewed source overlap" } });
      expect(response.statusCode, response.body).toBe(200);
      expect(response.json().source).toMatchObject({ sourceId: "greenhouse:reviewed-alias", displayName: "Reviewed Acme", state: "active", policyId: "reviewed-policy" });
      expect(db.prepare("SELECT * FROM source_registry_entries").all()).toEqual(before);
      expect(db.prepare("SELECT * FROM source_locator_candidates").all()).toEqual([]);
    } finally { await app.close(); db.close(); }
  });
});
