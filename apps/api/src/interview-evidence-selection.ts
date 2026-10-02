import type { GenerateInterviewPrepRequest } from "./contracts.js";
import type { SqliteDatabase } from "./db.js";

export class InterviewEvidenceSelectionError extends Error {
  constructor(readonly code: "evidence_profile_changed" | "invalid_evidence_selection") {
    super(code === "evidence_profile_changed"
      ? "The profile evidence has changed. Review your selection before generating."
      : "The evidence selection must use unique accepted facts from the current profile.");
  }
}

/** Canonical current-profile authority, checked before dispatch and repeated by the worker before spend. */
export function validateInterviewEvidenceSelection(
  db: SqliteDatabase, tenantId: string, profileId: string, request: GenerateInterviewPrepRequest,
): void {
  if (request.evidenceSelections === undefined) return;
  db.transaction(() => {
    const profile = db.prepare("SELECT version FROM candidate_profiles WHERE tenant_id = ? AND profile_id = ?")
      .get(tenantId, profileId) as { version: number } | undefined;
    if (!profile || profile.version !== request.evidenceProfileVersion) throw new InterviewEvidenceSelectionError("evidence_profile_changed");
    const rows = db.prepare(`SELECT evidence_id, user_confirmed, evidence_strength, source_text, scope, action, outcome
      FROM candidate_profile_achievement_evidence WHERE tenant_id = ? AND profile_id = ? LIMIT 401`)
      .all(tenantId, profileId) as Array<{ evidence_id: string; user_confirmed: number; evidence_strength: string;
        source_text: string; scope: string; action: string; outcome: string }>;
    if (rows.length > 400) throw new InterviewEvidenceSelectionError("invalid_evidence_selection");
    const seen = new Set<string>();
    const accepted = new Set<string>();
    for (const row of rows) {
      if (!row.evidence_id.trim()) continue;
      if (seen.has(row.evidence_id)) throw new InterviewEvidenceSelectionError("invalid_evidence_selection");
      seen.add(row.evidence_id);
      if (row.user_confirmed === 1 && ["supported", "verified"].includes(row.evidence_strength)
        && [row.source_text, row.scope, row.action, row.outcome].some((text) => text.trim())) accepted.add(row.evidence_id);
    }
    for (const selection of request.evidenceSelections!) {
      for (const evidenceId of selection.evidenceIds) {
        if (!accepted.has(evidenceId)) throw new InterviewEvidenceSelectionError("invalid_evidence_selection");
      }
    }
  })();
}
