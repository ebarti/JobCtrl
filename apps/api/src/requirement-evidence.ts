import type { RequirementArtifactCoverage, RequirementFitReport } from "./contracts.js";
import { allRows, getRow, type SqliteDatabase } from "./db.js";

export interface RequirementIdentity {
  id: string;
  text: string;
}

function identityText(value: string): string {
  return value.trim().replace(/\s+/g, " ");
}

export function requirementIdentities(value: string | null): RequirementIdentity[] {
  try {
    const parsed: unknown = JSON.parse(value ?? "null");
    return Array.isArray(parsed) ? parsed.flatMap((item) =>
      typeof item?.id === "string" && typeof item?.text === "string"
        ? [{ id: item.id, text: item.text }] : []) : [];
  } catch {
    return [];
  }
}

export function bindRequirementFitReport(
  report: RequirementFitReport | null,
  analysisGeneration: number | null | undefined,
  requirements: readonly RequirementIdentity[],
): RequirementFitReport | null {
  if (!report || !analysisGeneration || report.employerAnalysisGeneration !== analysisGeneration) return null;
  return {
    ...report,
    assessments: report.assessments.filter((assessment) => requirements.some((requirement) =>
      requirement.id === assessment.requirementId &&
      identityText(requirement.text) === identityText(assessment.requirementText))),
  };
}

export function unrecordedRequirementCoverage(): RequirementArtifactCoverage {
  return { state: "not_recorded", source: "tailored_resume_bullet_provenance", bulletCount: 0, examples: [] };
}

/** Join an immutable artifact's provenance only through its generation-time ID/text bindings. */
export function requirementCoverageForArtifact(
  db: SqliteDatabase,
  jobId: string,
  artifactId: string | null,
  requirements: readonly RequirementIdentity[],
  report: RequirementFitReport | null,
): Map<string, RequirementArtifactCoverage> {
  const result = new Map(requirements.map((requirement) => [requirement.id, unrecordedRequirementCoverage()]));
  if (!artifactId) return result;
  const artifact = getRow<{ metadata_json: string | null }>(db,
    `SELECT metadata_json FROM job_materials_artifacts
     WHERE tenant_id = 'local' AND job_id = ? AND artifact_id = ?
     ORDER BY generation DESC LIMIT 1`, [jobId, artifactId]);
  let directives: unknown;
  try {
    const metadata = JSON.parse(artifact?.metadata_json ?? "null");
    const plan = metadata?.quality_plan ?? metadata?.qualityPlan;
    directives = plan?.requirement_directives ?? plan?.requirementDirectives;
  } catch {
    return result;
  }
  if (!Array.isArray(directives)) return result;
  // Duplicate or missing source identities are ambiguous, even when a new score
  // happens to reuse the same requirement ID. Material generation is not analysis generation.
  const bound = requirements.filter((requirement) => {
    const matches = directives.filter((item) => (item?.requirement_id ?? item?.requirementId) === requirement.id);
    const text = matches[0]?.requirement_text ?? matches[0]?.requirementText;
    return matches.length === 1 && typeof text === "string" && identityText(text) === identityText(requirement.text);
  });
  if (!bound.length) return result;
  const rows = allRows<{ generated_text: string; requirement_ids_json: string }>(db,
    `SELECT generated_text, requirement_ids_json FROM job_bullet_provenance
     WHERE tenant_id = 'local' AND job_id = ? AND artifact_id = ? ORDER BY position, bullet_id`,
    [jobId, artifactId]);
  if (!rows.length) return result;
  for (const requirement of bound) {
    const hits = rows.filter((row) => {
      try {
        const ids: unknown = JSON.parse(row.requirement_ids_json);
        return Array.isArray(ids) && ids.includes(requirement.id);
      } catch {
        return false;
      }
    });
    const fit = report?.assessments.find((assessment) => assessment.requirementId === requirement.id)?.fit.kind;
    result.set(requirement.id, {
      state: hits.length ? "covered" : fit === "missing" || fit === "blocked" ? "missing_from_profile"
        : fit === "matched" || fit === "transferable" ? "missing_from_resume" : "not_recorded",
      source: "tailored_resume_bullet_provenance",
      bulletCount: hits.length,
      examples: hits.map((row) => row.generated_text.trim()).filter(Boolean).slice(0, 3),
    });
  }
  return result;
}
