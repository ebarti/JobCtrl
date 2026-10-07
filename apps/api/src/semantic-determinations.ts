import { z } from "zod";
import {
  validDeterminationResult,
  ClaimVerificationDeterminationSchema,
  DeterminationEnvelopeSchema,
  type DeterminationEnvelope,
} from "@jobctrl/contracts";
import type { SqliteDatabase } from "./db.js";

function recordedJson(value: string): unknown {
  try {
    return JSON.parse(value);
  } catch {
    throw new Error("determination_schema_violation");
  }
}

export function readDetermination(
  db: SqliteDatabase,
  tenantId: string,
  determinationId: string,
): DeterminationEnvelope | null {
  const row = db
    .prepare(
      "SELECT envelope_json FROM semantic_determinations WHERE tenant_id = ? AND determination_id = ?",
    )
    .get(tenantId, determinationId) as { envelope_json: string } | undefined;
  if (!row) return null;
  const parsed = DeterminationEnvelopeSchema.safeParse(
    recordedJson(row.envelope_json),
  );
  if (
    !parsed.success ||
    parsed.data.tenant_id !== tenantId ||
    parsed.data.determination_id !== determinationId ||
    parsed.data.input_fingerprint !== determinationId
  )
    throw new Error("determination_binding_invalid");
  const envelope = parsed.data;
  if (!validDeterminationResult(envelope))
    throw new Error("determination_schema_violation");
  return envelope;
}

export function readBoundDetermination(
  db: SqliteDatabase,
  tenantId: string,
  entityKind: string,
  entityId: string,
  entityVersion: string,
  kind: string,
): DeterminationEnvelope | null {
  const row = db
    .prepare(
      "SELECT determination_id FROM semantic_entity_bindings WHERE tenant_id = ? AND entity_kind = ? AND entity_id = ? AND entity_version = ? AND determination_kind = ?",
    )
    .get(tenantId, entityKind, entityId, entityVersion, kind) as
    | { determination_id: string }
    | undefined;
  const envelope = row
    ? readDetermination(db, tenantId, row.determination_id)
    : null;
  const expectedEntity = entityKind === "artifact" ? undefined : entityId;
  if (
    envelope &&
    (envelope.kind !== kind ||
      (expectedEntity !== undefined && envelope.entity_id !== expectedEntity))
  )
    throw new Error("determination_binding_invalid");
  return envelope;
}

export type ArtifactLineAnchor = {
  lineId: string;
  evidenceIds: string[];
  requirementIds: string[];
  transformType: string;
  reason: string;
  determinationId: string | null;
};

/** An edited artifact is owned through its saved revision, never prose overlap. */
export function determinationOwnsArtifact(
  db: SqliteDatabase,
  tenantId: string,
  artifactId: string,
  generation: number,
  jobId: string,
  envelope: DeterminationEnvelope,
): boolean {
  const artifact = db
    .prepare(
      "SELECT metadata_json FROM job_materials_artifacts WHERE tenant_id=? AND artifact_id=? AND generation=? AND job_id=?",
    )
    .get(tenantId, artifactId, generation, jobId) as
    | { metadata_json: string | null }
    | undefined;
  if (!artifact) return false;
  if (envelope.entity_id === jobId) return true;
  const metadata = artifact.metadata_json
    ? recordedJson(artifact.metadata_json)
    : {};
  const revisionId =
    typeof metadata === "object" &&
    metadata !== null &&
    "draft_revision_id" in metadata
      ? metadata.draft_revision_id
      : null;
  if (typeof revisionId !== "string" || envelope.entity_id !== revisionId)
    return false;
  return Boolean(
    db
      .prepare(
        "SELECT 1 FROM resume_review_draft_revisions WHERE tenant_id=? AND revision_id=? AND job_id=?",
      )
      .get(tenantId, revisionId, jobId),
  );
}

export function readArtifactLineAnchors(
  db: SqliteDatabase,
  tenantId: string,
  artifactKind: string,
  artifactId: string,
  generation: number,
  expectedJobId: string,
): Map<string, ArtifactLineAnchor> {
  const rows = db
    .prepare(
      "SELECT line_id, evidence_ids_json, requirement_ids_json, transform_type, reason, determination_id FROM artifact_line_anchors WHERE tenant_id = ? AND artifact_kind = ? AND artifact_id = ? AND generation = ?",
    )
    .all(tenantId, artifactKind, artifactId, generation) as Array<{
    line_id: string;
    evidence_ids_json: string;
    requirement_ids_json: string;
    transform_type: string;
    reason: string;
    determination_id: string | null;
  }>;
  const identifiers = z.array(z.string().min(1).max(240)).max(400);
  return new Map(
    rows.map((row) => {
      if (!row.determination_id)
        throw new Error("artifact_anchor_binding_invalid");
      const determination = readDetermination(
        db,
        tenantId,
        row.determination_id,
      );
      if (
        !determination ||
        determination.kind !== "claim_verification" ||
        !determinationOwnsArtifact(
          db,
          tenantId,
          artifactId,
          generation,
          expectedJobId,
          determination,
        )
      )
        throw new Error("artifact_anchor_binding_invalid");
      const result = ClaimVerificationDeterminationSchema.safeParse(
        determination.result,
      );
      const line = result.success
        ? result.data.lines.find((line) => line.line_id === row.line_id)
        : null;
      const parsedEvidenceIds = identifiers.safeParse(
        recordedJson(row.evidence_ids_json),
      );
      const parsedRequirementIds = identifiers.safeParse(
        recordedJson(row.requirement_ids_json),
      );
      if (!parsedEvidenceIds.success || !parsedRequirementIds.success)
        throw new Error("artifact_anchor_binding_invalid");
      const evidenceIds = parsedEvidenceIds.data;
      const requirementIds = parsedRequirementIds.data;
      if (
        !line ||
        evidenceIds.some(
          (id) => !line.source_evidence.some((cite) => cite.source_id === id),
        ) ||
        requirementIds.some(
          (id) =>
            !line.served_requirements.some(
              (served) => served.requirement_id === id,
            ),
        )
      )
        throw new Error("artifact_anchor_binding_invalid");
      return [
        row.line_id,
        {
          lineId: row.line_id,
          evidenceIds,
          requirementIds,
          transformType: row.transform_type,
          reason: row.reason,
          determinationId: row.determination_id,
        },
      ];
    }),
  );
}
