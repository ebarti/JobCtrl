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
import { InputError } from "./write-model.js";

const DEFAULT_TENANT = "local";

interface JobIdentityRow extends Record<string, unknown> {
  url: string;
  title: string | null;
  company: string | null;
  application_url: string | null;
}

interface ConfirmedFactRow extends Record<string, unknown> {
  job_key: string;
  fact_kind: RepeatApplicationFactKind;
  fact_id: string;
  confirmed_at: string;
  priority: number;
}

interface CanonicalIdentityRow extends Record<string, unknown> {
  job_url: string;
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
  target_job_key: string;
  prior_job_key: string;
  evidence_fingerprint: string;
  reason: string;
  confirmed_by: string;
  confirmed_at: string;
  consumed_at: string | null;
  consumed_run_id: string | null;
}

interface AuditRow extends Record<string, unknown> {
  audit_id: string;
  target_job_key: string;
  action: RepeatApplicationAuditEntry["action"];
  evidence_fingerprint: string;
  evidence_json: string;
  override_id: string | null;
  prior_job_key: string | null;
  actor: string;
  reason: string | null;
  occurred_at: string;
}

export function ensureRepeatApplicationTables(db: SqliteDatabase): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS application_repeat_overrides (
      tenant_id            TEXT NOT NULL DEFAULT 'local',
      override_id          TEXT NOT NULL,
      target_job_key       TEXT NOT NULL,
      prior_job_key        TEXT NOT NULL,
      relationship         TEXT NOT NULL,
      evidence_fingerprint TEXT NOT NULL,
      evidence_json        TEXT NOT NULL,
      reason               TEXT NOT NULL,
      confirmed_by         TEXT NOT NULL,
      confirmed_at         TEXT NOT NULL,
      PRIMARY KEY (tenant_id, override_id)
    );
    CREATE INDEX IF NOT EXISTS idx_application_repeat_overrides_target
      ON application_repeat_overrides(tenant_id, target_job_key, confirmed_at DESC);

    CREATE TABLE IF NOT EXISTS application_repeat_override_consumptions (
      tenant_id    TEXT NOT NULL DEFAULT 'local',
      override_id  TEXT NOT NULL,
      run_id       TEXT NOT NULL,
      consumed_at  TEXT NOT NULL,
      PRIMARY KEY (tenant_id, override_id),
      UNIQUE (tenant_id, run_id)
    );

    CREATE TABLE IF NOT EXISTS application_repeat_audit (
      tenant_id            TEXT NOT NULL DEFAULT 'local',
      audit_id             TEXT NOT NULL,
      audit_key            TEXT NOT NULL,
      target_job_key       TEXT NOT NULL,
      action               TEXT NOT NULL,
      evidence_fingerprint TEXT NOT NULL,
      evidence_json        TEXT NOT NULL,
      override_id          TEXT,
      actor                TEXT NOT NULL,
      reason               TEXT,
      occurred_at          TEXT NOT NULL,
      PRIMARY KEY (tenant_id, audit_id),
      UNIQUE (tenant_id, audit_key)
    );
    CREATE INDEX IF NOT EXISTS idx_application_repeat_audit_target
      ON application_repeat_audit(tenant_id, target_job_key, occurred_at DESC);
  `);
}

export function evaluateRepeatApplication(
  db: SqliteDatabase,
  targetJobKey: string,
  options: { recordAudit?: boolean; evaluatedAt?: string } = {},
): RepeatApplicationAssessment {
  ensureRepeatApplicationTables(db);
  const evaluatedAt = options.evaluatedAt ?? new Date().toISOString();
  const target = jobIdentity(db, targetJobKey);
  if (!target) {
    throw new InputError("Job not found.");
  }

  const confirmedFacts = confirmedApplicationFacts(db);
  const matches = confirmedFacts
    .map((fact) => relationshipMatch(db, target, fact))
    .filter((match): match is RepeatApplicationMatch => match !== null)
    .sort(compareMatches);

  if (!matches.length) {
    return {
      status: "clear",
      summary: "No confirmed prior application is related to this opening.",
      evidenceFingerprint: null,
      evaluatedAt,
      matches: [],
      override: null,
      auditTrail: auditTrail(db, targetJobKey),
    };
  }

  const evidenceFingerprint = repeatEvidenceFingerprint(targetJobKey, matches);
  const override = matchingOverride(db, targetJobKey, evidenceFingerprint);
  const exact = matches.some((match) => match.relationship !== "same_employer_equivalent_role");
  let status: RepeatApplicationAssessment["status"];
  let summary: string;
  if (override && !override.consumedAt) {
    status = "override_ready";
    summary = "A reasoned confirmation is recorded for one live attempt against this exact evidence.";
  } else if (override?.consumedAt) {
    status = "override_consumed";
    summary = "The prior confirmation was already used; another live attempt requires a new confirmation.";
  } else if (exact) {
    status = "blocked";
    summary = "A confirmed application to this canonical opening blocks another live submission by default.";
  } else {
    status = "confirmation_required";
    summary = "A confirmed application to the same employer and an equivalent role requires deliberate confirmation.";
  }

  if (options.recordAudit !== false && (status === "blocked" || status === "confirmation_required")) {
    recordAssessmentAudit(db, {
      targetJobKey,
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
    auditTrail: auditTrail(db, targetJobKey),
  };
}

export function recordRepeatApplicationOverride(
  db: SqliteDatabase,
  targetJobKey: string,
  request: RepeatApplicationOverrideRequest,
): RepeatApplicationOverrideResponse {
  ensureRepeatApplicationTables(db);
  const transact = db.transaction(() => {
    const assessment = evaluateRepeatApplication(db, targetJobKey);
    if (!assessment.evidenceFingerprint || assessment.status === "clear") {
      throw new InputError("repeat_application_confirmation_not_required");
    }
    if (assessment.evidenceFingerprint !== request.evidenceFingerprint) {
      throw new InputError("repeat_application_evidence_stale");
    }
    const selectedPrior = assessment.matches.find(
      (match) => match.priorApplication.jobKey === request.priorJobKey,
    );
    if (!selectedPrior) {
      throw new InputError("repeat_application_prior_mismatch");
    }

    const confirmedAt = new Date().toISOString();
    const overrideId = randomUUID();
    db.prepare(
      `INSERT INTO application_repeat_overrides (
         tenant_id, override_id, target_job_key, prior_job_key, relationship,
         evidence_fingerprint, evidence_json, reason, confirmed_by, confirmed_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      DEFAULT_TENANT,
      overrideId,
      targetJobKey,
      request.priorJobKey,
      selectedPrior.relationship,
      assessment.evidenceFingerprint,
      JSON.stringify(assessment.matches),
      request.reason,
      request.confirmedBy,
      confirmedAt,
    );
    insertAudit(db, {
      auditKey: `override_recorded:${overrideId}`,
      targetJobKey,
      action: "override_recorded",
      evidenceFingerprint: assessment.evidenceFingerprint,
      evidenceJson: JSON.stringify(assessment.matches),
      overrideId,
      actor: request.confirmedBy,
      reason: request.reason,
      occurredAt: confirmedAt,
    });
    return evaluateRepeatApplication(db, targetJobKey, {
      recordAudit: false,
      evaluatedAt: confirmedAt,
    });
  });
  return { ok: true, assessment: transact() };
}

export function assertLiveApplicationMayDispatch(
  db: SqliteDatabase,
  targetJobKey: string,
): RepeatApplicationAssessment {
  const assessment = evaluateRepeatApplication(db, targetJobKey);
  if (assessment.status === "blocked") {
    throw new InputError("repeat_application_blocked");
  }
  if (assessment.status === "confirmation_required") {
    throw new InputError("repeat_application_confirmation_required");
  }
  if (assessment.status === "override_consumed") {
    throw new InputError("repeat_application_override_consumed");
  }
  return assessment;
}

export function repeatEvidenceFingerprint(
  targetJobKey: string,
  matches: readonly RepeatApplicationMatch[],
): string {
  const orderedMatches = [...matches].sort(compareMatches);
  const canonical = {
    targetJobKey,
    matches: orderedMatches.map((match) => ({
      relationship: match.relationship,
      reason: match.reason,
      priorApplication: match.priorApplication,
      identityEvidence: match.identityEvidence,
    })),
  };
  return createHash("sha256").update(JSON.stringify(canonical), "utf8").digest("hex");
}

function jobIdentity(db: SqliteDatabase, jobKey: string): JobIdentityRow | null {
  const hasCompanyColumn = columnExists(db, "jobs", "company");
  const hasJobListProjections = tableExists(db, "job_list_projections");
  const companyExpression = hasJobListProjections
    ? `COALESCE(
        ${hasCompanyColumn ? "NULLIF(j.company, '')" : "NULL"},
        (SELECT jlp.employer FROM job_list_projections jlp
         WHERE jlp.tenant_id = ? AND jlp.job_id = j.url LIMIT 1),
        ''
      )`
    : hasCompanyColumn
      ? "COALESCE(j.company, '')"
      : "''";
  const enrichmentExpression = tableExists(db, "job_enrichments")
    ? `(SELECT je.application_url
          FROM job_enrichments je
         WHERE je.job_url = j.url AND je.tenant_id = ?
         ORDER BY je.updated_at DESC LIMIT 1),`
    : "";
  const params = [
    ...(hasJobListProjections ? [DEFAULT_TENANT] : []),
    ...(enrichmentExpression ? [DEFAULT_TENANT] : []),
    jobKey,
  ];
  return (
    getRow<JobIdentityRow>(
      db,
      `SELECT j.url, j.title, ${companyExpression} AS company,
              COALESCE(
                ${enrichmentExpression}
                j.application_url,
                j.url
              ) AS application_url
         FROM jobs j
        WHERE j.url = ?`,
      params,
    ) ?? null
  );
}

function columnExists(db: SqliteDatabase, tableName: string, columnName: string): boolean {
  if (!tableExists(db, tableName)) return false;
  const quoted = `"${tableName.replaceAll('"', '""')}"`;
  return allRows<Record<string, unknown>>(db, `PRAGMA table_info(${quoted})`).some(
    (row) => row.name === columnName,
  );
}

function confirmedApplicationFacts(db: SqliteDatabase): ConfirmedFactRow[] {
  const facts: ConfirmedFactRow[] = [];
  if (tableExists(db, "job_events")) {
    facts.push(
      ...allRows<ConfirmedFactRow>(
        db,
        `SELECT job_url AS job_key,
                CASE event_type
                  WHEN 'ApplicationSubmitted' THEN 'application_submitted'
                  ELSE 'application_manually_marked'
                END AS fact_kind,
                'event:' || event_id AS fact_id,
                occurred_at AS confirmed_at,
                CASE event_type WHEN 'ApplicationSubmitted' THEN 40 ELSE 30 END AS priority
           FROM job_events
          WHERE job_url IS NOT NULL
            AND event_type IN ('ApplicationSubmitted', 'ApplicationManuallyMarked')`,
      ),
    );
  }
  if (tableExists(db, "application_outcomes")) {
    facts.push(
      ...allRows<ConfirmedFactRow>(
        db,
        `SELECT job_key,
                'applied_confirmation' AS fact_kind,
                'outcome:' || outcome_id AS fact_id,
                occurred_at AS confirmed_at,
                20 AS priority
           FROM application_outcomes
          WHERE tenant_id = ? AND kind = 'applied_confirmation'`,
        [DEFAULT_TENANT],
      ),
    );
  }
  facts.push(
    ...allRows<ConfirmedFactRow>(
      db,
      `SELECT url AS job_key,
              'legacy_applied_status' AS fact_kind,
              'job:' || url AS fact_id,
              COALESCE(applied_at, discovered_at, '') AS confirmed_at,
              10 AS priority
         FROM jobs
        WHERE LOWER(COALESCE(apply_status, '')) = 'applied'
          AND COALESCE(applied_at, '') != ''`,
    ),
  );

  const best = new Map<string, ConfirmedFactRow>();
  for (const fact of facts) {
    const current = best.get(fact.job_key);
    if (
      !current ||
      fact.priority > current.priority ||
      (fact.priority === current.priority && fact.confirmed_at > current.confirmed_at)
    ) {
      best.set(fact.job_key, fact);
    }
  }
  return [...best.values()];
}

function relationshipMatch(
  db: SqliteDatabase,
  target: JobIdentityRow,
  fact: ConfirmedFactRow,
): RepeatApplicationMatch | null {
  const prior = jobIdentity(db, fact.job_key);
  if (!prior) return null;

  let relationship: RepeatApplicationRelationship | null = null;
  let reason = "";
  let identityEvidence: string[] = [];
  if (target.url === prior.url) {
    relationship = "canonical_job";
    reason = "Both records resolve to the same canonical JobCtrl job.";
    identityEvidence = [`job:${target.url}`];
  } else {
    const canonical = canonicalIdentityRelationship(db, target.url, prior.url);
    if (canonical) {
      relationship = "canonical_identity";
      reason = "The canonical ATS identity matches the previously applied opening.";
      identityEvidence = canonical;
    } else {
      const duplicate = acceptedDuplicateRelationship(db, target.url, prior.url);
      if (duplicate) {
        relationship = "accepted_duplicate";
        reason = "An accepted duplicate link connects this representation to the previously applied opening.";
        identityEvidence = duplicate;
      } else if (equivalentEmployerRole(target, prior)) {
        relationship = "same_employer_equivalent_role";
        reason = "The employer identity matches exactly and the normalized role titles are materially equivalent.";
        identityEvidence = [
          `employer:${normalizeEmployer(target.company)}`,
          `role:${normalizeRoleTitle(target.title)}`,
        ];
      }
    }
  }
  if (!relationship) return null;
  return {
    relationship,
    reason,
    priorApplication: {
      jobKey: prior.url,
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

function canonicalIdentityRelationship(
  db: SqliteDatabase,
  targetJobKey: string,
  priorJobKey: string,
): string[] | null {
  if (!tableExists(db, "job_canonical_identities")) return null;
  const rows = allRows<CanonicalIdentityRow>(
    db,
    `SELECT j.url AS job_url, c.canonical_url, c.ats_kind,
            c.source_native_id
       FROM job_canonical_identities c
       JOIN jobs j
         ON j.tenant_id = c.tenant_id
        AND j.job_id = c.job_id
      WHERE c.tenant_id = ? AND j.url IN (?, ?)`,
    [DEFAULT_TENANT, targetJobKey, priorJobKey],
  );
  const target = rows.find((row) => row.job_url === targetJobKey);
  const prior = rows.find((row) => row.job_url === priorJobKey);
  if (!target || !prior) return null;
  if (target.canonical_url && target.canonical_url === prior.canonical_url) {
    return [`canonical_url:${target.canonical_url}`];
  }
  if (
    target.ats_kind &&
    target.ats_kind === prior.ats_kind &&
    target.source_native_id &&
    target.source_native_id === prior.source_native_id
  ) {
    return [`ats:${target.ats_kind}`, `native_id:${target.source_native_id}`];
  }
  return null;
}

function acceptedDuplicateRelationship(
  db: SqliteDatabase,
  targetJobKey: string,
  priorJobKey: string,
): string[] | null {
  if (!tableExists(db, "job_duplicate_links")) return null;
  const targetAliases = jobAliases(db, targetJobKey);
  const priorAliases = jobAliases(db, priorJobKey);
  const links = allRows<DuplicateLinkRow>(
    db,
    `SELECT surviving_job_id, superseded_job_or_observation_id, reason
       FROM job_duplicate_links WHERE tenant_id = ?`,
    [DEFAULT_TENANT],
  );
  const link = links.find(
    (candidate) =>
      (targetAliases.has(candidate.surviving_job_id) &&
        priorAliases.has(candidate.superseded_job_or_observation_id)) ||
      (priorAliases.has(candidate.surviving_job_id) &&
        targetAliases.has(candidate.superseded_job_or_observation_id)),
  );
  return link
    ? [
        `survivor:${link.surviving_job_id}`,
        `superseded:${link.superseded_job_or_observation_id}`,
        `link_reason:${link.reason}`,
      ]
    : null;
}

function jobAliases(db: SqliteDatabase, jobKey: string): Set<string> {
  const aliases = new Set([jobKey]);
  const job = getRow<{ job_id: string }>(
    db,
    `SELECT job_id
       FROM jobs
      WHERE tenant_id = ? AND url = ?`,
    [DEFAULT_TENANT, jobKey],
  );
  if (!job) return aliases;
  aliases.add(job.job_id);
  if (tableExists(db, "job_identity_aliases")) {
    const postingAliases = allRows<{ alias_value: string }>(
      db,
      `SELECT alias_value
         FROM job_identity_aliases
        WHERE tenant_id = ? AND job_id = ?`,
      [DEFAULT_TENANT, job.job_id],
    );
    for (const alias of postingAliases) aliases.add(alias.alias_value);
  }
  if (!tableExists(db, "job_source_observations")) return aliases;
  const rows = allRows<Record<string, unknown>>(
    db,
    `SELECT source_observation_id, observed_url, normalized_observed_url
       FROM job_source_observations WHERE tenant_id = ? AND job_id = ?`,
    [DEFAULT_TENANT, job.job_id],
  );
  for (const row of rows) {
    for (const value of [row.source_observation_id, row.observed_url, row.normalized_observed_url]) {
      if (typeof value === "string" && value) aliases.add(value);
    }
  }
  return aliases;
}

function equivalentEmployerRole(target: JobIdentityRow, prior: JobIdentityRow): boolean {
  const targetEmployer = normalizeEmployer(target.company);
  const priorEmployer = normalizeEmployer(prior.company);
  if (!targetEmployer || targetEmployer !== priorEmployer) return false;
  const targetRole = normalizeRoleTitle(target.title);
  const priorRole = normalizeRoleTitle(prior.title);
  if (!targetRole || !priorRole) return false;
  if (targetRole === priorRole) return true;
  return [...targetRole.split(" ")].sort().join(" ") === [...priorRole.split(" ")].sort().join(" ");
}

export function normalizeEmployer(value: string | null | undefined): string {
  const tokens = normalizeTokens(value).filter(Boolean);
  const legalSuffixes = new Set([
    "inc", "incorporated", "llc", "ltd", "limited", "corp", "corporation", "plc", "gmbh",
  ]);
  while (tokens.length > 1 && legalSuffixes.has(tokens[tokens.length - 1] ?? "")) tokens.pop();
  return tokens.join(" ");
}

export function normalizeRoleTitle(value: string | null | undefined): string {
  const aliases: Record<string, string> = {
    sr: "senior",
    jr: "junior",
    eng: "engineer",
    engr: "engineer",
    mgr: "manager",
    dev: "developer",
    ii: "2",
    iii: "3",
    iv: "4",
  };
  const presentationOnly = new Set(["remote", "hybrid", "onsite", "fulltime"]);
  return normalizeTokens(value)
    .map((token) => aliases[token] ?? token)
    .filter((token) => !presentationOnly.has(token))
    .join(" ");
}

function normalizeTokens(value: string | null | undefined): string[] {
  return String(value ?? "")
    .normalize("NFKC")
    .toLocaleLowerCase("en-US")
    .replace(/&/g, " and ")
    .replace(/[^a-z0-9]+/g, " ")
    .trim()
    .split(/\s+/)
    .filter(Boolean);
}

function matchingOverride(
  db: SqliteDatabase,
  targetJobKey: string,
  evidenceFingerprint: string,
): RepeatApplicationOverride | null {
  const row = getRow<OverrideRow>(
    db,
    `SELECT o.override_id, o.target_job_key, o.prior_job_key,
            o.evidence_fingerprint, o.reason, o.confirmed_by, o.confirmed_at,
            c.consumed_at, c.run_id AS consumed_run_id
       FROM application_repeat_overrides o
       LEFT JOIN application_repeat_override_consumptions c
         ON c.tenant_id = o.tenant_id AND c.override_id = o.override_id
      WHERE o.tenant_id = ? AND o.target_job_key = ? AND o.evidence_fingerprint = ?
      ORDER BY o.confirmed_at DESC, o.override_id DESC LIMIT 1`,
    [DEFAULT_TENANT, targetJobKey, evidenceFingerprint],
  );
  return row
    ? {
        overrideId: row.override_id,
        targetJobKey: row.target_job_key,
        priorJobKey: row.prior_job_key,
        evidenceFingerprint: row.evidence_fingerprint,
        reason: row.reason,
        confirmedBy: row.confirmed_by,
        confirmedAt: row.confirmed_at,
        consumedAt: row.consumed_at,
        consumedRunId: row.consumed_run_id,
      }
    : null;
}

function recordAssessmentAudit(
  db: SqliteDatabase,
  input: {
    targetJobKey: string;
    action: "blocked" | "confirmation_required";
    evidenceFingerprint: string;
    matches: readonly RepeatApplicationMatch[];
    occurredAt: string;
  },
): void {
  insertAudit(db, {
    auditKey: `assessment:${input.targetJobKey}:${input.evidenceFingerprint}:${input.action}`,
    targetJobKey: input.targetJobKey,
    action: input.action,
    evidenceFingerprint: input.evidenceFingerprint,
    evidenceJson: JSON.stringify(input.matches),
    overrideId: null,
    actor: "system",
    reason: null,
    occurredAt: input.occurredAt,
  });
}

function insertAudit(
  db: SqliteDatabase,
  input: {
    auditKey: string;
    targetJobKey: string;
    action: RepeatApplicationAuditEntry["action"];
    evidenceFingerprint: string;
    evidenceJson: string;
    overrideId: string | null;
    actor: string;
    reason: string | null;
    occurredAt: string;
  },
): void {
  db.prepare(
    `INSERT OR IGNORE INTO application_repeat_audit (
       tenant_id, audit_id, audit_key, target_job_key, action,
       evidence_fingerprint, evidence_json, override_id, actor, reason, occurred_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    DEFAULT_TENANT,
    randomUUID(),
    input.auditKey,
    input.targetJobKey,
    input.action,
    input.evidenceFingerprint,
    input.evidenceJson,
    input.overrideId,
    input.actor,
    input.reason,
    input.occurredAt,
  );
}

function auditTrail(db: SqliteDatabase, targetJobKey: string): RepeatApplicationAuditEntry[] {
  return allRows<AuditRow>(
    db,
    `SELECT a.audit_id, a.target_job_key, a.action, a.evidence_fingerprint,
            a.evidence_json, a.override_id, o.prior_job_key,
            a.actor, a.reason, a.occurred_at
       FROM application_repeat_audit a
       LEFT JOIN application_repeat_overrides o
         ON o.tenant_id = a.tenant_id AND o.override_id = a.override_id
      WHERE a.tenant_id = ? AND a.target_job_key = ?
      ORDER BY a.occurred_at DESC, a.rowid DESC LIMIT 50`,
    [DEFAULT_TENANT, targetJobKey],
  ).map((row) => ({
    auditId: row.audit_id,
    targetJobKey: row.target_job_key,
    action: row.action,
    evidenceFingerprint: row.evidence_fingerprint,
    evidence: parseEvidenceSnapshot(row.evidence_json),
    overrideId: row.override_id,
    priorJobKey: row.prior_job_key,
    actor: row.actor,
    reason: row.reason,
    occurredAt: row.occurred_at,
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

function compareMatches(left: RepeatApplicationMatch, right: RepeatApplicationMatch): number {
  const rank: Record<RepeatApplicationRelationship, number> = {
    canonical_job: 0,
    canonical_identity: 1,
    accepted_duplicate: 2,
    same_employer_equivalent_role: 3,
  };
  return (
    rank[left.relationship] - rank[right.relationship] ||
    compareUtf8(left.priorApplication.jobKey, right.priorApplication.jobKey) ||
    compareUtf8(left.priorApplication.factId, right.priorApplication.factId)
  );
}

function compareUtf8(left: string, right: string): number {
  return Buffer.compare(Buffer.from(left, "utf8"), Buffer.from(right, "utf8"));
}
