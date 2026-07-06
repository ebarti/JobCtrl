import { describe, expect, it } from "vitest";
import Database from "better-sqlite3";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { buildApp } from "../src/server.js";
import type { ManualCaptureImportRequest } from "../src/contracts.js";
import { ManualCaptureImportError, type ManualCaptureImporter } from "../src/manual-capture-worker.js";

const CHROME_EXTENSION_ORIGIN = "chrome-extension://aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";

function withTempDb(): { dbPath: string; dir: string; cleanup: () => void } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "jobhunter-api-discovery-controls-"));
  const dbPath = path.join(dir, "jobs.db");
  const db = new Database(dbPath);
  db.exec(`
    CREATE TABLE jobs (
      url TEXT PRIMARY KEY,
      title TEXT,
      site TEXT,
      strategy TEXT,
      location TEXT,
      salary TEXT,
      discovered_at TEXT,
      application_url TEXT,
      description TEXT,
      full_description TEXT,
      detail_scraped_at TEXT,
      detail_error TEXT,
      fit_score INTEGER,
      score_reasoning TEXT,
      scored_at TEXT,
      tailored_resume_path TEXT,
      tailored_at TEXT,
      tailor_attempts INTEGER DEFAULT 0,
      cover_letter_path TEXT,
      cover_letter_at TEXT,
      cover_attempts INTEGER DEFAULT 0,
      applied_at TEXT,
      apply_status TEXT,
      apply_error TEXT
    );
    CREATE TABLE job_events (
      event_id INTEGER PRIMARY KEY AUTOINCREMENT,
      job_url TEXT,
      stage TEXT,
      event_type TEXT NOT NULL DEFAULT '',
      level TEXT,
      message TEXT,
      occurred_at TEXT NOT NULL,
      payload_json TEXT
    );
    CREATE TABLE job_source_observations (
      tenant_id TEXT NOT NULL DEFAULT 'local',
      source_observation_id TEXT NOT NULL,
      job_url TEXT NOT NULL,
      source_id TEXT NOT NULL,
      source_native_id TEXT NOT NULL,
      observed_url TEXT NOT NULL,
      normalized_observed_url TEXT NOT NULL,
      run_id TEXT NOT NULL DEFAULT '',
      observed_at TEXT NOT NULL,
      PRIMARY KEY (tenant_id, source_observation_id)
    );
  `);
  db.close();
  return {
    dbPath,
    dir,
    cleanup: () => fs.rmSync(dir, { recursive: true, force: true }),
  };
}

function options(dbPath: string, dir: string) {
  return {
    dbPath,
    settingsPath: path.join(dir, "dashboard.json"),
  };
}

function manualCaptureHtml(): string {
  const description =
    "Lead engineering teams building job search infrastructure with Python, TypeScript, observability, product strategy, hiring systems, and local-first automation. ".repeat(
      5,
    );
  return `
    <html>
      <head>
        <script type="application/ld+json">
        {
          "@type": "JobPosting",
          "title": "VP Engineering",
          "description": "${description}",
          "directApply": true,
          "url": "https://example.com/protected/job",
          "validThrough": "2999-01-01T00:00:00+00:00",
          "jobLocation": {
            "address": {
              "addressLocality": "Barcelona",
              "addressCountry": "Spain"
            }
          }
        }
        </script>
      </head>
      <body><main>${description}</main></body>
    </html>
  `;
}

describe("discovery product controls API", () => {
  it("stores runtime discovery settings in SQLite without dropping search contract fields", async () => {
    const { dbPath, dir, cleanup } = withTempDb();
    const app = buildApp(options(dbPath, dir));
    try {
      const db = new Database(dbPath);
      db.exec(`
        CREATE TABLE discovery_settings (
          tenant_id TEXT PRIMARY KEY,
          search_config_json TEXT NOT NULL,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL
        );
      `);
      db.prepare(
        `INSERT INTO discovery_settings (
           tenant_id, search_config_json, created_at, updated_at
         ) VALUES (?, ?, ?, ?)`,
      ).run(
        "local",
        JSON.stringify({
          boards: ["indeed"],
          defaults: { results_per_site: 25, hours_old: 48, country_indeed: "spain" },
          queries: [{ query: "Director of Engineering", tier: 1 }],
          locations: [{ label: "barcelona", location: "Barcelona, Spain", remote: false }],
        }),
        "2026-06-04T00:00:00+00:00",
        "2026-06-04T00:00:00+00:00",
      );
      db.close();

      const read = await app.inject({ method: "GET", url: "/v1/discovery/settings" });
      expect(read.statusCode, read.body).toBe(200);
      expect(read.json().settings).toMatchObject({
        boards: ["indeed"],
        resultsPerSite: 25,
        hoursOld: 48,
        source: "database",
      });

      const update = await app.inject({
        method: "PATCH",
        url: "/v1/discovery/settings",
        payload: {
          boards: ["linkedin", "zip_recruiter"],
          resultsPerSite: 100,
          hoursOld: 96,
        },
      });
      expect(update.statusCode, update.body).toBe(200);
      expect(update.json().settings).toMatchObject({
        boards: ["linkedin", "zip_recruiter"],
        resultsPerSite: 100,
        hoursOld: 96,
      });

      const after = new Database(dbPath);
      const row = after
        .prepare("SELECT search_config_json FROM discovery_settings WHERE tenant_id = ?")
        .get("local") as { search_config_json: string };
      after.close();
      const stored = JSON.parse(row.search_config_json);
      expect(stored).toMatchObject({
        boards: ["linkedin", "zip_recruiter"],
        defaults: { results_per_site: 100, hours_old: 96, country_indeed: "spain" },
        queries: [{ query: "Director of Engineering", tier: 1 }],
        locations: [{ label: "barcelona", location: "Barcelona, Spain", remote: false }],
      });
    } finally {
      await app.close();
      cleanup();
    }
  });

  it("upserts source registry entries and emits source registry events", async () => {
    const { dbPath, dir, cleanup } = withTempDb();
    const app = buildApp(options(dbPath, dir));
    try {
      const response = await app.inject({
        method: "POST",
        url: "/v1/discovery/sources",
        payload: {
          sourceId: "greenhouse-example",
          kind: "ats_api",
          displayName: "Greenhouse Example",
          priority: "canonical",
          state: "experimental",
          seedUrl: "https://example.com/careers",
        },
      });
      expect(response.statusCode, response.body).toBe(200);
      expect(response.json().source).toMatchObject({
        sourceId: "greenhouse-example",
        displayName: "Greenhouse Example",
        state: "experimental",
      });

      const list = await app.inject({ method: "GET", url: "/v1/discovery/sources" });
      expect(list.statusCode, list.body).toBe(200);
      expect(list.json().sources).toHaveLength(1);

      const db = new Database(dbPath);
      const event = db
        .prepare("SELECT event_type, payload_json FROM job_events ORDER BY event_id DESC LIMIT 1")
        .get() as { event_type: string; payload_json: string };
      db.close();
      expect(event.event_type).toBe("SourceRegistryEntryCreated");
      expect(JSON.parse(event.payload_json)).toMatchObject({
        sourceId: "greenhouse-example",
        kind: "ats_api",
        state: "experimental",
      });
    } finally {
      await app.close();
      cleanup();
    }
  });

  it("filters America-only source registry rows when profile target search is Europe-focused", async () => {
    const { dbPath, dir, cleanup } = withTempDb();
    const app = buildApp(options(dbPath, dir));
    try {
      await app.inject({ method: "GET", url: "/v1/discovery/sources" });
      const db = new Database(dbPath);
      db.exec(`
        CREATE TABLE candidate_profiles (
          tenant_id TEXT NOT NULL,
          profile_id TEXT NOT NULL,
          experience_target_locations TEXT NOT NULL,
          personal_city TEXT NOT NULL DEFAULT '',
          personal_country TEXT NOT NULL DEFAULT ''
        );
      `);
      db.prepare(
        `INSERT INTO candidate_profiles (
           tenant_id, profile_id, experience_target_locations, personal_city, personal_country
         ) VALUES (?, ?, ?, ?, ?)`,
      ).run("local", "default", "", "Barcelona", "Spain");
      const now = "2026-05-15T10:00:00+00:00";
      db.prepare(
        `INSERT INTO source_registry_entries (
           tenant_id, source_id, kind, display_name, owner, priority, state,
           policy_id, seed_url, created_at, updated_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        "local",
        "smart_extract:job-bank-canada",
        "smart_extract",
        "Job Bank Canada",
        "system",
        "fallback",
        "active",
        "smart_extract_experimental",
        "https://www.jobbank.gc.ca",
        now,
        now,
      );
      db.prepare(
        `INSERT INTO source_registry_entries (
           tenant_id, source_id, kind, display_name, owner, priority, state,
           policy_id, seed_url, created_at, updated_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        "local",
        "smart_extract:welcome-to-the-jungle",
        "smart_extract",
        "WelcomeToTheJungle",
        "system",
        "standard",
        "active",
        "smart_extract_experimental",
        "https://www.welcometothejungle.com/en/jobs",
        now,
        now,
      );
      db.prepare(
        `INSERT INTO source_quality_stats (
           tenant_id, source_id, window_start, window_end, recommended_state,
           run_count, failed_run_count, consecutive_failures, observed_jobs,
           new_jobs, existing_jobs, updated_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        "local",
        "smart_extract:dice",
        "2026-05-15T00:00:00+00:00",
        "2026-05-15T10:00:00+00:00",
        "active",
        1,
        0,
        0,
        5,
        5,
        0,
        now,
      );
      db.close();

      const list = await app.inject({ method: "GET", url: "/v1/discovery/sources" });
      expect(list.statusCode, list.body).toBe(200);
      const sourceIds = list.json().sources.map((source: { sourceId: string }) => source.sourceId);

      expect(sourceIds).not.toContain("smart_extract:job-bank-canada");
      expect(sourceIds).not.toContain("smart_extract:dice");
      expect(sourceIds).toContain("smart_extract:welcome-to-the-jungle");
    } finally {
      await app.close();
      cleanup();
    }
  });

  it("surfaces per-source politeness outcomes in the source registry list", async () => {
    const { dbPath, dir, cleanup } = withTempDb();
    const app = buildApp(options(dbPath, dir));
    try {
      // Ensure projection tables (including operational_attempt_metrics) exist.
      await app.inject({ method: "GET", url: "/v1/discovery/sources" });
      const now = "2026-05-16T10:00:00+00:00";
      const db = new Database(dbPath);
      db.prepare(
        `INSERT INTO source_registry_entries (
           tenant_id, source_id, kind, display_name, owner, priority, state,
           policy_id, seed_url, created_at, updated_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        "local",
        "greenhouse:acme",
        "ats_api",
        "Acme",
        "system",
        "canonical",
        "active",
        "local:greenhouse:acme",
        "https://boards.greenhouse.io/acme",
        now,
        now,
      );
      const insertBlocked = db.prepare(
        `INSERT INTO operational_attempt_metrics (
           tenant_id, occurred_at, stage, source_id, attempt_kind, outcome,
           failure_category, is_operational_failure, is_scrape_failure
         ) VALUES ('local', ?, ?, ?, 'politeness_gate', 'blocked', ?, 0, 0)`,
      );
      insertBlocked.run("2026-05-16T09:00:00Z", "discover", "greenhouse:acme", "robots_disallowed");
      insertBlocked.run("2026-05-16T09:05:00Z", "discover", "greenhouse:acme", "robots_disallowed");
      insertBlocked.run("2026-05-16T09:10:00Z", "discover", "greenhouse:acme", "budget_exhausted");
      db.close();

      const list = await app.inject({ method: "GET", url: "/v1/discovery/sources" });
      expect(list.statusCode, list.body).toBe(200);
      const source = list
        .json()
        .sources.find((entry: { sourceId: string }) => entry.sourceId === "greenhouse:acme");
      expect(source.politeness).toEqual({
        robotsDisallowedCount: 2,
        rateLimitedCount: 0,
        budgetExhaustedCount: 1,
        lastBlockedReason: "budget_exhausted",
        lastBlockedAt: "2026-05-16T09:10:00Z",
      });
    } finally {
      await app.close();
      cleanup();
    }
  });

  it("coalesces known Workday host aliases in the source registry list", async () => {
    const { dbPath, dir, cleanup } = withTempDb();
    const app = buildApp(options(dbPath, dir));
    try {
      await app.inject({ method: "GET", url: "/v1/discovery/sources" });
      const db = new Database(dbPath);
      const now = "2026-05-15T10:00:00+00:00";
      const insert = db.prepare(
        `INSERT INTO source_registry_entries (
           tenant_id, source_id, kind, display_name, owner, priority, state,
           policy_id, seed_url, created_at, updated_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      );
      insert.run(
        "local",
        "workday:acme",
        "ats_api",
        "Acme",
        "system",
        "canonical",
        "active",
        "workday_api_canonical",
        "https://acme.wd3.myworkdayjobs.com",
        now,
        now,
      );
      insert.run(
        "local",
        "workday:acme-wd3-myworkdayjobs-com",
        "ats_api",
        "acme.wd3.myworkdayjobs.com",
        "user",
        "canonical",
        "active",
        "workday_api_canonical",
        "https://acme.wd3.myworkdayjobs.com",
        now,
        now,
      );
      insert.run(
        "local",
        "workday:unknown-wd3-myworkdayjobs-com",
        "ats_api",
        "unknown.wd3.myworkdayjobs.com",
        "user",
        "canonical",
        "active",
        "workday_api_canonical",
        "https://unknown.wd3.myworkdayjobs.com",
        now,
        now,
      );
      db.close();

      const list = await app.inject({ method: "GET", url: "/v1/discovery/sources" });

      expect(list.statusCode, list.body).toBe(200);
      const sourceIds = list.json().sources.map((source: { sourceId: string }) => source.sourceId);
      expect(sourceIds).toContain("workday:acme");
      expect(sourceIds).not.toContain("workday:acme-wd3-myworkdayjobs-com");
      expect(sourceIds).toContain("workday:unknown-wd3-myworkdayjobs-com");
    } finally {
      await app.close();
      cleanup();
    }
  });

  it("records discovery feedback without copying the free-form note into domain events", async () => {
    const { dbPath, dir, cleanup } = withTempDb();
    const app = buildApp(options(dbPath, dir));
    try {
      const seedDb = new Database(dbPath);
      seedDb
        .prepare(
          "INSERT INTO job_events (job_url, stage, event_type, level, message, occurred_at, payload_json) VALUES (?, ?, ?, ?, ?, ?, ?)",
        )
        .run(
          null,
          "discover",
          "DiscoveryRunFailed",
          "error",
          "Discovery failed",
          "2026-05-12T10:00:00+00:00",
          JSON.stringify({
            run_id: "run-1",
            source_id: "greenhouse-example",
            error_class: "TimeoutError",
            retryable: true,
          }),
        );
      seedDb.close();

      const primed = await app.inject({ method: "GET", url: "/v1/dashboard/summary" });
      expect(primed.statusCode, primed.body).toBe(200);
      expect(primed.json().sourceHealth[0]).toMatchObject({
        sourceId: "greenhouse-example",
        lastErrorClass: "TimeoutError",
      });

      const response = await app.inject({
        method: "POST",
        url: "/v1/discovery/feedback",
        payload: {
          jobKey: "https://example.com/jobs/stale",
          sourceId: "greenhouse-example",
          kind: "bad_source",
          note: "private reviewer note",
        },
      });
      expect(response.statusCode, response.body).toBe(200);

      const dashboard = await app.inject({ method: "GET", url: "/v1/dashboard/summary" });
      expect(dashboard.statusCode, dashboard.body).toBe(200);
      expect(dashboard.json().sourceHealth[0]).toMatchObject({
        sourceId: "greenhouse-example",
        observedJobs: 1,
        lastErrorClass: "user_bad_source",
      });

      const db = new Database(dbPath);
      const event = db
        .prepare("SELECT payload_json FROM job_events WHERE event_type = 'DiscoveryFeedbackRecorded'")
        .get() as { payload_json: string };
      db.close();
      const payload = JSON.parse(event.payload_json);
      expect(payload).toMatchObject({
        jobId: "https://example.com/jobs/stale",
        sourceId: "greenhouse-example",
        kind: "bad_source",
      });
      expect(JSON.stringify(payload)).not.toContain("private reviewer note");
    } finally {
      await app.close();
      cleanup();
    }
  });

  it("promotes and rejects source locator candidates", async () => {
    const { dbPath, dir, cleanup } = withTempDb();
    const app = buildApp(options(dbPath, dir));
    try {
      await app.inject({ method: "GET", url: "/v1/discovery/locator-candidates" });
      const db = new Database(dbPath);
      db.prepare(
        `INSERT INTO source_locator_candidates (
           tenant_id, candidate_id, candidate_url, source_kind, confidence,
           detected_ats_kind, employer_domain_matched, manual_action_reason, discovered_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        "local",
        "candidate-1",
        "https://boards.greenhouse.io/acme",
        "employer_careers_page",
        0.86,
        "greenhouse",
        1,
        null,
        "2026-05-12T10:00:00+00:00",
      );
      db.prepare(
        `INSERT INTO source_locator_candidates (
           tenant_id, candidate_id, candidate_url, source_kind, confidence,
           detected_ats_kind, employer_domain_matched, manual_action_reason, discovered_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        "local",
        "candidate-2",
        "https://boards.greenhouse.io/contoso",
        "employer_careers_page",
        0.84,
        "greenhouse",
        1,
        null,
        "2026-05-12T10:05:00+00:00",
      );
      db.prepare(
        `INSERT INTO source_locator_candidates (
           tenant_id, candidate_id, candidate_url, source_kind, confidence,
           detected_ats_kind, employer_domain_matched, manual_action_reason, discovered_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        "local",
        "candidate-3",
        "https://bad.example.com/careers",
        "employer_careers_page",
        0.41,
        null,
        0,
        null,
        "2026-05-12T11:00:00+00:00",
      );
      db.close();

      const promoted = await app.inject({
        method: "POST",
        url: "/v1/discovery/locator-candidates/candidate-1/promote",
        payload: { reason: "reviewed" },
      });
      expect(promoted.statusCode, promoted.body).toBe(200);
      expect(promoted.json()).toMatchObject({
        candidateId: "candidate-1",
        decision: "promote",
        source: {
          sourceId: "greenhouse:acme",
          displayName: "boards.greenhouse.io",
          state: "active",
        },
      });

      const secondPromoted = await app.inject({
        method: "POST",
        url: "/v1/discovery/locator-candidates/candidate-2/promote",
        payload: { reason: "reviewed" },
      });
      expect(secondPromoted.statusCode, secondPromoted.body).toBe(200);
      expect(secondPromoted.json()).toMatchObject({
        candidateId: "candidate-2",
        decision: "promote",
        source: {
          sourceId: "greenhouse:contoso",
        },
      });

      const rejected = await app.inject({
        method: "POST",
        url: "/v1/discovery/locator-candidates/candidate-3/reject",
        payload: { reason: "not a careers site" },
      });
      expect(rejected.statusCode, rejected.body).toBe(200);
      expect(rejected.json()).toMatchObject({
        candidateId: "candidate-3",
        decision: "reject",
        source: null,
      });

      const candidates = await app.inject({ method: "GET", url: "/v1/discovery/locator-candidates" });
      expect(candidates.statusCode, candidates.body).toBe(200);
      expect(candidates.json().candidates).toEqual([]);

      const verifyDb = new Database(dbPath);
      const events = verifyDb
        .prepare("SELECT event_type, payload_json FROM job_events WHERE event_type = 'SourceLocationCandidatePromoted'")
        .all() as { event_type: string; payload_json: string }[];
      verifyDb.close();
      expect(events.map((event) => JSON.parse(event.payload_json).sourceId)).toEqual([
        "greenhouse:acme",
        "greenhouse:contoso",
      ]);
    } finally {
      await app.close();
      cleanup();
    }
  });

  it("auto-promotes parseable source locator candidates when listing review queue", async () => {
    const { dbPath, dir, cleanup } = withTempDb();
    const app = buildApp(options(dbPath, dir));
    try {
      await app.inject({ method: "GET", url: "/v1/discovery/locator-candidates" });
      const db = new Database(dbPath);
      db.prepare(
        `INSERT INTO source_locator_candidates (
           tenant_id, candidate_id, candidate_url, source_kind, confidence,
           detected_ats_kind, employer_domain_matched, manual_action_reason, discovered_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        "local",
        "candidate-parseable",
        "https://remoteok.com/remote-dev-jobs",
        "smart_extract",
        0.55,
        null,
        0,
        null,
        "2026-05-12T10:00:00+00:00",
      );
      db.prepare(
        `INSERT INTO source_locator_candidates (
           tenant_id, candidate_id, candidate_url, source_kind, confidence,
           detected_ats_kind, employer_domain_matched, manual_action_reason, discovered_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        "local",
        "candidate-blocked",
        "https://jobs.lever.co/private/123",
        "ats_api",
        0.95,
        "lever",
        0,
        "login_required",
        "2026-05-12T10:05:00+00:00",
      );
      db.close();

      const response = await app.inject({ method: "GET", url: "/v1/discovery/locator-candidates" });
      expect(response.statusCode, response.body).toBe(200);
      expect(response.json().candidates).toHaveLength(1);
      expect(response.json().candidates[0]).toMatchObject({ candidateId: "candidate-blocked" });

      const verifyDb = new Database(dbPath);
      const source = verifyDb
        .prepare("SELECT source_id, state, seed_url FROM source_registry_entries WHERE source_id = ?")
        .get("smart_extract:remoteok-com") as { source_id: string; state: string; seed_url: string };
      const parseableCandidate = verifyDb
        .prepare("SELECT 1 FROM source_locator_candidates WHERE candidate_id = ?")
        .get("candidate-parseable");
      verifyDb.close();
      expect(source).toMatchObject({
        source_id: "smart_extract:remoteok-com",
        state: "active",
        seed_url: "https://remoteok.com/remote-dev-jobs",
      });
      expect(parseableCandidate).toBeUndefined();
    } finally {
      await app.close();
      cleanup();
    }
  });

  it("builds discovery preview from observed source history instead of quarantine residue", async () => {
    const { dbPath, dir, cleanup } = withTempDb();
    const app = buildApp(options(dbPath, dir));
    try {
      await app.inject({ method: "GET", url: "/v1/discovery/sources" });
      const db = new Database(dbPath);
      db.prepare(
        "INSERT INTO jobs (url, title, site, location, discovered_at) VALUES (?, ?, ?, ?, ?)",
      ).run(
        "https://example.com/jobs/1",
        "Product Engineer",
        "ExampleCo",
        "Remote",
        "2026-05-12T10:00:00+00:00",
      );
      db.prepare(
        `INSERT INTO job_source_observations (
           tenant_id, source_observation_id, job_url, source_id, source_native_id,
           observed_url, normalized_observed_url, run_id, observed_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        "local",
        "observation-1",
        "https://example.com/jobs/1",
        "greenhouse:example-com",
        "native-1",
        "https://example.com/jobs/1",
        "https://example.com/jobs/1",
        "run-1",
        "2026-05-12T10:01:00+00:00",
      );
      db.prepare(
        `INSERT INTO discovery_quarantine_entries (
           tenant_id, job_id, job_key, title, company, source_id, posting_url,
           reason, confidence, snapshot_version, captured_at, notice_text, status
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        "local",
        "quarantine-1",
        "https://example.com/jobs/quarantined",
        "Quarantined Lead",
        "ExampleCo",
        "greenhouse:example-com",
        "https://example.com/jobs/quarantined",
        "unknown_active_state",
        0.4,
        1,
        "2026-05-12T09:00:00+00:00",
        null,
        "pending",
      );
      db.close();

      const response = await app.inject({
        method: "GET",
        url: "/v1/discovery/sources/greenhouse%3Aexample-com/preview",
      });
      expect(response.statusCode, response.body).toBe(200);
      expect(response.json().leads).toEqual([
        {
          candidateUrl: "https://example.com/jobs/1",
          title: "Product Engineer",
          company: "ExampleCo",
          location: "Remote",
          estimatedConfidence: 1,
        },
      ]);
      expect(JSON.stringify(response.json())).not.toContain("Quarantined Lead");
    } finally {
      await app.close();
      cleanup();
    }
  });

  it("delegates manual capture imports to the worker pipeline", async () => {
    const { dbPath, dir, cleanup } = withTempDb();
    const calls: Array<{
      itemId: string;
      input: ManualCaptureImportRequest;
      context: { appDir: string; dbPath: string };
    }> = [];
    const manualCaptureImporter: ManualCaptureImporter = async (itemId, input, context) => {
      calls.push({ itemId, input, context });
      return {
        ok: true,
        itemId,
        jobKey: input.capturedUrl ?? "https://example.com/protected/job",
        importedAt: "2026-05-12T10:05:00+00:00",
        provenance: {
          sourceKind: "user_mediated_capture",
          originatingUrl: "https://example.com/protected/job",
          captureMode: input.captureMode,
          futureManualActionRequired: input.futureManualActionRequired,
        },
      };
    };
    const app = buildApp({ ...options(dbPath, dir), manualCaptureImporter });
    try {
      await app.inject({ method: "GET", url: "/v1/discovery/manual-capture" });
      const db = new Database(dbPath);
      db.prepare(
        `INSERT INTO manual_capture_queue (
           tenant_id, item_id, originating_url, source_id, reason,
           retry_context_json, required_at, status
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        "local",
        "manual-1",
        "https://example.com/protected/job",
        "greenhouse-example",
        "login_required",
        "{}",
        "2026-05-12T10:00:00+00:00",
        "pending",
      );
      db.close();

      const response = await app.inject({
        method: "POST",
        url: "/v1/discovery/manual-capture/manual-1/import",
        payload: {
          captureMode: "pasted_text",
          capturedUrl: "https://example.com/protected/job",
          contentText: "Visible user-provided posting text.",
          futureManualActionRequired: true,
        },
      });
      expect(response.statusCode, response.body).toBe(200);
      expect(response.json()).toMatchObject({
        itemId: "manual-1",
        jobKey: "https://example.com/protected/job",
        provenance: {
          sourceKind: "user_mediated_capture",
          captureMode: "pasted_text",
          futureManualActionRequired: true,
        },
      });
      expect(calls).toEqual([
        {
          itemId: "manual-1",
          input: {
            captureMode: "pasted_text",
            capturedUrl: "https://example.com/protected/job",
            contentText: "Visible user-provided posting text.",
            futureManualActionRequired: true,
          },
          context: { appDir: dir, dbPath },
        },
      ]);

      const verifyDb = new Database(dbPath);
      const row = verifyDb
        .prepare(
          "SELECT status, content_sha256, content_length, captured_url FROM manual_capture_queue WHERE item_id = ?",
        )
        .get("manual-1") as {
        status: string;
        content_sha256: string | null;
        content_length: number | null;
        captured_url: string | null;
      };
      const events = verifyDb
        .prepare("SELECT COUNT(*) AS count FROM job_events WHERE event_type = 'PostingContentSnapshotCaptured'")
        .get() as { count: number };
      verifyDb.close();
      expect(row.status).toBe("pending");
      expect(row.content_sha256).toBeNull();
      expect(row.content_length).toBeNull();
      expect(row.captured_url).toBeNull();
      expect(events.count).toBe(0);
    } finally {
      await app.close();
      cleanup();
    }
  });

  it("seeds extension captures into the manual capture queue before worker import", async () => {
    const { dbPath, dir, cleanup } = withTempDb();
    const calls: Array<{
      itemId: string;
      input: ManualCaptureImportRequest;
      retryContext: Record<string, unknown>;
    }> = [];
    const manualCaptureImporter: ManualCaptureImporter = async (itemId, input, context) => {
      const db = new Database(context.dbPath);
      const row = db
        .prepare(
          `SELECT originating_url, source_id, reason, retry_context_json, status
           FROM manual_capture_queue
           WHERE tenant_id = ? AND item_id = ?`,
        )
        .get("local", itemId) as {
        originating_url: string;
        source_id: string;
        reason: string;
        retry_context_json: string;
        status: string;
      };
      const source = db
        .prepare(
          `SELECT source_id, kind, display_name, state
           FROM source_registry_entries
           WHERE tenant_id = ? AND source_id = ?`,
        )
        .get("local", "manual_capture:extension") as {
        source_id: string;
        kind: string;
        display_name: string;
        state: string;
      };
      db.close();
      const retryContext = JSON.parse(row.retry_context_json) as Record<string, unknown>;
      calls.push({ itemId, input, retryContext });
      expect(row).toMatchObject({
        originating_url: "https://example.com/jobs/extension?utm_source=newsletter",
        source_id: "manual_capture:extension",
        reason: "browser_extension_capture",
        status: "pending",
      });
      expect(source).toMatchObject({
        source_id: "manual_capture:extension",
        kind: "user_mediated_capture",
        display_name: "Browser extension",
        state: "active",
      });
      expect(retryContext).toMatchObject({
        source: "browser_extension",
        capture_client: "browser_extension",
        extension_version: "0.3.0",
      });
      return {
        ok: true,
        itemId,
        jobKey: input.capturedUrl ?? null,
        importedAt: "2026-07-05T10:05:00+00:00",
        provenance: {
          sourceKind: "user_mediated_capture",
          originatingUrl: row.originating_url,
          captureMode: input.captureMode,
          futureManualActionRequired: input.futureManualActionRequired,
          captureClient: "browser_extension",
          extensionVersion: "0.3.0",
        },
      };
    };
    const app = buildApp({ ...options(dbPath, dir), manualCaptureImporter });
    try {
      const unauthorized = await app.inject({
        method: "POST",
        url: "/v1/extension/captures",
        headers: {
          origin: CHROME_EXTENSION_ORIGIN,
          "sec-fetch-site": "cross-site",
        },
        payload: {
          originatingUrl: "https://example.com/jobs/extension",
          captureMode: "current_page",
          capturedUrl: "https://example.com/jobs/extension",
          contentText: "Visible user-provided posting text.",
        },
      });
      expect(unauthorized.statusCode, unauthorized.body).toBe(403);
      expect(calls).toHaveLength(0);

      const tokenResponse = await app.inject({ method: "GET", url: "/v1/extension/pairing-token" });
      const token = (tokenResponse.json() as { token: string }).token;
      const response = await app.inject({
        method: "POST",
        url: "/v1/extension/captures",
        headers: {
          origin: CHROME_EXTENSION_ORIGIN,
          authorization: `Bearer ${token}`,
          "sec-fetch-site": "cross-site",
        },
        payload: {
          originatingUrl: "https://example.com/jobs/extension?utm_source=newsletter",
          captureMode: "current_page",
          capturedUrl: "https://example.com/jobs/extension?utm_source=newsletter",
          contentText: "Visible user-provided posting text.",
          extensionVersion: "0.3.0",
        },
      });

      expect(response.statusCode, response.body).toBe(200);
      expect(response.headers["access-control-allow-origin"]).toBe(CHROME_EXTENSION_ORIGIN);
      expect(response.json()).toMatchObject({
        jobKey: "https://example.com/jobs/extension?utm_source=newsletter",
        provenance: {
          sourceKind: "user_mediated_capture",
          captureMode: "current_page",
          futureManualActionRequired: false,
          captureClient: "browser_extension",
          extensionVersion: "0.3.0",
        },
      });
      expect(calls).toHaveLength(1);
      expect(calls[0]?.input).toEqual({
        captureMode: "current_page",
        capturedUrl: "https://example.com/jobs/extension?utm_source=newsletter",
        contentText: "Visible user-provided posting text.",
        futureManualActionRequired: false,
      });
    } finally {
      await app.close();
      cleanup();
    }
  });

  it("keeps extension capture retries idempotent when import fails after seeding", async () => {
    const { dbPath, dir, cleanup } = withTempDb();
    const itemIds: string[] = [];
    const manualCaptureImporter: ManualCaptureImporter = async (itemId) => {
      itemIds.push(itemId);
      throw new ManualCaptureImportError("simulated importer failure", 500);
    };
    const app = buildApp({ ...options(dbPath, dir), manualCaptureImporter });
    try {
      const tokenResponse = await app.inject({ method: "GET", url: "/v1/extension/pairing-token" });
      const token = (tokenResponse.json() as { token: string }).token;
      const request = {
        method: "POST" as const,
        url: "/v1/extension/captures",
        headers: {
          origin: CHROME_EXTENSION_ORIGIN,
          authorization: `Bearer ${token}`,
          "sec-fetch-site": "cross-site",
        },
        payload: {
          captureId: "retry-capture-1",
          originatingUrl: "https://example.com/jobs/retry",
          captureMode: "current_page",
          capturedUrl: "https://example.com/jobs/retry",
          contentText: "Visible user-provided posting text.",
          extensionVersion: "0.3.0",
        },
      };

      const first = await app.inject(request);
      const second = await app.inject(request);

      expect(first.statusCode, first.body).toBe(500);
      expect(second.statusCode, second.body).toBe(500);
      expect(itemIds).toHaveLength(2);
      expect(new Set(itemIds).size).toBe(1);

      const verifyDb = new Database(dbPath);
      const rows = verifyDb
        .prepare(
          `SELECT item_id, status, originating_url
           FROM manual_capture_queue
           WHERE source_id = ?
           ORDER BY item_id`,
        )
        .all("manual_capture:extension") as Array<{
        item_id: string;
        status: string;
        originating_url: string;
      }>;
      verifyDb.close();
      expect(rows).toEqual([
        {
          item_id: itemIds[0],
          status: "pending",
          originating_url: "https://example.com/jobs/retry",
        },
      ]);
    } finally {
      await app.close();
      cleanup();
    }
  });

  it("returns imported extension capture replays without calling the pending importer", async () => {
    const { dbPath, dir, cleanup } = withTempDb();
    const itemIds: string[] = [];
    const importedAt = "2026-07-05T10:05:00+00:00";
    const manualCaptureImporter: ManualCaptureImporter = async (itemId, input, context) => {
      itemIds.push(itemId);
      const db = new Database(context.dbPath);
      const retryContext = {
        source: "browser_extension",
        capture_client: "browser_extension",
        extension_version: "0.3.0",
        manual_capture_provenance: {
          source_kind: "user_mediated_capture",
          originating_url: "https://example.com/jobs/replay",
          source_id: "manual_capture:extension",
          capture_mode: input.captureMode,
          captured_at: importedAt,
          future_manual_action_required: input.futureManualActionRequired,
          capture_client: "browser_extension",
          extension_version: "0.3.0",
        },
      };
      db.prepare(
        `UPDATE manual_capture_queue
         SET status = 'imported',
             imported_at = ?,
             capture_mode = ?,
             captured_url = ?,
             content_sha256 = ?,
             content_length = ?,
             future_manual_action_required = ?,
             retry_context_json = ?,
             job_key = ?
         WHERE tenant_id = ? AND item_id = ?`,
      ).run(
        importedAt,
        input.captureMode,
        input.capturedUrl,
        "a".repeat(64),
        input.contentText?.length ?? 0,
        input.futureManualActionRequired ? 1 : 0,
        JSON.stringify(retryContext),
        input.capturedUrl,
        "local",
        itemId,
      );
      db.close();
      return {
        ok: true,
        itemId,
        jobKey: input.capturedUrl ?? null,
        importedAt,
        provenance: {
          sourceKind: "user_mediated_capture",
          originatingUrl: "https://example.com/jobs/replay",
          captureMode: input.captureMode,
          futureManualActionRequired: input.futureManualActionRequired,
          captureClient: "browser_extension",
          extensionVersion: "0.3.0",
        },
      };
    };
    const app = buildApp({ ...options(dbPath, dir), manualCaptureImporter });
    try {
      const tokenResponse = await app.inject({ method: "GET", url: "/v1/extension/pairing-token" });
      const token = (tokenResponse.json() as { token: string }).token;
      const request = {
        method: "POST" as const,
        url: "/v1/extension/captures",
        headers: {
          origin: CHROME_EXTENSION_ORIGIN,
          authorization: `Bearer ${token}`,
          "sec-fetch-site": "cross-site",
        },
        payload: {
          captureId: "successful-replay-capture-1",
          originatingUrl: "https://example.com/jobs/replay",
          captureMode: "current_page",
          capturedUrl: "https://example.com/jobs/replay",
          contentText: "Visible user-provided posting text.",
          extensionVersion: "0.3.0",
        },
      };

      const first = await app.inject(request);
      const second = await app.inject(request);

      expect(first.statusCode, first.body).toBe(200);
      expect(second.statusCode, second.body).toBe(200);
      expect(itemIds).toHaveLength(1);
      expect(second.json()).toEqual(first.json());
    } finally {
      await app.close();
      cleanup();
    }
  });

  it("returns dismissed extension capture replays without reopening or calling the importer", async () => {
    const { dbPath, dir, cleanup } = withTempDb();
    const itemIds: string[] = [];
    const manualCaptureImporter: ManualCaptureImporter = async (itemId) => {
      itemIds.push(itemId);
      throw new ManualCaptureImportError("simulated importer failure", 500);
    };
    const app = buildApp({ ...options(dbPath, dir), manualCaptureImporter });
    try {
      const tokenResponse = await app.inject({ method: "GET", url: "/v1/extension/pairing-token" });
      const token = (tokenResponse.json() as { token: string }).token;
      const request = {
        method: "POST" as const,
        url: "/v1/extension/captures",
        headers: {
          origin: CHROME_EXTENSION_ORIGIN,
          authorization: `Bearer ${token}`,
          "sec-fetch-site": "cross-site",
        },
        payload: {
          captureId: "dismissed-replay-capture-1",
          originatingUrl: "https://example.com/jobs/dismissed",
          captureMode: "current_page",
          capturedUrl: "https://example.com/jobs/dismissed",
          contentText: "Visible user-provided posting text.",
          extensionVersion: "0.3.0",
        },
      };

      const seeded = await app.inject(request);
      expect(seeded.statusCode, seeded.body).toBe(500);
      expect(itemIds).toHaveLength(1);
      const dismissedAt = "2026-07-05T10:10:00+00:00";
      const db = new Database(dbPath);
      db.prepare(
        `UPDATE manual_capture_queue
         SET status = 'dismissed', dismissed_at = ?
         WHERE tenant_id = ? AND item_id = ?`,
      ).run(dismissedAt, "local", itemIds[0]);
      db.close();

      const replay = await app.inject(request);

      expect(replay.statusCode, replay.body).toBe(200);
      expect(replay.json()).toEqual({
        ok: true,
        itemId: itemIds[0],
        jobKey: null,
        status: "dismissed",
        dismissedAt,
        message: "Capture was already dismissed in JobHunter.",
      });
      expect(itemIds).toHaveLength(1);
    } finally {
      await app.close();
      cleanup();
    }
  });

  it("runs the default manual capture importer through the worker pipeline", async () => {
    const { dbPath, dir, cleanup } = withTempDb();
    const app = buildApp(options(dbPath, dir));
    try {
      await app.inject({ method: "GET", url: "/v1/discovery/manual-capture" });
      const db = new Database(dbPath);
      db.prepare(
        `INSERT INTO manual_capture_queue (
           tenant_id, item_id, originating_url, source_id, reason,
           retry_context_json, required_at, status
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        "local",
        "manual-2",
        "https://example.com/protected/job",
        "greenhouse-example",
        "login_required",
        "{}",
        "2026-05-12T10:00:00+00:00",
        "pending",
      );
      db.close();

      const contentText = manualCaptureHtml().trim();
      const response = await app.inject({
        method: "POST",
        url: "/v1/discovery/manual-capture/manual-2/import",
        payload: {
          captureMode: "saved_html",
          capturedUrl: "https://example.com/protected/job",
          contentText,
          futureManualActionRequired: true,
        },
      });
      expect(response.statusCode, response.body).toBe(200);
      expect(response.json()).toMatchObject({
        itemId: "manual-2",
        jobKey: "https://example.com/protected/job",
        provenance: {
          sourceKind: "user_mediated_capture",
          captureMode: "saved_html",
          futureManualActionRequired: true,
        },
      });

      const verifyDb = new Database(dbPath);
      const row = verifyDb
        .prepare(
          "SELECT status, content_sha256, content_length, captured_url, retry_context_json FROM manual_capture_queue WHERE item_id = ?",
        )
        .get("manual-2") as {
        status: string;
        content_sha256: string;
        content_length: number;
        captured_url: string;
        retry_context_json: string;
      };
      const job = verifyDb
        .prepare("SELECT title, strategy FROM jobs WHERE url = ?")
        .get("https://example.com/protected/job") as { title: string; strategy: string };
      const observation = verifyDb
        .prepare("SELECT source_id FROM job_source_observations WHERE job_url = ?")
        .get("https://example.com/protected/job") as { source_id: string };
      const enrichment = verifyDb
        .prepare("SELECT current_status, extraction_tier FROM job_enrichments WHERE job_url = ?")
        .get("https://example.com/protected/job") as { current_status: string; extraction_tier: string };
      const snapshot = verifyDb
        .prepare("SELECT latest_snapshot_version, latest_active_state FROM posting_snapshot_sets WHERE job_url = ?")
        .get("https://example.com/protected/job") as {
        latest_snapshot_version: number;
        latest_active_state: string;
      };
      verifyDb.close();

      expect(row.status).toBe("imported");
      expect(row.content_sha256).toHaveLength(64);
      expect(row.content_length).toBe(contentText.trim().length);
      expect(row.captured_url).toBe("https://example.com/protected/job");
      expect(JSON.parse(row.retry_context_json).manual_capture_provenance).toMatchObject({
        source_kind: "user_mediated_capture",
        capture_mode: "saved_html",
      });
      expect(job).toMatchObject({ title: "VP Engineering", strategy: "manual" });
      expect(observation.source_id).toBe("greenhouse-example");
      expect(enrichment).toMatchObject({ current_status: "enriched", extraction_tier: "json_ld" });
      expect(snapshot).toMatchObject({ latest_snapshot_version: 1, latest_active_state: "active" });
      expect(JSON.stringify(row)).not.toContain("Lead engineering teams");
    } finally {
      await app.close();
      cleanup();
    }
  });
});
