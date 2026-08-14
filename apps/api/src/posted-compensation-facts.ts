import type {
  PostedCompensationFact,
  PostedCompensationFactResponse,
  PostedCompensationWarning,
  PostedCompensationWarningCode,
} from "./contracts.js";
import { getRow, type SqliteDatabase } from "./db.js";

type JobSalaryRow = {
  job_id: string;
  url: string;
  salary: string | null;
};

type PostedCompensationFactRow = {
  tenant_id: string;
  job_id: string;
  source_field: string;
  source_text: string | null;
  legacy_raw_salary: string | null;
  parse_state: "missing" | "unparseable" | "ambiguous" | "parsed_range";
  currency: string | null;
  period: "hour" | "month" | "year" | "unknown";
  component:
    | "base_salary"
    | "ote"
    | "bonus"
    | "commission"
    | "equity"
    | "unknown";
  minimum_amount: number | null;
  maximum_amount: number | null;
  annualized_minimum_amount: number | null;
  annualized_maximum_amount: number | null;
  annualization_assumption: string | null;
  confidence: "none" | "low" | "medium" | "high";
  warnings_json: string;
  parser_version: string;
  source_hash: string;
  parsed_at: string;
};

const WARNING_MESSAGES: Record<PostedCompensationWarningCode, string> = {
  annual_period_inferred:
    "The posting states a high-value salary without a shorter pay period, so JobCtrl treats it as annual.",
  ambiguous_multiple_amounts:
    "Multiple compensation amounts were present and the primary range is ambiguous.",
  bonus_component: "The source text mentions bonus compensation.",
  broad_range: "The posted range is broad enough to reduce precision.",
  commission_component: "The source text mentions commission compensation.",
  equity_component:
    "The posting mentions stock or equity compensation; review the amount type below.",
  hourly_period: "The source text uses an hourly compensation period.",
  missing_currency: "The parser could not identify an explicit currency.",
  missing_period:
    "The parser could not identify an explicit compensation period.",
  monthly_period: "The source text uses a monthly compensation period.",
  no_amount_found: "No compensation amount could be safely extracted.",
  one_sided_range: "The posted range is one-sided.",
  ote_component: "The source text mentions on-target earnings.",
  source_text_truncated:
    "Only a bounded posting excerpt is stored; the excerpt below shows exactly what was parsed.",
};

export function getPostedCompensationFact(
  db: SqliteDatabase,
  tenantId: string,
  jobId: string,
): PostedCompensationFactResponse | null {
  const job = getRow<JobSalaryRow>(
    db,
    "SELECT job_id, url, salary FROM jobs WHERE tenant_id = ? AND job_id = ?",
    [tenantId, jobId],
  );
  if (!job) {
    return null;
  }
  const row = getRow<PostedCompensationFactRow>(
    db,
    `
    SELECT tenant_id, job_id, source_field, source_text, legacy_raw_salary,
           parse_state, currency, period, component, minimum_amount,
           maximum_amount, annualized_minimum_amount, annualized_maximum_amount,
           annualization_assumption, confidence, warnings_json, parser_version,
           source_hash, parsed_at
    FROM job_posted_compensation_facts
    WHERE tenant_id = ? AND job_id = ?
    `,
    [tenantId, jobId],
  );
  if (!row) {
    return notRecorded(job);
  }
  return {
    ok: true,
    recordStatus: "recorded",
    fact: mapFactRow(row),
  };
}

function notRecorded(job: JobSalaryRow): PostedCompensationFactResponse {
  return {
    ok: true,
    recordStatus: "not_recorded",
    jobKey: job.job_id,
    legacyRawSalary: nullableText(job.salary),
  };
}

function mapFactRow(row: PostedCompensationFactRow): PostedCompensationFact {
  const base = {
    tenantId: row.tenant_id,
    jobKey: row.job_id,
    sourceField: row.source_field,
    legacyRawSalary: nullableText(row.legacy_raw_salary),
    parserVersion: row.parser_version,
    sourceHash: row.source_hash,
    parsedAt: row.parsed_at,
    warnings: parseWarnings(row.warnings_json),
  };

  if (row.parse_state === "missing") {
    return {
      ...base,
      parseState: "missing",
      sourceText: null,
      confidence: "none",
    };
  }
  if (row.parse_state === "unparseable") {
    return {
      ...base,
      parseState: "unparseable",
      sourceText: row.source_text ?? "",
      confidence: "low",
    };
  }
  if (row.parse_state === "ambiguous") {
    return {
      ...base,
      parseState: "ambiguous",
      sourceText: row.source_text ?? "",
      confidence: row.confidence === "medium" ? "medium" : "low",
    };
  }
  return {
    ...base,
    parseState: "parsed_range",
    sourceText: row.source_text ?? "",
    currency: nullableText(row.currency),
    period: row.period,
    component: row.component,
    minimumAmount: nullableNumber(row.minimum_amount),
    maximumAmount: nullableNumber(row.maximum_amount),
    annualizedMinimumAmount: nullableNumber(row.annualized_minimum_amount),
    annualizedMaximumAmount: nullableNumber(row.annualized_maximum_amount),
    annualizationAssumption: nullableText(row.annualization_assumption),
    confidence:
      row.confidence === "high" || row.confidence === "medium"
        ? row.confidence
        : "low",
  };
}

function parseWarnings(value: string): PostedCompensationWarning[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(value || "[]");
  } catch {
    parsed = [];
  }
  if (!Array.isArray(parsed)) {
    return [];
  }
  return parsed
    .filter((entry): entry is PostedCompensationWarningCode =>
      isWarningCode(entry),
    )
    .map((code) => ({ code, message: WARNING_MESSAGES[code] }));
}

function isWarningCode(value: unknown): value is PostedCompensationWarningCode {
  return typeof value === "string" && Object.hasOwn(WARNING_MESSAGES, value);
}

function nullableText(value: string | null | undefined): string | null {
  if (value === undefined || value === null) {
    return null;
  }
  const trimmed = value.trim();
  return trimmed ? trimmed : null;
}

function nullableNumber(value: number | null | undefined): number | null {
  return value === undefined || value === null ? null : Number(value);
}
