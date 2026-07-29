import crypto from "node:crypto";

import type {
  DiscoverySettings,
  DiscoverySettingsResponse,
  DiscoverySettingsUpdateRequest,
  EffectiveDiscoverySettings,
  EffectiveSetting,
  DiscoveryFeedbackResponse,
  ExtensionCaptureIngestRequest,
  ExtensionCaptureIngestResponse,
  RoleMatchFeedbackDecisionRequest,
  RoleMatchFeedbackDecisionResponse,
  RoleMatchFeedbackEvidence,
  RoleMatchFeedbackListResponse,
  RoleMatchFeedbackReasonCode,
  RoleMatchFeedbackRuleKind,
  RoleMatchFeedbackStatus,
  RoleMatchFeedbackSuggestion,
  ManualCaptureDismissResponse,
  ManualCaptureListResponse,
  ManualActionReasonValue,
  ManualCaptureImportResponse,
  ManualCaptureModeValue,
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
  MANUAL_CAPTURE_MODE_VALUES,
  QUARANTINE_REASONS,
  SOURCE_KIND_VALUES,
  SOURCE_PRIORITY_VALUES,
  SOURCE_STATE_VALUES,
} from "./contracts.js";
import {
  allRows,
  getRow,
  jobReferenceColumn,
  tableExists,
  type SqliteDatabase,
  type SqliteValue,
} from "./db.js";
import { emptyPolitenessOutcomes, politenessOutcomesBySource } from "./source-politeness.js";
import type { SourcePolitenessOutcomes } from "@jobctrl/contracts";
import { refreshProjections } from "./projections.js";
import { InputError } from "./write-model.js";

const DEFAULT_TENANT = "local";
export const EXTENSION_MANUAL_CAPTURE_SOURCE_ID = "manual_capture:extension";
const EXTENSION_MANUAL_CAPTURE_REASON: ManualActionReasonValue = "browser_extension_capture";
const DEFAULT_DISCOVERY_SETTINGS: DiscoverySettings = {
  minFitScore: 7,
  autoApply: false,
  applyApprovalRequired: true,
  boards: ["indeed", "linkedin", "zip_recruiter"],
  resultsPerSite: 50,
  hoursOld: 72,
  schedulingEnabled: false,
  scheduleCron: "0 7 * * *",
  roleFilterMode: "auto",
  roleFilterModel: null,
  maxParallelFamilies: 1,
  crawlUserAgentProduct: "JobCtrl",
  crawlUserAgentContact: "https://github.com/ebarti/JobCtrl",
  source: "database",
};

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

const WORKDAY_HOST_ALIAS_SOURCE_RE = /^workday:(?<employer>.+)-wd\d+-myworkdayjobs-com$/;

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

interface ImportedManualCaptureRow extends ManualCaptureRow {
  imported_at: string | null;
  dismissed_at: string | null;
  capture_mode: string | null;
  captured_url: string | null;
  future_manual_action_required: number | null;
  job_key: string | null;
}

interface LowScoreJobRow extends Record<string, unknown> {
  job_key: string;
  title: string | null;
  company: string | null;
  site: string | null;
  strategy: string | null;
  fit_score: number;
  breakdown_json: string | null;
  scored_at: string | null;
}

interface RoleMatchFeedbackRow extends Record<string, unknown> {
  tenant_id: string;
  suggestion_id: string;
  status: string;
  rule_kind: string;
  title_pattern: string;
  title_display: string;
  reason_code: string;
  reason: string;
  sample_count: number;
  source_ids_json: string;
  evidence_json: string;
  created_at: string;
  updated_at: string;
  decided_at: string | null;
  decision_reason: string | null;
}

interface CandidateProfileTargetRow extends Record<string, unknown> {
  experience_target_locations?: string;
  personal_city?: string;
  personal_country?: string;
}

type CandidateProfileTargetColumn = "experience_target_locations" | "personal_city" | "personal_country";

export function ensureDiscoveryControlTables(db: SqliteDatabase): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS discovery_settings (
      tenant_id          TEXT PRIMARY KEY,
      search_config_json TEXT NOT NULL,
      created_at         TEXT NOT NULL,
      updated_at         TEXT NOT NULL
    );
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
    CREATE TABLE IF NOT EXISTS role_match_feedback_suggestions (
      tenant_id       TEXT NOT NULL DEFAULT 'local',
      suggestion_id   TEXT NOT NULL,
      status          TEXT NOT NULL DEFAULT 'pending',
      rule_kind       TEXT NOT NULL,
      title_pattern   TEXT NOT NULL,
      title_display   TEXT NOT NULL,
      reason_code     TEXT NOT NULL,
      reason          TEXT NOT NULL,
      sample_count    INTEGER NOT NULL DEFAULT 0,
      source_ids_json TEXT NOT NULL DEFAULT '[]',
      evidence_json   TEXT NOT NULL DEFAULT '[]',
      created_at      TEXT NOT NULL,
      updated_at      TEXT NOT NULL,
      decided_at      TEXT,
      decision_reason TEXT,
      PRIMARY KEY (tenant_id, suggestion_id)
    );
  `);
}

export function readDiscoverySettings(
  db: SqliteDatabase,
): DiscoverySettingsResponse {
  ensureDiscoveryControlTables(db);
  const stored = readDiscoverySearchConfig(db);
  return resolvedDiscoverySettings(stored.config, stored.persisted);
}

export function writeDiscoverySettings(
  db: SqliteDatabase,
  request: DiscoverySettingsUpdateRequest,
): DiscoverySettingsResponse {
  ensureDiscoveryControlTables(db);
  const stored = readDiscoverySearchConfig(db);
  const currentConfig = stored.config;
  const current = discoverySettingsFromConfig(currentConfig);
  const next: DiscoverySettings = {
    ...current,
    minFitScore: request.minFitScore ?? current.minFitScore,
    autoApply: request.autoApply ?? current.autoApply,
    applyApprovalRequired: request.applyApprovalRequired ?? current.applyApprovalRequired,
    boards: request.boards ?? current.boards,
    resultsPerSite: request.resultsPerSite ?? current.resultsPerSite,
    hoursOld: request.hoursOld ?? current.hoursOld,
    schedulingEnabled: request.schedulingEnabled ?? current.schedulingEnabled,
    scheduleCron: request.scheduleCron ?? current.scheduleCron,
    roleFilterMode: request.roleFilterMode ?? current.roleFilterMode,
    roleFilterModel: request.roleFilterModel === undefined ? current.roleFilterModel : request.roleFilterModel,
    maxParallelFamilies: request.maxParallelFamilies ?? current.maxParallelFamilies,
    crawlUserAgentProduct: request.crawlUserAgentProduct ?? current.crawlUserAgentProduct,
    crawlUserAgentContact: request.crawlUserAgentContact ?? current.crawlUserAgentContact,
  };
  const now = new Date().toISOString();
  const config = configFromDiscoverySettings(next, currentConfig);
  db.prepare(`
    INSERT INTO discovery_settings (
      tenant_id, search_config_json, created_at, updated_at
    ) VALUES (?, ?, ?, ?)
    ON CONFLICT(tenant_id) DO UPDATE SET
      search_config_json = excluded.search_config_json,
      updated_at = excluded.updated_at
  `).run(DEFAULT_TENANT, JSON.stringify(config), now, now);
  return resolvedDiscoverySettings(config, true);
}

function readDiscoverySearchConfig(db: SqliteDatabase): {
  config: Record<string, unknown>;
  persisted: boolean;
} {
  const row = getRow<{ search_config_json: string }>(
    db,
    "SELECT search_config_json FROM discovery_settings WHERE tenant_id = ?",
    [DEFAULT_TENANT],
  );
  if (!row?.search_config_json) {
    return { config: configFromDiscoverySettings(DEFAULT_DISCOVERY_SETTINGS), persisted: false };
  }
  try {
    const parsed = JSON.parse(row.search_config_json) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? { config: parsed as Record<string, unknown>, persisted: true }
      : { config: configFromDiscoverySettings(DEFAULT_DISCOVERY_SETTINGS), persisted: false };
  } catch {
    return { config: configFromDiscoverySettings(DEFAULT_DISCOVERY_SETTINGS), persisted: false };
  }
}

function discoverySettingsFromConfig(config: Record<string, unknown>): DiscoverySettings {
  const defaults = recordValue(config.defaults);
  const automation = recordValue(config.automation);
  return {
    minFitScore: boundedInt(
      automation.min_fit_score,
      DEFAULT_DISCOVERY_SETTINGS.minFitScore,
      0,
      10,
    ),
    autoApply: boolValue(automation.auto_apply, DEFAULT_DISCOVERY_SETTINGS.autoApply),
    applyApprovalRequired: boolValue(
      automation.apply_approval_required,
      DEFAULT_DISCOVERY_SETTINGS.applyApprovalRequired,
    ),
    boards: boardList(config.boards),
    resultsPerSite: positiveInt(defaults.results_per_site, DEFAULT_DISCOVERY_SETTINGS.resultsPerSite),
    hoursOld: positiveInt(defaults.hours_old, DEFAULT_DISCOVERY_SETTINGS.hoursOld),
    schedulingEnabled: boolValue(config.scheduling_enabled, DEFAULT_DISCOVERY_SETTINGS.schedulingEnabled),
    scheduleCron: nonEmptyString(config.schedule_cron, DEFAULT_DISCOVERY_SETTINGS.scheduleCron),
    roleFilterMode: roleFilterMode(recordValue(config.role_filter).mode),
    roleFilterModel: nullableString(recordValue(config.role_filter).model),
    maxParallelFamilies: boundedInt(config.max_parallel_families, DEFAULT_DISCOVERY_SETTINGS.maxParallelFamilies, 1, 4),
    crawlUserAgentProduct: nonEmptyString(
      recordValue(config.crawl_user_agent).product,
      DEFAULT_DISCOVERY_SETTINGS.crawlUserAgentProduct,
    ),
    crawlUserAgentContact: stringValue(
      recordValue(config.crawl_user_agent).contact,
      DEFAULT_DISCOVERY_SETTINGS.crawlUserAgentContact,
    ),
    source: "database",
  };
}

function configFromDiscoverySettings(
  settings: DiscoverySettings,
  base: Record<string, unknown> = {},
): Record<string, unknown> {
  const defaults = recordValue(base.defaults);
  return {
    ...base,
    automation: {
      ...recordValue(base.automation),
      min_fit_score: settings.minFitScore,
      auto_apply: settings.autoApply,
      apply_approval_required: settings.applyApprovalRequired,
    },
    boards: settings.boards,
    scheduling_enabled: settings.schedulingEnabled,
    schedule_cron: settings.scheduleCron,
    role_filter: {
      ...recordValue(base.role_filter),
      mode: settings.roleFilterMode,
      model: settings.roleFilterModel,
    },
    max_parallel_families: settings.maxParallelFamilies,
    crawl_user_agent: {
      ...recordValue(base.crawl_user_agent),
      product: settings.crawlUserAgentProduct,
      contact: settings.crawlUserAgentContact,
    },
    defaults: {
      ...defaults,
      hours_old: settings.hoursOld,
      results_per_site: settings.resultsPerSite,
    },
    queries: Array.isArray(base.queries) && base.queries.length > 0
      ? base.queries
      : [{ query: "Software Engineer", tier: 1 }],
    locations: Array.isArray(base.locations) && base.locations.length > 0
      ? base.locations
      : [{ label: "remote", location: "Remote", remote: true }],
    location_accept: Array.isArray(base.location_accept) && base.location_accept.length > 0
      ? base.location_accept
      : ["Remote"],
  };
}

function resolvedDiscoverySettings(
  config: Record<string, unknown>,
  persisted: boolean,
): DiscoverySettingsResponse {
  const stored = discoverySettingsFromConfig(config);
  const automation = recordValue(config.automation);
  const effectiveSettings: EffectiveDiscoverySettings = {
    minFitScore: setting(
      stored.minFitScore,
      "next_run",
      persisted && Object.hasOwn(automation, "min_fit_score"),
    ),
    autoApply: setting(
      stored.autoApply,
      "next_poll",
      persisted && Object.hasOwn(automation, "auto_apply"),
    ),
    applyApprovalRequired: setting(
      stored.applyApprovalRequired,
      "next_apply_job",
      persisted && Object.hasOwn(automation, "apply_approval_required"),
    ),
    boards: setting(stored.boards, "next_run", persisted && Object.hasOwn(config, "boards")),
    resultsPerSite: setting(
      stored.resultsPerSite,
      "next_run",
      persisted && Object.hasOwn(recordValue(config.defaults), "results_per_site"),
    ),
    hoursOld: setting(
      stored.hoursOld,
      "next_run",
      persisted && Object.hasOwn(recordValue(config.defaults), "hours_old"),
    ),
    schedulingEnabled: setting(
      stored.schedulingEnabled,
      "restart",
      persisted && Object.hasOwn(config, "scheduling_enabled"),
    ),
    scheduleCron: setting(
      stored.scheduleCron,
      "restart",
      persisted && Object.hasOwn(config, "schedule_cron"),
    ),
    roleFilterMode: setting(
      stored.roleFilterMode,
      "next_source_family",
      persisted && Object.hasOwn(recordValue(config.role_filter), "mode"),
    ),
    roleFilterModel: setting(
      stored.roleFilterModel,
      "next_source_family",
      persisted && Object.hasOwn(recordValue(config.role_filter), "model"),
    ),
    maxParallelFamilies: setting(
      stored.maxParallelFamilies,
      "next_run",
      persisted && Object.hasOwn(config, "max_parallel_families"),
    ),
    crawlUserAgentProduct: setting(
      stored.crawlUserAgentProduct,
      "next_source_family",
      persisted && Object.hasOwn(recordValue(config.crawl_user_agent), "product"),
    ),
    crawlUserAgentContact: setting(
      stored.crawlUserAgentContact,
      "next_source_family",
      persisted && Object.hasOwn(recordValue(config.crawl_user_agent), "contact"),
    ),
  };

  return {
    ok: true,
    settings: stored,
    effectiveSettings,
  };
}

function setting<T>(
  value: T,
  activation: EffectiveSetting<T>["activation"],
  persisted: boolean,
): EffectiveSetting<T> {
  return persisted
    ? { value, source: "persisted", activation, editable: true }
    : { value, source: "default", activation, editable: true };
}

function recordValue(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function boolValue(value: unknown, fallback: boolean): boolean {
  if (typeof value === "boolean") {
    return value;
  }
  if (typeof value === "string") {
    return !["", "0", "false", "no", "off"].includes(value.trim().toLowerCase());
  }
  return fallback;
}

function nonEmptyString(value: unknown, fallback: string): string {
  if (typeof value !== "string") {
    return fallback;
  }
  const trimmed = value.trim();
  return trimmed || fallback;
}

function stringValue(value: unknown, fallback: string): string {
  return typeof value === "string" ? value.trim() : fallback;
}

function nullableString(value: unknown): string | null {
  const text = stringValue(value, "");
  return text || null;
}

function roleFilterMode(value: unknown): DiscoverySettings["roleFilterMode"] {
  const normalized = stringValue(value, "auto").toLowerCase();
  if (["deterministic", "0", "false", "no", "off", "disabled"].includes(normalized)) {
    return "deterministic";
  }
  if (["llm", "1", "true", "yes", "on", "enabled"].includes(normalized)) {
    return "llm";
  }
  return "auto";
}

function boundedInt(value: unknown, fallback: number, minimum: number, maximum: number): number {
  const parsed = Number(value);
  return Number.isInteger(parsed) ? Math.min(maximum, Math.max(minimum, parsed)) : fallback;
}

function boardList(value: unknown): DiscoverySettings["boards"] {
  const allowed = new Set(["indeed", "linkedin", "zip_recruiter", "glassdoor"]);
  const values = Array.isArray(value)
    ? value.map((item) => String(item)).filter((item) => allowed.has(item))
    : [];
  return values.length > 0
    ? values as DiscoverySettings["boards"]
    : DEFAULT_DISCOVERY_SETTINGS.boards;
}

function positiveInt(value: unknown, fallback: number): number {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
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
  const politeness = politenessOutcomesBySource(db);
  const sourceIds = new Set(rows.map((row) => row.source_id));
  const summaries = new Map<string, SourceRegistryEntrySummary>();
  for (const row of rows) {
    if (filterAmericaOnlySources && isAmericaOnlySource(row.source_id, row.display_name, row.seed_url)) {
      continue;
    }
    if (isKnownWorkdayHostAlias(row.source_id, sourceIds)) {
      continue;
    }
    summaries.set(
      row.source_id,
      rowToSourceSummary(row, quality.get(row.source_id), politeness.get(row.source_id)),
    );
  }
  for (const [sourceId, stats] of quality.entries()) {
    if (filterAmericaOnlySources && isAmericaOnlySource(sourceId, sourceId, null)) {
      continue;
    }
    if (isKnownWorkdayHostAlias(sourceId, sourceIds)) {
      continue;
    }
    if (!summaries.has(sourceId)) {
      summaries.set(sourceId, qualityOnlySourceSummary(sourceId, stats, politeness.get(sourceId)));
    }
  }
  return { ok: true, sources: [...summaries.values()] };
}

function isKnownWorkdayHostAlias(sourceId: string, sourceIds: Set<string>): boolean {
  const canonicalId = canonicalWorkdaySourceIdForAlias(sourceId);
  return Boolean(canonicalId && sourceIds.has(canonicalId));
}

function canonicalWorkdaySourceIdForAlias(sourceId: string): string | null {
  const match = WORKDAY_HOST_ALIAS_SOURCE_RE.exec(sourceId);
  const employer = match?.groups?.employer;
  return employer ? `workday:${employer}` : null;
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
  return rowToSourceSummary(
    row,
    sourceQualityById(db).get(input.sourceId),
    politenessOutcomesBySource(db).get(input.sourceId),
  );
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
  return rowToSourceSummary(
    row,
    sourceQualityById(db).get(sourceId),
    politenessOutcomesBySource(db).get(sourceId),
  );
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

export function seedExtensionManualCapture(
  db: SqliteDatabase,
  input: ExtensionCaptureIngestRequest,
): { itemId: string; sourceId: string } | ExtensionCaptureIngestResponse {
  ensureDiscoveryControlTables(db);
  const now = new Date().toISOString();
  const itemId = extensionManualCaptureItemId(input);
  upsertSourceRegistryEntry(db, {
    sourceId: EXTENSION_MANUAL_CAPTURE_SOURCE_ID,
    kind: "user_mediated_capture",
    displayName: "Browser extension",
    priority: "standard",
    state: "active",
  });
  db.prepare(
    `INSERT INTO manual_capture_queue (
       tenant_id, item_id, originating_url, source_id, reason,
       retry_context_json, required_at, status
     ) VALUES (?, ?, ?, ?, ?, ?, ?, 'pending')
     ON CONFLICT(tenant_id, item_id) DO UPDATE SET
       originating_url = CASE
         WHEN manual_capture_queue.status IN ('imported', 'dismissed')
           THEN manual_capture_queue.originating_url
         ELSE excluded.originating_url
       END,
       source_id = CASE
         WHEN manual_capture_queue.status IN ('imported', 'dismissed')
           THEN manual_capture_queue.source_id
         ELSE excluded.source_id
       END,
       reason = CASE
         WHEN manual_capture_queue.status IN ('imported', 'dismissed')
           THEN manual_capture_queue.reason
         ELSE excluded.reason
       END,
       retry_context_json = CASE
         WHEN manual_capture_queue.status IN ('imported', 'dismissed')
           THEN manual_capture_queue.retry_context_json
         ELSE excluded.retry_context_json
       END,
       required_at = CASE
         WHEN manual_capture_queue.status IN ('imported', 'dismissed')
           THEN manual_capture_queue.required_at
         ELSE excluded.required_at
       END,
       status = CASE
         WHEN manual_capture_queue.status IN ('imported', 'dismissed')
           THEN manual_capture_queue.status
         ELSE excluded.status
       END`,
  ).run(
    DEFAULT_TENANT,
    itemId,
    input.originatingUrl,
    EXTENSION_MANUAL_CAPTURE_SOURCE_ID,
    EXTENSION_MANUAL_CAPTURE_REASON,
    JSON.stringify(
      {
        source: "browser_extension",
        capture_client: input.captureClient,
        extension_version: input.extensionVersion,
      },
      null,
      0,
    ),
    now,
  );
  const replay = importedExtensionManualCaptureResponse(db, itemId);
  if (replay) {
    return replay;
  }
  const dismissed = dismissedExtensionManualCaptureResponse(db, itemId);
  if (dismissed) {
    return dismissed;
  }
  return { itemId, sourceId: EXTENSION_MANUAL_CAPTURE_SOURCE_ID };
}

function extensionManualCaptureItemId(input: ExtensionCaptureIngestRequest): string {
  if (!input.captureId) {
    return `extension:${crypto.randomUUID()}`;
  }
  const digest = crypto.createHash("sha256").update(input.captureId).digest("hex").slice(0, 32);
  return `extension:${digest}`;
}

function dismissedExtensionManualCaptureResponse(
  db: SqliteDatabase,
  itemId: string,
): ExtensionCaptureIngestResponse | null {
  const row = getRow<ImportedManualCaptureRow>(
    db,
    `SELECT item_id, originating_url, source_id, reason, retry_context_json,
            required_at, status, imported_at, dismissed_at, capture_mode,
            captured_url, future_manual_action_required, job_key
     FROM manual_capture_queue
     WHERE tenant_id = ? AND item_id = ? AND status = 'dismissed'`,
    [DEFAULT_TENANT, itemId],
  );
  if (!row) {
    return null;
  }
  return {
    ok: true,
    itemId: row.item_id,
    jobKey: null,
    status: "dismissed",
    dismissedAt: optionalText(row.dismissed_at),
    message: "Capture was already dismissed in JobCtrl.",
  };
}

function importedExtensionManualCaptureResponse(
  db: SqliteDatabase,
  itemId: string,
): ManualCaptureImportResponse | null {
  const row = getRow<ImportedManualCaptureRow>(
    db,
    `SELECT item_id, originating_url, source_id, reason, retry_context_json,
            required_at, status, imported_at, capture_mode, captured_url,
            future_manual_action_required, job_key
     FROM manual_capture_queue
     WHERE tenant_id = ? AND item_id = ? AND status = 'imported'`,
    [DEFAULT_TENANT, itemId],
  );
  if (!row?.imported_at) {
    return null;
  }
  const retryContext = parseObject(row.retry_context_json);
  const provenance = parseObject(retryContext.manual_capture_provenance);
  const captureClient = optionalText(provenance.capture_client ?? provenance.captureClient);
  const extensionVersion = optionalText(provenance.extension_version ?? provenance.extensionVersion);
  return {
    ok: true,
    itemId: row.item_id,
    jobKey: optionalText(row.job_key) ?? optionalText(row.captured_url),
    importedAt: row.imported_at,
    provenance: {
      sourceKind: "user_mediated_capture",
      originatingUrl: optionalText(provenance.originating_url ?? provenance.originatingUrl) ?? row.originating_url,
      captureMode: manualCaptureMode(row.capture_mode),
      futureManualActionRequired: Boolean(row.future_manual_action_required),
      ...(captureClient ? { captureClient } : {}),
      ...(extensionVersion ? { extensionVersion } : {}),
    },
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

export function listRoleMatchFeedbackSuggestions(
  db: SqliteDatabase,
): RoleMatchFeedbackListResponse {
  ensureDiscoveryControlTables(db);
  refreshRoleMatchFeedbackSuggestions(db);
  const rows = allRows<RoleMatchFeedbackRow>(
    db,
    `SELECT tenant_id, suggestion_id, status, rule_kind, title_pattern,
            title_display, reason_code, reason, sample_count, source_ids_json,
            evidence_json, created_at, updated_at, decided_at, decision_reason
     FROM role_match_feedback_suggestions
     WHERE tenant_id = ?
     ORDER BY
       CASE status WHEN 'pending' THEN 0 WHEN 'approved' THEN 1 ELSE 2 END,
       sample_count DESC,
       updated_at DESC`,
    [DEFAULT_TENANT],
  );
  return { ok: true, suggestions: rows.map(rowToRoleMatchSuggestion) };
}

export function decideRoleMatchFeedbackSuggestion(
  db: SqliteDatabase,
  suggestionId: string,
  decision: RoleMatchFeedbackDecisionRequest,
): RoleMatchFeedbackDecisionResponse {
  ensureDiscoveryControlTables(db);
  refreshRoleMatchFeedbackSuggestions(db);
  const existing = getRoleMatchFeedbackRow(db, suggestionId);
  if (!existing) {
    throw new InputError(`Role-match feedback suggestion ${suggestionId} was not found.`);
  }
  const now = new Date().toISOString();
  const status = decision.decision === "approve" ? "approved" : "declined";
  db.prepare(
    `UPDATE role_match_feedback_suggestions
     SET status = ?, decision_reason = ?, decided_at = ?, updated_at = ?
     WHERE tenant_id = ? AND suggestion_id = ?`,
  ).run(status, decision.reason ?? null, now, now, DEFAULT_TENANT, suggestionId);
  const row = getRoleMatchFeedbackRow(db, suggestionId);
  if (!row) {
    throw new Error(`Unable to read role-match feedback suggestion ${suggestionId}.`);
  }
  return { ok: true, suggestion: rowToRoleMatchSuggestion(row) };
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
    `SELECT j.url AS job_url, o.observed_url, o.observed_at,
            j.title, j.site, j.location
     FROM job_source_observations o
     JOIN jobs j
       ON j.tenant_id = o.tenant_id
      AND j.job_id = o.job_id
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

function refreshRoleMatchFeedbackSuggestions(db: SqliteDatabase): void {
  const groups = lowScoreRoleMatchGroups(db);
  const now = new Date().toISOString();
  const upsert = db.prepare(
    `INSERT INTO role_match_feedback_suggestions (
       tenant_id, suggestion_id, status, rule_kind, title_pattern,
       title_display, reason_code, reason, sample_count, source_ids_json,
       evidence_json, created_at, updated_at
     ) VALUES (?, ?, 'pending', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(tenant_id, suggestion_id) DO UPDATE SET
       title_display = excluded.title_display,
       reason_code = excluded.reason_code,
       reason = excluded.reason,
       sample_count = excluded.sample_count,
       source_ids_json = excluded.source_ids_json,
       evidence_json = excluded.evidence_json,
       updated_at = excluded.updated_at`,
  );
  for (const group of groups.values()) {
    upsert.run(
      DEFAULT_TENANT,
      group.suggestionId,
      group.ruleKind,
      group.titlePattern,
      group.titleDisplay,
      group.reasonCode,
      group.reason,
      group.sampleCount,
      JSON.stringify(group.sourceIds),
      JSON.stringify(group.evidence),
      now,
      now,
    );
  }
}

function lowScoreRoleMatchGroups(db: SqliteDatabase): Map<string, RoleMatchFeedbackSuggestion> {
  const groups = new Map<string, RoleMatchFeedbackSuggestion>();
  const rows = lowScoreJobRows(db);
  const sourceByJobKey = latestSourceIdsByJobKey(db);
  for (const row of rows) {
    const evidence = roleMatchFeedbackEvidence(row, sourceByJobKey.get(row.job_key) ?? null);
    if (!evidence) {
      continue;
    }
    const titlePattern = normalizeTitlePattern(evidence.title);
    if (!titlePattern) {
      continue;
    }
    const suggestionId = `role-title-exclusion:${shortHash(titlePattern)}`;
    const sourceIds = evidence.sourceId ? [evidence.sourceId] : [];
    const existing = groups.get(suggestionId);
    if (existing) {
      existing.sampleCount += 1;
      existing.evidence.push(evidence);
      existing.sourceIds = [...new Set([...existing.sourceIds, ...sourceIds])].sort();
      if (evidence.scoredAt && (!existing.updatedAt || evidence.scoredAt > existing.updatedAt)) {
        existing.updatedAt = evidence.scoredAt;
      }
      continue;
    }
    groups.set(suggestionId, {
      suggestionId,
      status: "pending",
      ruleKind: "exact_title_exclusion",
      titlePattern,
      titleDisplay: evidence.title,
      reasonCode: roleMatchReasonCode(row),
      reason: evidence.reason,
      sampleCount: 1,
      sourceIds,
      evidence: [evidence],
      createdAt: evidence.scoredAt ?? new Date().toISOString(),
      updatedAt: evidence.scoredAt ?? new Date().toISOString(),
      decidedAt: null,
      decisionReason: null,
    });
  }
  for (const suggestion of groups.values()) {
    suggestion.evidence = suggestion.evidence
      .sort((left, right) => String(right.scoredAt ?? "").localeCompare(String(left.scoredAt ?? "")))
      .slice(0, 5);
  }
  return groups;
}

function lowScoreJobRows(db: SqliteDatabase): LowScoreJobRow[] {
  if (!tableExists(db, "jobs") || !tableExists(db, "job_scores")) {
    return [];
  }
  const columns = tableColumns(db, "jobs");
  const titleExpr = columns.has("title") ? "COALESCE(j.title, '')" : "''";
  const companyExpr = columns.has("company")
    ? "COALESCE(j.company, j.site, '')"
    : columns.has("site")
      ? "COALESCE(j.site, '')"
      : "''";
  const siteExpr = columns.has("site") ? "COALESCE(j.site, '')" : "''";
  const strategyExpr = columns.has("strategy") ? "COALESCE(j.strategy, '')" : "''";
  const scoreReference = jobReferenceColumn(db, "job_scores");
  const jobJoin = scoreReference === "job_id"
    ? "j.tenant_id = s.tenant_id AND j.job_id = s.job_id"
    : "j.tenant_id = s.tenant_id AND j.url = s.job_url";
  return allRows<LowScoreJobRow>(
    db,
    `WITH latest_scores AS (
       SELECT tenant_id, ${scoreReference}, MAX(version) AS version
       FROM job_scores
       WHERE tenant_id = ?
       GROUP BY tenant_id, ${scoreReference}
     )
     SELECT j.url AS job_key,
            ${titleExpr} AS title,
            ${companyExpr} AS company,
            ${siteExpr} AS site,
            ${strategyExpr} AS strategy,
            s.fit_score,
            s.breakdown_json,
            s.scored_at
     FROM latest_scores latest
     JOIN job_scores s
       ON s.tenant_id = latest.tenant_id
      AND s.${scoreReference} = latest.${scoreReference}
      AND s.version = latest.version
     JOIN jobs j ON ${jobJoin}
     WHERE s.tenant_id = ?
       AND s.fit_score <= 2
     ORDER BY s.scored_at DESC
     LIMIT 250`,
    [DEFAULT_TENANT, DEFAULT_TENANT],
  );
}

function latestSourceIdsByJobKey(db: SqliteDatabase): Map<string, string> {
  if (!tableExists(db, "job_source_observations")) {
    return new Map();
  }
  const rows = allRows<{ job_url: string; source_id: string }>(
    db,
    `SELECT j.url AS job_url, o.source_id
     FROM job_source_observations o
     JOIN jobs j
       ON j.tenant_id = o.tenant_id
      AND j.job_id = o.job_id
     WHERE o.tenant_id = ?
       AND o.source_id != ''
     ORDER BY o.observed_at DESC, o.source_observation_id DESC`,
    [DEFAULT_TENANT],
  );
  const result = new Map<string, string>();
  for (const row of rows) {
    if (!result.has(row.job_url)) {
      result.set(row.job_url, row.source_id);
    }
  }
  return result;
}

function roleMatchFeedbackEvidence(
  row: LowScoreJobRow,
  observedSourceId: string | null,
): RoleMatchFeedbackEvidence | null {
  const title = String(row.title ?? "").trim();
  if (!title || normalizeTitlePattern(title).split(" ").length < 2) {
    return null;
  }
  const breakdown = parseObject(row.breakdown_json);
  const roleFit = nullableNumber(breakdown.roleFit ?? breakdown.role_fit);
  const reasonText = scoreEvidenceText(breakdown);
  const hasRoleEvidence =
    (roleFit !== null && roleFit <= 2) ||
    /\b(role|title|seniority|domain|function|track|manager|management|engineering|technical|technology)\b/i.test(
      reasonText,
    );
  const hasOnlyNonRoleBlocker =
    !hasRoleEvidence &&
    /\b(location|remote|visa|sponsor|sponsorship|country|salary|compensation|language)\b/i.test(
      reasonText,
    );
  if (hasOnlyNonRoleBlocker || (!hasRoleEvidence && Number(row.fit_score) > 1)) {
    return null;
  }
  return {
    jobKey: row.job_key,
    title,
    company: String(row.company ?? "").trim(),
    sourceId: observedSourceId ?? inferredSourceId(row),
    fitScore: Number(row.fit_score),
    roleFit,
    reason:
      roleFit !== null && roleFit <= 2
        ? `Role fit is ${roleFit}/10 on a job scored ${row.fit_score}/10.`
        : `Job scored ${row.fit_score}/10 with role-matching evidence.`,
    scoredAt: row.scored_at ?? null,
  };
}

function roleMatchReasonCode(row: LowScoreJobRow): RoleMatchFeedbackReasonCode {
  const breakdown = parseObject(row.breakdown_json);
  const roleFit = nullableNumber(breakdown.roleFit ?? breakdown.role_fit);
  if (roleFit !== null && roleFit <= 2) {
    return "low_role_fit";
  }
  if (Number(row.fit_score) <= 1) {
    return "very_low_score";
  }
  return "role_mismatch_evidence";
}

function scoreEvidenceText(breakdown: Record<string, unknown>): string {
  const eligibility = parseObject(breakdown.eligibility);
  return [
    breakdown.reasoning,
    ...stringArray(breakdown.missingSignals ?? breakdown.missing_signals),
    ...stringArray(breakdown.matchedSignals ?? breakdown.matched_signals),
    ...stringArray(eligibility.hardBlockers ?? eligibility.hard_blockers),
    ...stringArray(eligibility.warnings),
  ]
    .map((value) => String(value ?? ""))
    .join(" ");
}

function inferredSourceId(row: LowScoreJobRow): string | null {
  const strategy = String(row.strategy ?? "").trim().toLowerCase();
  const site = String(row.site ?? "").trim().toLowerCase();
  if (strategy === "jobspy" && site) {
    return `jobspy:${slugText(site)}`;
  }
  return strategy ? strategy : null;
}

function getRoleMatchFeedbackRow(
  db: SqliteDatabase,
  suggestionId: string,
): RoleMatchFeedbackRow | undefined {
  return getRow<RoleMatchFeedbackRow>(
    db,
    `SELECT tenant_id, suggestion_id, status, rule_kind, title_pattern,
            title_display, reason_code, reason, sample_count, source_ids_json,
            evidence_json, created_at, updated_at, decided_at, decision_reason
     FROM role_match_feedback_suggestions
     WHERE tenant_id = ? AND suggestion_id = ?`,
    [DEFAULT_TENANT, suggestionId],
  );
}

function rowToRoleMatchSuggestion(row: RoleMatchFeedbackRow): RoleMatchFeedbackSuggestion {
  return {
    suggestionId: row.suggestion_id,
    status: roleMatchFeedbackStatus(row.status),
    ruleKind: roleMatchFeedbackRuleKind(row.rule_kind),
    titlePattern: row.title_pattern,
    titleDisplay: row.title_display,
    reasonCode: roleMatchFeedbackReasonCode(row.reason_code),
    reason: row.reason,
    sampleCount: Number(row.sample_count ?? 0),
    sourceIds: stringArrayJson(row.source_ids_json),
    evidence: evidenceArrayJson(row.evidence_json),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    decidedAt: row.decided_at,
    decisionReason: row.decision_reason,
  };
}

function rowToSourceSummary(
  row: SourceRegistryRow,
  stats: SourceQualityRow | undefined,
  politeness: SourcePolitenessOutcomes | undefined,
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
    politeness: politeness ?? emptyPolitenessOutcomes(),
    qualityTrend: "unknown",
  };
}

function qualityOnlySourceSummary(
  sourceId: string,
  stats: SourceQualityRow,
  politeness: SourcePolitenessOutcomes | undefined,
): SourceRegistryEntrySummary {
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
    politeness: politeness ?? emptyPolitenessOutcomes(),
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

function manualCaptureMode(value: string | null | undefined): ManualCaptureModeValue {
  return MANUAL_CAPTURE_MODE_VALUES.includes(value as ManualCaptureModeValue)
    ? (value as ManualCaptureModeValue)
    : "current_page";
}

function quarantineReason(value: string): QuarantineReason {
  return QUARANTINE_REASONS.includes(value as QuarantineReason)
    ? (value as QuarantineReason)
    : "user_review_requested";
}

function optionalText(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
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

function stringArray(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value
    .map((item) => String(item ?? "").trim())
    .filter(Boolean);
}

function stringArrayJson(raw: unknown): string[] {
  if (Array.isArray(raw)) {
    return stringArray(raw);
  }
  if (typeof raw !== "string") {
    return [];
  }
  try {
    return stringArray(JSON.parse(raw) as unknown);
  } catch {
    return [];
  }
}

function evidenceArrayJson(raw: unknown): RoleMatchFeedbackEvidence[] {
  const parsed = typeof raw === "string" ? safeJson(raw) : raw;
  if (!Array.isArray(parsed)) {
    return [];
  }
  return parsed
    .map((item) => parseObject(item))
    .map((item) => ({
      jobKey: String(item.jobKey ?? ""),
      title: String(item.title ?? ""),
      company: String(item.company ?? ""),
      sourceId: typeof item.sourceId === "string" ? item.sourceId : null,
      fitScore: Number(item.fitScore ?? 0),
      roleFit: nullableNumber(item.roleFit),
      reason: String(item.reason ?? ""),
      scoredAt: typeof item.scoredAt === "string" ? item.scoredAt : null,
    }))
    .filter((item) => item.jobKey && item.title);
}

function safeJson(raw: string): unknown {
  try {
    return JSON.parse(raw) as unknown;
  } catch {
    return null;
  }
}

function roleMatchFeedbackStatus(value: string): RoleMatchFeedbackStatus {
  if (value === "approved" || value === "declined") {
    return value;
  }
  return "pending";
}

function roleMatchFeedbackRuleKind(value: string): RoleMatchFeedbackRuleKind {
  return value === "exact_title_exclusion" ? value : "exact_title_exclusion";
}

function roleMatchFeedbackReasonCode(value: string): RoleMatchFeedbackReasonCode {
  if (value === "role_mismatch_evidence" || value === "very_low_score") {
    return value;
  }
  return "low_role_fit";
}

function normalizeTitlePattern(value: string): string {
  return String(value ?? "")
    .toLowerCase()
    .match(/[a-z0-9]+/g)
    ?.join(" ") ?? "";
}

function shortHash(value: string): string {
  return crypto.createHash("sha256").update(value).digest("hex").slice(0, 16);
}

function tableColumns(db: SqliteDatabase, tableName: string): Set<string> {
  return new Set(
    allRows<{ name: string }>(db, `PRAGMA table_info(${tableName})`).map((row) => row.name),
  );
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
