import { readFileSync } from "node:fs";

import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  assertLiveApplicationMayDispatch,
  ensureRepeatApplicationTables,
  evaluateRepeatApplication,
  normalizeEmployer,
  normalizeRoleTitle,
  recordRepeatApplicationOverride,
  repeatEvidenceFingerprint,
} from "../src/repeat-application.js";

const PRIOR = "https://jobs.example.test/prior";
const TARGET = "https://careers.example.test/target";
const NOW = "2026-07-20T08:00:00.000Z";

let db: Database.Database;

beforeEach(() => {
  db = new Database(":memory:");
  db.exec(`
    CREATE TABLE jobs (
      url TEXT PRIMARY KEY,
      title TEXT,
      company TEXT,
      application_url TEXT,
      applied_at TEXT,
      apply_status TEXT,
      discovered_at TEXT
    );
    CREATE TABLE job_enrichments (
      job_url TEXT NOT NULL,
      tenant_id TEXT NOT NULL,
      application_url TEXT,
      updated_at TEXT NOT NULL
    );
    CREATE TABLE job_list_projections (
      tenant_id TEXT NOT NULL,
      job_id TEXT NOT NULL,
      employer TEXT NOT NULL
    );
    CREATE TABLE job_events (
      event_id INTEGER PRIMARY KEY AUTOINCREMENT,
      job_url TEXT,
      event_type TEXT NOT NULL,
      occurred_at TEXT NOT NULL
    );
    CREATE TABLE application_outcomes (
      tenant_id TEXT NOT NULL,
      outcome_id TEXT NOT NULL,
      job_key TEXT NOT NULL,
      kind TEXT NOT NULL,
      occurred_at TEXT NOT NULL
    );
    CREATE TABLE application_outcome_suggestions (
      tenant_id TEXT NOT NULL,
      suggestion_id TEXT NOT NULL,
      job_key TEXT NOT NULL,
      suggested_kind TEXT NOT NULL,
      status TEXT NOT NULL,
      created_at TEXT NOT NULL
    );
    CREATE TABLE job_canonical_identities (
      tenant_id TEXT NOT NULL,
      job_url TEXT NOT NULL,
      canonical_url TEXT NOT NULL,
      ats_kind TEXT NOT NULL,
      source_native_id TEXT NOT NULL
    );
    CREATE TABLE job_source_observations (
      tenant_id TEXT NOT NULL,
      source_observation_id TEXT NOT NULL,
      job_url TEXT NOT NULL,
      observed_url TEXT NOT NULL,
      normalized_observed_url TEXT NOT NULL
    );
    CREATE TABLE job_duplicate_links (
      tenant_id TEXT NOT NULL,
      duplicate_link_id TEXT NOT NULL,
      surviving_job_id TEXT NOT NULL,
      superseded_job_or_observation_id TEXT NOT NULL,
      reason TEXT NOT NULL,
      confidence REAL NOT NULL,
      linked_at TEXT NOT NULL
    );
  `);
  ensureRepeatApplicationTables(db);
});

afterEach(() => {
  vi.useRealTimers();
  db.close();
});

function insertJob(url: string, title: string, company: string): void {
  db.prepare(
    `INSERT INTO jobs (url, title, company, application_url, discovered_at)
     VALUES (?, ?, ?, ?, ?)`,
  ).run(url, title, company, `${url}/apply`, NOW);
}

function confirmPrior(kind: "ApplicationSubmitted" | "ApplicationManuallyMarked" = "ApplicationSubmitted"): void {
  db.prepare(
    "INSERT INTO job_events (job_url, event_type, occurred_at) VALUES (?, ?, ?)",
  ).run(PRIOR, kind, NOW);
}

describe("repeat application evidence", () => {
  it("shares a portable multi-match evidence fingerprint with the worker", () => {
    const fixture = JSON.parse(
      readFileSync(
        new URL(
          "../../../packages/domain-types/test/fixtures/repeat_application_fingerprint_parity.json",
          import.meta.url,
        ),
        "utf8",
      ),
    ) as {
      targetJobKey: string;
      matches: Parameters<typeof repeatEvidenceFingerprint>[1];
      expectedFingerprint: string;
    };

    expect(repeatEvidenceFingerprint(fixture.targetJobKey, fixture.matches)).toBe(
      fixture.expectedFingerprint,
    );
    expect(repeatEvidenceFingerprint(fixture.targetJobKey, [...fixture.matches].reverse())).toBe(
      fixture.expectedFingerprint,
    );
  });

  it("blocks alternate URLs with the same canonical ATS identity", () => {
    insertJob(PRIOR, "Senior Platform Engineer", "Acme, Inc.");
    insertJob(TARGET, "Senior Platform Engineer", "Acme Inc");
    confirmPrior();
    const identity = db.prepare(
      `INSERT INTO job_canonical_identities
       (tenant_id, job_url, canonical_url, ats_kind, source_native_id)
       VALUES ('local', ?, ?, 'greenhouse', 'gh-123')`,
    );
    identity.run(PRIOR, "https://boards.example.test/jobs/123");
    identity.run(TARGET, "https://boards.example.test/jobs/123");

    const assessment = evaluateRepeatApplication(db, TARGET);

    expect(assessment.status).toBe("blocked");
    expect(assessment.matches[0]).toMatchObject({
      relationship: "canonical_identity",
      priorApplication: { jobKey: PRIOR, factKind: "application_submitted" },
    });
    expect(assessment.auditTrail[0]?.action).toBe("blocked");
    expect(() => assertLiveApplicationMayDispatch(db, TARGET)).toThrow(
      "repeat_application_blocked",
    );
  });

  it("honors accepted duplicate links, including observation identities", () => {
    insertJob(PRIOR, "Platform Engineer", "Acme");
    insertJob(TARGET, "Unrelated label", "Different display name");
    confirmPrior("ApplicationManuallyMarked");
    db.prepare(
      `INSERT INTO job_source_observations
       (tenant_id, source_observation_id, job_url, observed_url, normalized_observed_url)
       VALUES ('local', 'prior-observation', ?, ?, ?)`,
    ).run(PRIOR, `${PRIOR}?source=board`, PRIOR);
    db.prepare(
      `INSERT INTO job_duplicate_links
       (tenant_id, duplicate_link_id, surviving_job_id,
        superseded_job_or_observation_id, reason, confidence, linked_at)
       VALUES ('local', 'link-1', ?, 'prior-observation', 'accepted_content_identity', 0.99, ?)`,
    ).run(TARGET, NOW);

    expect(evaluateRepeatApplication(db, TARGET)).toMatchObject({
      status: "blocked",
      matches: [{ relationship: "accepted_duplicate" }],
    });
  });

  it("requires confirmation only for strict same-employer equivalent roles", () => {
    insertJob(PRIOR, "Sr. Backend Eng II", "Acme, Inc.");
    insertJob(TARGET, "Senior Backend Engineer 2 (Remote)", "ACME INC");
    confirmPrior();

    const assessment = evaluateRepeatApplication(db, TARGET);

    expect(assessment.status).toBe("confirmation_required");
    expect(assessment.matches[0]?.relationship).toBe("same_employer_equivalent_role");
    expect(normalizeEmployer("Acme, Inc.")).toBe("acme");
    expect(normalizeRoleTitle("Sr. Backend Eng II (Remote)")).toBe(
      "senior backend engineer 2",
    );
  });

  it("preserves the projected employer in evidence when the writable job value is empty", () => {
    insertJob(PRIOR, "Senior Backend Engineer", "");
    insertJob(TARGET, "Backend Senior Eng", "");
    db.prepare("UPDATE jobs SET company = NULL").run();
    db.prepare(
      `INSERT INTO job_list_projections (tenant_id, job_id, employer)
       VALUES ('local', ?, 'Acme Inc'), ('local', ?, 'Acme Inc')`,
    ).run(PRIOR, TARGET);
    confirmPrior();

    const assessment = evaluateRepeatApplication(db, TARGET);

    expect(assessment.status).toBe("confirmation_required");
    expect(assessment.matches[0]).toMatchObject({
      relationship: "same_employer_equivalent_role",
      priorApplication: { company: "Acme Inc" },
    });
    expect(assessment.matches[0]?.identityEvidence).toContain("employer:acme");
  });

  it.each([
    ["Engineering Manager", "Acme Inc", "distinct role"],
    ["Senior Backend Engineer", "Acme Health", "similar employer"],
  ])("allows %s at %s as a %s case", (title, company) => {
    insertJob(PRIOR, "Senior Backend Engineer", "Acme Inc");
    insertJob(TARGET, title, company);
    confirmPrior();

    expect(evaluateRepeatApplication(db, TARGET).status).toBe("clear");
  });

  it("excludes dry runs, failed attempts, and pending outcome suggestions", () => {
    insertJob(PRIOR, "Senior Backend Engineer", "Acme Inc");
    insertJob(TARGET, "Senior Backend Engineer", "Acme Inc");
    for (const eventType of ["DryRunCompleted", "ApplicationFailed", "ApplySubmitIntended"]) {
      db.prepare(
        "INSERT INTO job_events (job_url, event_type, occurred_at) VALUES (?, ?, ?)",
      ).run(PRIOR, eventType, NOW);
    }
    db.prepare(
      `INSERT INTO application_outcome_suggestions
       (tenant_id, suggestion_id, job_key, suggested_kind, status, created_at)
       VALUES ('local', 'suggestion-1', ?, 'applied_confirmation', 'pending', ?)`,
    ).run(PRIOR, NOW);
    db.prepare(
      `INSERT INTO application_outcomes
       (tenant_id, outcome_id, job_key, kind, occurred_at)
       VALUES ('local', 'note-like-outcome', ?, 'unknown', ?)`,
    ).run(PRIOR, NOW);

    expect(evaluateRepeatApplication(db, TARGET).status).toBe("clear");

    db.prepare(
      `INSERT INTO application_outcomes
       (tenant_id, outcome_id, job_key, kind, occurred_at)
       VALUES ('local', 'confirmed-application', ?, 'applied_confirmation', ?)`,
    ).run(PRIOR, NOW);
    expect(evaluateRepeatApplication(db, TARGET)).toMatchObject({
      status: "confirmation_required",
      matches: [{ priorApplication: { factKind: "applied_confirmation" } }],
    });
  });

  it("records a reasoned override bound to the complete evidence and rejects stale evidence", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(NOW));
    insertJob(PRIOR, "Senior Backend Engineer", "Acme Inc");
    insertJob(TARGET, "Senior Backend Engineer", "Acme Inc");
    confirmPrior();
    const initial = evaluateRepeatApplication(db, TARGET);

    const response = recordRepeatApplicationOverride(db, TARGET, {
      evidenceFingerprint: initial.evidenceFingerprint!,
      priorJobKey: PRIOR,
      reason: "The first record was withdrawn before review.",
      confirmedBy: "qa-user",
    });

    expect(response.assessment).toMatchObject({
      status: "override_ready",
      override: {
        targetJobKey: TARGET,
        priorJobKey: PRIOR,
        reason: "The first record was withdrawn before review.",
        confirmedBy: "qa-user",
        consumedAt: null,
      },
    });
    expect(response.assessment.auditTrail.map((entry) => entry.action)).toContain(
      "override_recorded",
    );

    // UUIDs do not encode insertion order.  Force the tied timestamps into
    // the inverse lexical UUID order to reproduce the production race.
    db.prepare(
      "UPDATE application_repeat_audit SET audit_id = ? WHERE action = 'confirmation_required'",
    ).run("ffffffff-ffff-ffff-ffff-ffffffffffff");
    db.prepare(
      "UPDATE application_repeat_audit SET audit_id = ? WHERE action = 'override_recorded'",
    ).run("00000000-0000-0000-0000-000000000000");
    const ordered = evaluateRepeatApplication(db, TARGET, {
      recordAudit: false,
      evaluatedAt: NOW,
    });
    expect(ordered.auditTrail[0]).toMatchObject({
      action: "override_recorded",
      targetJobKey: TARGET,
      priorJobKey: PRIOR,
      evidence: [
        {
          relationship: "same_employer_equivalent_role",
          priorApplication: { jobKey: PRIOR, factId: "event:1" },
        },
      ],
    });

    db.prepare("UPDATE jobs SET title = 'Engineering Manager' WHERE url = ?").run(TARGET);
    const cleared = evaluateRepeatApplication(db, TARGET);
    expect(cleared.status).toBe("clear");
    expect(cleared.auditTrail).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          action: "override_recorded",
          priorJobKey: PRIOR,
          evidence: expect.arrayContaining([
            expect.objectContaining({ priorApplication: expect.objectContaining({ jobKey: PRIOR }) }),
          ]),
        }),
      ]),
    );
    db.prepare("UPDATE jobs SET title = 'Senior Backend Engineer' WHERE url = ?").run(TARGET);

    const secondPrior = "https://jobs.example.test/second-prior";
    insertJob(secondPrior, "Senior Backend Engineer", "Acme Inc");
    db.prepare(
      "INSERT INTO job_events (job_url, event_type, occurred_at) VALUES (?, 'ApplicationSubmitted', ?)",
    ).run(secondPrior, "2026-07-20T09:00:00.000Z");
    expect(() =>
      recordRepeatApplicationOverride(db, TARGET, {
        evidenceFingerprint: initial.evidenceFingerprint!,
        priorJobKey: PRIOR,
        reason: "Trying to reuse an outdated confirmation.",
        confirmedBy: "qa-user",
      }),
    ).toThrow("repeat_application_evidence_stale");
  });
});
