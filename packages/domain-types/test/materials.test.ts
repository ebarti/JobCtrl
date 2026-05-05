/**
 * Phase 6 / S-19: TypeScript MaterialsSet types are constructable.
 *
 * The TS types are pure compile-time interfaces, so the runtime tests
 * focus on (a) the closed enumerations matching the Python source of
 * truth and (b) a fully populated MaterialsSet being structurally
 * constructable from literal data — i.e. no required field is
 * accidentally missing. ``createMaterialsSet`` is a validating
 * constructor that mirrors the Python aggregate's ``__post_init__``
 * invariants.
 */

import { describe, it, expect } from "vitest";
import { LOCAL_TENANT } from "../src/tenant.js";
import { generateJobId } from "../src/identifiers.js";
import {
  ARTIFACT_STATUSES,
  ARTIFACT_TYPES,
  MATERIALS_LIFECYCLE_STATES,
  RENDER_FORMATS,
  type Artifact,
  type ArtifactStatus,
  type ArtifactType,
  type JudgeVerdict,
  type MaterialsLifecycle,
  type MaterialsSet,
  type RenderFormat,
  type ValidationResult,
  createMaterialsSet,
} from "../src/materials/index.js";

describe("Materials types", () => {
  it("exposes the canonical ArtifactType values", () => {
    expect(ARTIFACT_TYPES).toEqual([
      "tailored_resume",
      "cover_letter",
      "resume_pdf",
      "cover_letter_pdf",
    ]);
  });

  it("exposes the canonical ArtifactStatus values", () => {
    expect(ARTIFACT_STATUSES).toEqual(["candidate", "approved", "rejected", "superseded"]);
  });

  it("exposes the canonical RenderFormat values", () => {
    expect(RENDER_FORMATS).toEqual(["latex_pdf", "html_pdf", "text"]);
  });

  it("exposes the canonical MaterialsLifecycle values", () => {
    expect(MATERIALS_LIFECYCLE_STATES).toEqual([
      "resume_in_progress",
      "resume_approved",
      "cover_letter_ready",
      "complete",
    ]);
  });

  it("a fully specified MaterialsSet is structurally constructable", () => {
    const validation: ValidationResult = {
      passed: true,
      errors: [],
      warnings: [],
    };
    const verdict: JudgeVerdict = {
      approved: true,
      score: 0.95,
      notes: "strong overlap",
    };
    const status: MaterialsLifecycle = "resume_approved";
    const tailoredType: ArtifactType = "tailored_resume";
    const approved: ArtifactStatus = "approved";
    const text: RenderFormat = "text";
    const tailored: Artifact = {
      artifactId: "abc",
      type: tailoredType,
      status: approved,
      path: "/tmp/r.txt",
      renderFormat: text,
      createdAt: "2024-01-01T00:00:00+00:00",
      sizeBytes: 128,
      metadata: {},
      supersededAt: null,
    };
    const materials: MaterialsSet = createMaterialsSet({
      tenantId: LOCAL_TENANT,
      jobId: generateJobId(),
      generation: 1,
      status,
      createdAt: "2024-01-01T00:00:00+00:00",
      updatedAt: "2024-01-02T00:00:00+00:00",
      tailoredResume: tailored,
      coverLetter: null,
      resumePdf: null,
      coverLetterPdf: null,
      lastValidation: validation,
      lastVerdict: verdict,
      metadata: { source: "test" },
    });

    expect(materials.generation).toBe(1);
    expect(materials.tailoredResume?.status).toBe("approved");
    expect(materials.lastVerdict?.approved).toBe(true);
  });

  it("createMaterialsSet rejects generation < 1", () => {
    expect(() =>
      createMaterialsSet({
        tenantId: LOCAL_TENANT,
        jobId: generateJobId(),
        generation: 0,
        status: "resume_in_progress",
        createdAt: "2024-01-01T00:00:00+00:00",
        updatedAt: "2024-01-01T00:00:00+00:00",
        tailoredResume: null,
        coverLetter: null,
        resumePdf: null,
        coverLetterPdf: null,
        lastValidation: null,
        lastVerdict: null,
        metadata: {},
      }),
    ).toThrow(RangeError);
  });

  it("createMaterialsSet rejects cover letter without tailored resume", () => {
    const cover: Artifact = {
      artifactId: "c",
      type: "cover_letter",
      status: "approved",
      path: "/tmp/c.txt",
      renderFormat: "text",
      createdAt: "2024-01-01T00:00:00+00:00",
      sizeBytes: 64,
      metadata: {},
      supersededAt: null,
    };
    expect(() =>
      createMaterialsSet({
        tenantId: LOCAL_TENANT,
        jobId: generateJobId(),
        generation: 1,
        status: "resume_in_progress",
        createdAt: "2024-01-01T00:00:00+00:00",
        updatedAt: "2024-01-01T00:00:00+00:00",
        tailoredResume: null,
        coverLetter: cover,
        resumePdf: null,
        coverLetterPdf: null,
        lastValidation: null,
        lastVerdict: null,
        metadata: {},
      }),
    ).toThrow(/cover letter/);
  });
});
