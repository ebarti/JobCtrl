import { createHash } from "node:crypto";
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
const PRIOR_JOB_ID = "70000000-0000-4000-8000-000000000002";
const TARGET_JOB_ID = "70000000-0000-4000-8000-000000000001";
const NOW = "2026-07-20T08:00:00.000Z";

let db: Database.Database;

beforeEach(() => {
  db = new Database(":memory:");
  db.exec(readFileSync(new URL(
    "../../../workers/automation/src/jobctrl/infrastructure/migrations/schema_v7.sql",
    import.meta.url,
  ), "utf8"));
  db.pragma("user_version = 7");
  ensureRepeatApplicationTables(db);
});

afterEach(() => {
  vi.useRealTimers();
  db.close();
});

function jobIdFor(url: string): string {
  if (url === PRIOR) return PRIOR_JOB_ID;
  if (url === TARGET) return TARGET_JOB_ID;
  const hex = createHash("sha256").update(`repeat-test:${url}`, "utf8").digest("hex").slice(0, 32);
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-8${hex.slice(17, 20)}-${hex.slice(20)}`;
}

function insertJob(url: string, title: string, company: string): void {
  db.prepare(
    `INSERT INTO jobs (tenant_id, job_id, url, title, company, application_url, discovered_at)
     VALUES ('local', ?, ?, ?, ?, ?, ?)`,
  ).run(jobIdFor(url), url, title, company, `${url}/apply`, NOW);
  db.prepare(
    `INSERT INTO job_enrichments
       (tenant_id, job_id, current_status, application_url, updated_at)
     VALUES ('local', ?, 'enriched', ?, ?)`,
  ).run(jobIdFor(url), `${url}/apply`, NOW);
}

function confirmPrior(kind: "ApplicationSubmitted" | "ApplicationManuallyMarked" = "ApplicationSubmitted"): void {
  db.prepare(
    `INSERT INTO job_events (tenant_id, job_id, identity_version, event_type, occurred_at)
     VALUES ('local', ?, 1, ?, ?)`,
  ).run(PRIOR_JOB_ID, kind, NOW);
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
      targetJobId: string;
      matches: Parameters<typeof repeatEvidenceFingerprint>[1];
      expectedFingerprint: string;
    };

    expect(repeatEvidenceFingerprint(fixture.targetJobId, fixture.matches)).toBe(
      fixture.expectedFingerprint,
    );
    expect(repeatEvidenceFingerprint(fixture.targetJobId, [...fixture.matches].reverse())).toBe(
      fixture.expectedFingerprint,
    );
  });

  it("rejects legacy locator keys at the fingerprint boundary", () => {
    const legacyMatch = {
      relationship: "canonical_identity",
      reason: "legacy input",
      priorApplication: {
        jobKey: PRIOR,
        title: "Platform Engineer",
        company: "Acme",
        applicationUrl: null,
        factKind: "application_submitted",
        factId: "event:legacy",
        confirmedAt: NOW,
      },
      identityEvidence: [],
    } as unknown as Parameters<typeof repeatEvidenceFingerprint>[1][number];

    expect(
      () =>
        repeatEvidenceFingerprint("70000000-0000-4000-8000-000000000001", [legacyMatch]),
    ).toThrow("canonical priorApplication.jobId");
  });

  it("rejects every shared invalid fingerprint vector", () => {
    const fixture = JSON.parse(
      readFileSync(
        new URL(
          "../../../packages/domain-types/test/fixtures/repeat_application_fingerprint_parity.json",
          import.meta.url,
        ),
        "utf8",
      ),
    ) as {
      invalidVectors: Array<{
        targetJobId: string;
        matches: unknown[];
        error: string;
      }>;
    };

    for (const vector of fixture.invalidVectors) {
      expect(() =>
        repeatEvidenceFingerprint(
          vector.targetJobId,
          vector.matches as Parameters<typeof repeatEvidenceFingerprint>[1],
        ),
      ).toThrow(vector.error);
    }
  });

  it("keeps live-dispatch safety on canonical JobIds", () => {
    insertJob(TARGET, "Platform Engineer", "Acme Inc");
    expect(assertLiveApplicationMayDispatch(db, TARGET_JOB_ID).status).toBe("clear");
  });

  it("blocks alternate URLs with the same canonical ATS identity", () => {
    insertJob(PRIOR, "Senior Platform Engineer", "Acme, Inc.");
    insertJob(TARGET, "Senior Platform Engineer", "Acme Inc");
    confirmPrior();
    const identity = db.prepare(
      `INSERT INTO job_canonical_identities
       (tenant_id, job_id, canonical_url, ats_kind, source_native_id, confidence, resolved_at)
       VALUES ('local', ?, ?, 'greenhouse', 'gh-123', 1, ?)`,
    );
    identity.run(PRIOR_JOB_ID, "https://boards.example.test/jobs/123", NOW);
    identity.run(TARGET_JOB_ID, "https://boards.example.test/jobs/123", NOW);

    const assessment = evaluateRepeatApplication(db, TARGET_JOB_ID);

    expect(assessment.status).toBe("blocked");
    expect(assessment.matches[0]).toMatchObject({
      relationship: "canonical_identity",
      priorApplication: { jobId: PRIOR_JOB_ID, factKind: "application_submitted" },
    });
    expect(assessment.auditTrail[0]?.action).toBe("blocked");
    expect(() => assertLiveApplicationMayDispatch(db, TARGET_JOB_ID)).toThrow(
      "repeat_application_blocked",
    );
  });

  it("honors accepted duplicate links, including observation identities", () => {
    insertJob(PRIOR, "Platform Engineer", "Acme");
    insertJob(TARGET, "Unrelated label", "Different display name");
    confirmPrior("ApplicationManuallyMarked");
    db.prepare(
      `INSERT INTO job_source_observations
       (tenant_id, source_observation_id, job_id, source_id, source_native_id,
        observed_url, normalized_observed_url, observed_at)
       VALUES ('local', 'prior-observation', ?, 'test', 'prior-observation', ?, ?, ?)`,
    ).run(PRIOR_JOB_ID, `${PRIOR}?source=board`, PRIOR, NOW);
    db.prepare(
      `INSERT INTO job_duplicate_links
       (tenant_id, duplicate_link_id, surviving_job_id,
        superseded_job_or_observation_id, reason, confidence, linked_at)
       VALUES ('local', 'link-1', ?, 'prior-observation', 'accepted_content_identity', 0.99, ?)`,
    ).run(TARGET_JOB_ID, NOW);

    expect(evaluateRepeatApplication(db, TARGET_JOB_ID)).toMatchObject({
      status: "blocked",
      matches: [{ relationship: "accepted_duplicate" }],
    });
  });

  it("requires confirmation only for strict same-employer equivalent roles", () => {
    insertJob(PRIOR, "Sr. Backend Eng II", "Acme, Inc.");
    insertJob(TARGET, "Senior Backend Engineer 2 (Remote)", "ACME INC");
    confirmPrior();

    const assessment = evaluateRepeatApplication(db, TARGET_JOB_ID);

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
    ).run(PRIOR_JOB_ID, TARGET_JOB_ID);
    confirmPrior();

    const assessment = evaluateRepeatApplication(db, TARGET_JOB_ID);

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

    expect(evaluateRepeatApplication(db, TARGET_JOB_ID).status).toBe("clear");
  });

  it("excludes dry runs, failed attempts, and pending outcome suggestions", () => {
    insertJob(PRIOR, "Senior Backend Engineer", "Acme Inc");
    insertJob(TARGET, "Senior Backend Engineer", "Acme Inc");
    for (const eventType of ["DryRunCompleted", "ApplicationFailed", "ApplySubmitIntended"]) {
      db.prepare(
        "INSERT INTO job_events (tenant_id, job_id, identity_version, event_type, occurred_at) VALUES ('local', ?, 1, ?, ?)",
      ).run(PRIOR_JOB_ID, eventType, NOW);
    }
    db.prepare(
      `INSERT INTO application_outcome_suggestions
       (tenant_id, suggestion_id, job_id, suggested_kind, status, created_at)
       VALUES ('local', 'suggestion-1', ?, 'applied_confirmation', 'pending', ?)`,
    ).run(PRIOR_JOB_ID, NOW);
    db.prepare(
      `INSERT INTO application_outcomes
       (tenant_id, outcome_id, job_id, kind, source, occurred_at, recorded_at)
       VALUES ('local', 'note-like-outcome', ?, 'unknown', 'test', ?, ?)`,
    ).run(PRIOR_JOB_ID, NOW, NOW);

    expect(evaluateRepeatApplication(db, TARGET_JOB_ID).status).toBe("clear");

    db.prepare(
      `INSERT INTO application_outcomes
       (tenant_id, outcome_id, job_id, kind, source, occurred_at, recorded_at)
       VALUES ('local', 'confirmed-application', ?, 'applied_confirmation', 'test', ?, ?)`,
    ).run(PRIOR_JOB_ID, NOW, NOW);
    expect(evaluateRepeatApplication(db, TARGET_JOB_ID)).toMatchObject({
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
    const initial = evaluateRepeatApplication(db, TARGET_JOB_ID);

    const response = recordRepeatApplicationOverride(db, TARGET_JOB_ID, {
      evidenceFingerprint: initial.evidenceFingerprint!,
      priorJobId: PRIOR_JOB_ID,
      reason: "The first record was withdrawn before review.",
      confirmedBy: "qa-user",
    });

    expect(response.assessment).toMatchObject({
      status: "override_ready",
      override: {
        targetJobId: TARGET_JOB_ID,
        priorJobId: PRIOR_JOB_ID,
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
    const ordered = evaluateRepeatApplication(db, TARGET_JOB_ID, {
      recordAudit: false,
      evaluatedAt: NOW,
    });
    expect(ordered.auditTrail[0]).toMatchObject({
      action: "override_recorded",
      targetJobId: TARGET_JOB_ID,
      priorJobId: PRIOR_JOB_ID,
      evidence: [
        {
          relationship: "same_employer_equivalent_role",
          priorApplication: { jobId: PRIOR_JOB_ID, factId: "event:1" },
        },
      ],
    });

    db.prepare("UPDATE jobs SET title = 'Engineering Manager' WHERE job_id = ?").run(TARGET_JOB_ID);
    const cleared = evaluateRepeatApplication(db, TARGET_JOB_ID);
    expect(cleared.status).toBe("clear");
    expect(cleared.auditTrail).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          action: "override_recorded",
          priorJobId: PRIOR_JOB_ID,
          evidence: expect.arrayContaining([
            expect.objectContaining({ priorApplication: expect.objectContaining({ jobId: PRIOR_JOB_ID }) }),
          ]),
        }),
      ]),
    );
    db.prepare("UPDATE jobs SET title = 'Senior Backend Engineer' WHERE job_id = ?").run(TARGET_JOB_ID);

    const secondPrior = "https://jobs.example.test/second-prior";
    insertJob(secondPrior, "Senior Backend Engineer", "Acme Inc");
    db.prepare(
      "INSERT INTO job_events (tenant_id, job_id, identity_version, event_type, occurred_at) VALUES ('local', ?, 1, 'ApplicationSubmitted', ?)",
    ).run(jobIdFor(secondPrior), "2026-07-20T09:00:00.000Z");
    expect(() =>
      recordRepeatApplicationOverride(db, TARGET_JOB_ID, {
        evidenceFingerprint: initial.evidenceFingerprint!,
        priorJobId: PRIOR_JOB_ID,
        reason: "Trying to reuse an outdated confirmation.",
        confirmedBy: "qa-user",
      }),
    ).toThrow("repeat_application_evidence_stale");
  });
});
