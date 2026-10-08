import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import {
  MaterialLocaleStateSchema,
  type MaterialLocaleState,
} from "./contracts.js";
import type { SqliteDatabase } from "./db.js";
import { readDetermination } from "./semantic-determinations.js";

export function materialLocaleFieldsForJob(
  db: SqliteDatabase,
  tenantId: string,
  jobId: string,
): {
  localeVariants?: MaterialLocaleState;
  localeVariantsError?: "locale_history_unavailable";
} {
  try {
    return { localeVariants: readMaterialLocaleVariants(db, tenantId, jobId) };
  } catch {
    // Keep the original job/material readers available; expose authority failure explicitly.
    return { localeVariantsError: "locale_history_unavailable" };
  }
}

export function readMaterialLocaleVariants(
  db: SqliteDatabase,
  tenantId: string,
  jobId: string,
): MaterialLocaleState {
  const rows = db
    .prepare(
      "SELECT generation, metadata_json FROM job_materials WHERE tenant_id=? AND job_id=? ORDER BY generation",
    )
    .all(tenantId, jobId) as {
    generation: number;
    metadata_json: string | null;
  }[];
  const state: MaterialLocaleState = {
    revision: 0,
    variants: [],
    failures: [],
  };
  for (const row of rows) {
    const metadata: Record<string, unknown> = JSON.parse(
      row.metadata_json ?? "{}",
    );
    const stored = metadata.locale_variants_v1;
    if (stored === undefined) continue;
    if (
      !stored ||
      typeof stored !== "object" ||
      !("schema_version" in stored) ||
      stored.schema_version !== 1
    )
      throw new Error("locale_schema_unavailable");
    const { schema_version: _version, ...data } = stored;
    const parsed = MaterialLocaleStateSchema.parse(data);
    state.revision += parsed.revision;
    state.failures.push(...parsed.failures);
    for (const variant of parsed.variants) {
      if (
        variant.tenant_id !== tenantId ||
        variant.job_id !== jobId ||
        variant.generation !== row.generation
      )
        throw new Error("locale_binding_invalid");
      const sourceVerification = readDetermination(
        db,
        tenantId,
        variant.verification_id,
      );
      const sourceBinding = db
        .prepare(
          "SELECT determination_id FROM semantic_entity_bindings WHERE tenant_id=? AND entity_kind='artifact' AND entity_id=? AND entity_version=? AND determination_kind='claim_verification'",
        )
        .get(tenantId, variant.artifact_id, String(variant.generation)) as
        | { determination_id: string }
        | undefined;
      if (
        !sourceVerification ||
        sourceVerification.kind !== "claim_verification" ||
        sourceVerification.result.verdict !== "pass" ||
        sourceBinding?.determination_id !== variant.verification_id
      )
        throw new Error("locale_source_authority_unavailable");
      variant.determinations = variant.determinations.map((reference) => {
        const determination = readDetermination(
          db,
          tenantId,
          reference.determination_id,
        );
        if (
          !determination ||
          determination.entity_id !== variant.semantic_entity_id ||
          determination.kind !== reference.kind ||
          JSON.stringify(determination.result) !==
            JSON.stringify(reference.result)
        )
          throw new Error("locale_determination_binding_invalid");
        return determination;
      });
      const stale: string[] = [];
      const profile = db
        .prepare(
          "SELECT version FROM candidate_profiles WHERE tenant_id=? AND profile_id='default'",
        )
        .get(tenantId) as { version: number } | undefined;
      if (profile?.version !== variant.profile_version)
        stale.push("profile changed");
      const current = db
        .prepare(
          "SELECT artifact_id,path,metadata_json FROM job_materials_artifacts WHERE tenant_id=? AND job_id=? AND artifact_type=? AND status='approved' ORDER BY generation DESC LIMIT 1",
        )
        .get(tenantId, jobId, variant.artifact_type) as
        | { artifact_id: string; path: string; metadata_json: string | null }
        | undefined;
      if (current?.artifact_id !== variant.artifact_id)
        stale.push("accepted source changed");
      // Reader checks recorded metadata; byte containment/hash validation remains in the writer/export route.
      const sourceMetadata = JSON.parse(current?.metadata_json ?? "{}") as {
        accepted_text_sha256?: string;
      };
      if (sourceMetadata.accepted_text_sha256 !== variant.sha256)
        stale.push("source binding changed");
      variant.stale_reasons = stale;
      state.variants.push(variant);
    }
  }
  return state;
}

export function readMaterialLocaleExport(
  db: SqliteDatabase,
  tenantId: string,
  jobId: string,
  exportId: string,
  appDir: string,
) {
  const state = readMaterialLocaleVariants(db, tenantId, jobId);
  const variant = state.variants.find(
    (candidate) =>
      candidate.status === "accepted" &&
      candidate.exports.some((item) => item.export_id === exportId),
  );
  const registered = variant?.exports.find(
    (item) => item.export_id === exportId,
  );
  if (
    !variant ||
    !registered ||
    registered.accepted_revision !== variant.accepted_revision ||
    registered.document_sha256 !== variant.document_sha256
  )
    throw new Error("locale_export_not_found");
  const root = path.resolve(appDir, "tailored_resumes", "locale_variants");
  const resolved = fs.realpathSync(registered.path);
  const extension = registered.format === "text" ? "txt" : registered.format;
  if (
    resolved !== path.join(root, `${exportId}.${extension}`) ||
    !fs.statSync(resolved).isFile()
  )
    throw new Error("locale_export_path_invalid");
  const bytes = fs.readFileSync(resolved);
  if (createHash("sha256").update(bytes).digest("hex") !== registered.sha256)
    throw new Error("locale_export_bytes_changed");
  return {
    bytes,
    format: registered.format,
    filename: `${variant.kind}-${variant.target_locale}.${extension}`,
  };
}
