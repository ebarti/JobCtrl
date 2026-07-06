import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { ensureApplicationFeedbackTables } from "../src/application-feedback.js";
import type { ApplyReviewQueueResponse } from "../src/contracts.js";
import { GmailFeedbackScanError, type GmailFeedbackScanner } from "../src/gmail-feedback-worker.js";
import { type ActionDispatcher, type ActionDispatchResult } from "../src/local-actions.js";
import { type BuildAppOptions, buildApp } from "../src/server.js";

const READY_JOB = "https://example.com/jobs/apply-ready";
const DRY_RUN_JOB = "https://example.com/jobs/apply-dry-run";
const APPLIED_JOB = "https://example.com/jobs/already-applied";
const NOW = "2026-06-01T10:00:00.000Z";
const LONG_TAILORED_REQUIREMENT_EVIDENCE =
  "Owned platform reliability improvements for incident response across four production services, reduced high-severity repeat incidents through clearer ownership, and built review habits that kept customer-facing systems stable during launch pressure.";

let tempDir = "";
let options: BuildAppOptions;
let actionDispatcher: ReturnType<typeof vi.fn> & ActionDispatcher;

beforeEach(() => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "jobhunter-feedback-api-"));
  actionDispatcher = vi.fn(async (): Promise<ActionDispatchResult> => ({
    status: "queued",
    runId: "unexpected-run",
  })) as ReturnType<typeof vi.fn> & ActionDispatcher;
  options = {
    dbPath: path.join(tempDir, "jobhunter.db"),
    settingsPath: path.join(tempDir, "dashboard.json"),
    actionDispatcher,
  };
  seedDatabase(options.dbPath);
});

afterEach(() => {
  fs.rmSync(tempDir, { force: true, recursive: true });
});

describe("application feedback API", () => {
  it("lists only apply-review eligible jobs with readiness and latest run context", async () => {
    const app = buildApp(options);

    const response = await app.inject({ method: "GET", url: "/v1/apply/review-queue" });

    expect(response.statusCode, response.body).toBe(200);
    const body = response.json();
    expect(body.items.map((item: { jobKey: string }) => item.jobKey)).toEqual([
      READY_JOB,
      DRY_RUN_JOB,
    ]);
    expect(body.items[0]).toMatchObject({
      jobKey: READY_JOB,
      title: "Principal Platform Engineer",
      currentStage: "apply",
      currentState: "pending",
      compensationSummary: {
        posted: {
          recordStatus: "recorded",
          displayRange: "EUR 70000-90000/year",
          confidence: "high",
        },
        market: {
          recordStatus: "recorded",
          estimateState: "estimated_range",
          displayRange: "EUR 112000-142000/year",
          confidenceBand: "medium",
          confidenceScore: 0.82,
          sourceCount: 2,
          sampleCount: 7,
        },
      },
      fitScore: 9,
      scoreBreakdown: {
        technicalFit: 9,
        experienceFit: 8,
        roleFit: 8,
        reasoning: "Strong platform leadership fit.",
        fitBand: "strong",
        confidence: "high",
        eligibility: { status: "eligible", hardBlockers: [], warnings: [] },
        matchedSignals: ["platform leadership"],
        missingSignals: ["public company scale"],
        transferableSignals: ["incident leadership"],
      },
      scoreKeywords: ["platform", "leadership"],
      scoreReasoning: "Strong platform leadership fit.",
      scoreVersion: 1,
      scoredAt: NOW,
      scoreCriteria: {
        minFitScore: 7,
        criteriaVersion: "criteria-test",
      },
      scoreTrace: {
        rawWeightedScore: 8.6,
        scoringPolicyVersion: 3,
        resolutionReason: "weighted_dimensions",
      },
      materials: {
        hasResume: true,
        ready: true,
      },
      applyAudit: {
        state: "ready",
        label: "materials ready",
        hardBlockers: [],
      },
      position: {
        descriptionPreview: "Full description",
        idealCandidate:
          "A senior platform leader who improves developer experience and incident response across teams.",
        idealRequirements: [
          {
            id: "r1",
            text: "Lead platform reliability improvements across critical services.",
            tier: "must_have",
            weight: 0.9,
            evidence: "lead platform reliability",
            fit: {
              kind: "matched",
              evidenceIds: ["ev-platform"],
              strength: "direct",
            },
            contribution: {
              maxPoints: 1.125,
              awardedPoints: 1.125,
              weightedImpact: 1.125,
              rationale: "Direct platform reliability evidence covers the requirement.",
            },
            tailoring: {
              action: "double_down",
              priority: 0.9,
              allowedEvidenceIds: ["ev-platform"],
              targetKeywords: ["platform reliability"],
              prohibitedClaims: [],
              instruction: "Keep platform reliability ownership prominent.",
            },
            coverage: {
              state: "covered",
              source: "tailored_resume_bullet_provenance",
              bulletCount: 1,
              examples: [LONG_TAILORED_REQUIREMENT_EVIDENCE],
            },
          },
          {
            id: "r2",
            text: "Improve developer experience and incident-response practices.",
            tier: "important",
            weight: 0.7,
            evidence: "developer experience improvements",
            fit: {
              kind: "transferable",
              evidenceIds: ["ev-incident"],
              gap: "No direct developer-experience ownership evidence was recorded.",
              bridge: "Incident leadership can support adjacent developer-experience expectations.",
            },
            contribution: {
              maxPoints: 0.7,
              awardedPoints: 0.42,
              weightedImpact: 0.42,
              rationale: "Transferable incident leadership partially covers the requirement.",
            },
            tailoring: {
              action: "bridge_gap",
              priority: 0.7,
              allowedEvidenceIds: ["ev-incident"],
              targetKeywords: ["incident response", "developer experience"],
              prohibitedClaims: ["owned developer experience end to end"],
              instruction: "Bridge from incident leadership without claiming direct developer-experience ownership.",
            },
            coverage: {
              state: "missing_from_resume",
              source: "tailored_resume_bullet_provenance",
              bulletCount: 0,
              examples: [],
            },
          },
        ],
        requirements: [
          "Lead platform reliability improvements across critical services.",
          "Improve developer experience and incident-response practices.",
        ],
        matched: ["platform leadership"],
        missing: ["public company scale"],
        transferable: ["incident leadership"],
        keywords: ["platform", "leadership"],
      },
      materialsPreview: {
        resumeText: "tailored resume",
        resumeTextArtifactId: "apply-ready-resume-text",
        resumePdfArtifactId: "apply-ready-resume-pdf",
        coverLetterText: null,
      },
      latestApplyRun: {
        runId: "dry-run-ready",
        dryRun: true,
      },
      review: {
        state: "pending",
      },
      blockers: [],
    });

    await app.close();
  });

  it("keeps jobs in review queue while existing materials are being refreshed", async () => {
    const db = new Database(options.dbPath);
    db.prepare(
      `
      UPDATE job_stage_states
         SET state = 'running',
             updated_at = '2026-06-01T11:30:00.000Z'
       WHERE job_url = ?
         AND stage = 'tailor'
      `,
    ).run(READY_JOB);
    db.close();
    const app = buildApp(options);

    const response = await app.inject({ method: "GET", url: "/v1/apply/review-queue" });

    expect(response.statusCode, response.body).toBe(200);
    expect(queueItem(response.json(), READY_JOB)).toMatchObject({
      currentStage: "discover",
      currentState: "running",
      materialsPreview: {
        resumeText: "tailored resume",
        resumeTextArtifactId: "apply-ready-resume-text",
        resumePdfArtifactId: "apply-ready-resume-pdf",
      },
      applyAudit: {
        state: "preparing",
        label: "materials preparing",
        summary: "tailor is running. Review evidence is still available where recorded.",
      },
    });

    await app.close();
  });

  it("uses stage error messages instead of generic blocker codes in the review queue", async () => {
    const db = new Database(options.dbPath);
    db.prepare(
      `
      UPDATE job_stage_states
         SET state = 'failed',
             error_code = 'FAILED',
             error_message = 'SKIPPED: process killed by signal'
       WHERE job_url = ?
         AND stage = 'apply'
      `,
    ).run(READY_JOB);
    db.close();
    const app = buildApp(options);

    const response = await app.inject({ method: "GET", url: "/v1/apply/review-queue" });

    expect(response.statusCode, response.body).toBe(200);
    expect(queueItem(response.json(), READY_JOB)).toMatchObject({
      currentStage: "apply",
      currentState: "failed",
      blockers: ["SKIPPED: process killed by signal"],
      applyAudit: {
        state: "repair",
        label: "apply failed",
        hardBlockers: [
          expect.objectContaining({
            code: "stage_not_ready",
            detail: "process killed by signal",
          }),
        ],
      },
    });

    await app.close();
  });

  it("surfaces missing profile data apply failures as review blockers", async () => {
    const db = new Database(options.dbPath);
    db.prepare(
      `
      UPDATE job_stage_states
         SET state = 'failed',
             error_code = 'FAILED',
             error_message = 'missing_profile_data:age_18_plus',
             retryable = 0
       WHERE job_url = ?
         AND stage = 'apply'
      `,
    ).run(READY_JOB);
    db.close();
    const app = buildApp(options);

    const response = await app.inject({ method: "GET", url: "/v1/apply/review-queue" });

    expect(response.statusCode, response.body).toBe(200);
    expect(queueItem(response.json(), READY_JOB)).toMatchObject({
      currentStage: "apply",
      currentState: "failed",
      blockers: ["missing_profile_data:age_18_plus"],
      applyAudit: {
        state: "repair",
        label: "apply failed",
      },
    });

    await app.close();
  });

  it("surfaces incomplete application attestations before approval", async () => {
    const db = new Database(options.dbPath);
    db.exec(`
      CREATE TABLE candidate_profiles (
        tenant_id TEXT NOT NULL,
        profile_id TEXT NOT NULL,
        application_attestation_age_18_plus INTEGER DEFAULT NULL,
        application_attestation_background_check_consent INTEGER DEFAULT NULL,
        application_attestation_felony_conviction INTEGER DEFAULT NULL,
        application_attestation_previously_worked_at_employer INTEGER DEFAULT NULL,
        version INTEGER NOT NULL DEFAULT 1,
        updated_at TEXT NOT NULL,
        PRIMARY KEY (tenant_id, profile_id)
      );
    `);
    db.prepare(
      `INSERT INTO candidate_profiles (
         tenant_id, profile_id, application_attestation_age_18_plus,
         application_attestation_background_check_consent,
         application_attestation_felony_conviction,
         application_attestation_previously_worked_at_employer,
         version, updated_at
       ) VALUES ('local', 'default', 1, NULL, 0, NULL, 3, ?)`,
    ).run(NOW);
    db.close();
    const app = buildApp(options);

    const response = await app.inject({ method: "GET", url: "/v1/apply/review-queue" });

    expect(response.statusCode, response.body).toBe(200);
    expect(queueItem(response.json(), READY_JOB)?.applyAudit).toMatchObject({
      state: "preparing",
      missingPrerequisites: [
        expect.objectContaining({
          code: "missing_profile_attestations",
          label: "Profile attestations incomplete",
          detail:
            "Application attestations missing: background_check_consent, previously_worked_at_employer.",
        }),
      ],
      sources: expect.arrayContaining([
        expect.objectContaining({
          kind: "profile_attestations",
          status: "missing",
        }),
      ]),
    });

    await app.close();
  });

  it("labels apply-review repair status from the failed apply substage", async () => {
    const db = new Database(options.dbPath);
    db.prepare(
      `
      UPDATE job_stage_states
         SET state = 'failed',
             error_code = 'RENDER_FAILED',
             error_message = 'Cover PDF render failed'
       WHERE job_url = ?
         AND stage = 'cover'
      `,
    ).run(READY_JOB);
    db.close();
    const app = buildApp(options);

    const response = await app.inject({ method: "GET", url: "/v1/apply/review-queue" });

    expect(response.statusCode, response.body).toBe(200);
    expect(queueItem(response.json(), READY_JOB)).toMatchObject({
      currentStage: "apply",
      currentState: "failed",
      blockers: ["Cover PDF render failed"],
      applyAudit: {
        state: "repair",
        label: "cover failed",
        hardBlockers: [
          expect.objectContaining({
            code: "stage_not_ready",
            label: "cover failed",
            detail: "cover PDF render failed",
          }),
        ],
      },
    });

    await app.close();
  });

  it("surfaces needs-verification apply rows in the review queue", async () => {
    const db = new Database(options.dbPath);
    db.prepare(
      `
      UPDATE job_stage_states
         SET state = 'needs_verification',
             error_code = 'APPLY_NEEDS_VERIFICATION',
             error_message = 'Submit intent was recorded but no terminal result exists.'
       WHERE job_url = ?
         AND stage = 'apply'
      `,
    ).run(READY_JOB);
    db.close();
    const app = buildApp(options);

    const response = await app.inject({ method: "GET", url: "/v1/apply/review-queue" });

    expect(response.statusCode, response.body).toBe(200);
    expect(queueItem(response.json(), READY_JOB)).toMatchObject({
      currentStage: "apply",
      currentState: "needs_verification",
      blockers: ["Submit intent was recorded but no terminal result exists."],
    });

    await app.close();
  });

  it("repairs stale apply material blockers before listing the review queue", async () => {
    const db = new Database(options.dbPath);
    db.prepare(
      `
      UPDATE job_stage_states
         SET state = 'blocked',
             error_code = 'BLOCKED',
             error_message = 'Materials are not ready.',
             retryable = 0
       WHERE job_url = ?
         AND stage = 'apply'
      `,
    ).run(READY_JOB);
    db.close();
    const app = buildApp(options);

    const response = await app.inject({ method: "GET", url: "/v1/apply/review-queue" });

    expect(response.statusCode, response.body).toBe(200);
    expect(queueItem(response.json(), READY_JOB)).toMatchObject({
      currentStage: "apply",
      currentState: "pending",
      blockers: [],
    });
    await app.close();

    const readDb = new Database(options.dbPath, { readonly: true });
    const stage = readDb
      .prepare(
        `
        SELECT state, error_code, error_message
          FROM job_stage_states
         WHERE job_url = ?
           AND stage = 'apply'
        `,
      )
      .get(READY_JOB) as { state: string; error_code: string | null; error_message: string | null };
    readDb.close();

    expect(stage).toEqual({
      state: "pending",
      error_code: null,
      error_message: null,
    });
  });

  it("self-heals obsolete cover generation conflicts before listing the review queue", async () => {
    const staleConflict =
      "MaterialsSet generation conflict for job_id='https://example.com/jobs/apply-ready': got generation=1, expected 2 (or current==0)";
    const db = new Database(options.dbPath);
    db.prepare(
      `
      UPDATE job_stage_states
         SET state = 'failed',
             error_code = 'COVER_FAILED',
             error_message = ?,
             retryable = 1,
             next_action = ?,
             updated_at = '2026-06-01T11:30:00.000Z'
       WHERE job_url = ?
         AND stage = 'cover'
      `,
    ).run(staleConflict, `jobhunter retry cover ${READY_JOB}`, READY_JOB);
    db.close();
    const app = buildApp(options);

    const response = await app.inject({ method: "GET", url: "/v1/apply/review-queue" });

    expect(response.statusCode, response.body).toBe(200);
    const item = queueItem(response.json(), READY_JOB);
    expect(item).toMatchObject({
      currentStage: "apply",
      currentState: "pending",
      blockers: [],
      applyAudit: {
        state: "preparing",
        label: "materials preparing",
        summary: "cover is pending. Review evidence is still available where recorded.",
        hardBlockers: [],
      },
    });
    expect(JSON.stringify(item)).not.toContain("MaterialsSet generation conflict");
    await app.close();

    const readDb = new Database(options.dbPath, { readonly: true });
    const stage = readDb
      .prepare(
        `
        SELECT state, error_code, error_message, retryable, next_action, metadata_json
          FROM job_stage_states
         WHERE job_url = ?
           AND stage = 'cover'
        `,
      )
      .get(READY_JOB) as {
      state: string;
      error_code: string | null;
      error_message: string | null;
      retryable: number;
      next_action: string | null;
      metadata_json: string | null;
    };
    readDb.close();

    expect(stage).toMatchObject({
      state: "pending",
      error_code: null,
      error_message: null,
      retryable: 1,
      next_action: null,
    });
    expect(JSON.parse(stage.metadata_json ?? "{}")).toMatchObject({
      repair_reason: "obsolete_cover_generation_conflict",
      target_state: "pending",
      previous_error_message: staleConflict,
    });
  });

  it("uses the posting URL as the review apply target when direct application URL is missing", async () => {
    const db = new Database(options.dbPath);
    db.prepare("UPDATE jobs SET application_url = NULL WHERE url = ?").run(READY_JOB);
    db.close();
    const app = buildApp(options);

    const response = await app.inject({ method: "GET", url: "/v1/apply/review-queue" });

    expect(response.statusCode, response.body).toBe(200);
    expect(queueItem(response.json(), READY_JOB)).toMatchObject({
      applicationUrl: READY_JOB,
      blockers: [],
      applyAudit: {
        state: "ready",
        hardBlockers: [],
      },
    });

    await app.close();
  });

  it("keeps resume text and PDF previews on the same material generation", async () => {
    const newerResumePath = path.join(tempDir, "newer-resume.txt");
    fs.writeFileSync(newerResumePath, "newer orphan resume text");
    const db = new Database(options.dbPath);
    db.prepare("INSERT INTO job_materials (job_url, generation) VALUES (?, ?)").run(READY_JOB, 2);
    db.prepare(
      `INSERT INTO job_materials_artifacts (
         job_url, generation, artifact_id, artifact_type, status, path, created_at, size_bytes
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      READY_JOB,
      2,
      "apply-ready-resume-text-v2",
      "tailored_resume",
      "approved",
      newerResumePath,
      "2026-06-01T11:30:00.000Z",
      24,
    );
    db.close();
    const app = buildApp(options);

    const response = await app.inject({ method: "GET", url: "/v1/apply/review-queue" });

    expect(response.statusCode, response.body).toBe(200);
    expect(queueItem(response.json(), READY_JOB)).toMatchObject({
      materialsPreview: {
        resumeText: "tailored resume",
        resumeTextArtifactId: "apply-ready-resume-text",
        resumePdfArtifactId: "apply-ready-resume-pdf",
      },
    });

    await app.close();
  });

  it("returns resume PDF layout boxes for apply-review highlighting", async () => {
    const app = buildApp(options);

    const response = await app.inject({ method: "GET", url: "/v1/apply/review-queue" });

    expect(response.statusCode, response.body).toBe(200);
    expect(queueItem(response.json(), READY_JOB)?.materialsPreview.resumePdfLayoutBoxes).toEqual([
      {
        semanticId: "experience:acme:bullet:1",
        pageNumber: 1,
        lineNumber: 6,
        textExcerpt: "Owned platform reliability improvements for incident response.",
        leftPct: 12.5,
        topPct: 24,
        widthPct: 62,
        heightPct: 2.4,
      },
    ]);

    await app.close();
  });

  it("returns full resume text for apply-review PDF audit targets", async () => {
    const longResumeText = [
      "Jordan Example",
      "",
      "Experience",
      ...Array.from({ length: 90 }, (_, index) =>
        `- Earlier resume bullet ${index + 1} keeps the artifact long enough to exceed the generic preview limit.`,
      ),
      "- Wrote Python APIs for real-time factory floor communication, giving the Manufacturing Operating System (MOS) fast, high-volume links to the industrial control systems.",
      "- Leadership: Team Building & Mentoring, Global Teams (30+ engineers), Remote-First Operations, Career Framework Design, Stakeholder Communication.",
    ].join("\n");
    const longResumePath = path.join(tempDir, "long-apply-review-resume.txt");
    fs.writeFileSync(longResumePath, longResumeText);
    const db = new Database(options.dbPath);
    db.prepare(
      `UPDATE job_materials_artifacts
          SET path = ?, size_bytes = ?
        WHERE job_url = ?
          AND artifact_id = 'apply-ready-resume-text'`,
    ).run(longResumePath, Buffer.byteLength(longResumeText), READY_JOB);
    db.close();
    const app = buildApp(options);

    const response = await app.inject({ method: "GET", url: "/v1/apply/review-queue" });

    expect(response.statusCode, response.body).toBe(200);
    const resumeText = queueItem(response.json(), READY_JOB)?.materialsPreview.resumeText ?? "";
    expect(resumeText).toContain("Wrote Python APIs for real-time factory floor communication");
    expect(resumeText).toContain("Stakeholder Communication.");
    expect(resumeText).not.toMatch(/\.\.\.$/);

    await app.close();
  });

  it("returns full cover letter text in the apply-review material preview", async () => {
    const longCoverText = [
      "Dear Hiring Manager,",
      "",
      ...Array.from({ length: 75 }, (_, index) =>
        `Cover paragraph ${index + 1} keeps the letter long enough to exceed the generic preview limit while still being reviewable.`,
      ),
      "This final sentence must remain visible in the apply review cover letter panel.",
      "",
      "Jordan",
    ].join("\n");
    const longCoverPath = path.join(tempDir, "long-cover-letter.txt");
    fs.writeFileSync(longCoverPath, longCoverText);
    const db = new Database(options.dbPath);
    db.prepare(
      `INSERT INTO job_materials_artifacts (
         job_url, generation, artifact_id, artifact_type, status, path, created_at, size_bytes
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      READY_JOB,
      1,
      "apply-ready-cover-letter-text",
      "cover_letter",
      "approved",
      longCoverPath,
      "2026-06-01T11:45:00.000Z",
      Buffer.byteLength(longCoverText),
    );
    db.close();
    const app = buildApp(options);

    const response = await app.inject({ method: "GET", url: "/v1/apply/review-queue" });

    expect(response.statusCode, response.body).toBe(200);
    const coverLetterText = queueItem(response.json(), READY_JOB)?.materialsPreview.coverLetterText ?? "";
    expect(coverLetterText).toContain("Cover paragraph 75");
    expect(coverLetterText).toContain("This final sentence must remain visible");
    expect(coverLetterText).toContain("Jordan");
    expect(coverLetterText).not.toMatch(/\.\.\.$/);

    await app.close();
  });

  it("includes sanitized Profile source fields for apply-review PDF audit matching", async () => {
    const db = new Database(options.dbPath);
    db.exec(`
      CREATE TABLE candidate_profiles (
        tenant_id TEXT NOT NULL,
        profile_id TEXT NOT NULL,
        personal_full_name TEXT NOT NULL DEFAULT '',
        personal_address TEXT NOT NULL DEFAULT '',
        personal_password TEXT NOT NULL DEFAULT '',
        resume_baseline_text TEXT NOT NULL DEFAULT '',
        PRIMARY KEY (tenant_id, profile_id)
      );
    `);
    db.prepare(
      `INSERT INTO candidate_profiles (
         tenant_id, profile_id, personal_full_name, personal_address, personal_password, resume_baseline_text
       ) VALUES ('local', 'default', ?, ?, ?, ?)`,
    ).run(
      "Jordan Candidate",
      "42 Example Avenue, Harbor City",
      "do-not-send-this-field",
      "Experienced platform leader with reliable operations depth.",
    );
    db.close();
    const app = buildApp(options);

    const response = await app.inject({ method: "GET", url: "/v1/apply/review-queue" });

    expect(response.statusCode, response.body).toBe(200);
    const fields = queueItem(response.json(), READY_JOB)?.materialsPreview.profileSourceFields ?? [];
    expect(fields).toEqual(
      expect.arrayContaining([
        {
          path: "personal.full_name",
          label: "Profile > Personal information > Full name",
          value: "Jordan Candidate",
          section: "profile_personal",
        },
        {
          path: "personal.address",
          label: "Profile > Personal information > Address",
          value: "42 Example Avenue, Harbor City",
          section: "profile_personal",
        },
        {
          path: "resume.executive_profile.baseline_text",
          label: "Profile > Resume baseline > Executive profile baseline",
          value: "Experienced platform leader with reliable operations depth.",
          section: "profile_summary",
        },
      ]),
    );
    expect(JSON.stringify(fields)).not.toContain("do-not-send-this-field");

    await app.close();
  });

  it("keeps the PDF preview when no same-generation resume text is available", async () => {
    const newerResumePath = path.join(tempDir, "newer-only-resume.txt");
    fs.writeFileSync(newerResumePath, "newer only resume text");
    const db = new Database(options.dbPath);
    db.prepare(
      `DELETE FROM job_materials_artifacts
        WHERE job_url = ?
          AND artifact_type IN ('tailored_resume', 'tailored_resume_txt', 'resume_txt')`,
    ).run(READY_JOB);
    db.prepare("INSERT INTO job_materials (job_url, generation) VALUES (?, ?)").run(READY_JOB, 2);
    db.prepare(
      `INSERT INTO job_materials_artifacts (
         job_url, generation, artifact_id, artifact_type, status, path, created_at, size_bytes
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      READY_JOB,
      2,
      "apply-ready-resume-text-v2",
      "tailored_resume",
      "approved",
      newerResumePath,
      "2026-06-01T11:30:00.000Z",
      24,
    );
    db.close();
    const app = buildApp(options);

    const response = await app.inject({ method: "GET", url: "/v1/apply/review-queue" });

    expect(response.statusCode, response.body).toBe(200);
    expect(queueItem(response.json(), READY_JOB)).toMatchObject({
      materialsPreview: {
        resumeText: null,
        resumeTextArtifactId: null,
        resumePdfArtifactId: "apply-ready-resume-pdf",
      },
    });

    await app.close();
  });

  it("returns safe requirement-led audit metadata with review-blocking draft claims", async () => {
    const db = new Database(options.dbPath);
    db.prepare(
      `UPDATE job_materials_artifacts
          SET metadata_json = ?
        WHERE job_url = ?
          AND artifact_id = 'apply-ready-resume-text'`,
    ).run(JSON.stringify(requirementLedAuditMetadata()), READY_JOB);
    db.close();
    const app = buildApp(options);

    const response = await app.inject({ method: "GET", url: "/v1/apply/review-queue" });

    expect(response.statusCode, response.body).toBe(200);
    const audit = queueItem(response.json(), READY_JOB)?.materialsPreview.requirementLedAudit;
    expect(audit).toMatchObject({
      requirementCount: 2,
      achievementCount: 3,
      coverageEdgeCount: 1,
      coveredRequirements: [
        {
          id: "r1",
          textExcerpt: "Lead platform reliability improvements across critical services.",
          tier: "must_have",
          reason: null,
        },
      ],
      uncoveredRequirements: [
        {
          id: "r2",
          textExcerpt: "Improve developer experience and incident-response practices.",
          reason: "No confirmed developer-experience evidence.",
        },
      ],
      unusedAchievementIds: ["ev-unused"],
      bulletLimitOverflows: [
        {
          experienceEntryId: "exp-1",
          maxBullets: 3,
          actualBullets: 4,
          reason: "requirement_coverage",
          evidenceIds: ["ev-platform"],
        },
      ],
      revision: {
        score: 7,
        mustHaveCoverage: 0.5,
        thresholdFailed: true,
        shouldRevise: false,
        reviewBlocked: true,
        enhancementAllowed: true,
        reason: "review_blocked_claims",
        reviewBlockers: ["claim-draft: draft_requires_confirmation"],
      },
      reviewBlockers: ["claim-draft: draft_requires_confirmation", "Acme Platform Engineer: draft_requires_confirmation"],
    });
    expect(audit?.evidenceBackedClaims).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          label: "Acme Platform Engineer",
          requirementIds: ["r1"],
          evidenceIds: ["ev-platform"],
          coverageEdgeIds: ["edge-r1-ev-platform"],
          claimLabels: ["evidence_reframed"],
          reviewRequired: false,
        }),
      ]),
    );
    expect(audit?.adjacentOrDraftClaims).toEqual([
      expect.objectContaining({
        label: "Acme Platform Engineer",
        requirementIds: ["r2"],
        evidenceIds: ["ev-incident"],
        claimLabels: ["draft_requires_confirmation"],
        reviewRequired: true,
      }),
    ]);
    expect(audit?.pinnedClaims).toEqual([
      expect.objectContaining({
        label: "Pinned leadership",
        positioningReasons: ["pinned"],
      }),
    ]);
    expect(JSON.stringify(audit)).not.toContain("RAW PROMPT SECRET");
    expect(JSON.stringify(audit)).not.toContain("FULL PROFILE SECRET");
    expect(JSON.stringify(audit)).not.toContain("/private/secret-resume.pdf");

    await app.close();
  });

  it("derives requirement-led coverage from selected artifact provenance rows", async () => {
    const metadata = requirementLedAuditMetadata();
    const qualityPlan = metadata.quality_plan as Record<string, unknown>;
    const coverageGraph = qualityPlan.coverage_graph as Record<string, unknown>;
    coverageGraph.covered_requirement_ids = ["r1", "r2"];
    coverageGraph.uncovered_requirements = [];

    const db = new Database(options.dbPath);
    db.prepare(
      `UPDATE job_materials_artifacts
          SET metadata_json = ?
        WHERE job_url = ?
          AND artifact_id = 'apply-ready-resume-text'`,
    ).run(JSON.stringify(metadata), READY_JOB);
    db.close();
    const app = buildApp(options);

    const response = await app.inject({ method: "GET", url: "/v1/apply/review-queue" });

    expect(response.statusCode, response.body).toBe(200);
    const audit = queueItem(response.json(), READY_JOB)?.materialsPreview.requirementLedAudit;
    expect(audit?.coveredRequirements.map((requirement) => requirement.id)).toEqual(["r1"]);
    expect(audit?.uncoveredRequirements).toEqual([
      {
        id: "r2",
        textExcerpt: "Improve developer experience and incident-response practices.",
        tier: "nice_to_have",
        reason: "No provenance-linked bullet in the selected tailored resume.",
      },
    ]);

    await app.close();
  });

  it("labels grounded coverage basis and parses the shipped grounded fit record", async () => {
    const metadata = requirementLedAuditMetadata();
    const fit = metadata.post_generation_fit as Record<string, unknown>;
    const fitScore = fit.fit_score as Record<string, unknown>;
    fitScore.coverage_basis = "grounded_shipped_text_v1";
    fitScore.claimed_only_requirement_ids = ["r2"];
    const decision = fit.revision_decision as Record<string, unknown>;
    decision.attempt = 2;
    decision.max_revision_attempts = 1;
    metadata.post_generation_fit_final = {
      lifecycle: "post_voice_shipped",
      fit_score: {
        score: 5,
        must_have_coverage: 0.5,
        covered_requirement_ids: ["r1"],
        uncovered_requirement_ids: ["r2"],
        claimed_only_requirement_ids: ["r2"],
        prioritized_fixes: [
          "r2: Improve developer experience — a claim mapped this requirement but its text does not appear in the shipped resume.",
        ],
        review_blockers: [],
        coverage_basis: "grounded_shipped_text_v1",
      },
      grounding: {
        basis: "grounded_shipped_text_v1",
        grounded_claims: [],
        ungrounded_claims: [],
        claimed_only_requirement_ids: ["r2"],
      },
      gate_thresholds: { min_fit_score: 6, must_have_coverage: 1.0 },
      passed: false,
      warnings: ["Shipped grounded must-have coverage 50% (fit 5/10) is below the revision gate."],
    };

    const db = new Database(options.dbPath);
    db.prepare(
      `UPDATE job_materials_artifacts
          SET metadata_json = ?
        WHERE job_url = ?
          AND artifact_id = 'apply-ready-resume-text'`,
    ).run(JSON.stringify(metadata), READY_JOB);
    db.close();
    const app = buildApp(options);

    const response = await app.inject({ method: "GET", url: "/v1/apply/review-queue" });

    expect(response.statusCode, response.body).toBe(200);
    const audit = queueItem(response.json(), READY_JOB)?.materialsPreview.requirementLedAudit;
    expect(audit?.revision).toMatchObject({
      coverageBasis: "grounded_shipped_text_v1",
      claimedOnlyRequirementIds: ["r2"],
      attempt: 2,
      maxRevisionAttempts: 1,
      revisionsUsed: 1,
    });
    expect(audit?.shippedFit).toMatchObject({
      lifecycle: "post_voice_shipped",
      score: 5,
      mustHaveCoverage: 0.5,
      claimedOnlyRequirementIds: ["r2"],
      passed: false,
      coverageBasis: "grounded_shipped_text_v1",
    });
    expect(audit?.shippedFit?.warnings).toEqual([
      "Shipped grounded must-have coverage 50% (fit 5/10) is below the revision gate.",
    ]);

    await app.close();
  });

  it("labels legacy judge-claimed coverage basis and omits the shipped grounded fit", async () => {
    const db = new Database(options.dbPath);
    db.prepare(
      `UPDATE job_materials_artifacts
          SET metadata_json = ?
        WHERE job_url = ?
          AND artifact_id = 'apply-ready-resume-text'`,
    ).run(JSON.stringify(requirementLedAuditMetadata()), READY_JOB);
    db.close();
    const app = buildApp(options);

    const response = await app.inject({ method: "GET", url: "/v1/apply/review-queue" });

    expect(response.statusCode, response.body).toBe(200);
    const audit = queueItem(response.json(), READY_JOB)?.materialsPreview.requirementLedAudit;
    expect(audit?.revision).toMatchObject({
      coverageBasis: "judge_claimed_legacy",
      claimedOnlyRequirementIds: [],
      attempt: 1,
      maxRevisionAttempts: 1,
      revisionsUsed: 0,
    });
    expect(audit?.shippedFit ?? null).toBeNull();

    await app.close();
  });

  it("reports revisions used as null when the generation attempt ordinal is absent", async () => {
    const metadata = requirementLedAuditMetadata();
    const decision = (metadata.post_generation_fit as Record<string, unknown>)
      .revision_decision as Record<string, unknown>;
    delete decision.attempt;

    const db = new Database(options.dbPath);
    db.prepare(
      `UPDATE job_materials_artifacts
          SET metadata_json = ?
        WHERE job_url = ?
          AND artifact_id = 'apply-ready-resume-text'`,
    ).run(JSON.stringify(metadata), READY_JOB);
    db.close();
    const app = buildApp(options);

    const response = await app.inject({ method: "GET", url: "/v1/apply/review-queue" });

    expect(response.statusCode, response.body).toBe(200);
    const audit = queueItem(response.json(), READY_JOB)?.materialsPreview.requirementLedAudit;
    expect(audit?.revision?.attempt).toBeNull();
    expect(audit?.revision?.revisionsUsed).toBeNull();

    await app.close();
  });

  it("surfaces review-required candidate material previews but ignores ordinary candidates", async () => {
    const ignoredCandidatePath = path.join(tempDir, "ignored-candidate-resume.txt");
    const reviewCandidatePath = path.join(tempDir, "review-candidate-resume.txt");
    fs.writeFileSync(ignoredCandidatePath, "ordinary candidate should not be shown");
    fs.writeFileSync(reviewCandidatePath, "review required candidate resume");
    const db = new Database(options.dbPath);
    db.prepare("INSERT INTO job_materials (job_url, generation) VALUES (?, ?)").run(READY_JOB, 2);
    db.prepare("INSERT INTO job_materials (job_url, generation) VALUES (?, ?)").run(READY_JOB, 3);
    db.prepare(
      `INSERT INTO job_materials_artifacts (
         job_url, generation, artifact_id, artifact_type, status, path, metadata_json, created_at, size_bytes
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      READY_JOB,
      3,
      "ignored-candidate-resume",
      "tailored_resume",
      "candidate",
      ignoredCandidatePath,
      JSON.stringify({ review_required: false }),
      "2026-06-01T12:00:00.000Z",
      38,
    );
    db.prepare(
      `INSERT INTO job_materials_artifacts (
         job_url, generation, artifact_id, artifact_type, status, path, metadata_json, created_at, size_bytes
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      READY_JOB,
      2,
      "review-candidate-resume",
      "tailored_resume",
      "candidate",
      reviewCandidatePath,
      JSON.stringify({ ...requirementLedAuditMetadata(), review_required: true }),
      "2026-06-01T11:45:00.000Z",
      32,
    );
    db.close();
    const app = buildApp(options);

    const response = await app.inject({ method: "GET", url: "/v1/apply/review-queue" });

    expect(response.statusCode, response.body).toBe(200);
    expect(queueItem(response.json(), READY_JOB)?.materialsPreview).toMatchObject({
      materialsGeneration: 2,
      resumeText: "review required candidate resume",
      resumeTextArtifactId: "review-candidate-resume",
      resumePdfArtifactId: null,
    });
    expect(queueItem(response.json(), READY_JOB)?.approvalGate).toMatchObject({
      materialsGeneration: 2,
    });
    expect(queueItem(response.json(), READY_JOB)?.materialsPreview.requirementLedAudit?.revision?.reason).toBe(
      "review_blocked_claims",
    );

    const decisionDb = new Database(options.dbPath);
    decisionDb.exec(`
      CREATE TABLE IF NOT EXISTS candidate_profiles (
        tenant_id TEXT NOT NULL,
        profile_id TEXT NOT NULL,
        version INTEGER NOT NULL DEFAULT 1,
        updated_at TEXT NOT NULL,
        PRIMARY KEY (tenant_id, profile_id)
      );
    `);
    decisionDb
      .prepare(
        "INSERT OR REPLACE INTO candidate_profiles (tenant_id, profile_id, version, updated_at) VALUES ('local', 'default', ?, ?)",
      )
      .run(7, NOW);
    insertVersionedDryRunEvidence(decisionDb, {
      applicationUrl: READY_JOB,
      materialsGeneration: 2,
      profileVersion: 7,
      runId: "dry-run-review-candidate",
    });
    decisionDb.close();

    const approve = await app.inject({
      method: "POST",
      url: `/v1/jobs/${encodeURIComponent(READY_JOB)}/apply-review/decision`,
      payload: {
        decision: "approve_submit",
        reason: "Reviewed candidate generation.",
        materialsGeneration: 2,
        profileVersion: 7,
        applicationUrl: READY_JOB,
      },
    });
    expect(approve.statusCode, approve.body).toBe(200);
    const boundDb = new Database(options.dbPath);
    try {
      const row = boundDb
        .prepare(
          `SELECT materials_generation
             FROM application_review_decisions
            WHERE job_key = ?
            ORDER BY decided_at DESC, decision_id DESC
            LIMIT 1`,
        )
        .get(READY_JOB) as { materials_generation?: number } | undefined;
      expect(row?.materials_generation).toBe(2);
    } finally {
      boundDb.close();
    }

    await app.close();
  });

  it("records approve, defer, reset, and decline review decisions without dispatching apply", async () => {
    const profileDb = new Database(options.dbPath);
    profileDb.exec(`
      CREATE TABLE candidate_profiles (
        tenant_id TEXT NOT NULL,
        profile_id TEXT NOT NULL,
        version INTEGER NOT NULL DEFAULT 1,
        updated_at TEXT NOT NULL,
        PRIMARY KEY (tenant_id, profile_id)
      );
    `);
    profileDb
      .prepare(
        "INSERT INTO candidate_profiles (tenant_id, profile_id, version, updated_at) VALUES ('local', 'default', ?, ?)",
      )
      .run(7, NOW);
    insertVersionedDryRunEvidence(profileDb, {
      applicationUrl: READY_JOB,
      materialsGeneration: 1,
      profileVersion: 7,
      runId: "dry-run-profile-v7",
    });
    profileDb.close();
    const app = buildApp(options);
    const readyKey = encodeURIComponent(READY_JOB);
    const dryRunKey = encodeURIComponent(DRY_RUN_JOB);

    const approve = await app.inject({
      method: "POST",
      url: `/v1/jobs/${readyKey}/apply-review/decision`,
      payload: {
        decision: "approve_submit",
        reason: "Looks complete.",
        materialsGeneration: 1,
        profileVersion: 7,
        applicationUrl: READY_JOB,
      },
    });
    expect(approve.statusCode, approve.body).toBe(200);
    expect(approve.json()).toMatchObject({
      ok: true,
      decision: {
        jobKey: READY_JOB,
        decision: "approve_submit",
      },
    });
    expect(actionDispatcher).not.toHaveBeenCalled();
    const db = new Database(options.dbPath);
    try {
      const row = db
        .prepare(
          `SELECT decision, materials_generation, profile_version, application_url
           FROM application_review_decisions
           WHERE job_key = ?
           ORDER BY decided_at DESC LIMIT 1`,
        )
        .get(READY_JOB) as {
          decision?: string;
          materials_generation?: number;
          profile_version?: number;
          application_url?: string;
        } | undefined;
      expect(row?.decision).toBe("approve_submit");
      expect(row?.materials_generation).toBe(1);
      expect(row?.profile_version).toBe(7);
      expect(row?.application_url).toBe(READY_JOB);
    } finally {
      db.close();
    }

    const afterApprove = await app.inject({ method: "GET", url: "/v1/apply/review-queue" });
    expect(queueItem(afterApprove.json(), READY_JOB)).toMatchObject({
      review: { state: "approved_submit", decision: "approve_submit" },
    });

    const defer = await app.inject({
      method: "POST",
      url: `/v1/jobs/${readyKey}/apply-review/decision`,
      payload: { decision: "defer", reason: "Wait for salary details." },
    });
    expect(defer.statusCode, defer.body).toBe(200);
    const afterDefer = await app.inject({ method: "GET", url: "/v1/apply/review-queue" });
    expect(queueItem(afterDefer.json(), READY_JOB)).toBeUndefined();

    const reset = await app.inject({
      method: "POST",
      url: `/v1/jobs/${readyKey}/apply-review/decision`,
      payload: { decision: "reset" },
    });
    expect(reset.statusCode, reset.body).toBe(200);
    const afterReset = await app.inject({ method: "GET", url: "/v1/apply/review-queue" });
    expect(queueItem(afterReset.json(), READY_JOB)).toMatchObject({
      review: { state: "pending", decision: "reset" },
    });

    const approveDryRun = await app.inject({
      method: "POST",
      url: `/v1/jobs/${dryRunKey}/apply-review/decision`,
      payload: { decision: "approve_dry_run" },
    });
    expect(approveDryRun.statusCode, approveDryRun.body).toBe(200);

    const decline = await app.inject({
      method: "POST",
      url: `/v1/jobs/${dryRunKey}/apply-review/decision`,
      payload: { decision: "decline" },
    });
    expect(decline.statusCode, decline.body).toBe(200);
    const afterDecline = await app.inject({ method: "GET", url: "/v1/apply/review-queue" });
    expect(queueItem(afterDecline.json(), DRY_RUN_JOB)).toBeUndefined();

    await app.close();
  });

  it("returns approval precondition errors with stable conflict codes", async () => {
    const db = new Database(options.dbPath);
    db.exec(`
      CREATE TABLE candidate_profiles (
        tenant_id TEXT NOT NULL,
        profile_id TEXT NOT NULL,
        version INTEGER NOT NULL DEFAULT 1,
        updated_at TEXT NOT NULL,
        PRIMARY KEY (tenant_id, profile_id)
      );
    `);
    db.prepare(
      "INSERT INTO candidate_profiles (tenant_id, profile_id, version, updated_at) VALUES ('local', 'default', ?, ?)",
    ).run(7, NOW);
    db.prepare("DELETE FROM job_events WHERE event_type = 'DryRunCompleted'").run();
    db.close();
    const app = buildApp(options);
    const readyKey = encodeURIComponent(READY_JOB);

    const awaitingDryRun = await app.inject({
      method: "POST",
      url: `/v1/jobs/${readyKey}/apply-review/decision`,
      payload: {
        decision: "approve_submit",
        materialsGeneration: 1,
        profileVersion: 7,
        applicationUrl: READY_JOB,
      },
    });
    expect(awaitingDryRun.statusCode, awaitingDryRun.body).toBe(409);
    expect(awaitingDryRun.json()).toMatchObject({
      ok: false,
      error: "awaiting_dry_run",
    });

    const invalidPartialOverride = await app.inject({
      method: "POST",
      url: `/v1/jobs/${readyKey}/apply-review/decision`,
      payload: {
        decision: "approve_submit",
        materialsGeneration: 1,
        profileVersion: 7,
        applicationUrl: READY_JOB,
        partialOverrideRunId: "missing-partial-run",
      },
    });
    expect(invalidPartialOverride.statusCode, invalidPartialOverride.body).toBe(409);
    expect(invalidPartialOverride.json()).toMatchObject({
      ok: false,
      error: "partial_override_evidence_invalid",
    });

    await app.close();
  });

  it("rejects submit approval when the displayed review binding is stale", async () => {
    const db = new Database(options.dbPath);
    db.exec(`
      CREATE TABLE candidate_profiles (
        tenant_id TEXT NOT NULL,
        profile_id TEXT NOT NULL,
        version INTEGER NOT NULL DEFAULT 1,
        updated_at TEXT NOT NULL,
        PRIMARY KEY (tenant_id, profile_id)
      );
    `);
    db.prepare(
      "INSERT INTO candidate_profiles (tenant_id, profile_id, version, updated_at) VALUES ('local', 'default', ?, ?)",
    ).run(7, NOW);
    insertVersionedDryRunEvidence(db, {
      applicationUrl: READY_JOB,
      materialsGeneration: 1,
      profileVersion: 7,
      runId: "dry-run-profile-v7",
    });
    db.close();
    const app = buildApp(options);
    const readyKey = encodeURIComponent(READY_JOB);

    const staleMaterials = await app.inject({
      method: "POST",
      url: `/v1/jobs/${readyKey}/apply-review/decision`,
      payload: {
        decision: "approve_submit",
        materialsGeneration: 0,
        profileVersion: 7,
        applicationUrl: READY_JOB,
      },
    });
    expect(staleMaterials.statusCode, staleMaterials.body).toBe(409);
    expect(staleMaterials.json()).toMatchObject({ ok: false, error: "approval_stale_materials" });

    const staleProfile = await app.inject({
      method: "POST",
      url: `/v1/jobs/${readyKey}/apply-review/decision`,
      payload: {
        decision: "approve_submit",
        materialsGeneration: 1,
        profileVersion: 6,
        applicationUrl: READY_JOB,
      },
    });
    expect(staleProfile.statusCode, staleProfile.body).toBe(409);
    expect(staleProfile.json()).toMatchObject({ ok: false, error: "approval_stale_profile" });

    const staleUrl = await app.inject({
      method: "POST",
      url: `/v1/jobs/${readyKey}/apply-review/decision`,
      payload: {
        decision: "approve_submit",
        materialsGeneration: 1,
        profileVersion: 7,
        applicationUrl: "https://example.com/old-apply",
      },
    });
    expect(staleUrl.statusCode, staleUrl.body).toBe(409);
    expect(staleUrl.json()).toMatchObject({ ok: false, error: "approval_stale_url" });

    await app.close();
  });

  it("rejects submit approval when dry-run evidence belongs to an older profile version", async () => {
    const db = new Database(options.dbPath);
    db.exec(`
      CREATE TABLE candidate_profiles (
        tenant_id TEXT NOT NULL,
        profile_id TEXT NOT NULL,
        version INTEGER NOT NULL DEFAULT 1,
        updated_at TEXT NOT NULL,
        PRIMARY KEY (tenant_id, profile_id)
      );
    `);
    db.prepare(
      "INSERT INTO candidate_profiles (tenant_id, profile_id, version, updated_at) VALUES ('local', 'default', ?, ?)",
    ).run(2, NOW);
    db.prepare("DELETE FROM job_events WHERE event_type IN ('ApplyRunStarted', 'DryRunCompleted')").run();
    db.prepare(
      `INSERT INTO job_events (
         job_url, stage, event_type, level, message, occurred_at, payload_json
       ) VALUES (?, 'apply', 'ApplyRunStarted', 'info', ?, ?, ?)`,
    ).run(
      READY_JOB,
      "Stale-profile dry run started",
      "2026-06-01T12:00:00.000Z",
      JSON.stringify({
        run_id: "dry-run-profile-v1",
        dry_run: true,
        materials_generation: 1,
        profile_version: 1,
        application_url: READY_JOB,
      }),
    );
    db.prepare(
      `INSERT INTO job_events (
         job_url, stage, event_type, level, message, occurred_at, payload_json
       ) VALUES (?, 'apply', 'DryRunCompleted', 'info', ?, ?, ?)`,
    ).run(
      READY_JOB,
      "Stale-profile dry run completed",
      "2026-06-01T12:01:00.000Z",
      JSON.stringify({
        run_id: "dry-run-profile-v1",
        result: "dry_run_complete",
        dry_run: true,
        coverage: "full",
        materials_generation: 1,
        profile_version: 1,
        application_url: READY_JOB,
        finished_at: "2026-06-01T12:01:00.000Z",
      }),
    );
    db.prepare(
      `INSERT INTO job_events (
         job_url, stage, event_type, level, message, occurred_at, payload_json
       ) VALUES (?, 'apply', 'DryRunCompleted', 'info', ?, ?, ?)`,
    ).run(
      READY_JOB,
      "Stale-profile partial dry run completed",
      "2026-06-01T12:02:00.000Z",
      JSON.stringify({
        run_id: "dry-run-profile-v1-partial",
        result: "dry_run_complete",
        dry_run: true,
        coverage: "partial",
        materials_generation: 1,
        profile_version: 1,
        application_url: READY_JOB,
        finished_at: "2026-06-01T12:02:00.000Z",
      }),
    );
    db.close();
    const app = buildApp(options);
    const readyKey = encodeURIComponent(READY_JOB);

    const approveSubmit = await app.inject({
      method: "POST",
      url: `/v1/jobs/${readyKey}/apply-review/decision`,
      payload: {
        decision: "approve_submit",
        materialsGeneration: 1,
        profileVersion: 2,
        applicationUrl: READY_JOB,
      },
    });
    expect(approveSubmit.statusCode, approveSubmit.body).toBe(409);
    expect(approveSubmit.json()).toMatchObject({
      ok: false,
      error: "awaiting_dry_run",
    });

    const approvePartial = await app.inject({
      method: "POST",
      url: `/v1/jobs/${readyKey}/apply-review/decision`,
      payload: {
        decision: "approve_submit",
        materialsGeneration: 1,
        profileVersion: 2,
        applicationUrl: READY_JOB,
        partialOverrideRunId: "dry-run-profile-v1-partial",
      },
    });
    expect(approvePartial.statusCode, approvePartial.body).toBe(409);
    expect(approvePartial.json()).toMatchObject({
      ok: false,
      error: "partial_override_evidence_invalid",
    });

    await app.close();
  });

  it("writes manual outcomes and reads job/global outcome timelines", async () => {
    const app = buildApp(options);
    const note = "private outcome note that should stay out of event payloads";

    const write = await app.inject({
      method: "POST",
      url: `/v1/jobs/${encodeURIComponent(READY_JOB)}/outcomes`,
      payload: {
        kind: "interview",
        occurredAt: "2026-06-01T11:00:00.000Z",
        note,
      },
    });

    expect(write.statusCode, write.body).toBe(200);
    const outcome = write.json().outcome;
    expect(outcome).toMatchObject({
      jobKey: READY_JOB,
      kind: "interview",
      source: "manual",
      note,
      interviewPrepGeneration: null,
    });

    const jobOutcomes = await app.inject({
      method: "GET",
      url: `/v1/jobs/${encodeURIComponent(READY_JOB)}/outcomes`,
    });
    expect(jobOutcomes.statusCode, jobOutcomes.body).toBe(200);
    expect(jobOutcomes.json()).toMatchObject({
      ok: true,
      jobKey: READY_JOB,
      outcomes: [expect.objectContaining({ outcomeId: outcome.outcomeId, note })],
    });

    const allOutcomes = await app.inject({ method: "GET", url: "/v1/outcomes" });
    expect(allOutcomes.statusCode, allOutcomes.body).toBe(200);
    expect(allOutcomes.json().outcomes).toEqual([
      expect.objectContaining({ outcomeId: outcome.outcomeId, jobKey: READY_JOB }),
    ]);

    expect(eventPayloadText(options.dbPath)).not.toContain(note);
    await app.close();
  });

  it("links post-interview reflections to an accepted prep generation without leaking notes", async () => {
    seedInterviewPrepGeneration(options.dbPath, READY_JOB, 2);
    const app = buildApp(options);
    const note = "private reflection after a platform design interview";

    const write = await app.inject({
      method: "POST",
      url: `/v1/jobs/${encodeURIComponent(READY_JOB)}/outcomes`,
      payload: {
        kind: "interview",
        occurredAt: "2026-06-01T12:00:00.000Z",
        note,
        interviewPrepGeneration: 2,
      },
    });

    expect(write.statusCode, write.body).toBe(200);
    const outcome = write.json().outcome;
    expect(outcome).toMatchObject({
      jobKey: READY_JOB,
      kind: "interview",
      source: "manual",
      note,
      interviewPrepGeneration: 2,
    });

    const jobOutcomes = await app.inject({
      method: "GET",
      url: `/v1/jobs/${encodeURIComponent(READY_JOB)}/outcomes`,
    });
    expect(jobOutcomes.statusCode, jobOutcomes.body).toBe(200);
    expect(jobOutcomes.json().outcomes).toEqual([
      expect.objectContaining({
        outcomeId: outcome.outcomeId,
        interviewPrepGeneration: 2,
      }),
    ]);

    const payloadText = eventPayloadText(options.dbPath);
    expect(payloadText).toContain('"interviewPrepGeneration":2');
    expect(payloadText).not.toContain(note);
    await app.close();
  });

  it("rejects reflection links that do not resolve to stored prep", async () => {
    const app = buildApp(options);

    const write = await app.inject({
      method: "POST",
      url: `/v1/jobs/${encodeURIComponent(READY_JOB)}/outcomes`,
      payload: {
        kind: "interview",
        occurredAt: "2026-06-01T12:00:00.000Z",
        note: "private reflection",
        interviewPrepGeneration: 99,
      },
    });

    expect(write.statusCode, write.body).toBe(404);
    expect(write.json()).toMatchObject({
      ok: false,
      error: "not_found",
      message: "Interview prep generation not found.",
    });
    expect(eventPayloadText(options.dbPath)).not.toContain("private reflection");
    await app.close();
  });

  it("runs Gmail outcome scan through the worker and returns only safe summary fields", async () => {
    const rawBody = "raw private Gmail body must not leave the worker boundary";
    const gmailFeedbackScanner = vi.fn(async () => ({
      ok: true,
      scannedAnchorCount: 1,
      searchedMessageCount: 2,
      linkedEvidenceCount: 1,
      suggestionsCreatedCount: 1,
      duplicateMessageCount: 0,
      unlinkedCandidateCount: 1,
      evidence: [
        {
          evidenceId: "evidence-1",
          jobKey: READY_JOB,
          providerMessageId: "gmail-message-1",
          linkConfidence: 0.94,
          bodyText: rawBody,
        },
      ],
      suggestions: [
        {
          suggestionId: "suggestion-1",
          evidenceId: "evidence-1",
          jobKey: READY_JOB,
          kind: "interview",
          confidence: 0.9,
          bodyText: rawBody,
        },
      ],
    })) as ReturnType<typeof vi.fn> & GmailFeedbackScanner;
    const app = buildApp({ ...options, gmailFeedbackScanner });

    const response = await app.inject({
      method: "POST",
      url: "/v1/outcomes/gmail/scan",
      payload: {
        recipientEmail: "candidate@example.com",
        limit: 2,
        maxResultsPerAnchor: 3,
        windowDays: 14,
      },
    });

    expect(response.statusCode, response.body).toBe(200);
    expect(gmailFeedbackScanner).toHaveBeenCalledWith(
      {
        recipientEmail: "candidate@example.com",
        limit: 2,
        maxResultsPerAnchor: 3,
        windowDays: 14,
      },
      { appDir: tempDir, dbPath: options.dbPath },
    );
    expect(response.json()).toEqual({
      ok: true,
      scannedAnchorCount: 1,
      searchedMessageCount: 2,
      linkedEvidenceCount: 1,
      suggestionsCreatedCount: 1,
      duplicateMessageCount: 0,
      unlinkedCandidateCount: 1,
      evidence: [
        {
          evidenceId: "evidence-1",
          jobKey: READY_JOB,
          providerMessageId: "gmail-message-1",
          linkConfidence: 0.94,
        },
      ],
      suggestions: [
        {
          suggestionId: "suggestion-1",
          evidenceId: "evidence-1",
          jobKey: READY_JOB,
          kind: "interview",
          confidence: 0.9,
        },
      ],
    });
    expect(response.body).not.toContain(rawBody);

    await app.close();
  });

  it("maps Gmail outcome worker errors without exposing raw body fields", async () => {
    const gmailFeedbackScanner = vi.fn(async () => {
      throw new GmailFeedbackScanError("missing Gmail token at local auth path", 503);
    }) as ReturnType<typeof vi.fn> & GmailFeedbackScanner;
    const app = buildApp({ ...options, gmailFeedbackScanner });

    const response = await app.inject({
      method: "POST",
      url: "/v1/outcomes/gmail/scan",
      payload: { limit: 1 },
    });

    expect(response.statusCode, response.body).toBe(503);
    expect(response.json()).toEqual({
      ok: false,
      error: "gmail_feedback_scan_failed",
      message: "missing Gmail token at local auth path",
    });

    await app.close();
  });

  it("rejects non-timestamp outcome dates before they reach event payloads", async () => {
    seedOutcomeSuggestion(options.dbPath);
    const app = buildApp(options);
    const privateTimestampText = "confidential recruiter feedback in a timestamp field";

    const manual = await app.inject({
      method: "POST",
      url: `/v1/jobs/${encodeURIComponent(READY_JOB)}/outcomes`,
      payload: {
        kind: "interview",
        occurredAt: privateTimestampText,
        note: "manual note",
      },
    });
    expect(manual.statusCode, manual.body).toBe(400);

    const suggestion = await app.inject({
      method: "POST",
      url: "/v1/outcome-suggestions/suggestion-1/decision",
      payload: {
        decision: "accept",
        occurredAt: privateTimestampText,
      },
    });
    expect(suggestion.statusCode, suggestion.body).toBe(400);

    expect(eventPayloadText(options.dbPath)).not.toContain(privateTimestampText);
    expect(eventPayloadText(options.dbPath)).not.toContain("manual note");

    await app.close();
  });

  it("returns not found for outcome reads on missing jobs", async () => {
    const app = buildApp(options);

    const response = await app.inject({
      method: "GET",
      url: `/v1/jobs/${encodeURIComponent("https://example.com/jobs/missing")}/outcomes`,
    });

    expect(response.statusCode, response.body).toBe(404);
    expect(response.json()).toEqual({ ok: false, error: "job_not_found" });

    await app.close();
  });

  it("accepts outcome suggestions without copying raw note or email body text into events", async () => {
    seedOutcomeSuggestion(options.dbPath);
    const app = buildApp(options);
    const privateNote = "private accepted suggestion note";
    const rawBody = "raw confidential email body";

    const response = await app.inject({
      method: "POST",
      url: "/v1/outcome-suggestions/suggestion-1/decision",
      payload: {
        decision: "accept",
        note: privateNote,
        reason: "Confirmation looks linked.",
      },
    });

    expect(response.statusCode, response.body).toBe(200);
    const acceptedOutcomeId = response.json().outcome.outcomeId;
    expect(response.json()).toMatchObject({
      ok: true,
      suggestion: {
        suggestionId: "suggestion-1",
        status: "accepted",
        decidedOutcomeId: expect.any(String),
      },
      outcome: {
        jobKey: READY_JOB,
        kind: "applied_confirmation",
        source: "email_suggestion",
        note: privateNote,
      },
    });

    const repeated = await app.inject({
      method: "POST",
      url: "/v1/outcome-suggestions/suggestion-1/decision",
      payload: {
        decision: "accept",
        note: "second private note must not create a second outcome",
      },
    });

    expect(repeated.statusCode, repeated.body).toBe(200);
    expect(repeated.json()).toMatchObject({
      ok: true,
      suggestion: {
        suggestionId: "suggestion-1",
        status: "accepted",
        decidedOutcomeId: acceptedOutcomeId,
      },
      outcome: {
        outcomeId: acceptedOutcomeId,
      },
    });

    const jobOutcomes = await app.inject({
      method: "GET",
      url: `/v1/jobs/${encodeURIComponent(READY_JOB)}/outcomes`,
    });
    expect(jobOutcomes.json().outcomes).toHaveLength(1);
    expect(jobOutcomes.json().suggestions).toEqual([
      expect.objectContaining({ suggestionId: "suggestion-1", status: "accepted" }),
    ]);

    const payloads = eventPayloadText(options.dbPath);
    expect(payloads).not.toContain(privateNote);
    expect(payloads).not.toContain(rawBody);

    await app.close();
  });
});

function queueItem(body: unknown, jobKey: string): ApplyReviewQueueResponse["items"][number] | undefined {
  const items = (body as ApplyReviewQueueResponse).items ?? [];
  return items.find((item) => item.jobKey === jobKey);
}

function seedDatabase(dbPath: string): void {
  const resumePath = path.join(path.dirname(dbPath), "resume.txt");
  const resumePdfPath = path.join(path.dirname(dbPath), "resume.pdf");
  const rejectedResumePdfPath = path.join(path.dirname(dbPath), "rejected-resume.pdf");
  fs.writeFileSync(resumePath, "tailored resume");
  fs.writeFileSync(resumePdfPath, "%PDF-1.4\n% test\n");
  fs.writeFileSync(rejectedResumePdfPath, "%PDF-1.4\n% rejected test\n");
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
      tailor_attempts INTEGER,
      cover_letter_path TEXT,
      cover_letter_at TEXT,
      cover_attempts INTEGER,
      apply_status TEXT,
      apply_error TEXT,
      applied_at TEXT
    );
    CREATE TABLE job_stage_states (
      job_url TEXT,
      stage TEXT,
      state TEXT,
      attempt_count INTEGER,
      max_attempts INTEGER,
      started_at TEXT,
      updated_at TEXT,
      finished_at TEXT,
      duration_ms INTEGER,
      error_code TEXT,
      error_message TEXT,
      retryable INTEGER,
      blocked_by_json TEXT,
      next_action TEXT,
      metadata_json TEXT
    );
    CREATE TABLE job_events (
      event_id INTEGER PRIMARY KEY AUTOINCREMENT,
      job_url TEXT,
      stage TEXT,
      event_type TEXT NOT NULL DEFAULT '',
      level TEXT NOT NULL DEFAULT 'info',
      message TEXT,
      occurred_at TEXT NOT NULL,
      payload_json TEXT
    );
    CREATE TABLE apply_run_projections (
      run_id TEXT PRIMARY KEY,
      tenant_id TEXT NOT NULL DEFAULT 'local',
      job_id TEXT NOT NULL,
      job_title TEXT NOT NULL DEFAULT '',
      job_employer TEXT NOT NULL DEFAULT '',
      status TEXT NOT NULL DEFAULT '',
      result TEXT,
      dry_run INTEGER NOT NULL DEFAULT 0,
      worker_id INTEGER,
      model TEXT,
      started_at TEXT,
      finished_at TEXT,
      duration_ms INTEGER,
      events_json TEXT NOT NULL DEFAULT '[]'
    );
    CREATE TABLE job_scores (
      job_url TEXT NOT NULL,
      version INTEGER NOT NULL,
      tenant_id TEXT NOT NULL DEFAULT 'local',
      fit_score INTEGER NOT NULL,
      breakdown_json TEXT NOT NULL,
      keywords_json TEXT NOT NULL,
      scored_at TEXT,
      correction_json TEXT NOT NULL DEFAULT '{}',
      criteria_json TEXT NOT NULL DEFAULT '{}',
      trace_json TEXT NOT NULL DEFAULT '{}',
      PRIMARY KEY (job_url, version)
    );
    CREATE TABLE job_materials (
      job_url TEXT NOT NULL,
      generation INTEGER NOT NULL
    );
    CREATE TABLE job_materials_artifacts (
      job_url TEXT NOT NULL,
      generation INTEGER NOT NULL,
      artifact_id TEXT,
      artifact_type TEXT,
      status TEXT,
      path TEXT,
      created_at TEXT,
      size_bytes INTEGER,
      metadata_json TEXT
    );
    CREATE TABLE job_bullet_provenance (
      job_url TEXT NOT NULL,
      generation INTEGER NOT NULL,
      bullet_id TEXT NOT NULL,
      tenant_id TEXT NOT NULL DEFAULT 'local',
      artifact_id TEXT NOT NULL,
      section TEXT NOT NULL,
      source_id TEXT,
      evidence_ids_json TEXT NOT NULL DEFAULT '[]',
      requirement_ids_json TEXT NOT NULL DEFAULT '[]',
      matched_keywords_json TEXT NOT NULL DEFAULT '[]',
      transform_type TEXT NOT NULL,
      control TEXT NOT NULL,
      rationale TEXT NOT NULL DEFAULT '',
      generated_text TEXT NOT NULL,
      position INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL,
      PRIMARY KEY (job_url, generation, bullet_id)
    );
    CREATE TABLE job_material_layout_boxes (
      job_url TEXT NOT NULL,
      generation INTEGER NOT NULL,
      artifact_id TEXT NOT NULL,
      box_index INTEGER NOT NULL,
      tenant_id TEXT NOT NULL DEFAULT 'local',
      semantic_id TEXT NOT NULL,
      page_number INTEGER NOT NULL,
      line_number INTEGER,
      text_excerpt TEXT NOT NULL,
      left_pct REAL NOT NULL,
      top_pct REAL NOT NULL,
      width_pct REAL NOT NULL,
      height_pct REAL NOT NULL,
      audit_target_json TEXT NOT NULL DEFAULT '{}',
      created_at TEXT NOT NULL,
      PRIMARY KEY (job_url, generation, artifact_id, box_index)
    );
    CREATE TABLE job_employer_analysis (
      job_url TEXT NOT NULL,
      generation INTEGER NOT NULL,
      tenant_id TEXT NOT NULL DEFAULT 'local',
      ideal_candidate_narrative TEXT NOT NULL DEFAULT '',
      requirements_json TEXT NOT NULL DEFAULT '[]'
    );
    CREATE TABLE job_employer_analysis_sub_analyses (
      job_url TEXT NOT NULL,
      generation INTEGER NOT NULL,
      model_id TEXT NOT NULL,
      analysis_json TEXT NOT NULL DEFAULT '{}'
    );
    CREATE TABLE job_employer_analysis_failures (
      job_url TEXT NOT NULL,
      generation INTEGER NOT NULL,
      model_id TEXT NOT NULL,
      error TEXT NOT NULL DEFAULT '',
      raw_output TEXT
    );
    CREATE TABLE job_requirement_fit_reports (
      tenant_id TEXT NOT NULL DEFAULT 'local',
      job_url TEXT NOT NULL,
      score_version INTEGER NOT NULL,
      employer_analysis_generation INTEGER NOT NULL,
      profile_snapshot_version INTEGER NOT NULL,
      scoring_policy_version INTEGER NOT NULL,
      formula_version TEXT NOT NULL,
      resolved_fit_score INTEGER,
      fit_band TEXT NOT NULL,
      confidence TEXT NOT NULL,
      summary_json TEXT NOT NULL DEFAULT '{}',
      PRIMARY KEY (tenant_id, job_url, score_version)
    );
    CREATE TABLE job_requirement_fit_items (
      tenant_id TEXT NOT NULL DEFAULT 'local',
      job_url TEXT NOT NULL,
      score_version INTEGER NOT NULL,
      requirement_id TEXT NOT NULL,
      requirement_text TEXT NOT NULL,
      tier TEXT NOT NULL,
      weight REAL NOT NULL,
      job_evidence_span TEXT NOT NULL,
      fit_json TEXT NOT NULL DEFAULT '{}',
      contribution_json TEXT NOT NULL DEFAULT '{}',
      tailoring_json TEXT NOT NULL DEFAULT '{}',
      artifact_coverage_json TEXT,
      position INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY (tenant_id, job_url, score_version, requirement_id)
    );
    CREATE TABLE job_posted_compensation_facts (
      tenant_id TEXT NOT NULL DEFAULT 'local',
      job_url TEXT NOT NULL,
      source_field TEXT NOT NULL DEFAULT 'jobs.salary',
      source_text TEXT,
      legacy_raw_salary TEXT,
      parse_state TEXT NOT NULL,
      currency TEXT,
      period TEXT NOT NULL DEFAULT 'unknown',
      component TEXT NOT NULL DEFAULT 'unknown',
      minimum_amount INTEGER,
      maximum_amount INTEGER,
      annualized_minimum_amount INTEGER,
      annualized_maximum_amount INTEGER,
      annualization_assumption TEXT,
      confidence TEXT NOT NULL DEFAULT 'none',
      warnings_json TEXT NOT NULL DEFAULT '[]',
      parser_version TEXT NOT NULL,
      source_hash TEXT NOT NULL,
      parsed_at TEXT NOT NULL,
      PRIMARY KEY (tenant_id, job_url)
    );
    CREATE TABLE job_market_compensation_estimates (
      tenant_id TEXT NOT NULL DEFAULT 'local',
      job_url TEXT NOT NULL,
      estimate_state TEXT NOT NULL,
      currency TEXT,
      period TEXT NOT NULL DEFAULT 'year',
      component TEXT NOT NULL DEFAULT 'base_salary',
      minimum_amount INTEGER,
      maximum_amount INTEGER,
      confidence_band TEXT NOT NULL DEFAULT 'none',
      confidence_score REAL NOT NULL DEFAULT 0,
      source_count INTEGER NOT NULL DEFAULT 0,
      sample_count INTEGER,
      aggregate_bucket TEXT,
      geography_scope TEXT,
      occupation_code TEXT,
      occupation_label TEXT,
      seniority_label TEXT,
      source_snapshot_json TEXT NOT NULL DEFAULT '[]',
      factor_reasons_json TEXT NOT NULL DEFAULT '[]',
      insufficient_reasons_json TEXT NOT NULL DEFAULT '[]',
      unsupported_reasons_json TEXT NOT NULL DEFAULT '[]',
      source_unavailable_reasons_json TEXT NOT NULL DEFAULT '[]',
      warnings_json TEXT NOT NULL DEFAULT '[]',
      estimator_version TEXT NOT NULL,
      estimated_at TEXT NOT NULL,
      company_name TEXT,
      normalized_company TEXT,
      role_title TEXT,
      normalized_role TEXT,
      company_tier TEXT NOT NULL DEFAULT 'unknown',
      match_scope TEXT NOT NULL DEFAULT 'none',
      PRIMARY KEY (tenant_id, job_url)
    );
  `);

  insertJob(db, {
    url: READY_JOB,
    title: "Principal Platform Engineer",
    site: "ExampleCo",
    fitScore: 9,
    resumePath,
    resumePdfPath,
    rejectedResumePdfPath,
    applyState: "pending",
  });
  insertJob(db, {
    url: DRY_RUN_JOB,
    title: "Staff Backend Engineer",
    site: "ExampleCo",
    fitScore: 8,
    resumePath,
    resumePdfPath,
    rejectedResumePdfPath,
    applyState: "pending",
  });
  insertJob(db, {
    url: APPLIED_JOB,
    title: "Already Applied Engineer",
    site: "ExampleCo",
    fitScore: 8,
    resumePath,
    resumePdfPath,
    rejectedResumePdfPath,
    applyState: "succeeded",
    appliedAt: "2026-05-31T10:00:00.000Z",
  });
  db.prepare(
    `INSERT INTO apply_run_projections (
       run_id, job_id, job_title, job_employer, status, result, dry_run, started_at, finished_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    "dry-run-ready",
    READY_JOB,
    "Principal Platform Engineer",
    "ExampleCo",
    "dry_run_complete",
    "dry_run_complete",
    1,
    "2026-05-31T09:00:00.000Z",
    "2026-05-31T09:01:00.000Z",
  );
  db.prepare(
    `INSERT INTO job_events (
       job_url, stage, event_type, level, message, occurred_at, payload_json
     ) VALUES (?, 'apply', 'ApplyRunStarted', 'info', ?, ?, ?)`,
  ).run(
    READY_JOB,
    "Apply dry-run started",
    "2026-05-31T09:00:00.000Z",
    JSON.stringify({
      run_id: "dry-run-ready",
      dry_run: true,
      materials_generation: 1,
      application_url: READY_JOB,
    }),
  );
  db.prepare(
    `INSERT INTO job_events (
       job_url, stage, event_type, level, message, occurred_at, payload_json
     ) VALUES (?, 'apply', 'DryRunCompleted', 'info', ?, ?, ?)`,
  ).run(
    READY_JOB,
    "Dry run completed",
    "2026-05-31T09:01:00.000Z",
    JSON.stringify({
      run_id: "dry-run-ready",
      result: "dry_run_complete",
      dry_run: true,
      coverage: "full",
      materials_generation: 1,
      application_url: READY_JOB,
      finished_at: "2026-05-31T09:01:00.000Z",
    }),
  );
  insertBulletProvenance(db);
  insertCompensationRows(db, READY_JOB);
  db.close();
}

function insertVersionedDryRunEvidence(
  db: Database.Database,
  options: {
    readonly applicationUrl: string;
    readonly coverage?: "full" | "partial";
    readonly materialsGeneration: number;
    readonly profileVersion: number;
    readonly runId: string;
  },
): void {
  const coverage = options.coverage ?? "full";
  db.prepare(
    `INSERT INTO job_events (
       job_url, stage, event_type, level, message, occurred_at, payload_json
     ) VALUES (?, 'apply', 'ApplyRunStarted', 'info', ?, ?, ?)`,
  ).run(
    READY_JOB,
    "Versioned dry run started",
    "2026-06-01T12:00:00.000Z",
    JSON.stringify({
      run_id: options.runId,
      dry_run: true,
      materials_generation: options.materialsGeneration,
      profile_version: options.profileVersion,
      application_url: options.applicationUrl,
    }),
  );
  db.prepare(
    `INSERT INTO job_events (
       job_url, stage, event_type, level, message, occurred_at, payload_json
     ) VALUES (?, 'apply', 'DryRunCompleted', 'info', ?, ?, ?)`,
  ).run(
    READY_JOB,
    "Versioned dry run completed",
    "2026-06-01T12:01:00.000Z",
    JSON.stringify({
      run_id: options.runId,
      result: "dry_run_complete",
      dry_run: true,
      coverage,
      materials_generation: options.materialsGeneration,
      profile_version: options.profileVersion,
      application_url: options.applicationUrl,
      finished_at: "2026-06-01T12:01:00.000Z",
    }),
  );
}

function insertCompensationRows(db: Database.Database, jobUrl: string): void {
  db.prepare("UPDATE jobs SET salary = ? WHERE url = ?").run("EUR 70000-90000/year", jobUrl);
  db.prepare(
    `INSERT INTO job_posted_compensation_facts (
       tenant_id, job_url, source_field, source_text, legacy_raw_salary,
       parse_state, currency, period, component, minimum_amount, maximum_amount,
       annualized_minimum_amount, annualized_maximum_amount, annualization_assumption,
       confidence, warnings_json, parser_version, source_hash, parsed_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    "local",
    jobUrl,
    "jobs.salary",
    "EUR 70000-90000/year",
    "EUR 70000-90000/year",
    "parsed_range",
    "EUR",
    "year",
    "base_salary",
    70000,
    90000,
    70000,
    90000,
    null,
    "high",
    "[]",
    "posted-compensation-parser-v1",
    "posted-hash",
    NOW,
  );
  db.prepare(
    `INSERT INTO job_market_compensation_estimates (
       tenant_id, job_url, estimate_state, currency, period, component,
       minimum_amount, maximum_amount, confidence_band, confidence_score,
       source_count, sample_count, aggregate_bucket, geography_scope,
       occupation_code, occupation_label, seniority_label, source_snapshot_json,
       factor_reasons_json, insufficient_reasons_json, unsupported_reasons_json,
       source_unavailable_reasons_json, warnings_json, estimator_version, estimated_at,
       company_name, normalized_company, role_title, normalized_role, company_tier, match_scope
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    "local",
    jobUrl,
    "estimated_range",
    "EUR",
    "year",
    "base_salary",
    112000,
    142000,
    "medium",
    0.82,
    2,
    7,
    "company_role",
    "europe",
    "2512",
    "Software developers",
    "principal",
    JSON.stringify([
      {
        source_id: "levels_fyi",
        source_type: "reported_compensation",
        release_year: 2026,
        sample_count: 4,
        aggregate_bucket: "company_role",
        geography_scope: "europe",
        attribution: "local permitted export",
      },
      {
        source_id: "glassdoor",
        source_type: "reported_compensation",
        release_year: 2026,
        sample_count: 3,
        aggregate_bucket: "company_role",
        geography_scope: "europe",
        attribution: "local permitted export",
      },
    ]),
    JSON.stringify([
      {
        name: "company",
        score: 0.96,
        band: "high",
        reason: "Reported rows match ExampleCo directly.",
      },
      {
        name: "sample",
        score: 0.64,
        band: "medium",
        reason: "Seven reported rows support the estimate.",
      },
    ]),
    "[]",
    "[]",
    "[]",
    JSON.stringify([
      {
        code: "reported_compensation_sample",
        message: "Reported compensation support is moderate, not exhaustive.",
      },
    ]),
    "company-role-reported-compensation-v1",
    NOW,
    "ExampleCo",
    "exampleco",
    "Principal Platform Engineer",
    "principal platform engineer",
    "tier_2_ambitious",
    "exact_company_role",
  );
}

function insertJob(
  db: Database.Database,
  job: {
    url: string;
    title: string;
    site: string;
    fitScore: number;
    resumePath: string;
    resumePdfPath: string;
    rejectedResumePdfPath: string;
    applyState: string;
    appliedAt?: string;
  },
): void {
  db.prepare(
    `INSERT INTO jobs (
       url, title, site, strategy, location, salary, discovered_at, application_url,
       description, full_description, detail_scraped_at, fit_score, score_reasoning,
       scored_at, tailored_resume_path, tailored_at, apply_status, applied_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    job.url,
    job.title,
    job.site,
    "test",
    "Remote",
    "",
    NOW,
    job.url,
    "Short description",
    "Full description",
    NOW,
    job.fitScore,
    "Strong fit.",
    NOW,
    job.resumePath,
    NOW,
    job.appliedAt ? "applied" : null,
    job.appliedAt ?? null,
  );
  for (const stage of ["discover", "enrich", "score", "tailor", "cover"]) {
    insertStage(db, job.url, stage, "succeeded");
  }
  insertStage(db, job.url, "apply", job.applyState);
  insertScore(db, job.url, job.fitScore);
  insertEmployerAnalysis(db, job.url);
  insertRequirementFitReport(db, job.url);
  insertMaterials(db, job.url, job.resumePath, job.resumePdfPath, job.rejectedResumePdfPath);
}

function insertEmployerAnalysis(db: Database.Database, jobUrl: string): void {
  if (jobUrl !== READY_JOB) {
    return;
  }
  db.prepare(
    `INSERT INTO job_employer_analysis (
       job_url, generation, tenant_id, ideal_candidate_narrative, requirements_json
     ) VALUES (?, ?, ?, ?, ?)`,
  ).run(
    jobUrl,
    1,
    "local",
    "A senior platform leader who improves developer experience and incident response across teams.",
    JSON.stringify([
      {
        id: "r1",
        text: "Lead platform reliability improvements across critical services.",
        tier: "must_have",
        weight: 0.9,
        evidence_span: "lead platform reliability",
      },
      {
        id: "r2",
        text: "Improve developer experience and incident-response practices.",
        tier: "important",
        weight: 0.7,
        evidence_span: "developer experience improvements",
      },
    ]),
  );
}

function insertMaterials(
  db: Database.Database,
  jobUrl: string,
  resumePath: string,
  resumePdfPath: string,
  rejectedResumePdfPath: string,
): void {
  const artifactPrefix =
    jobUrl === READY_JOB ? "apply-ready" : jobUrl === DRY_RUN_JOB ? "dry-run" : "already-applied";
  db.prepare("INSERT INTO job_materials (job_url, generation) VALUES (?, ?)").run(jobUrl, 1);
  db.prepare(
    `INSERT INTO job_materials_artifacts (
       job_url, generation, artifact_id, artifact_type, status, path, created_at, size_bytes
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(jobUrl, 1, `${artifactPrefix}-resume-text`, "tailored_resume", "approved", resumePath, NOW, 15);
  db.prepare(
    `INSERT INTO job_materials_artifacts (
       job_url, generation, artifact_id, artifact_type, status, path, created_at, size_bytes
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(jobUrl, 1, `${artifactPrefix}-resume-pdf`, "resume_pdf", "approved", resumePdfPath, NOW, 15);
  db.prepare(
    `INSERT INTO job_material_layout_boxes (
       job_url, generation, artifact_id, box_index, tenant_id,
       semantic_id, page_number, line_number, text_excerpt,
       left_pct, top_pct, width_pct, height_pct, audit_target_json, created_at
     ) VALUES (?, 1, ?, 0, 'local', ?, 1, 6, ?, 12.5, 24.0, 62.0, 2.4, '{}', ?)`,
  ).run(
    jobUrl,
    `${artifactPrefix}-resume-pdf`,
    "experience:acme:bullet:1",
    "Owned platform reliability improvements for incident response.",
    NOW,
  );
  db.prepare(
    `INSERT INTO job_materials_artifacts (
       job_url, generation, artifact_id, artifact_type, status, path, created_at, size_bytes
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    jobUrl,
    1,
    `${artifactPrefix}-rejected-resume-pdf`,
    "resume_pdf",
    "rejected",
    rejectedResumePdfPath,
    "2026-06-01T11:00:00.000Z",
    22,
  );
}

function requirementLedAuditMetadata(): Record<string, unknown> {
  return {
    system_prompt: "RAW PROMPT SECRET",
    job_text: "Full description with FULL PROFILE SECRET and unrelated details.",
    local_path: "/private/secret-resume.pdf",
    quality_plan: {
      target_profile: {
        requirements: [
          {
            requirement_id: "r1",
            text_excerpt: "Lead platform reliability improvements across critical services.",
            tier: "must_have",
          },
          {
            requirement_id: "r2",
            text_excerpt: "Improve developer experience and incident-response practices.",
            tier: "nice_to_have",
          },
        ],
      },
      coverage_graph: {
        requirement_count: 2,
        achievement_count: 3,
        coverage_edge_count: 1,
        covered_requirement_ids: ["r1"],
        uncovered_requirements: [
          {
            requirement_id: "r2",
            reason: "No confirmed developer-experience evidence.",
            prohibited_claims: ["owned developer experience end to end"],
          },
        ],
        unused_achievement_ids: ["ev-unused"],
        coverage_edges: [
          {
            edge_id: "edge-r1-ev-platform",
            requirement_id: "r1",
            achievement_evidence_id: "ev-platform",
            coverage_kind: "direct",
            strength: "direct",
            required_claim_policy: "evidence_reframing",
            target_terms: ["platform reliability"],
            rationale: "Direct evidence supports platform reliability.",
          },
        ],
      },
    },
    change_annotations: [
      {
        section: "experience",
        label: "Acme Platform Engineer",
        source_text: ["FULL PROFILE SECRET source bullet"],
        tailored_text: ["Owned platform reliability improvements for incident response."],
        evidence_ids: ["ev-platform"],
        requirement_ids: ["r1"],
        coverage_edge_ids: ["edge-r1-ev-platform"],
        claim_labels: ["evidence_reframed"],
        positioning_reasons: [],
        review_required: false,
      },
      {
        section: "experience",
        label: "Acme Platform Engineer",
        tailored_text: ["Draft developer experience translation requires confirmation."],
        evidence_ids: ["ev-incident"],
        requirement_ids: ["r2"],
        coverage_edge_ids: ["edge-r2-ev-incident"],
        claim_labels: ["draft_requires_confirmation"],
        positioning_reasons: [],
        review_required: true,
      },
      {
        section: "experience",
        label: "Pinned leadership",
        tailored_text: ["Pinned community mentoring."],
        evidence_ids: ["ev-pinned"],
        requirement_ids: [],
        coverage_edge_ids: [],
        claim_labels: ["pinned"],
        positioning_reasons: ["pinned"],
        review_required: false,
      },
    ],
    post_generation_fit: {
      fit_score: {
        score: 7,
        must_have_coverage: 0.5,
        covered_requirement_ids: ["r1"],
        uncovered_requirement_ids: ["r2"],
        prioritized_fixes: ["Add direct developer experience proof."],
        review_blockers: ["claim-draft: draft_requires_confirmation"],
      },
      revision_decision: {
        threshold_failed: true,
        should_revise: false,
        review_blocked: true,
        enhancement_allowed: true,
        reason: "review_blocked_claims",
        attempt: 1,
        max_revision_attempts: 1,
        prioritized_fixes: ["Add direct developer experience proof."],
        review_blockers: ["claim-draft: draft_requires_confirmation"],
      },
    },
    bullet_limit_overflows: [
      {
        experience_entry_id: "exp-1",
        max_bullets: 3,
        actual_bullets: 4,
        reason: "requirement_coverage",
        evidence_ids: ["ev-platform"],
      },
    ],
  };
}

function insertRequirementFitReport(db: Database.Database, jobUrl: string): void {
  if (jobUrl !== READY_JOB) {
    return;
  }
  db.prepare(
    `INSERT INTO job_requirement_fit_reports (
       tenant_id, job_url, score_version, employer_analysis_generation,
       profile_snapshot_version, scoring_policy_version, formula_version,
       resolved_fit_score, fit_band, confidence, summary_json
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    "local",
    jobUrl,
    1,
    1,
    4,
    3,
    "requirement-fit-v1",
    9,
    "strong",
    "high",
    JSON.stringify({ weighted_fit: 0.86, must_have_coverage: 1, blocker_count: 0, missing_high_weight_count: 0 }),
  );
  const insertItem = db.prepare(
    `INSERT INTO job_requirement_fit_items (
       tenant_id, job_url, score_version, requirement_id, requirement_text,
       tier, weight, job_evidence_span, fit_json, contribution_json,
       tailoring_json, artifact_coverage_json, position
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  insertItem.run(
    "local",
    jobUrl,
    1,
    "r1",
    "Lead platform reliability improvements across critical services.",
    "must_have",
    0.9,
    "lead platform reliability",
    JSON.stringify({ kind: "matched", evidence_ids: ["ev-platform"], strength: "direct" }),
    JSON.stringify({
      max_points: 1.125,
      awarded_points: 1.125,
      weighted_impact: 1.125,
      rationale: "Direct platform reliability evidence covers the requirement.",
    }),
    JSON.stringify({
      action: "double_down",
      priority: 0.9,
      allowed_evidence_ids: ["ev-platform"],
      target_keywords: ["platform reliability"],
      prohibited_claims: [],
      instruction: "Keep platform reliability ownership prominent.",
    }),
    null,
    1,
  );
  insertItem.run(
    "local",
    jobUrl,
    1,
    "r2",
    "Improve developer experience and incident-response practices.",
    "nice_to_have",
    0.7,
    "developer experience improvements",
    JSON.stringify({
      kind: "transferable",
      evidence_ids: ["ev-incident"],
      gap: "No direct developer-experience ownership evidence was recorded.",
      bridge: "Incident leadership can support adjacent developer-experience expectations.",
    }),
    JSON.stringify({
      max_points: 0.7,
      awarded_points: 0.42,
      weighted_impact: 0.42,
      rationale: "Transferable incident leadership partially covers the requirement.",
    }),
    JSON.stringify({
      action: "bridge_gap",
      priority: 0.7,
      allowed_evidence_ids: ["ev-incident"],
      target_keywords: ["incident response", "developer experience"],
      prohibited_claims: ["owned developer experience end to end"],
      instruction: "Bridge from incident leadership without claiming direct developer-experience ownership.",
    }),
    null,
    2,
  );
}

function insertBulletProvenance(db: Database.Database): void {
  db.prepare(
    `INSERT INTO job_bullet_provenance (
       job_url, generation, bullet_id, tenant_id, artifact_id, section, source_id,
       evidence_ids_json, requirement_ids_json, matched_keywords_json,
       transform_type, control, rationale, generated_text, position, created_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    READY_JOB,
    1,
    "summary-1",
    "local",
    "apply-ready-resume-text",
    "summary",
    "exp-1",
    JSON.stringify(["ev-platform"]),
    JSON.stringify(["r1"]),
    JSON.stringify(["platform reliability"]),
    "rephrased",
    "rephrase_allowed",
    "Reframed the bullet toward platform reliability.",
    LONG_TAILORED_REQUIREMENT_EVIDENCE,
    1,
    NOW,
  );
}

function insertScore(db: Database.Database, jobUrl: string, fitScore: number): void {
  db.prepare(
    `INSERT INTO job_scores (
       job_url, version, tenant_id, fit_score, breakdown_json, keywords_json,
       scored_at, correction_json, criteria_json, trace_json
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    jobUrl,
    1,
    "local",
    fitScore,
    JSON.stringify({
      reasoning: "Strong platform leadership fit.",
      technical_fit: 9,
      experience_fit: 8,
      role_fit: 8,
      fit_band: "strong",
      confidence: "high",
      eligibility: { status: "eligible", hard_blockers: [], warnings: [] },
      matched_signals: ["platform leadership"],
      missing_signals: ["public company scale"],
      transferable_signals: ["incident leadership"],
    }),
    JSON.stringify(["platform", "leadership"]),
    NOW,
    "{}",
    JSON.stringify({
      min_fit_score: 7,
      criteria_text: "Platform leadership and incident response.",
      target_criteria: "Senior platform leader.",
      criteria_version: "criteria-test",
    }),
    JSON.stringify({
      prompt_version: "score-fit-assessment-v1",
      schema_version: "score-fit-assessment-v1",
      model: "fake-model",
      criteria_version: "criteria-test",
      profile_snapshot_version: 4,
      scoring_policy_id: "local:scoring-policy-v3",
      scoring_policy_version: 3,
      rubric_version: "default-scoring-rubric-v1",
      raw_weighted_score: 8.6,
      calibration_adjustment: 0,
      resolved_fit_band: "strong",
      resolution_reason: "weighted_dimensions",
      parser_warnings: [],
    }),
  );
}

function insertStage(db: Database.Database, jobUrl: string, stage: string, state: string): void {
  db.prepare(
    `INSERT INTO job_stage_states (
       job_url, stage, state, attempt_count, max_attempts, updated_at,
       error_code, error_message, retryable, blocked_by_json
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(jobUrl, stage, state, 0, 3, NOW, null, null, 1, "[]");
}

function seedOutcomeSuggestion(dbPath: string): void {
  const db = new Database(dbPath);
  ensureApplicationFeedbackTables(db);
  db.prepare(
    `INSERT INTO application_email_evidence (
       tenant_id, evidence_id, job_key, provider, provider_message_id,
       provider_thread_id, from_address, to_addresses_json, subject, snippet,
       received_at, linked_at, link_confidence, link_signals_json,
       body_text, body_sha256, body_stored_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    "local",
    "evidence-1",
    READY_JOB,
    "gmail",
    "gmail-message-1",
    "gmail-thread-1",
    "recruiting@example.com",
    JSON.stringify(["candidate@example.com"]),
    "Application received",
    "Thanks for applying.",
    "2026-06-01T09:00:00.000Z",
    "2026-06-01T09:05:00.000Z",
    0.94,
    JSON.stringify(["company", "title", "time_window"]),
    "raw confidential email body",
    "body-sha",
    "2026-06-01T09:05:00.000Z",
  );
  db.prepare(
    `INSERT INTO application_outcome_suggestions (
       tenant_id, suggestion_id, job_key, evidence_id, suggested_kind,
       confidence, rationale, status, created_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    "local",
    "suggestion-1",
    READY_JOB,
    "evidence-1",
    "applied_confirmation",
    0.91,
    "Gmail subject and snippet look like an application confirmation.",
    "pending",
    "2026-06-01T09:06:00.000Z",
  );
  db.close();
}

function eventPayloadText(dbPath: string): string {
  const db = new Database(dbPath);
  try {
    const rows = db
      .prepare("SELECT payload_json FROM job_events ORDER BY event_id ASC")
      .all() as Array<{ payload_json: string | null }>;
    return rows.map((row) => row.payload_json ?? "").join("\n");
  } finally {
    db.close();
  }
}

function seedInterviewPrepGeneration(dbPath: string, jobUrl: string, generation: number): void {
  const db = new Database(dbPath);
  try {
    db.exec(`
      CREATE TABLE IF NOT EXISTS job_interview_prep (
        tenant_id TEXT NOT NULL DEFAULT 'local',
        job_url TEXT NOT NULL,
        generation INTEGER NOT NULL,
        status TEXT NOT NULL,
        generated_at TEXT NOT NULL,
        model TEXT,
        gate_audit_json TEXT NOT NULL DEFAULT '{}',
        PRIMARY KEY (job_url, generation)
      );
    `);
    db.prepare(
      `INSERT INTO job_interview_prep (
         tenant_id, job_url, generation, status, generated_at, model, gate_audit_json
       ) VALUES ('local', ?, ?, 'accepted', '2026-06-01T10:30:00.000Z', 'gpt-test', '{}')`,
    ).run(jobUrl, generation);
  } finally {
    db.close();
  }
}
