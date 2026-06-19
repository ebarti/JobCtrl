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
  component: "base_salary" | "gross_annual_salary" | "gross_monthly_salary";
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
};

type MarketCompensationRecordedEstimateRow = MarketCompensationEstimateRow & {
  estimate_state: "unsupported" | "source_unavailable" | "insufficient_evidence" | "estimated_range";
};

const WARNING_MESSAGES: Record<MarketCompensationWarningCode, string> = {
  aggregate_baseline: "The market estimate is based on public occupation/location aggregate data.",
  broad_aggregate_band: "The public aggregate band is broad enough to reduce precision.",
  eu_wide_assumption: "The estimate uses an EU or Europe-wide aggregate assumption.",
  low_sample_count: "The public source sample support is low.",
  non_eu_europe_assumption: "The estimate uses a non-EU Europe aggregate assumption.",
  remote_europe_assumption: "The estimate maps a remote-Europe role to a Europe aggregate baseline.",
  source_conflict_with_posted_salary: "The public baseline diverges materially from the posted salary.",
  spain_local_assumption: "The estimate uses a Spain-local public wage baseline assumption.",
  stale_source_snapshot: "A source snapshot is stale under the freshness policy.",
  unknown_location_assumption: "The job location is not specific enough for a precise market mapping.",
};

const REASON_MESSAGES: Record<MarketCompensationReasonCode, string> = {
  low_sample_count: "Public source sample support is below the configured confidence threshold.",
  missing_occupation_mapping: "No supported ESCO occupation mapping was available.",
  missing_salary_observation: "No public wage baseline row was available for the mapped occupation/location.",
  source_dispersion_too_high: "Public source ranges diverged too much to emit a precise market range.",
  stale_source_snapshot: "A required public source snapshot is stale under the freshness policy.",
  unsupported_component: "The compensation component is outside the supported public wage baseline model.",
  unsupported_geography: "The job geography is outside the Europe-first source scope.",
  unsupported_source: "Unsupported source evidence was rejected.",
  weak_component_match: "Component compatibility was too weak for a range.",
  weak_geography_match: "Geography support was too weak for a range.",
  weak_occupation_match: "Occupation mapping support was too weak for a range.",
  weak_seniority_match: "Seniority support was too weak for a range.",
};

const SOURCE_IDS = new Set<MarketCompensationSourceId>([
  "eurostat_structure_of_earnings",
  "esco_occupation_taxonomy",
  "spain_ine_salary_structure",
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
    sourceType: "public_wage_baseline" | "occupation_taxonomy";
    snapshotVersion: string;
    geographyScope: string;
    aggregateBucket: string;
    attribution: string;
  }
> = {
  eurostat_structure_of_earnings: {
    displayName: "Eurostat Structure of Earnings Survey",
    sourceType: "public_wage_baseline",
    snapshotVersion: "synthetic-public-fixture",
    geographyScope: "EU",
    aggregateBucket: "Eurostat SES occupation/country aggregate",
    attribution: "Eurostat public statistical aggregate",
  },
  esco_occupation_taxonomy: {
    displayName: "ESCO occupation taxonomy",
    sourceType: "occupation_taxonomy",
    snapshotVersion: "synthetic-public-fixture",
    geographyScope: "Europe",
    aggregateBucket: "ESCO occupation mapping",
    attribution: "ESCO public occupation taxonomy",
  },
  spain_ine_salary_structure: {
    displayName: "Spain INE Wage Structure Survey",
    sourceType: "public_wage_baseline",
    snapshotVersion: "synthetic-public-fixture",
    geographyScope: "Spain",
    aggregateBucket: "Spain INE occupation aggregate",
    attribution: "Spain INE public statistical aggregate",
  },
};
const SAFE_AGGREGATE_BUCKETS = new Set(Object.values(SOURCE_DEFAULTS).map((source) => source.aggregateBucket));
const SAFE_GEOGRAPHY_SCOPES = new Set(["remote_europe", "spain", "eu_wide", "non_eu_europe", "unknown"]);
const FACTOR_NAMES = new Set<MarketCompensationFactorName>([
  "agreement",
  "component",
  "freshness",
  "geography",
  "occupation",
  "sample",
  "seniority",
]);
const DEFAULT_FACTOR_REASON = "Market estimate factor recorded by the deterministic Europe public estimator.";

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
  const row = getRow<MarketCompensationEstimateRow>(
    db,
    `
    SELECT tenant_id, job_url, estimate_state, currency, period, component,
           minimum_amount, maximum_amount, confidence_band, confidence_score,
           source_count, sample_count, aggregate_bucket, geography_scope,
           occupation_code, occupation_label, seniority_label, source_snapshot_json,
           factor_reasons_json, insufficient_reasons_json, unsupported_reasons_json,
           source_unavailable_reasons_json, warnings_json, estimator_version, estimated_at
    FROM job_market_compensation_estimates
    WHERE tenant_id = ? AND job_url = ?
    `,
    [DEFAULT_TENANT, jobKey],
  );
  if (!row) {
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
