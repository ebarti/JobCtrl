import crypto from "node:crypto";

import type {
  DiscoveryFeedbackResponse,
  ManualCaptureDismissResponse,
  ManualCaptureListResponse,
  ManualActionReasonValue,
  QuarantineDecision,
  QuarantineDecisionResponse,
  QuarantineListResponse,
  QuarantineReason,
  RecommendedSourceState,
  SourceLocatorListResponse,
  SourceLocatorDecisionResponse,
  SourcePriorityValue,
  SourceRegistryEntrySummary,
  SourceRegistryListResponse,
  SourceStatePatch,
  SourceStateValue,
  SourceUpsertRequest,
  DiscoveryPreviewResponse,
  DiscoveryFeedbackRequest,
  SourceKindValue,
} from "./contracts.js";
import {
  MANUAL_ACTION_REASON_VALUES,
  QUARANTINE_REASONS,
  SOURCE_KIND_VALUES,
  SOURCE_PRIORITY_VALUES,
  SOURCE_STATE_VALUES,
} from "./contracts.js";
import { allRows, getRow, tableExists, type SqliteDatabase, type SqliteValue } from "./db.js";
import { refreshProjections } from "./projections.js";
import { InputError } from "./write-model.js";

const DEFAULT_TENANT = "local";

const EUROPE_TARGET_MARKERS = [
  "barcelona",
  "spain",
  "españa",
  "madrid",
  "valencia",
  "europe",
  "european union",
];

const AMERICA_ONLY_SOURCE_MARKERS = [
  "canada",
  "canadian",
  "job bank",
  "job-bank",
  "careerjet canada",
  "careerjet-canada",
  "randstad canada",
  "randstad-canada",
  "eluta",
  "jobbank.gc.ca",
  "careerjet.ca",
  "randstad.ca",
  "eluta.ca",
  "smart_extract:dice",
  "dice.com",
  "smart_extract:wellfound",
  "wellfound.com/role/l/software-engineer/canada",
];

interface SourceRegistryRow extends Record<string, unknown> {
  tenant_id: string;
  source_id: string;
  kind: string;
  display_name: string;
  owner: string;
  priority: string;
  state: string;
  policy_id: string;
  seed_url: string | null;
  created_at: string;
  updated_at: string;
}

interface SourceQualityRow extends Record<string, unknown> {
  source_id: string;
  recommended_state: string;
  run_count: number;
  failed_run_count: number;
  consecutive_failures: number;
  observed_jobs: number;
  new_jobs: number;
  existing_jobs: number;
  duplicate_rate: number | null;
  active_verification_rate: number | null;
  full_description_success_rate: number | null;
  apply_url_success_rate: number | null;
  last_run_id: string | null;
  last_error_class: string | null;
  updated_at: string | null;
}

interface SourceLocatorCandidateRow extends Record<string, unknown> {
  candidate_id: string;
  candidate_url: string;
  source_kind: string;
  confidence: number;
  detected_ats_kind: string | null;
  employer_domain_matched: number;
  manual_action_reason: string | null;
  discovered_at: string;
}

interface PreviewObservationRow extends Record<string, unknown> {
  job_url: string;
  observed_url: string;
  observed_at: string;
  title: string | null;
  site: string | null;
  location: string | null;
}

interface QuarantineEntryRow extends Record<string, unknown> {
  job_id: string;
  job_key: string;
  title: string;
  company: string;
  source_id: string;
  posting_url: string | null;
  reason: string;
  confidence: number | null;
  snapshot_version: number | null;
  captured_at: string | null;
  notice_text: string | null;
}

interface ManualCaptureRow extends Record<string, unknown> {
  item_id: string;
  originating_url: string;
  source_id: string | null;
  reason: string;
  retry_context_json: string;
  required_at: string;
  status: string;
}

interface CandidateProfileTargetRow extends Record<string, unknown> {
  experience_target_locations?: string;
  personal_city?: string;
  personal_country?: string;
}

type CandidateProfileTargetColumn = "experience_target_locations" | "personal_city" | "personal_country";

export function ensureDiscoveryControlTables(db: SqliteDatabase): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS source_registry_entries (
      tenant_id     TEXT NOT NULL DEFAULT 'local',
      source_id     TEXT NOT NULL,
      kind          TEXT NOT NULL,
      display_name  TEXT NOT NULL,
      owner         TEXT NOT NULL DEFAULT 'user',
      priority      TEXT NOT NULL DEFAULT 'standard',
      state         TEXT NOT NULL DEFAULT 'experimental',
      policy_id     TEXT NOT NULL,
      seed_url      TEXT,
      created_at    TEXT NOT NULL,
      updated_at    TEXT NOT NULL,
      PRIMARY KEY (tenant_id, source_id)
    );
    CREATE TABLE IF NOT EXISTS source_locator_candidates (
      tenant_id                TEXT NOT NULL DEFAULT 'local',
      candidate_id             TEXT NOT NULL,
      candidate_url            TEXT NOT NULL,
      source_kind              TEXT NOT NULL,
      confidence               REAL NOT NULL DEFAULT 0,
      detected_ats_kind        TEXT,
      employer_domain_matched  INTEGER NOT NULL DEFAULT 0,
      manual_action_reason     TEXT,
      discovered_at            TEXT NOT NULL,
      PRIMARY KEY (tenant_id, candidate_id)
    );
    CREATE TABLE IF NOT EXISTS discovery_quarantine_entries (
      tenant_id        TEXT NOT NULL DEFAULT 'local',
      job_id           TEXT NOT NULL,
      job_key          TEXT NOT NULL,
      title            TEXT NOT NULL DEFAULT '',
      company          TEXT NOT NULL DEFAULT '',
      source_id        TEXT NOT NULL,
      posting_url      TEXT,
      reason           TEXT NOT NULL,
      confidence       REAL,
      snapshot_version INTEGER,
      captured_at      TEXT,
      notice_text      TEXT,
      status           TEXT NOT NULL DEFAULT 'pending',
      decision_reason  TEXT,
      decided_at       TEXT,
      PRIMARY KEY (tenant_id, job_key)
    );
    CREATE TABLE IF NOT EXISTS manual_capture_queue (
      tenant_id                     TEXT NOT NULL DEFAULT 'local',
      item_id                       TEXT NOT NULL,
      originating_url               TEXT NOT NULL,
      source_id                     TEXT,
      reason                        TEXT NOT NULL,
      retry_context_json            TEXT NOT NULL DEFAULT '{}',
      required_at                   TEXT NOT NULL,
      status                        TEXT NOT NULL DEFAULT 'pending',
      imported_at                   TEXT,
      dismissed_at                  TEXT,
      capture_mode                  TEXT,
      captured_url                  TEXT,
      content_sha256                TEXT,
      content_length                INTEGER,
      note                          TEXT,
      future_manual_action_required INTEGER NOT NULL DEFAULT 0,
      job_key                       TEXT,
      PRIMARY KEY (tenant_id, item_id)
    );
    CREATE TABLE IF NOT EXISTS discovery_feedback (
      tenant_id   TEXT NOT NULL DEFAULT 'local',
      feedback_id TEXT NOT NULL,
      job_key     TEXT NOT NULL,
      source_id   TEXT,
      kind        TEXT NOT NULL,
      note        TEXT,
      recorded_at TEXT NOT NULL,
      PRIMARY KEY (tenant_id, feedback_id)
    );
  `);
}

export function listSourceRegistry(db: SqliteDatabase): SourceRegistryListResponse {
  ensureDiscoveryControlTables(db);
  refreshProjections(db, DEFAULT_TENANT);
  const filterAmericaOnlySources = targetSearchPrefersEurope(db);

  const rows = allRows<SourceRegistryRow>(
    db,
    `SELECT tenant_id, source_id, kind, display_name, owner, priority, state,
            policy_id, seed_url, created_at, updated_at
     FROM source_registry_entries
     WHERE tenant_id = ?
     ORDER BY state ASC, priority ASC, display_name ASC`,
    [DEFAULT_TENANT],
  );
  const quality = sourceQualityById(db);
  const summaries = new Map<string, SourceRegistryEntrySummary>();
  for (const row of rows) {
    if (filterAmericaOnlySources && isAmericaOnlySource(row.source_id, row.display_name, row.seed_url)) {
      continue;
    }
    summaries.set(row.source_id, rowToSourceSummary(row, quality.get(row.source_id)));
  }
  for (const [sourceId, stats] of quality.entries()) {
    if (filterAmericaOnlySources && isAmericaOnlySource(sourceId, sourceId, null)) {
      continue;
    }
    if (!summaries.has(sourceId)) {
      summaries.set(sourceId, qualityOnlySourceSummary(sourceId, stats));
    }
  }
  return { ok: true, sources: [...summaries.values()] };
}

function targetSearchPrefersEurope(db: SqliteDatabase): boolean {
  if (!tableExists(db, "candidate_profiles")) {
    return false;
  }
  const columns = candidateProfileColumns(db);
  const row = getRow<CandidateProfileTargetRow>(
    db,
    `SELECT ${candidateProfileColumn(columns, "experience_target_locations")},
            ${candidateProfileColumn(columns, "personal_city")},
            ${candidateProfileColumn(columns, "personal_country")}
     FROM candidate_profiles
     WHERE tenant_id = ? AND profile_id = ?`,
    [DEFAULT_TENANT, "default"],
  );
  const target = [
    row?.experience_target_locations,
    row?.personal_city,
    row?.personal_country,
  ]
    .map((value) => String(value ?? ""))
    .join(" ")
    .toLowerCase();
  return EUROPE_TARGET_MARKERS.some((marker) => target.includes(marker));
}

function candidateProfileColumns(db: SqliteDatabase): Set<string> {
  return new Set(
    allRows<{ name: string }>(db, "PRAGMA table_info(candidate_profiles)").map((row) => row.name),
  );
}

function candidateProfileColumn(columns: Set<string>, column: CandidateProfileTargetColumn): string {
  return columns.has(column) ? column : `'' AS ${column}`;
}

function isAmericaOnlySource(sourceId: string, displayName: string, seedUrl: string | null): boolean {
  const target = `${sourceId} ${displayName} ${seedUrl ?? ""}`.toLowerCase();
  return AMERICA_ONLY_SOURCE_MARKERS.some((marker) => target.includes(marker));
}

export function upsertSourceRegistryEntry(
  db: SqliteDatabase,
  input: SourceUpsertRequest,
): SourceRegistryEntrySummary {
  ensureDiscoveryControlTables(db);
  const now = new Date().toISOString();
  const existing = getSourceRegistryRow(db, input.sourceId);
  const policyId = existing?.policy_id ?? `local:${input.sourceId}`;
  db.prepare(
    `INSERT INTO source_registry_entries (
       tenant_id, source_id, kind, display_name, owner, priority, state,
       policy_id, seed_url, created_at, updated_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(tenant_id, source_id) DO UPDATE SET
       kind = excluded.kind,
       display_name = excluded.display_name,
       priority = excluded.priority,
       state = excluded.state,
       seed_url = excluded.seed_url,
       updated_at = excluded.updated_at`,
  ).run(
    DEFAULT_TENANT,
    input.sourceId,
    input.kind,
    input.displayName,
    existing?.owner ?? "user",
    input.priority,
    input.state,
    policyId,
    input.seedUrl ?? null,
    existing?.created_at ?? now,
    now,
  );

  recordEvent(db, {
    eventType: existing ? "SourceRegistryEntryUpdated" : "SourceRegistryEntryCreated",
    message: existing ? "Source registry entry updated." : "Source registry entry created.",
    payload: existing
      ? {
          sourceId: input.sourceId,
          changedFields: changedSourceFields(existing, input),
          updatedAt: now,
        }
      : {
          sourceId: input.sourceId,
          kind: input.kind,
          policyId,
          state: input.state,
          createdAt: now,
        },
  });

  const row = getSourceRegistryRow(db, input.sourceId);
  if (!row) {
    throw new Error(`Unable to read source registry entry ${input.sourceId}.`);
  }
  return rowToSourceSummary(row, sourceQualityById(db).get(input.sourceId));
}

export function patchSourceState(
  db: SqliteDatabase,
  sourceId: string,
  patch: SourceStatePatch,
): SourceRegistryEntrySummary {
  ensureDiscoveryControlTables(db);
  const now = new Date().toISOString();
  let existing = getSourceRegistryRow(db, sourceId);
  if (!existing) {
    const kind = sourceKindFromId(sourceId);
    db.prepare(
      `INSERT INTO source_registry_entries (
         tenant_id, source_id, kind, display_name, owner, priority, state,
         policy_id, seed_url, created_at, updated_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      DEFAULT_TENANT,
      sourceId,
      kind,
      sourceId,
      "user",
      defaultPriority(kind),
      "experimental",
      `local:${sourceId}`,
      null,
      now,
      now,
    );
    existing = getSourceRegistryRow(db, sourceId);
  }
  if (!existing) {
    throw new InputError(`Source ${sourceId} was not found.`);
  }
  db.prepare(
    `UPDATE source_registry_entries
     SET state = ?, updated_at = ?
     WHERE tenant_id = ? AND source_id = ?`,
  ).run(patch.state, now, DEFAULT_TENANT, sourceId);
  recordEvent(db, {
    eventType: "SourceStateChanged",
    message: "Source state changed.",
    payload: {
      sourceId,
      fromState: existing.state,
      toState: patch.state,
      reason: patch.reason ?? "",
      changedAt: now,
    },
  });
  recordEvent(db, {
    eventType: "SourceRegistryEntryUpdated",
    message: "Source registry entry updated.",
    payload: { sourceId, changedFields: ["state"], updatedAt: now },
  });
  const row = getSourceRegistryRow(db, sourceId);
  if (!row) {
    throw new Error(`Unable to read source registry entry ${sourceId}.`);
  }
  return rowToSourceSummary(row, sourceQualityById(db).get(sourceId));
}

export function listSourceLocatorCandidates(db: SqliteDatabase): SourceLocatorListResponse {
  ensureDiscoveryControlTables(db);
  const rows = allRows<SourceLocatorCandidateRow>(
    db,
    `SELECT candidate_id, candidate_url, source_kind, confidence, detected_ats_kind,
            employer_domain_matched, manual_action_reason, discovered_at
     FROM source_locator_candidates
     WHERE tenant_id = ?
     ORDER BY confidence DESC, discovered_at DESC`,
    [DEFAULT_TENANT],
  );
  const pendingRows: SourceLocatorCandidateRow[] = [];
  for (const row of rows) {
    if (shouldAutoPromoteParseableLocatorCandidate(row)) {
      promoteSourceLocatorCandidate(db, row.candidate_id);
      continue;
    }
    pendingRows.push(row);
  }
  return {
    ok: true,
    candidates: pendingRows.map((row) => ({
      candidateId: row.candidate_id,
      candidateUrl: row.candidate_url,
      sourceKind: sourceKind(row.source_kind),
      confidence: Number(row.confidence ?? 0),
      detectedAtsKind: row.detected_ats_kind,
      employerDomainMatched: Boolean(row.employer_domain_matched),
      manualActionReason: manualActionReason(row.manual_action_reason),
      discoveredAt: row.discovered_at,
    })),
  };
}

function shouldAutoPromoteParseableLocatorCandidate(row: SourceLocatorCandidateRow): boolean {
  return Number(row.confidence ?? 0) >= 0.4 && manualActionReason(row.manual_action_reason) === null;
}

export function promoteSourceLocatorCandidate(
  db: SqliteDatabase,
  candidateId: string,
): SourceLocatorDecisionResponse {
  ensureDiscoveryControlTables(db);
  const candidate = getSourceLocatorCandidateRow(db, candidateId);
  if (!candidate) {
    throw new InputError(`Source locator candidate ${candidateId} was not found.`);
  }

  const now = new Date().toISOString();
  const kind = sourceKind(candidate.source_kind);
  const sourceId = sourceIdFromLocatorCandidate(candidate);
  const source = upsertSourceRegistryEntry(db, {
    sourceId,
    kind,
    displayName: sourceDisplayNameFromUrl(candidate.candidate_url),
    priority: defaultPriority(kind),
    state: "active",
    seedUrl: candidate.candidate_url,
  });
  deleteSourceLocatorCandidate(db, candidateId);
  recordEvent(db, {
    eventType: "SourceLocationCandidatePromoted",
    message: "Source locator candidate promoted.",
    payload: { candidateId, sourceId, promotedAt: now },
  });

  return { ok: true, candidateId, decision: "promote", source, decidedAt: now };
}

export function rejectSourceLocatorCandidate(
  db: SqliteDatabase,
  candidateId: string,
): SourceLocatorDecisionResponse {
  ensureDiscoveryControlTables(db);
  const candidate = getSourceLocatorCandidateRow(db, candidateId);
  if (!candidate) {
    throw new InputError(`Source locator candidate ${candidateId} was not found.`);
  }
  const now = new Date().toISOString();
  deleteSourceLocatorCandidate(db, candidateId);
  return { ok: true, candidateId, decision: "reject", source: null, decidedAt: now };
}

export function listQuarantine(db: SqliteDatabase): QuarantineListResponse {
  ensureDiscoveryControlTables(db);
  const rows = allRows<QuarantineEntryRow>(
    db,
    `SELECT job_id, job_key, title, company, source_id, posting_url, reason,
            confidence, snapshot_version, captured_at, notice_text
     FROM discovery_quarantine_entries
     WHERE tenant_id = ? AND status = 'pending'
     ORDER BY captured_at DESC, job_key ASC`,
    [DEFAULT_TENANT],
  );
  return {
    ok: true,
    entries: rows.map((row) => ({
      jobId: row.job_id,
      jobKey: row.job_key,
      title: row.title,
      company: row.company,
      sourceId: row.source_id,
      postingUrl: row.posting_url,
      reason: quarantineReason(row.reason),
      confidence: nullableNumber(row.confidence),
      snapshotVersion: nullableNumber(row.snapshot_version),
      capturedAt: row.captured_at,
      noticeText: row.notice_text,
    })),
  };
}

export function decideQuarantineEntry(
  db: SqliteDatabase,
  jobKey: string,
  decision: QuarantineDecision,
): QuarantineDecisionResponse {
  ensureDiscoveryControlTables(db);
  const now = new Date().toISOString();
  const row = getRow<QuarantineEntryRow>(
    db,
    `SELECT job_id, job_key, title, company, source_id, posting_url, reason,
            confidence, snapshot_version, captured_at, notice_text
     FROM discovery_quarantine_entries
     WHERE tenant_id = ? AND job_key = ? AND status = 'pending'`,
    [DEFAULT_TENANT, jobKey],
  );
  if (!row) {
    throw new InputError(`Quarantine entry ${jobKey} was not found.`);
  }
  db.prepare(
    `UPDATE discovery_quarantine_entries
     SET status = ?, decision_reason = ?, decided_at = ?
     WHERE tenant_id = ? AND job_key = ?`,
  ).run(decision.decision, decision.reason ?? null, now, DEFAULT_TENANT, jobKey);
  recordEvent(db, {
    eventType: "DiscoveryFeedbackRecorded",
    jobUrl: row.job_id || row.job_key,
    message: "Discovery quarantine decision recorded.",
    payload: {
      feedbackId: `feedback-${crypto.randomUUID()}`,
      jobId: row.job_id || row.job_key,
      sourceId: row.source_id,
      kind: decision.decision === "approve" ? "useful" : "irrelevant",
      recordedAt: now,
    },
  });
  return { ok: true, jobKey, decision: decision.decision, recordedAt: now };
}

export function listManualCaptureQueue(db: SqliteDatabase): ManualCaptureListResponse {
  ensureDiscoveryControlTables(db);
  const rows = allRows<ManualCaptureRow>(
    db,
    `SELECT item_id, originating_url, source_id, reason, retry_context_json, required_at, status
     FROM manual_capture_queue
     WHERE tenant_id = ? AND status = 'pending'
     ORDER BY required_at DESC, item_id ASC`,
    [DEFAULT_TENANT],
  );
  return {
    ok: true,
    items: rows.map((row) => ({
      itemId: row.item_id,
      originatingUrl: row.originating_url,
      sourceId: row.source_id,
      reason: manualActionReason(row.reason) ?? "ambiguous_career_system",
      retryContext: parseObject(row.retry_context_json),
      requiredAt: row.required_at,
      status: "pending",
    })),
  };
}

export function dismissManualCapture(
  db: SqliteDatabase,
  itemId: string,
  _reason?: string,
): ManualCaptureDismissResponse {
  ensureDiscoveryControlTables(db);
  const row = getManualCaptureRow(db, itemId);
  if (!row) {
    throw new InputError(`Manual capture item ${itemId} was not found.`);
  }
  const now = new Date().toISOString();
  db.prepare(
    `UPDATE manual_capture_queue
     SET status = 'dismissed', dismissed_at = ?
     WHERE tenant_id = ? AND item_id = ?`,
  ).run(now, DEFAULT_TENANT, itemId);
  return { ok: true, itemId, status: "dismissed", dismissedAt: now };
}

export function recordDiscoveryFeedback(
  db: SqliteDatabase,
  input: DiscoveryFeedbackRequest,
): DiscoveryFeedbackResponse {
  ensureDiscoveryControlTables(db);
  const now = new Date().toISOString();
  const feedbackId = `feedback-${crypto.randomUUID()}`;
  db.prepare(
    `INSERT INTO discovery_feedback (
       tenant_id, feedback_id, job_key, source_id, kind, note, recorded_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    DEFAULT_TENANT,
    feedbackId,
    input.jobKey,
    input.sourceId ?? null,
    input.kind,
    input.note ?? null,
    now,
  );
  recordEvent(db, {
    eventType: "DiscoveryFeedbackRecorded",
    jobUrl: input.jobKey,
    message: "Discovery feedback recorded.",
    payload: {
      feedbackId,
      jobId: input.jobKey,
      sourceId: input.sourceId ?? null,
      kind: input.kind,
      recordedAt: now,
    },
  });
  return {
    ok: true,
    feedbackId,
    jobKey: input.jobKey,
    sourceId: input.sourceId ?? null,
    kind: input.kind,
    recordedAt: now,
  };
}

export function previewDiscoverySource(
  db: SqliteDatabase,
  sourceId: string,
): DiscoveryPreviewResponse {
  ensureDiscoveryControlTables(db);
  if (!tableExists(db, "job_source_observations")) {
    return { ok: true, sourceId, leads: [], generatedAt: new Date().toISOString() };
  }

  const rows = allRows<PreviewObservationRow>(
    db,
    `SELECT o.job_url, o.observed_url, o.observed_at,
            j.title, j.site, j.location
     FROM job_source_observations o
     LEFT JOIN jobs j ON j.url = o.job_url
     WHERE o.tenant_id = ? AND o.source_id = ?
     ORDER BY o.observed_at DESC, o.source_observation_id DESC
     LIMIT 10`,
    [DEFAULT_TENANT, sourceId],
  );
  const leads: DiscoveryPreviewResponse["leads"] = [];
  const seen = new Set<string>();
  for (const row of rows) {
    const candidateUrl = row.observed_url || row.job_url;
    if (!candidateUrl || seen.has(candidateUrl)) {
      continue;
    }
    seen.add(candidateUrl);
    leads.push({
      candidateUrl,
      title: row.title || "",
      company: row.site || "",
      location: row.location || "",
      estimatedConfidence: 1,
    });
  }
  return {
    ok: true,
    sourceId,
    leads,
    generatedAt: new Date().toISOString(),
  };
}

function sourceQualityById(db: SqliteDatabase): Map<string, SourceQualityRow> {
  if (!tableExists(db, "source_quality_stats")) {
    return new Map();
  }
  const rows = allRows<SourceQualityRow>(
    db,
    `SELECT source_id, recommended_state, run_count, failed_run_count,
            consecutive_failures, observed_jobs, new_jobs, existing_jobs,
            duplicate_rate, active_verification_rate,
            full_description_success_rate, apply_url_success_rate,
            last_run_id, last_error_class, updated_at
     FROM source_quality_stats
     WHERE tenant_id = ?`,
    [DEFAULT_TENANT],
  );
  return new Map(rows.map((row) => [row.source_id, row]));
}

function getSourceRegistryRow(db: SqliteDatabase, sourceId: string): SourceRegistryRow | undefined {
  return getRow<SourceRegistryRow>(
    db,
    `SELECT tenant_id, source_id, kind, display_name, owner, priority, state,
            policy_id, seed_url, created_at, updated_at
     FROM source_registry_entries
     WHERE tenant_id = ? AND source_id = ?`,
    [DEFAULT_TENANT, sourceId],
  );
}

function getManualCaptureRow(db: SqliteDatabase, itemId: string): ManualCaptureRow | undefined {
  return getRow<ManualCaptureRow>(
    db,
    `SELECT item_id, originating_url, source_id, reason, retry_context_json, required_at, status
     FROM manual_capture_queue
     WHERE tenant_id = ? AND item_id = ? AND status = 'pending'`,
    [DEFAULT_TENANT, itemId],
  );
}

function getSourceLocatorCandidateRow(
  db: SqliteDatabase,
  candidateId: string,
): SourceLocatorCandidateRow | undefined {
  return getRow<SourceLocatorCandidateRow>(
    db,
    `SELECT candidate_id, candidate_url, source_kind, confidence, detected_ats_kind,
            employer_domain_matched, manual_action_reason, discovered_at
     FROM source_locator_candidates
     WHERE tenant_id = ? AND candidate_id = ?`,
    [DEFAULT_TENANT, candidateId],
  );
}

function deleteSourceLocatorCandidate(db: SqliteDatabase, candidateId: string): void {
  db.prepare(
    `DELETE FROM source_locator_candidates
     WHERE tenant_id = ? AND candidate_id = ?`,
  ).run(DEFAULT_TENANT, candidateId);
}

function rowToSourceSummary(
  row: SourceRegistryRow,
  stats: SourceQualityRow | undefined,
): SourceRegistryEntrySummary {
  return {
    sourceId: row.source_id,
    kind: sourceKind(row.kind),
    displayName: row.display_name,
    owner: row.owner === "system" ? "system" : "user",
    priority: sourcePriority(row.priority),
    state: sourceState(row.state),
    policyId: row.policy_id,
    recommendedState: recommendedSourceState(stats?.recommended_state),
    lastRunId: stats?.last_run_id ?? null,
    lastRunCompletedAt: stats?.updated_at ?? null,
    lastErrorClass: stats?.last_error_class ?? null,
    consecutiveFailures: Number(stats?.consecutive_failures ?? 0),
    observedJobs: Number(stats?.observed_jobs ?? 0),
    newJobs: Number(stats?.new_jobs ?? 0),
    duplicateRate: nullableNumber(stats?.duplicate_rate),
    activeVerificationRate: nullableNumber(stats?.active_verification_rate),
    fullDescriptionSuccessRate: nullableNumber(stats?.full_description_success_rate),
    applyUrlSuccessRate: nullableNumber(stats?.apply_url_success_rate),
    qualityTrend: "unknown",
  };
}

function qualityOnlySourceSummary(sourceId: string, stats: SourceQualityRow): SourceRegistryEntrySummary {
  const recommended = recommendedSourceState(stats.recommended_state);
  return {
    sourceId,
    kind: sourceKindFromId(sourceId),
    displayName: sourceId,
    owner: "system",
    priority: "standard",
    state: sourceStateFromRecommended(recommended),
    policyId: `local:${sourceId}`,
    recommendedState: recommended,
    lastRunId: stats.last_run_id,
    lastRunCompletedAt: stats.updated_at,
    lastErrorClass: stats.last_error_class,
    consecutiveFailures: Number(stats.consecutive_failures ?? 0),
    observedJobs: Number(stats.observed_jobs ?? 0),
    newJobs: Number(stats.new_jobs ?? 0),
    duplicateRate: nullableNumber(stats.duplicate_rate),
    activeVerificationRate: nullableNumber(stats.active_verification_rate),
    fullDescriptionSuccessRate: nullableNumber(stats.full_description_success_rate),
    applyUrlSuccessRate: nullableNumber(stats.apply_url_success_rate),
    qualityTrend: "unknown",
  };
}

function changedSourceFields(existing: SourceRegistryRow, input: SourceUpsertRequest): string[] {
  const changed: string[] = [];
  if (existing.kind !== input.kind) changed.push("kind");
  if (existing.display_name !== input.displayName) changed.push("displayName");
  if (existing.priority !== input.priority) changed.push("priority");
  if (existing.state !== input.state) changed.push("state");
  if ((existing.seed_url ?? undefined) !== input.seedUrl) changed.push("seedUrl");
  return changed.length ? changed : ["updatedAt"];
}

function recordEvent(
  db: SqliteDatabase,
  event: {
    eventType: string;
    payload: Record<string, unknown>;
    message: string;
    jobUrl?: string;
    stage?: string;
  },
): void {
  if (!tableExists(db, "job_events")) {
    return;
  }
  const columns = jobEventColumns(db);
  const values: Record<string, SqliteValue> = {
    job_url: event.jobUrl ?? null,
    stage: event.stage ?? "discover",
    event_type: event.eventType,
    level: "info",
    message: event.message,
    occurred_at: new Date().toISOString(),
    payload_json: JSON.stringify(event.payload),
  };
  const entries = Object.entries(values).filter(([name]) => columns.has(name));
  if (!entries.length) {
    return;
  }
  db.prepare(
    `INSERT INTO job_events (${entries.map(([name]) => name).join(", ")}) VALUES (${entries.map(() => "?").join(", ")})`,
  ).run(...entries.map(([, value]) => value));
}

function jobEventColumns(db: SqliteDatabase): Set<string> {
  return new Set(
    allRows<{ name: string }>(db, "PRAGMA table_info(job_events)").map((row) => row.name),
  );
}

function sourceKind(value: string): SourceKindValue {
  return SOURCE_KIND_VALUES.includes(value as SourceKindValue) ? (value as SourceKindValue) : "broad_board";
}

function sourceState(value: string): SourceStateValue {
  return SOURCE_STATE_VALUES.includes(value as SourceStateValue) ? (value as SourceStateValue) : "experimental";
}

function sourcePriority(value: string): SourcePriorityValue {
  return SOURCE_PRIORITY_VALUES.includes(value as SourcePriorityValue)
    ? (value as SourcePriorityValue)
    : "standard";
}

function sourceKindFromId(sourceId: string): SourceKindValue {
  if (sourceId.startsWith("workday:")) return "ats_api";
  if (sourceId.startsWith("greenhouse:")) return "ats_api";
  if (sourceId.startsWith("lever:")) return "ats_api";
  if (sourceId.startsWith("jobspy:")) return "broad_board";
  if (sourceId.startsWith("smart_extract:")) return "smart_extract";
  return "employer_careers_page";
}

function defaultPriority(kind: SourceKindValue): SourcePriorityValue {
  if (kind === "ats_api") return "canonical";
  if (kind === "broad_board") return "lead_generator";
  if (kind === "smart_extract") return "fallback";
  return "standard";
}

function recommendedSourceState(value: string | undefined): RecommendedSourceState {
  if (value === "trusted" || value === "normal" || value === "experimental" || value === "quarantined" || value === "disabled") {
    return value;
  }
  return "normal";
}

function sourceStateFromRecommended(value: RecommendedSourceState): SourceStateValue {
  if (value === "disabled") return "disabled";
  if (value === "quarantined") return "quarantined";
  if (value === "experimental") return "experimental";
  return "active";
}

function manualActionReason(value: string | null | undefined): ManualActionReasonValue | null {
  return MANUAL_ACTION_REASON_VALUES.includes(value as ManualActionReasonValue)
    ? (value as ManualActionReasonValue)
    : null;
}

function quarantineReason(value: string): QuarantineReason {
  return QUARANTINE_REASONS.includes(value as QuarantineReason)
    ? (value as QuarantineReason)
    : "user_review_requested";
}

function parseObject(raw: unknown): Record<string, unknown> {
  if (raw && typeof raw === "object" && !Array.isArray(raw)) {
    return raw as Record<string, unknown>;
  }
  if (typeof raw !== "string") {
    return {};
  }
  try {
    const parsed = JSON.parse(raw) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}

function nullableNumber(value: unknown): number | null {
  if (value === null || value === undefined || value === "") {
    return null;
  }
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function sourceIdFromLocatorCandidate(candidate: SourceLocatorCandidateRow): string {
  const atsKind = candidate.detected_ats_kind?.trim().toLowerCase();
  const slug = sourceSlugFromLocatorCandidate(candidate.candidate_url, atsKind) || candidate.candidate_id;
  if (atsKind) {
    return `${atsKind}:${slug}`;
  }
  return `${sourceKind(candidate.source_kind)}:${slug}`;
}

function sourceDisplayNameFromUrl(rawUrl: string): string {
  const host = hostFromUrl(rawUrl);
  return host ? host.replace(/^www\./, "") : rawUrl;
}

function slugFromUrl(rawUrl: string): string {
  return slugText(sourceDisplayNameFromUrl(rawUrl));
}

function hostFromUrl(rawUrl: string): string {
  try {
    return new URL(rawUrl).hostname;
  } catch {
    return "";
  }
}

function sourceSlugFromLocatorCandidate(rawUrl: string, atsKind: string | undefined): string {
  try {
    const url = new URL(rawUrl);
    const host = url.hostname.toLowerCase().replace(/^www\./, "");
    const firstPathSegment = url.pathname.split("/").filter(Boolean)[0] ?? "";
    if (atsKind && isSharedAtsHost(host) && firstPathSegment) {
      return slugText(firstPathSegment);
    }
    return slugText(host);
  } catch {
    return slugFromUrl(rawUrl);
  }
}

function isSharedAtsHost(host: string): boolean {
  return [
    "boards.greenhouse.io",
    "jobs.lever.co",
    "jobs.ashbyhq.com",
    "myworkdayjobs.com",
    "wd1.myworkdaysite.com",
    "wd3.myworkdayjobs.com",
    "wd5.myworkdayjobs.com",
  ].some((domain) => host === domain || host.endsWith(`.${domain}`));
}

function slugText(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}
