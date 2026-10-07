import {
  DiscoveryTriageResponseSchema,
  DiscoveryIntakeSnapshotSchema,
  PostingTriageResultSchema,
  type DiscoveryTriageResponse,
} from "@jobctrl/contracts";
import type { SqliteDatabase } from "./db.js";
import { readDetermination } from "./semantic-determinations.js";

export function readDiscoveryTriage(
  db: SqliteDatabase,
  offset = 0,
  limit = 50,
): DiscoveryTriageResponse {
  const records = db
    .prepare(
      "SELECT * FROM posting_triage WHERE tenant_id='local' ORDER BY created_at DESC,listing_id,target_fingerprint LIMIT ? OFFSET ?",
    )
    .all(limit, offset) as Array<{
    listing_id: string;
    source_id: string;
    listing_json: string;
    snapshot_fingerprint: string;
    target_fingerprint: string;
    status:
      | "pending_triage"
      | "literal_excluded"
      | "superseded"
      | "admit"
      | "reject"
      | "uncertain";
    reason_code: string | null;
    failure_code: string | null;
    determination_id: string | null;
    created_at: string;
  }>;
  const total = (
    db
      .prepare(
        "SELECT count(*) AS total FROM posting_triage WHERE tenant_id='local'",
      )
      .get() as { total: number }
  ).total;
  const rows = records.map((row) => {
    const snapshot = DiscoveryIntakeSnapshotSchema.parse(
      JSON.parse(row.listing_json),
    );
    const listing = snapshot.listing;
    const envelope = row.determination_id
      ? readDetermination(db, "local", row.determination_id)
      : null;
    if (
      envelope &&
      (envelope.kind !== "posting_triage" ||
        envelope.schema_version !== "2" ||
        envelope.prompt_version !== "posting-triage-v3-saved-targets" ||
        envelope.entity_id !== "discovery:intake" ||
        envelope.lane !== "discovery")
    )
      throw new Error("triage_binding_invalid");
    const result =
      envelope?.kind === "posting_triage"
        ? PostingTriageResultSchema.parse(envelope.result)
        : null;
    const decision = result?.listings.find(
      (item) => item.listing_id === row.listing_id,
    );
    if (
      row.status !== "pending_triage" &&
      row.status !== "literal_excluded" &&
      row.status !== "superseded" &&
      (!decision ||
        decision.verdict !== row.status ||
        decision.reason_code !== row.reason_code)
    )
      throw new Error("triage_binding_invalid");
    if (
      listing.listing_id !== row.listing_id ||
      listing.source_id !== row.source_id
    )
      throw new Error("triage_binding_invalid");
    if (decision) {
      const sources = new Map<string, string>();
      for (const field of [
        "url",
        "title",
        "company",
        "location",
        "remote",
      ] as const)
        sources.set(
          `listing:${row.listing_id}:${field}`,
          field === "remote"
            ? listing.remote === null
              ? "None"
              : listing.remote
                ? "True"
                : "False"
            : listing[field],
        );
      for (const source of snapshot.target_sources)
        sources.set(source.source_id, source.text);
      if (
        decision.citations.some(
          (citation) =>
            !sources.get(citation.source_id)?.includes(citation.quote),
        )
      )
        throw new Error("triage_binding_invalid");
    }
    return {
      targetSources: snapshot.target_sources,
      targetProfileVersion: snapshot.profile_version,
      rowId:
        row.listing_id +
        ":" +
        row.snapshot_fingerprint +
        ":" +
        row.target_fingerprint,
      targetFingerprint: row.target_fingerprint,
      listingId: row.listing_id,
      sourceId: row.source_id,
      url: listing.url,
      title: listing.title,
      company: listing.company,
      location: listing.location,
      status: row.status,
      reasonCode: row.reason_code,
      failureCode: row.failure_code,
      rationale:
        row.status === "literal_excluded"
          ? "Excluded by the user’s saved literal exact-title filter"
          : (decision?.rationale ?? null),
      citations: decision?.citations ?? [],
      determination: envelope,
      createdAt: row.created_at,
    };
  });
  return DiscoveryTriageResponseSchema.parse({
    ok: true,
    rows,
    total,
    offset,
    limit,
  });
}
