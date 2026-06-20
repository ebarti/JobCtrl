import type {
  MarketCompensationEstimate,
  MarketCompensationEstimateResponse,
  MarketCompensationFactor,
  MarketCompensationFactorName,
  MarketCompensationReason,
  MarketCompensationReasonCode,
  MarketCompensationSourceId,
  MarketCompensationSourceSnapshot,
  MarketCompensationWarning,
  MarketCompensationWarningCode,
} from "./contracts.js";
import { getRow, tableExists, type SqliteDatabase } from "./db.js";

const DEFAULT_TENANT = "local";

type JobRow = {
  url: string;
};

type MarketCompensationEstimateRow = {
  tenant_id: string;
  job_url: string;
  estimate_state: string;
  currency: string | null;
  period: "year" | "month";
  component: "base_salary" | "total_compensation";
  minimum_amount: number | null;
  maximum_amount: number | null;
  confidence_band: "none" | "low" | "medium" | "high";
  confidence_score: number;
  source_count: number;
  sample_count: number | null;
  aggregate_bucket: string | null;
  geography_scope: string | null;
  occupation_code: string | null;
  occupation_label: string | null;
  seniority_label: string | null;
  source_snapshot_json: string;
  factor_reasons_json: string;
  insufficient_reasons_json: string;
  unsupported_reasons_json: string;
  source_unavailable_reasons_json: string;
  warnings_json: string;
  estimator_version: string;
  estimated_at: string;
  company_name: string | null;
  normalized_company: string | null;
  role_title: string | null;
  normalized_role: string | null;
  company_tier: "tier_1_local" | "tier_2_ambitious" | "tier_3_top_of_market" | "unknown";
  match_scope: "exact_company_role" | "company_adjacent_role" | "tier_role_fallback" | "none";
};

type MarketCompensationRecordedEstimateRow = MarketCompensationEstimateRow & {
  estimate_state: "unsupported" | "source_unavailable" | "insufficient_evidence" | "estimated_range";
};

const WARNING_MESSAGES: Record<MarketCompensationWarningCode, string> = {
  company_role_fallback: "The estimate fell back from exact company-role evidence to adjacent company or tier evidence.",
  location_mismatch: "Reported compensation locations did not strongly match the job location.",
  low_sample_count: "Reported compensation sample support is low.",
  reported_compensation_sample: "The estimate uses reported compensation rows for the job company and role.",
  source_conflict_with_posted_salary: "Reported compensation diverges materially from the posted salary.",
  stale_source_snapshot: "A reported compensation source snapshot is stale under the freshness policy.",
  trimodal_tier_inferred: "The company tier was inferred from reported compensation amounts.",
};

const REASON_MESSAGES: Record<MarketCompensationReasonCode, string> = {
  low_sample_count: "Reported compensation sample support is below the configured confidence threshold.",
  missing_company: "The job has no company name to match reported compensation.",
  missing_reported_observation: "No reported compensation row matched this job's company and role.",
  missing_role: "The job has no title/role text to match reported compensation.",
  source_dispersion_too_high: "Reported compensation rows diverged too much to emit a precise range.",
  stale_source_snapshot: "A required reported compensation source snapshot is stale under the freshness policy.",
  unsupported_component: "The compensation component is outside the supported reported compensation model.",
  unsupported_source: "Unsupported source evidence was rejected.",
  weak_company_match: "Company match support was too weak for a range.",
  weak_level_match: "Level/seniority support was too weak for a range.",
  weak_location_match: "Location support was too weak for a range.",
  weak_role_match: "Role match support was too weak for a range.",
};

const SOURCE_IDS = new Set<MarketCompensationSourceId>([
  "levels_fyi",
  "glassdoor",
  "manual_reported_compensation",
]);
const RECORDED_ESTIMATE_STATES = new Set([
  "unsupported",
  "source_unavailable",
  "insufficient_evidence",
  "estimated_range",
]);
const SOURCE_DEFAULTS: Record<
  MarketCompensationSourceId,
  {
    displayName: string;
    sourceType: "reported_compensation";
    snapshotVersion: string;
    geographyScope: string;
    aggregateBucket: string;
    attribution: string;
  }
> = {
  levels_fyi: {
    displayName: "Levels.fyi",
    sourceType: "reported_compensation",
    snapshotVersion: "reported-compensation-import-v1",
    geographyScope: "reported",
    aggregateBucket: "reported company-role compensation",
    attribution: "Levels.fyi reported compensation data",
  },
  glassdoor: {
    displayName: "Glassdoor",
    sourceType: "reported_compensation",
    snapshotVersion: "reported-compensation-import-v1",
    geographyScope: "reported",
    aggregateBucket: "reported company-role compensation",
    attribution: "Glassdoor reported compensation data",
  },
  manual_reported_compensation: {
    displayName: "Manual reported compensation import",
    sourceType: "reported_compensation",
    snapshotVersion: "reported-compensation-import-v1",
    geographyScope: "reported",
    aggregateBucket: "reported company-role compensation",
    attribution: "Manual reported compensation import",
  },
};
const SAFE_AGGREGATE_BUCKETS = new Set([
  ...Object.values(SOURCE_DEFAULTS).map((source) => source.aggregateBucket),
  "reported company adjacent-role compensation",
  "trimodal tier role fallback",
]);
const SAFE_GEOGRAPHY_SCOPES = new Set(["Europe", "reported"]);
const FACTOR_NAMES = new Set<MarketCompensationFactorName>([
  "agreement",
  "company",
  "component",
  "freshness",
  "level",
  "location",
  "role",
  "sample",
  "trimodal_tier",
]);
const DEFAULT_FACTOR_REASON = "Reported compensation estimate factor recorded by the deterministic company-role estimator.";

export function getMarketCompensationEstimate(
  db: SqliteDatabase,
  jobKey: string,
): MarketCompensationEstimateResponse | null {
  const job = getRow<JobRow>(db, "SELECT url FROM jobs WHERE url = ?", [jobKey]);
  if (!job) {
    return null;
  }
  if (!tableExists(db, "job_market_compensation_estimates")) {
    return notRequested(job);
  }
  const tableColumns = columnsFor(db, "job_market_compensation_estimates");
  const row = getRow<MarketCompensationEstimateRow>(
    db,
    `
    SELECT tenant_id, job_url, estimate_state, currency, period, component,
           minimum_amount, maximum_amount, confidence_band, confidence_score,
           source_count, sample_count, aggregate_bucket, geography_scope,
           occupation_code, occupation_label, seniority_label, source_snapshot_json,
           factor_reasons_json, insufficient_reasons_json, unsupported_reasons_json,
           source_unavailable_reasons_json, warnings_json, estimator_version, estimated_at,
           ${columnOrNull(tableColumns, "company_name")} AS company_name,
           ${columnOrNull(tableColumns, "normalized_company")} AS normalized_company,
           ${columnOrNull(tableColumns, "role_title")} AS role_title,
           ${columnOrNull(tableColumns, "normalized_role")} AS normalized_role,
           ${columnOrDefault(tableColumns, "company_tier", "unknown")} AS company_tier,
           ${columnOrDefault(tableColumns, "match_scope", "none")} AS match_scope
    FROM job_market_compensation_estimates
    WHERE tenant_id = ? AND job_url = ?
    `,
    [DEFAULT_TENANT, jobKey],
  );
  if (!row) {
    return notRequested(job);
  }
  if (!row.estimator_version.startsWith("company-role-reported-compensation-")) {
    return notRequested(job);
  }
  if (!isRecordedEstimateRow(row)) {
    return notRequested(job);
  }
  return {
    ok: true,
    recordStatus: "recorded",
    estimate: mapEstimateRow(row),
  };
}

function isRecordedEstimateRow(row: MarketCompensationEstimateRow): row is MarketCompensationRecordedEstimateRow {
  return RECORDED_ESTIMATE_STATES.has(row.estimate_state);
}

function notRequested(job: JobRow): MarketCompensationEstimateResponse {
  return {
    ok: true,
    recordStatus: "not_requested",
    jobKey: job.url,
  };
}

function mapEstimateRow(row: MarketCompensationRecordedEstimateRow): MarketCompensationEstimate {
  const sources = parseSources(row.source_snapshot_json);
  const base = {
    tenantId: row.tenant_id,
    jobKey: row.job_url,
    estimateState: row.estimate_state,
    confidenceBand: row.confidence_band,
    confidenceScore: Number(row.confidence_score ?? 0),
    sourceCount: Number(row.source_count ?? 0),
    sampleCount: nullableNumber(row.sample_count),
    aggregateBucket: safeAggregateBucket(row.aggregate_bucket, sources),
    geographyScope: safeGeographyScope(row.geography_scope),
    occupationCode: nullableText(row.occupation_code),
    occupationLabel: nullableText(row.occupation_label),
    seniorityLabel: nullableText(row.seniority_label),
    companyName: nullableText(row.company_name),
    normalizedCompany: nullableText(row.normalized_company),
    roleTitle: nullableText(row.role_title),
    normalizedRole: nullableText(row.normalized_role),
    companyTier: companyTier(row.company_tier),
    matchScope: matchScope(row.match_scope),
    sources,
    factors: parseFactors(row.factor_reasons_json),
    warnings: parseWarnings(row.warnings_json),
    estimatorVersion: row.estimator_version,
    estimatedAt: row.estimated_at,
  };

  if (row.estimate_state === "unsupported") {
    return {
      ...base,
      estimateState: "unsupported",
      unsupportedReasons: parseReasons(row.unsupported_reasons_json),
    };
  }
  if (row.estimate_state === "source_unavailable") {
    return {
      ...base,
      estimateState: "source_unavailable",
      sourceUnavailableReasons: parseReasons(row.source_unavailable_reasons_json),
    };
  }
  if (row.estimate_state === "insufficient_evidence") {
    return {
      ...base,
      estimateState: "insufficient_evidence",
      insufficientReasons: parseReasons(row.insufficient_reasons_json),
    };
  }
  return {
    ...base,
    estimateState: "estimated_range",
    currency: nullableText(row.currency) ?? "EUR",
    period: row.period,
    component: row.component,
    minimumAmount: nullableNumber(row.minimum_amount) ?? 0,
    maximumAmount: nullableNumber(row.maximum_amount) ?? 0,
  };
}

function parseWarnings(value: string): MarketCompensationWarning[] {
  return parseStringList(value)
    .filter((entry): entry is MarketCompensationWarningCode => Object.hasOwn(WARNING_MESSAGES, entry))
    .map((code) => ({ code, message: WARNING_MESSAGES[code] }));
}

function parseReasons(value: string): MarketCompensationReason[] {
  return parseStringList(value)
    .filter((entry): entry is MarketCompensationReasonCode => Object.hasOwn(REASON_MESSAGES, entry))
    .map((code) => ({ code, message: REASON_MESSAGES[code] }));
}

function parseFactors(value: string): MarketCompensationFactor[] {
  return parseObjects(value)
    .map((entry) => {
      const name = stringValue(entry.name);
      if (!FACTOR_NAMES.has(name as MarketCompensationFactorName)) return null;
      return {
        name: name as MarketCompensationFactorName,
        score: numberValue(entry.score),
        band: confidenceBand(entry.band),
        reason: DEFAULT_FACTOR_REASON,
      };
    })
    .filter((entry): entry is MarketCompensationFactor => entry !== null);
}

function parseSources(value: string): MarketCompensationSourceSnapshot[] {
  return parseObjects(value)
    .map((entry) => {
      const sourceId = stringValue(entry.source_id);
      const sourceType = stringValue(entry.source_type);
      if (!SOURCE_IDS.has(sourceId as MarketCompensationSourceId)) return null;
      const typedSourceId = sourceId as MarketCompensationSourceId;
      const defaults = SOURCE_DEFAULTS[typedSourceId];
      if (sourceType !== defaults.sourceType) return null;
      return {
        sourceId: typedSourceId,
        displayName: defaults.displayName,
        sourceType: defaults.sourceType,
        releaseYear: nullableNumber(entry.release_year),
        snapshotVersion: defaults.snapshotVersion,
        geographyScope: defaults.geographyScope,
        aggregateBucket: defaults.aggregateBucket,
        attribution: defaults.attribution,
        sampleCount: nullableNumber(entry.sample_count),
      };
    })
    .filter((entry): entry is MarketCompensationSourceSnapshot => entry !== null);
}

function parseStringList(value: string): string[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(value || "[]");
  } catch {
    parsed = [];
  }
  if (!Array.isArray(parsed)) {
    return [];
  }
  return parsed.filter((entry): entry is string => typeof entry === "string");
}

function parseObjects(value: string): Array<Record<string, unknown>> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(value || "[]");
  } catch {
    parsed = [];
  }
  if (!Array.isArray(parsed)) {
    return [];
  }
  return parsed.filter((entry): entry is Record<string, unknown> => entry !== null && typeof entry === "object");
}

function confidenceBand(value: unknown): "none" | "low" | "medium" | "high" {
  return value === "high" || value === "medium" || value === "low" ? value : "none";
}

function stringValue(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function nullableText(value: string | null | undefined): string | null {
  if (value === undefined || value === null) {
    return null;
  }
  const trimmed = value.trim();
  return trimmed ? trimmed : null;
}

function safeAggregateBucket(
  value: string | null | undefined,
  sources: MarketCompensationSourceSnapshot[],
): string | null {
  const text = nullableText(value);
  if (text && SAFE_AGGREGATE_BUCKETS.has(text)) {
    return text;
  }
  const buckets = Array.from(new Set(sources.map((source) => source.aggregateBucket)));
  return buckets.length ? buckets.join(", ") : null;
}

function safeGeographyScope(value: string | null | undefined): string | null {
  const text = nullableText(value);
  return text && SAFE_GEOGRAPHY_SCOPES.has(text) ? text : null;
}

function companyTier(value: unknown): "tier_1_local" | "tier_2_ambitious" | "tier_3_top_of_market" | "unknown" {
  return value === "tier_1_local" || value === "tier_2_ambitious" || value === "tier_3_top_of_market"
    ? value
    : "unknown";
}

function matchScope(value: unknown): "exact_company_role" | "company_adjacent_role" | "tier_role_fallback" | "none" {
  return value === "exact_company_role" || value === "company_adjacent_role" || value === "tier_role_fallback"
    ? value
    : "none";
}

function columnsFor(db: SqliteDatabase, tableName: string): Set<string> {
  const rows = db.prepare(`PRAGMA table_info(${tableName})`).all() as Array<{ name: string }>;
  return new Set(rows.map((row) => row.name));
}

function columnOrNull(columns: Set<string>, columnName: string): string {
  return columns.has(columnName) ? columnName : "NULL";
}

function columnOrDefault(columns: Set<string>, columnName: string, fallback: string): string {
  return columns.has(columnName) ? columnName : `'${fallback}'`;
}

function nullableNumber(value: unknown): number | null {
  if (value === undefined || value === null || value === "") {
    return null;
  }
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function numberValue(value: unknown): number {
  const number = Number(value);
  return Number.isFinite(number) ? number : 0;
}
