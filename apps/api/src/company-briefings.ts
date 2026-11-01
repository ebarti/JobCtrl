/** Operations joins recorded company IDs and determinations; reads never research. */
import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import {
  AcceptedCompanyBriefingSchema, CompanyBriefingAttemptSchema, CompanyBriefingConfigSchema,
  CompanyBriefingLinkSchema, CompanyBriefingResultSchema, DeterminationEnvelopeSchema, type CompanyBriefingView, type CompanyBriefingSummary,
} from "@jobctrl/contracts";
import type { SqliteDatabase } from "./db.js";

const hash = (text: string) => createHash("sha256").update(text).digest("hex");
function latest(db: SqliteDatabase, tenant: string, kind: string, entity: string): unknown {
  const row = db.prepare("SELECT event_id,payload_json FROM job_events WHERE tenant_id=? AND entity_kind=? AND entity_ref=? ORDER BY event_id DESC LIMIT 1")
    .get(tenant, `company_briefing_${kind}`, entity) as { event_id: number; payload_json: string } | undefined;
  return row ? { ...JSON.parse(row.payload_json), revision: row.event_id } : null;
}
function publicUrl(value: string): boolean {
  const url = new URL(value);
  return ["https:", "http:"].includes(url.protocol) && !url.username && !url.password && !url.search && !url.hash;
}
export function readCompanyBriefing(db: SqliteDatabase, tenant: string, jobId: string, now = new Date()): CompanyBriefingView | null {
  try {
    const raw = latest(db, tenant, "link", jobId);
    if (!raw) return null;
    const link = CompanyBriefingLinkSchema.parse(raw);
    const job = db.prepare("SELECT company FROM jobs WHERE tenant_id=? AND job_id=?").get(tenant, jobId) as { company: string } | undefined;
    if (!job || link.jobId !== jobId) return null;
    const company = CompanyBriefingConfigSchema.parse(latest(db, tenant, "config", link.companyId));
    if (company.companyId !== link.companyId || hash(company.homepageUrl) !== company.companyId
      || !publicUrl(company.homepageUrl) || !company.sourceUrls.every(publicUrl)) throw new Error("invalid identity");
    const accepted = AcceptedCompanyBriefingSchema.nullable().parse(latest(db, tenant, "accepted", company.companyId));
    const lastAttempt = CompanyBriefingAttemptSchema.nullable().parse(latest(db, tenant, "attempt", company.companyId));
    const staleReasons: string[] = [];
    if (job.company !== link.employerName) staleReasons.push("identity_review_required");
    if (lastAttempt?.failureCode === "briefing_identity_needs_review") {
      const row = db.prepare("SELECT envelope_json FROM semantic_determinations WHERE tenant_id=? AND determination_id=?").get(tenant, lastAttempt.determinationId) as { envelope_json: string } | undefined;
      const rejected = row ? DeterminationEnvelopeSchema.parse(JSON.parse(row.envelope_json)) : null;
      const result = rejected ? CompanyBriefingResultSchema.parse(rejected.result) : null;
      if (!rejected || rejected.tenant_id !== tenant || rejected.entity_id !== company.companyId || rejected.kind !== "company_briefing" || rejected.determination_id !== lastAttempt.determinationId || rejected.input_fingerprint !== lastAttempt.determinationId || result?.identity !== "needs_review" || result.identity_reason !== lastAttempt.identityReason) throw new Error("invalid refusal binding");
      for (const source of lastAttempt.sources) {
        if (!publicUrl(source.url) || !publicUrl(source.finalUrl) || hash(source.url) !== source.sourceId || hash(source.text) !== source.contentHash) throw new Error("invalid refusal source");
      }
      for (const citation of result.identity_citations) {
        const source = lastAttempt.sources.find((entry) => entry.sourceId === citation.source_id);
        if (!source || !source.text.includes(citation.quote) || hash(source.text) !== source.contentHash) throw new Error("invalid refusal citation");
      }
      staleReasons.push("source_identity_needs_review");
    }
    if (accepted) {
      const recorded = db.prepare("SELECT envelope_json FROM semantic_determinations WHERE tenant_id=? AND determination_id=?").get(tenant, accepted.determinationId) as { envelope_json: string } | undefined;
      const envelope = recorded ? DeterminationEnvelopeSchema.parse(JSON.parse(recorded.envelope_json)) : null;
      if (!envelope || envelope.tenant_id !== tenant || envelope.determination_id !== accepted.determinationId
        || envelope.input_fingerprint !== accepted.determinationId || envelope.schema_version !== "1" || envelope.entity_id !== company.companyId || envelope.kind !== "company_briefing"
        || accepted.companyId !== company.companyId || envelope.provider !== accepted.provider || envelope.model !== accepted.model
        || envelope.prompt_version !== accepted.promptVersion || !isDeepStrictEqual(envelope.result, accepted.result)
        || accepted.result.identity !== "confirmed" || accepted.result.claims.length === 0) throw new Error("invalid briefing binding");
      const binding = db.prepare("SELECT payload_json FROM job_events WHERE tenant_id=? AND entity_kind='company_briefing_config' AND entity_ref=? AND event_id=?").get(tenant, company.companyId, accepted.configurationId) as { payload_json: string } | undefined;
      const boundConfig = binding ? CompanyBriefingConfigSchema.parse({ ...JSON.parse(binding.payload_json), revision: accepted.configurationId }) : null;
      if (!boundConfig || !isDeepStrictEqual(boundConfig.sourceUrls, accepted.sources.map((source) => source.url))) throw new Error("invalid configuration binding");
      const sources = new Map(accepted.sources.map((source) => [source.sourceId, source]));
      if (sources.size !== accepted.sources.length) throw new Error("duplicate source");
      for (const source of accepted.sources) {
        if (hash(source.text) !== source.contentHash || hash(source.url) !== source.sourceId
          || !publicUrl(source.url) || !publicUrl(source.finalUrl)) throw new Error("invalid source binding");
      }
      for (const citation of [...accepted.result.identity_citations, ...accepted.result.claims.flatMap((claim) => claim.citations)]) {
        if (!citation.quote.trim() || !sources.get(citation.source_id)?.text.includes(citation.quote)) throw new Error("invalid citation");
      }
      if (Math.min(...accepted.sources.map((source) => Date.parse(source.observedAt))) !== Date.parse(accepted.observedAt)) throw new Error("invalid observation clock");
      if (Date.parse(accepted.observedAt) + 7 * 86400000 <= now.getTime()) staleReasons.push("sources_older_than_seven_days");
      if (accepted.configurationId !== company.revision) staleReasons.push("sources_changed");
      if (accepted.promptVersion !== "company-briefing-v1") staleReasons.push("briefing_version_changed");
    }
    return { company, accepted, lastAttempt, staleReasons,
      status: job.company !== link.employerName || staleReasons.includes("source_identity_needs_review") ? "needs_review" : !accepted ? "missing" : staleReasons.length ? "stale" : "current" };
  } catch {
    return { company: null, accepted: null, lastAttempt: null, staleReasons: [], status: "unavailable" };
  }
}
export function companyBriefingSummaries(db: SqliteDatabase, tenant: string, now = new Date()): CompanyBriefingSummary[] {
  const rows = db.prepare("SELECT e.entity_ref FROM job_events e JOIN jobs j ON j.tenant_id=e.tenant_id AND j.job_id=e.job_id WHERE e.tenant_id=? AND e.entity_kind='company_briefing_link' AND e.event_id=(SELECT max(x.event_id) FROM job_events x WHERE x.tenant_id=e.tenant_id AND x.entity_kind=e.entity_kind AND x.entity_ref=e.entity_ref) AND NOT EXISTS (SELECT 1 FROM jobctrl_hidden_jobs h WHERE h.tenant_id=e.tenant_id AND h.job_id=e.job_id AND h.unhidden_at IS NULL) AND NOT EXISTS (SELECT 1 FROM jobctrl_deleted_jobs d WHERE d.tenant_id=e.tenant_id AND d.job_id=e.job_id AND (d.restored_at IS NULL OR julianday(d.restored_at)<=julianday(d.deleted_at))) ORDER BY e.event_id DESC LIMIT 100")
    .all(tenant) as { entity_ref: string }[];
  const seen = new Set<string>();
  const summaries: CompanyBriefingSummary[] = [];
  for (const row of rows) {
    const view = readCompanyBriefing(db, tenant, row.entity_ref, now);
    if (!view?.company || view.staleReasons.includes("identity_review_required") || seen.has(view.company.companyId)) continue;
    seen.add(view.company.companyId);
    summaries.push({ companyId: view.company.companyId, name: view.company.name, jobId: row.entity_ref,
      status: view.status, staleReasons: view.staleReasons, observedAt: view.accepted?.observedAt ?? null,
      failureCode: view.lastAttempt?.failureCode ?? null });
    if (summaries.length === 5) break;
  }
  return summaries;
}
