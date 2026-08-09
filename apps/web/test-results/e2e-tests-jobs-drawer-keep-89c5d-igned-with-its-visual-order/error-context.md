# Instructions

- Following Playwright test failed.
- Explain why, be concise, respect Playwright best practices.
- Provide a snippet of code with the fix, if possible.

# Test info

- Name: e2e/tests/jobs-drawer.spec.ts >> keeps the job detail header Tab order aligned with its visual order
- Location: e2e/tests/jobs-drawer.spec.ts:490:1

# Error details

```
Error: JOBCTRL_E2E_DB_PATH is required for Jobs compensation e2e data.
```

# Test source

```ts
  1   | import Database from "better-sqlite3";
  2   | import { test, expect, type Locator, type Page } from "@playwright/test";
  3   | 
  4   | import { QA_PLATFORM_JOB_ID } from "../fixtures/e2e-state.js";
  5   | 
  6   | const FILTER_PARAMS =
  7   |   "stage=all&state=all&deleted=active&sort=fit_score&dir=desc&page=1&pageSize=50";
  8   | const PLATFORM_JOB_TITLE = "Director of Platform Engineering";
  9   | // Pending-preparation pickup is an existing non-apply Jobs behavior; Phase 22 blocks apply/material/Gmail/destructive paths.
  10  | const PROHIBITED_PRODUCT_PATH_REQUESTS = [
  11  |   /\/v1\/jobs\/.+\/actions\/apply$/i,
  12  |   /\/v1\/jobs\/.+\/actions\/generate-materials$/i,
  13  |   /\/v1\/jobs\/.+\/actions\/generate-interview-prep$/i,
  14  |   /\/v1\/jobs\/.+\/actions\/tailor$/i,
  15  |   /\/v1\/jobs\/.+\/actions\/retailor-current-policy$/i,
  16  |   /\/v1\/jobs\/.+\/actions\/run-stage$/i,
  17  |   /\/v1\/jobs\/.+\/actions\/retry-stage$/i,
  18  |   /\/v1\/jobs\/bulk-(?:delete|delete-permanent|restore|hide|unhide|retry-failed)$/i,
  19  |   /\/v1\/pipeline\/actions\/run-stage$/i,
  20  |   /\/v1\/materials\/actions\/retailor-current-policy$/i,
  21  |   /\/v1\/outcomes\/gmail\/scan$/i,
  22  |   /\/v1\/profile\/import-resume$/i,
  23  |   /\/v1\/_internal\/rpc$/i,
  24  | ] as const;
  25  | 
  26  | test.beforeEach(() => {
  27  |   seedSyntheticCompensationData();
  28  | });
  29  | 
  30  | function watchProhibitedProductPathRequests(page: Page): string[] {
  31  |   const prohibitedRequests: string[] = [];
  32  |   page.on("request", (request) => {
  33  |     if (["GET", "HEAD", "OPTIONS"].includes(request.method())) return;
  34  |     const pathname = new URL(request.url()).pathname;
  35  |     if (
  36  |       PROHIBITED_PRODUCT_PATH_REQUESTS.some((pattern) => pattern.test(pathname))
  37  |     ) {
  38  |       prohibitedRequests.push(`${request.method()} ${pathname}`);
  39  |     }
  40  |   });
  41  |   return prohibitedRequests;
  42  | }
  43  | 
  44  | function seedSyntheticCompensationData(): void {
  45  |   const dbPath = process.env["JOBCTRL_E2E_DB_PATH"];
  46  |   if (!dbPath) {
> 47  |     throw new Error(
      |           ^ Error: JOBCTRL_E2E_DB_PATH is required for Jobs compensation e2e data.
  48  |       "JOBCTRL_E2E_DB_PATH is required for Jobs compensation e2e data.",
  49  |     );
  50  |   }
  51  |   const db = new Database(dbPath);
  52  |   try {
  53  |     db.prepare("UPDATE jobs SET salary = ? WHERE tenant_id = ? AND job_id = ?").run(
  54  |       "€55,000/year",
  55  |       "local",
  56  |       QA_PLATFORM_JOB_ID,
  57  |     );
  58  |     db.prepare(
  59  |       `INSERT INTO job_posted_compensation_facts (
  60  |         tenant_id, job_id, source_field, source_text, legacy_raw_salary,
  61  |         parse_state, currency, period, component, minimum_amount, maximum_amount,
  62  |         annualized_minimum_amount, annualized_maximum_amount, annualization_assumption,
  63  |         confidence, warnings_json, parser_version, source_hash, parsed_at
  64  |       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  65  |       ON CONFLICT(tenant_id, job_id) DO UPDATE SET
  66  |         source_text = excluded.source_text,
  67  |         legacy_raw_salary = excluded.legacy_raw_salary,
  68  |         parse_state = excluded.parse_state,
  69  |         currency = excluded.currency,
  70  |         period = excluded.period,
  71  |         component = excluded.component,
  72  |         minimum_amount = excluded.minimum_amount,
  73  |         maximum_amount = excluded.maximum_amount,
  74  |         annualized_minimum_amount = excluded.annualized_minimum_amount,
  75  |         annualized_maximum_amount = excluded.annualized_maximum_amount,
  76  |         annualization_assumption = excluded.annualization_assumption,
  77  |         confidence = excluded.confidence,
  78  |         warnings_json = excluded.warnings_json,
  79  |         parser_version = excluded.parser_version,
  80  |         source_hash = excluded.source_hash,
  81  |         parsed_at = excluded.parsed_at`,
  82  |     ).run(
  83  |       "local",
  84  |       QA_PLATFORM_JOB_ID,
  85  |       "jobs.salary",
  86  |       "€55,000/year",
  87  |       "€55,000/year",
  88  |       "parsed_range",
  89  |       "EUR",
  90  |       "year",
  91  |       "base_salary",
  92  |       55_000,
  93  |       55_000,
  94  |       55_000,
  95  |       55_000,
  96  |       "Source text states annual compensation.",
  97  |       "high",
  98  |       "[]",
  99  |       "posted-compensation-v1",
  100 |       "e2e".padEnd(64, "0"),
  101 |       "2026-06-19T10:00:00Z",
  102 |     );
  103 |     db.prepare(
  104 |       `INSERT INTO job_market_compensation_estimates (
  105 |         tenant_id, job_id, estimate_state, currency, period, component,
  106 |         minimum_amount, maximum_amount, confidence_band, confidence_score,
  107 |         source_count, sample_count, aggregate_bucket, geography_scope,
  108 |         occupation_code, occupation_label, seniority_label, source_snapshot_json,
  109 |         factor_reasons_json, insufficient_reasons_json, unsupported_reasons_json,
  110 |         source_unavailable_reasons_json, warnings_json, estimator_version, estimated_at,
  111 |         company_name, normalized_company, role_title, normalized_role, company_tier, match_scope
  112 |       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  113 |       ON CONFLICT(tenant_id, job_id) DO UPDATE SET
  114 |         estimate_state = excluded.estimate_state,
  115 |         currency = excluded.currency,
  116 |         period = excluded.period,
  117 |         component = excluded.component,
  118 |         minimum_amount = excluded.minimum_amount,
  119 |         maximum_amount = excluded.maximum_amount,
  120 |         confidence_band = excluded.confidence_band,
  121 |         confidence_score = excluded.confidence_score,
  122 |         source_count = excluded.source_count,
  123 |         sample_count = excluded.sample_count,
  124 |         aggregate_bucket = excluded.aggregate_bucket,
  125 |         geography_scope = excluded.geography_scope,
  126 |         source_snapshot_json = excluded.source_snapshot_json,
  127 |         factor_reasons_json = excluded.factor_reasons_json,
  128 |         warnings_json = excluded.warnings_json,
  129 |         estimator_version = excluded.estimator_version,
  130 |         estimated_at = excluded.estimated_at,
  131 |         company_name = excluded.company_name,
  132 |         normalized_company = excluded.normalized_company,
  133 |         role_title = excluded.role_title,
  134 |         normalized_role = excluded.normalized_role,
  135 |         company_tier = excluded.company_tier,
  136 |         match_scope = excluded.match_scope`,
  137 |     ).run(
  138 |       "local",
  139 |       QA_PLATFORM_JOB_ID,
  140 |       "estimated_range",
  141 |       "EUR",
  142 |       "year",
  143 |       "total_compensation",
  144 |       112_000,
  145 |       142_000,
  146 |       "medium",
  147 |       0.82,
```