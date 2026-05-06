/**
 * Materials Generation aggregate + value objects — TypeScript mirror.
 *
 * See ddd-target.md §4.5. The Python ``MaterialsSet`` aggregate
 * (``workers/automation/src/jobhunter/domain/materials/aggregate.py``) is
 * the source of truth; both languages must stay structurally compatible.
 *
 * Wire-format invariants reflected here at the type level:
 *
 *   * ``ArtifactType`` / ``ArtifactStatus`` / ``RenderFormat`` are closed
 *     enumerations matching the Python ``enum.Enum`` values.
 *   * ``MaterialsLifecycle`` mirrors the four §4.5 lifecycle states.
 *   * ``MaterialsSet.generation`` is a strictly positive integer that
 *     monotonically increases per ``(tenantId, jobId)``.
 *   * Cover letter requires a tailored resume; PDFs require their text
 *     counterparts. (Enforced by the Python aggregate at construction.)
 */
import type { TenantId } from "../tenant.js";
import type { JobId } from "../identifiers.js";

// ---------------------------------------------------------------------------
// Closed enumerations
// ---------------------------------------------------------------------------

export const ARTIFACT_TYPES = [
  "tailored_resume",
  "cover_letter",
  "resume_pdf",
  "cover_letter_pdf",
] as const;
export type ArtifactType = (typeof ARTIFACT_TYPES)[number];

export const ARTIFACT_STATUSES = [
  "candidate",
  "approved",
  "rejected",
  "superseded",
] as const;
export type ArtifactStatus = (typeof ARTIFACT_STATUSES)[number];

export const RENDER_FORMATS = ["latex_pdf", "html_pdf", "text"] as const;
export type RenderFormat = (typeof RENDER_FORMATS)[number];

export const MATERIALS_LIFECYCLE_STATES = [
  "resume_in_progress",
  "resume_approved",
  "cover_letter_ready",
  "complete",
] as const;
export type MaterialsLifecycle = (typeof MATERIALS_LIFECYCLE_STATES)[number];

// ---------------------------------------------------------------------------
// ValidationResult / JudgeVerdict
// ---------------------------------------------------------------------------

export interface ValidationResult {
  readonly passed: boolean;
  readonly errors: readonly string[];
  readonly warnings: readonly string[];
}

export interface JudgeVerdict {
  readonly approved: boolean;
  readonly score: number;
  readonly notes: string;
}

// ---------------------------------------------------------------------------
// Artifact entity
// ---------------------------------------------------------------------------

export interface Artifact {
  readonly artifactId: string;
  readonly type: ArtifactType;
  readonly status: ArtifactStatus;
  readonly path: string;
  readonly renderFormat: RenderFormat;
  readonly createdAt: string;
  readonly sizeBytes: number | null;
  readonly metadata: Readonly<Record<string, unknown>>;
  readonly supersededAt: string | null;
}

// ---------------------------------------------------------------------------
// MaterialsSet aggregate
// ---------------------------------------------------------------------------

export interface MaterialsSet {
  readonly tenantId: TenantId;
  readonly jobId: JobId;
  readonly generation: number;
  readonly status: MaterialsLifecycle;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly tailoredResume: Artifact | null;
  readonly coverLetter: Artifact | null;
  readonly resumePdf: Artifact | null;
  readonly coverLetterPdf: Artifact | null;
  readonly lastValidation: ValidationResult | null;
  readonly lastVerdict: JudgeVerdict | null;
  readonly metadata: Readonly<Record<string, unknown>>;
}

/** Validating constructor for the generation invariant. Mirrors the
 * Python aggregate's ``__post_init__`` invariant on ``generation >= 1``. */
export function createMaterialsSet(input: MaterialsSet): MaterialsSet {
  if (!Number.isInteger(input.generation) || input.generation < 1) {
    throw new RangeError(
      `MaterialsSet.generation must be an integer >= 1, got ${input.generation}`,
    );
  }
  if (!MATERIALS_LIFECYCLE_STATES.includes(input.status)) {
    throw new RangeError(
      `MaterialsSet.status must be one of ${MATERIALS_LIFECYCLE_STATES.join(", ")}, got ${input.status}`,
    );
  }
  if (input.coverLetter && !input.tailoredResume) {
    throw new Error(
      "MaterialsSet invariant violated: cover letter present without tailored resume",
    );
  }
  if (input.resumePdf && !input.tailoredResume) {
    throw new Error(
      "MaterialsSet invariant violated: resume PDF present without tailored resume",
    );
  }
  if (input.coverLetterPdf && !input.coverLetter) {
    throw new Error(
      "MaterialsSet invariant violated: cover-letter PDF present without cover-letter text",
    );
  }
  return input;
}
