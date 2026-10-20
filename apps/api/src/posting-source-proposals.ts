import ipaddr from "ipaddr.js";

import type { SourceProposalEvidence, SourceProposalReview } from "@jobctrl/contracts";
import { SourceProposalEvidenceSchema } from "@jobctrl/contracts";
import { allRows, type SqliteDatabase } from "./db.js";

interface SourceCoordinate {
  coordinateKey: string;
  sourceId: string;
  atsKind: string | null;
  boardToken: string | null;
}

/** Parse source coordinates only; this never determines employer identity. */
export function postingSourceCoordinate(rawUrl: string): SourceCoordinate | null {
  if (/[\s\\\x00-\x1f\x7f]/.test(rawUrl)) return null;
  let url: URL;
  try { url = new URL(rawUrl); } catch { return null; }
  const host = url.hostname.toLowerCase().replace(/\.$/, "");
  if (!["http:", "https:"].includes(url.protocol) || url.username || url.password ||
      (url.port && !["80", "443"].includes(url.port)) || !host.includes(".") ||
      [".localhost", ".local", ".internal", ".lan", ".home", ".localdomain"].some((suffix) => host.endsWith(suffix))) return null;
  if (ipaddr.isValid(host)) {
    if (ipaddr.parse(host).range() !== "unicast") return null;
  } else if (!host.split(".").every((part) => /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(part))) return null;
  let parts = url.pathname.split("/").filter(Boolean);
  let kind: string | null = null;
  let token: string | null = null;
  let boardHost = host;
  if (["boards.greenhouse.io", "job-boards.greenhouse.io", "boards-api.greenhouse.io"].includes(host)) {
    kind = "greenhouse";
    token = host === "boards-api.greenhouse.io"
      ? parts[0] === "v1" && parts[1] === "boards" ? parts[2] ?? null : null
      : parts[0] ?? null;
    boardHost = "boards.greenhouse.io";
  } else if (["jobs.lever.co", "api.lever.co", "jobs.eu.lever.co", "api.eu.lever.co"].includes(host)) {
    kind = "lever";
    token = host.startsWith("api.")
      ? parts[0] === "v0" && parts[1] === "postings" ? parts[2] ?? null : null
      : parts[0] ?? null;
    boardHost = host.includes(".eu.") ? "jobs.eu.lever.co" : "jobs.lever.co";
  } else if (["jobs.ashbyhq.com", "api.ashbyhq.com"].includes(host)) {
    kind = "ashby";
    token = host.startsWith("api.")
      ? parts[0] === "posting-api" && parts[1] === "job-board" ? parts[2] ?? null : null
      : parts[0] ?? null;
    boardHost = "jobs.ashbyhq.com";
  } else if (host.endsWith(".myworkdayjobs.com")) {
    kind = "workday";
    if (parts[0] && /^[a-z]{2}-[A-Z]{2}$/.test(parts[0])) parts = parts.slice(1);
    token = parts[0] === "wday" && parts[1] === "cxs" ? parts[3] ?? null : parts[0] ?? null;
  }
  if (kind) {
    if (!token || !/^[A-Za-z0-9_-]+$/.test(token)) return null;
    const sourceToken = kind === "workday" ? `${host}:${token}`
      : kind === "lever" && boardHost === "jobs.eu.lever.co" ? `eu:${token}` : token;
    return { coordinateKey: `https://${boardHost}/${token}`, sourceId: `${kind}:${sourceToken}`, atsKind: kind, boardToken: token };
  }
  return { coordinateKey: `https://${host}/`, sourceId: `employer_careers_page:${host}`, atsKind: null, boardToken: null };
}

export function sourceCoordinateOverlaps(db: SqliteDatabase, coordinateKey: string, sourceId: string): SourceProposalReview["overlaps"] {
  return allRows<{ source_id: string; state: string; seed_url: string | null } & Record<string, unknown>>(
    db, "SELECT source_id, state, seed_url FROM source_registry_entries WHERE tenant_id = 'local'",
  ).filter((row) => row.source_id === sourceId || (row.seed_url && postingSourceCoordinate(row.seed_url)?.coordinateKey === coordinateKey))
    .map((row) => ({ sourceId: row.source_id, state: row.state, seedUrl: row.seed_url }));
}

export function sourceProposalReviews(db: SqliteDatabase): Map<string, SourceProposalReview> {
  const reviews = new Map<string, SourceProposalReview>();
  const registry = allRows<{ source_id: string; state: string; seed_url: string | null } & Record<string, unknown>>(
    db, "SELECT source_id, state, seed_url FROM source_registry_entries WHERE tenant_id = 'local'",
  );
  const events = allRows<{ payload_json: string } & Record<string, unknown>>(
    db, `SELECT payload_json FROM job_events WHERE tenant_id = 'local' AND entity_kind = 'discovery'
         AND entity_ref IN (SELECT candidate_url FROM source_locator_candidates WHERE tenant_id = 'local')
         AND event_type = 'SourceLocationCandidateDiscovered' AND json_valid(payload_json)
         AND json_extract(payload_json, '$.proposalOnly') = 1 ORDER BY event_id`,
  );
  const seenEvidence = new Map<string, Set<string>>();
  for (const event of events) {
    const payload = JSON.parse(event.payload_json) as Record<string, unknown>;
    const coordinate = typeof payload["coordinateKey"] === "string" ? postingSourceCoordinate(payload["coordinateKey"]) : null;
    if (!coordinate || typeof payload["candidateId"] !== "string") continue;
    const evidence = SourceProposalEvidenceSchema.safeParse(payload["evidence"]);
    const existing = reviews.get(payload["candidateId"]);
    const receipts: SourceProposalEvidence[] = existing?.evidence ?? [];
    const seen = seenEvidence.get(payload["candidateId"]) ?? new Set<string>();
    if (evidence.success) {
      const fingerprint = JSON.stringify(evidence.data);
      if (!seen.has(fingerprint)) { receipts.push(evidence.data); seen.add(fingerprint); }
    }
    seenEvidence.set(payload["candidateId"], seen);
    const overlaps = existing?.overlaps ?? registry.filter((row) => row.source_id === coordinate.sourceId ||
      (row.seed_url && postingSourceCoordinate(row.seed_url)?.coordinateKey === coordinate.coordinateKey))
      .map((row) => ({ sourceId: row.source_id, state: row.state, seedUrl: row.seed_url }));
    const promotionBlockedReason = overlaps.length ? null
      : coordinate.atsKind === "workday" ? "Configure this Workday employer and site before promoting the proposal."
      : coordinate.coordinateKey.startsWith("https://jobs.eu.lever.co/") ? "The current Lever adapter supports global boards. This regional board remains available for review."
      : null;
    reviews.set(payload["candidateId"], {
      ...coordinate, completeness: "unknown", promotionBlockedReason, evidence: receipts, overlaps,
    });
  }
  return reviews;
}

export function recordSourceProposalReview(
  db: SqliteDatabase, candidate: { candidate_id: string; candidate_url: string },
  decision: "promote" | "reject", reason: string,
): void {
  const coordinate = postingSourceCoordinate(candidate.candidate_url);
  if (!coordinate && decision !== "reject") throw new Error("Source candidate has invalid or private URL coordinates.");
  const now = new Date().toISOString();
  db.prepare(`INSERT INTO job_events (tenant_id, job_id, identity_version, stage, event_type,
       level, message, occurred_at, payload_json, entity_kind, entity_ref)
       VALUES ('local', NULL, 1, 'discover', 'SourceLocationCandidateReviewed', 'info', ?, ?, ?, 'discovery', ?)`)
    .run(`User reviewed source candidate: ${decision}.`, now,
      JSON.stringify({ candidateId: candidate.candidate_id, coordinateKey: coordinate?.coordinateKey ?? candidate.candidate_url, decision, reason, decidedAt: now }), coordinate?.coordinateKey ?? candidate.candidate_url);
}
