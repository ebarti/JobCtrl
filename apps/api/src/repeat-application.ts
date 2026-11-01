import { RoleEquivalenceSchema } from "@jobctrl/contracts";
import { Buffer } from "node:buffer";
import { createHash, randomUUID } from "node:crypto";

import type {
  RepeatApplicationAssessment,
  RepeatApplicationAuditEntry,
  RepeatApplicationFactKind,
  RepeatApplicationMatch,
  RepeatApplicationOverride,
  RepeatApplicationOverrideRequest,
  RepeatApplicationOverrideResponse,
  RepeatApplicationRelationship,
} from "./contracts.js";
import { allRows, getRow, tableExists, type SqliteDatabase } from "./db.js";
import { readBoundDetermination } from "./semantic-determinations.js";
import { InputError } from "./write-model.js";

const DEFAULT_TENANT = "local";

interface JobIdentityRow extends Record<string, unknown> {
  job_id: string;
  url: string;
  title: string | null;
  company: string | null;
  application_url: string | null;
  location: string | null;
  salary: string | null;
  description: string | null;
  full_description: string | null;
  interpretation_id: string;
}

interface ConfirmedFactRow extends Record<string, unknown> {
  job_id: string;
  fact_kind: RepeatApplicationFactKind;
  fact_id: string;
  confirmed_at: string;
  priority: number;
}

interface CanonicalIdentityRow extends Record<string, unknown> {
  job_id: string;
  canonical_url: string;
  ats_kind: string;
  source_native_id: string;
}

interface DuplicateLinkRow extends Record<string, unknown> {
  surviving_job_id: string;
  superseded_job_or_observation_id: string;
  reason: string;
}

interface OverrideRow extends Record<string, unknown> {
  override_id: string;
  target_job_id: string;
  prior_job_id: string;
  evidence_fingerprint: string;
  reason: string;
  confirmed_by: string;
  confirmed_at: string;
  consumed_at: string | null;
  consumed_run_id: string | null;
}

interface AuditRow extends Record<string, unknown> {
  audit_id: string;
  target_job_id: string;
  action: RepeatApplicationAuditEntry["action"];
  evidence_fingerprint: string;
  evidence_json: string;
  override_id: string | null;
  prior_job_id: string | null;
  actor: string;
  reason: string | null;
  occurred_at: string;
}

type RepeatFingerprintMatch = Omit<RepeatApplicationMatch, "priorApplication"> & {
  priorApplication: Omit<RepeatApplicationMatch["priorApplication"], "jobId"> & {
    jobId: string;
  };
};

export function ensureRepeatApplicationTables(db: SqliteDatabase): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS application_repeat_overrides (
      tenant_id TEXT NOT NULL DEFAULT 'local',
      override_id TEXT NOT NULL,
      target_job_id TEXT NOT NULL,
      prior_job_id TEXT NOT NULL,
      relationship TEXT NOT NULL,
      evidence_fingerprint TEXT NOT NULL,
      evidence_json TEXT NOT NULL,
      reason TEXT NOT NULL,
      confirmed_by TEXT NOT NULL,
      confirmed_at TEXT NOT NULL,
      PRIMARY KEY (tenant_id, override_id),
      FOREIGN KEY (tenant_id, target_job_id) REFERENCES jobs(tenant_id, job_id) ON DELETE CASCADE,
      FOREIGN KEY (tenant_id, prior_job_id) REFERENCES jobs(tenant_id, job_id) ON DELETE CASCADE
    );
    CREATE INDEX IF NOT EXISTS idx_application_repeat_overrides_target
      ON application_repeat_overrides(tenant_id, target_job_id, confirmed_at DESC);
    CREATE TABLE IF NOT EXISTS application_repeat_override_consumptions (
      tenant_id TEXT NOT NULL DEFAULT 'local',
      override_id TEXT NOT NULL,
      run_id TEXT NOT NULL,
      consumed_at TEXT NOT NULL,
      PRIMARY KEY (tenant_id, override_id),
      UNIQUE (tenant_id, run_id)
    );
    CREATE TABLE IF NOT EXISTS application_repeat_audit (
      tenant_id TEXT NOT NULL DEFAULT 'local',
      audit_id TEXT NOT NULL,
      audit_key TEXT NOT NULL,
      target_job_id TEXT NOT NULL,
      action TEXT NOT NULL,
      evidence_fingerprint TEXT NOT NULL,
      evidence_json TEXT NOT NULL,
      override_id TEXT,
      actor TEXT NOT NULL,
      reason TEXT,
      occurred_at TEXT NOT NULL,
      PRIMARY KEY (tenant_id, audit_id),
      UNIQUE (tenant_id, audit_key),
      FOREIGN KEY (tenant_id, target_job_id) REFERENCES jobs(tenant_id, job_id) ON DELETE CASCADE
    );
    CREATE INDEX IF NOT EXISTS idx_application_repeat_audit_target
      ON application_repeat_audit(tenant_id, target_job_id, occurred_at DESC);
  `);
}

export function evaluateRepeatApplication(
  db: SqliteDatabase,
  targetJobId: string,
  options: { recordAudit?: boolean; evaluatedAt?: string } = {},
): RepeatApplicationAssessment {
  ensureRepeatApplicationTables(db);
  const evaluatedAt = options.evaluatedAt ?? new Date().toISOString();
  const target = jobIdentity(db, targetJobId);
  if (!target) throw new InputError("Job not found.");
  const matches: RepeatApplicationMatch[] = [];
  let determinationFailure: InputError | null = null;
  for (const fact of confirmedApplicationFacts(db)) {
    try {
      const match = relationshipMatch(db, target, fact);
      if (match) matches.push(match);
    } catch (error) {
      if (!(error instanceof InputError) || !["repeat_determination_unavailable", "repeat_equivalence_uncertain"].includes(error.message)) throw error;
      determinationFailure ??= error;
    }
  }
  matches.sort(compareMatches);
  // A proven canonical collision remains authoritative even if another prior
  // application has no semantic determination. Missing decisions still block
  // every assessment without that exact identity evidence.
  if (determinationFailure && !matches.some(match => match.relationship !== "same_employer_equivalent_role")) {
    const uncertain = determinationFailure.message === "repeat_equivalence_uncertain";
    return {status: uncertain ? "uncertain" : "unavailable", summary: uncertain ? "The model could not establish whether this is an equivalent role. Review the prior application before proceeding." : "Role equivalence has no current determination. Run the repeat-application check before authorizing submission.", evidenceFingerprint: null, evaluatedAt, matches: [], override: null, auditTrail: auditTrail(db, targetJobId)};
  }
  if (!matches.length) {
    return {
      status: "clear",
      summary: "No confirmed prior application is related to this opening.",
      evidenceFingerprint: null,
      evaluatedAt,
      matches: [],
      override: null,
      auditTrail: auditTrail(db, targetJobId),
    };
  }
  const fingerprintMatches = matches.map((match) => {
    const prior = jobIdentity(db, match.priorApplication.jobId);
    if (!prior) throw new InputError("Repeat evidence references an unknown prior job.");
    return { ...match, priorApplication: { ...match.priorApplication, jobId: prior.job_id } };
  });
  const evidenceFingerprint = repeatEvidenceFingerprint(target.job_id, fingerprintMatches);
  const override = matchingOverride(db, targetJobId, evidenceFingerprint);
  const exact = matches.some((match) => match.relationship !== "same_employer_equivalent_role");
  const status: RepeatApplicationAssessment["status"] = exact
    ? "blocked"
    : override
      ? override.consumedAt ? "override_consumed" : "override_ready"
      : "confirmation_required";
  const summary = status === "override_ready"
    ? "A reasoned confirmation is recorded for one live attempt against this exact evidence."
    : status === "override_consumed"
      ? "The prior confirmation was already used; another live attempt requires a new confirmation."
      : status === "blocked"
        ? "A confirmed application to this canonical opening blocks another live submission by default."
        : "A confirmed application to the same employer and an equivalent role requires deliberate confirmation.";
  if (options.recordAudit !== false && (status === "blocked" || status === "confirmation_required")) {
    recordAssessmentAudit(db, {
      targetJobId,
      action: status,
      evidenceFingerprint,
      matches,
      occurredAt: evaluatedAt,
    });
  }
  return {
    status,
    summary,
    evidenceFingerprint,
    evaluatedAt,
    matches,
    override,
    auditTrail: auditTrail(db, targetJobId),
  };
}

export function recordRepeatApplicationOverride(
  db: SqliteDatabase,
  targetJobId: string,
  request: RepeatApplicationOverrideRequest,
): RepeatApplicationOverrideResponse {
  ensureRepeatApplicationTables(db);
  const transact = db.transaction(() => {
    const assessment = evaluateRepeatApplication(db, targetJobId);
    if (!assessment.evidenceFingerprint || assessment.status === "clear") {
      throw new InputError("repeat_application_confirmation_not_required");
    }
    if (assessment.status === "blocked") {
      throw new InputError("repeat_application_blocked");
    }
    if (assessment.evidenceFingerprint !== request.evidenceFingerprint) {
      throw new InputError("repeat_application_evidence_stale");
    }
    const selectedPrior = assessment.matches.find(
      (match) => match.priorApplication.jobId === request.priorJobId,
    );
    if (!selectedPrior) throw new InputError("repeat_application_prior_mismatch");
    const confirmedAt = new Date().toISOString();
    const overrideId = randomUUID();
    db.prepare(
      `INSERT INTO application_repeat_overrides (
         tenant_id, override_id, target_job_id, prior_job_id, relationship,
         evidence_fingerprint, evidence_json, reason, confirmed_by, confirmed_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      DEFAULT_TENANT, overrideId, targetJobId, request.priorJobId, selectedPrior.relationship,
      assessment.evidenceFingerprint, JSON.stringify(assessment.matches), request.reason,
      request.confirmedBy, confirmedAt,
    );
    insertAudit(db, {
      auditKey: `override_recorded:${overrideId}`,
      targetJobId,
      action: "override_recorded",
      evidenceFingerprint: assessment.evidenceFingerprint,
      evidenceJson: JSON.stringify(assessment.matches),
      overrideId,
      actor: request.confirmedBy,
      reason: request.reason,
      occurredAt: confirmedAt,
    });
    return evaluateRepeatApplication(db, targetJobId, { recordAudit: false, evaluatedAt: confirmedAt });
  });
  return { ok: true, assessment: transact() };
}

export function assertLiveApplicationMayDispatch(
  db: SqliteDatabase,
  targetJobId: string,
): RepeatApplicationAssessment {
  const assessment = evaluateRepeatApplication(db, targetJobId);
  if (assessment.status === "unavailable")throw new InputError("repeat_determination_unavailable");
  if (assessment.status === "uncertain")throw new InputError("repeat_equivalence_uncertain");
  if (assessment.status === "blocked") throw new InputError("repeat_application_blocked");
  if (assessment.status === "confirmation_required") {
    throw new InputError("repeat_application_confirmation_required");
  }
  if (assessment.status === "override_consumed") {
    throw new InputError("repeat_application_override_consumed");
  }
  return assessment;
}

export function repeatEvidenceFingerprint(
  targetJobId: string,
  matches: readonly RepeatFingerprintMatch[],
): string {
  const canonicalTargetJobId = assertCanonicalJobId(targetJobId, "targetJobId");
  const validatedMatches = matches.map((match) => {
    if (!("jobId" in match.priorApplication) || !match.priorApplication.jobId || "jobKey" in match.priorApplication) {
      throw new InputError("Repeat evidence fingerprint requires canonical priorApplication.jobId.");
    }
    return {
      ...match,
      priorApplication: {
        ...match.priorApplication,
        jobId: assertCanonicalJobId(match.priorApplication.jobId, "priorApplication.jobId"),
      },
    };
  });
  const canonical = {
    targetJobId: canonicalTargetJobId,
    matches: validatedMatches.sort(compareMatches).map((match) => ({
      relationship: match.relationship,
      reason: match.reason,
      priorApplication: {
        jobId: match.priorApplication.jobId,
        title: match.priorApplication.title,
        company: match.priorApplication.company,
        applicationUrl: match.priorApplication.applicationUrl,
        factKind: match.priorApplication.factKind,
        factId: match.priorApplication.factId,
        confirmedAt: match.priorApplication.confirmedAt,
      },
      identityEvidence: match.identityEvidence,
    })),
  };
  return createHash("sha256").update(JSON.stringify(canonical), "utf8").digest("hex");
}

function assertCanonicalJobId(value: string, field: string): string {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(value)) {
    throw new InputError(`${field} must be a canonical UUID.`);
  }
  return value;
}

function jobIdentity(db: SqliteDatabase, jobId: string): JobIdentityRow | null {
  const company = "COALESCE(j.company, '')";
  const enrichment = tableExists(db, "job_enrichments")
    ? `(SELECT je.application_url FROM job_enrichments je WHERE je.tenant_id = ? AND je.job_id = j.job_id ORDER BY je.updated_at DESC LIMIT 1),`
    : "";
  const params = [
    ...(enrichment ? [DEFAULT_TENANT] : []),
    DEFAULT_TENANT,
    jobId,
  ];
  const row = getRow<JobIdentityRow>(
    db,
    `SELECT j.job_id, j.url, j.title, j.location, j.salary, j.description,
            COALESCE((SELECT je.full_description FROM job_enrichments je
              WHERE je.tenant_id=j.tenant_id AND je.job_id=j.job_id AND je.current_status='enriched'
                AND length(trim(je.full_description))>0 ORDER BY je.updated_at DESC LIMIT 1), j.full_description) AS full_description,
            ${company} AS company,
            ${enrichment ? `COALESCE(${enrichment} j.url)` : "j.url"} AS application_url
       FROM jobs j WHERE j.tenant_id = ? AND j.job_id = ?`,
    params,
  ) ?? null;
  if (!row) return null;
  const text = ["title", "company", "location", "salary", "remote"].map(field => `${field}:\n${String(row[field] ?? "").trim()}`);
  text.push("description:\n" + String(row.full_description || row.description || "").trim());
  const snapshot = createHash("sha256").update(text.join("\n\n")).digest("hex");
  const interpretation = readBoundDetermination(db, DEFAULT_TENANT, "job", row.job_id, snapshot, "job_interpretation");
  return { ...row, description: row.full_description || row.description || "", interpretation_id: interpretation?.determination_id ?? "" };
}

function confirmedApplicationFacts(db: SqliteDatabase): ConfirmedFactRow[] {
  const facts: ConfirmedFactRow[] = [];
  if (tableExists(db, "job_events")) {
    facts.push(...allRows<ConfirmedFactRow>(db, `
      SELECT job_id, CASE event_type WHEN 'ApplicationSubmitted' THEN 'application_submitted'
        ELSE 'application_manually_marked' END AS fact_kind,
        'event:' || event_id AS fact_id, occurred_at AS confirmed_at,
        CASE event_type WHEN 'ApplicationSubmitted' THEN 40 ELSE 30 END AS priority
      FROM job_events WHERE tenant_id = ? AND job_id IS NOT NULL
        AND event_type IN ('ApplicationSubmitted', 'ApplicationManuallyMarked')
    `, [DEFAULT_TENANT]));
  }
  if (tableExists(db, "application_outcomes")) {
    facts.push(...allRows<ConfirmedFactRow>(db, `
      SELECT job_id, 'applied_confirmation' AS fact_kind,
        'outcome:' || outcome_id AS fact_id, occurred_at AS confirmed_at, 20 AS priority
      FROM application_outcomes WHERE tenant_id = ? AND kind = 'applied_confirmation'
    `, [DEFAULT_TENANT]));
  }
  facts.push(...allRows<ConfirmedFactRow>(db, `
    SELECT job_id, 'legacy_applied_status' AS fact_kind, 'job:' || job_id AS fact_id,
      COALESCE(applied_at, discovered_at, '') AS confirmed_at, 10 AS priority
    FROM jobs WHERE tenant_id = ? AND LOWER(COALESCE(apply_status, '')) = 'applied'
      AND COALESCE(applied_at, '') != ''
  `, [DEFAULT_TENANT]));
  const best = new Map<string, ConfirmedFactRow>();
  for (const fact of facts) {
    const current = best.get(fact.job_id);
    if (!current || fact.priority > current.priority ||
      (fact.priority === current.priority && fact.confirmed_at > current.confirmed_at)) {
      best.set(fact.job_id, fact);
    }
  }
  return [...best.values()];
}

function relationshipMatch(db: SqliteDatabase, target: JobIdentityRow, fact: ConfirmedFactRow): RepeatApplicationMatch | null {
  const prior = jobIdentity(db, fact.job_id);
  if (!prior) return null;
  let relationship: RepeatApplicationRelationship | null = null;
  let reason = "";
  let identityEvidence: string[] = [];
  if (target.job_id === prior.job_id) {
    relationship = "canonical_job";
    reason = "Both records resolve to the same canonical JobCtrl job.";
    identityEvidence = [`job:${target.job_id}`];
  } else {
    const canonical = canonicalIdentityRelationship(db, target.job_id, prior.job_id);
    const duplicate = canonical ? null : acceptedDuplicateRelationship(db, target.job_id, prior.job_id);
    if (canonical) {
      relationship = "canonical_identity";
      reason = "The canonical ATS identity matches the previously applied opening.";
      identityEvidence = canonical;
    } else if (duplicate) {
      relationship = "accepted_duplicate";
      reason = "An accepted duplicate link connects this representation to the previously applied opening.";
      identityEvidence = duplicate;
    } else {
      const values=[target,prior].flatMap((row)=>[row.job_id,row.title ?? "",row.company ?? "",row.application_url ?? "",row.location ?? "",row.salary ?? "",row.description ?? "",row.interpretation_id]);
      const version=createHash("sha256").update(JSON.stringify(values)).digest("hex");
      const envelope=readBoundDetermination(db,DEFAULT_TENANT,"repeat_pair",target.job_id+":"+prior.job_id,version,"repeat_equivalence");
      if (!envelope || envelope.kind !== "repeat_equivalence" || envelope.entity_id !== target.job_id+":"+prior.job_id || envelope.schema_version !== "2" || envelope.prompt_version !== "repeat-equivalence-v2") throw new InputError("repeat_determination_unavailable");
      const result=RoleEquivalenceSchema.safeParse(envelope.result);
      if (!result.success) throw new InputError("repeat_determination_unavailable");
      if (result.data.verdict === "uncertain") throw new InputError("repeat_equivalence_uncertain");
      if (result.data.verdict === "equivalent") {
        relationship="same_employer_equivalent_role";
        reason=result.data.rationale;
        identityEvidence=["determination:"+envelope.determination_id];
      }

    }
  }
  if (!relationship) return null;
  return {
    relationship,
    reason,
    priorApplication: {
      jobId: prior.job_id,
      title: prior.title?.trim() || "Untitled role",
      company: prior.company?.trim() || "Unknown company",
      applicationUrl: prior.application_url,
      factKind: fact.fact_kind,
      factId: fact.fact_id,
      confirmedAt: fact.confirmed_at,
    },
    identityEvidence,
  };
}

function canonicalIdentityRelationship(db: SqliteDatabase, targetJobId: string, priorJobId: string): string[] | null {
  if (!tableExists(db, "job_canonical_identities")) return null;
  const rows = allRows<CanonicalIdentityRow>(db, `
    SELECT job_id, canonical_url, ats_kind, source_native_id
    FROM job_canonical_identities WHERE tenant_id = ? AND job_id IN (?, ?)
  `, [DEFAULT_TENANT, targetJobId, priorJobId]);
  const target = rows.find((row) => row.job_id === targetJobId);
  const prior = rows.find((row) => row.job_id === priorJobId);
  if (!target || !prior) return null;
  if (target.canonical_url && target.canonical_url === prior.canonical_url) return [`canonical_url:${target.canonical_url}`];
  if (target.ats_kind === prior.ats_kind && target.source_native_id === prior.source_native_id) {
    return [`ats:${target.ats_kind}`, `native_id:${target.source_native_id}`];
  }
  return null;
}

function acceptedDuplicateRelationship(db: SqliteDatabase, targetJobId: string, priorJobId: string): string[] | null {
  if (!tableExists(db, "job_duplicate_links")) return null;
  const targetAliases = jobAliases(db, targetJobId);
  const priorAliases = jobAliases(db, priorJobId);
  const links = allRows<DuplicateLinkRow>(db, `SELECT surviving_job_id, superseded_job_or_observation_id, reason FROM job_duplicate_links WHERE tenant_id = ?`, [DEFAULT_TENANT]);
  const link = links.find((candidate) =>
    (targetAliases.has(candidate.surviving_job_id) && priorAliases.has(candidate.superseded_job_or_observation_id)) ||
    (priorAliases.has(candidate.surviving_job_id) && targetAliases.has(candidate.superseded_job_or_observation_id)));
  return link ? [`survivor:${link.surviving_job_id}`, `superseded:${link.superseded_job_or_observation_id}`, `link_reason:${link.reason}`] : null;
}

function jobAliases(db: SqliteDatabase, jobId: string): Set<string> {
  const aliases = new Set([jobId]);
  if (!tableExists(db, "job_source_observations")) return aliases;
  const rows = allRows<Record<string, unknown>>(db, `
    SELECT source_observation_id FROM job_source_observations WHERE tenant_id = ? AND job_id = ?
  `, [DEFAULT_TENANT, jobId]);
  for (const row of rows) if (typeof row.source_observation_id === "string") aliases.add(row.source_observation_id);
  return aliases;
}

function matchingOverride(db: SqliteDatabase, targetJobId: string, evidenceFingerprint: string): RepeatApplicationOverride | null {
  const row = getRow<OverrideRow>(db, `
    SELECT o.override_id, o.target_job_id, o.prior_job_id, o.evidence_fingerprint,
      o.reason, o.confirmed_by, o.confirmed_at, c.consumed_at, c.run_id AS consumed_run_id
    FROM application_repeat_overrides o
    LEFT JOIN application_repeat_override_consumptions c
      ON c.tenant_id = o.tenant_id AND c.override_id = o.override_id
    WHERE o.tenant_id = ? AND o.target_job_id = ? AND o.evidence_fingerprint = ?
    ORDER BY o.confirmed_at DESC, o.override_id DESC LIMIT 1
  `, [DEFAULT_TENANT, targetJobId, evidenceFingerprint]);
  return row ? {
    overrideId: row.override_id, targetJobId: row.target_job_id, priorJobId: row.prior_job_id,
    evidenceFingerprint: row.evidence_fingerprint, reason: row.reason, confirmedBy: row.confirmed_by,
    confirmedAt: row.confirmed_at, consumedAt: row.consumed_at, consumedRunId: row.consumed_run_id,
  } : null;
}

function recordAssessmentAudit(db: SqliteDatabase, input: { targetJobId: string; action: "blocked" | "confirmation_required"; evidenceFingerprint: string; matches: readonly RepeatApplicationMatch[]; occurredAt: string }): void {
  insertAudit(db, { auditKey: `assessment:${input.targetJobId}:${input.evidenceFingerprint}:${input.action}`, targetJobId: input.targetJobId, action: input.action, evidenceFingerprint: input.evidenceFingerprint, evidenceJson: JSON.stringify(input.matches), overrideId: null, actor: "system", reason: null, occurredAt: input.occurredAt });
}

function insertAudit(db: SqliteDatabase, input: { auditKey: string; targetJobId: string; action: RepeatApplicationAuditEntry["action"]; evidenceFingerprint: string; evidenceJson: string; overrideId: string | null; actor: string; reason: string | null; occurredAt: string }): void {
  db.prepare(`INSERT OR IGNORE INTO application_repeat_audit (tenant_id, audit_id, audit_key, target_job_id, action, evidence_fingerprint, evidence_json, override_id, actor, reason, occurred_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(DEFAULT_TENANT, randomUUID(), input.auditKey, input.targetJobId, input.action, input.evidenceFingerprint, input.evidenceJson, input.overrideId, input.actor, input.reason, input.occurredAt);
}

function auditTrail(db: SqliteDatabase, targetJobId: string): RepeatApplicationAuditEntry[] {
  return allRows<AuditRow>(db, `
    SELECT a.audit_id, a.target_job_id, a.action, a.evidence_fingerprint, a.evidence_json,
      a.override_id, o.prior_job_id, a.actor, a.reason, a.occurred_at
    FROM application_repeat_audit a
    LEFT JOIN application_repeat_overrides o ON o.tenant_id = a.tenant_id AND o.override_id = a.override_id
    WHERE a.tenant_id = ? AND a.target_job_id = ?
    ORDER BY a.occurred_at DESC, a.rowid DESC LIMIT 50
  `, [DEFAULT_TENANT, targetJobId]).map((row) => ({
    auditId: row.audit_id, targetJobId: row.target_job_id, action: row.action,
    evidenceFingerprint: row.evidence_fingerprint, evidence: parseEvidenceSnapshot(row.evidence_json),
    overrideId: row.override_id, priorJobId: row.prior_job_id, actor: row.actor,
    reason: row.reason, occurredAt: row.occurred_at,
  }));
}

function parseEvidenceSnapshot(value: string): RepeatApplicationMatch[] {
  try {
    const parsed: unknown = JSON.parse(value);
    return Array.isArray(parsed) ? (parsed as RepeatApplicationMatch[]) : [];
  } catch {
    return [];
  }
}

function compareMatches(left: RepeatApplicationMatch | RepeatFingerprintMatch, right: RepeatApplicationMatch | RepeatFingerprintMatch): number {
  const rank: Record<RepeatApplicationRelationship, number> = { canonical_job: 0, canonical_identity: 1, accepted_duplicate: 2, same_employer_equivalent_role: 3 };
  return rank[left.relationship] - rank[right.relationship] || compareUtf8(left.priorApplication.jobId, right.priorApplication.jobId) || compareUtf8(left.priorApplication.factId, right.priorApplication.factId);
}

function compareUtf8(left: string, right: string): number {
  return Buffer.compare(Buffer.from(left, "utf8"), Buffer.from(right, "utf8"));
}
