import type {
  MarketCompensationBenchmarkGeography,
  MarketCompensationBenchmarkLineage,
  MarketCompensationDirectBenchmarkInput,
  MarketCompensationPriceLevelInput,
} from "./contracts.js";
import { allRows, getRow, type SqliteDatabase } from "./db.js";

const CANONICAL_ESTIMATOR =
  /^company-role-reported-compensation-canonical-benchmark-v\d+:(direct|extrapolated):([a-f0-9-]{36})$/;
const FACT_ID =
  /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
const DIRECT_INPUT_ROLES = new Set<
  MarketCompensationDirectBenchmarkInput["inputRole"]
>([
  "anchor",
  "matched_company_source",
  "matched_company_target",
  "occupation_anchor",
]);
const PRICE_INPUT_ROLES = new Set<
  MarketCompensationPriceLevelInput["inputRole"]
>(["source_price_level", "target_price_level", "shrinkage_prior"]);
const SOURCE_PROVENANCE = new Set<
  MarketCompensationDirectBenchmarkInput["sourceProvenance"]
>(["public", "licensed", "manual", "official"]);
const PRICE_CATEGORIES = new Set<MarketCompensationPriceLevelInput["category"]>(
  [
    "actual_individual_consumption",
    "household_final_consumption",
    "general_price_level",
  ],
);
const PRICE_SOURCE_IDS = new Set<MarketCompensationPriceLevelInput["sourceId"]>(
  ["eurostat", "world_bank", "oecd", "manual_official"],
);
const UNSAFE_LINEAGE_TEXT =
  /(?:^|[\\/])(?:users?|home|tmp|private|volumes)(?:[\\/]|$)|file:\/\/|credential|secret|token|password|api[_ -]?key/i;

interface DirectFactRow extends Record<string, unknown> {
  fact_id: string;
  taxonomy_version: string;
  role_family_code: string;
  seniority_label: string;
  country_code: string;
  subdivision_code: string;
  locality: string;
  geography_scope: string;
  market_scope: string;
  normalized_company: string | null;
  component: "base_salary" | "total_compensation";
  eur_annual_minimum_amount: number;
  eur_annual_maximum_amount: number;
  confidence_score: number;
  sample_count: number;
  source_id: string;
  source_provenance: string;
  source_snapshot_id: string;
  as_of_date: string;
  fetched_at: string;
  fresh_until: string;
}

interface DirectInputRow extends DirectFactRow {
  input_role: string;
  input_weight: number;
}

interface PriceInputRow extends Record<string, unknown> {
  fact_id: string;
  input_role: string;
  input_weight: number;
  country_code: string;
  category: string;
  reference_year: number;
  base_geography_code: string;
  index_value: number;
  source_id: string;
  source_snapshot_id: string;
  as_of_date: string;
  fetched_at: string;
  fresh_until: string;
}

interface ExtrapolatedFactRow extends Record<string, unknown> {
  fact_id: string;
  anchor_direct_fact_id: string;
  taxonomy_version: string;
  role_family_code: string;
  seniority_label: string;
  target_country_code: string;
  target_subdivision_code: string;
  target_locality: string;
  target_geography_scope: string;
  component: "base_salary" | "total_compensation";
  extrapolation_method: string;
  raw_factor: number;
  shrinkage_weight: number;
  lower_factor_bound: number;
  upper_factor_bound: number;
  factor_bound_state: string;
  matched_company_count: number;
  formula_version: string;
  as_of_date: string;
  derived_at: string;
  fresh_until: string;
}

export function loadMarketCompensationBenchmarkLineage(
  db: SqliteDatabase,
  tenantId: string,
  estimatorVersion: string,
): MarketCompensationBenchmarkLineage | null {
  const reference = CANONICAL_ESTIMATOR.exec(estimatorVersion);
  if (!reference) return null;
  const kind = reference[1];
  const factId = reference[2];
  if (
    (kind !== "direct" && kind !== "extrapolated") ||
    !factId ||
    !FACT_ID.test(factId)
  )
    return null;

  try {
    if (kind === "direct") {
      const fact = loadDirectFact(db, tenantId, factId);
      if (!fact) return null;
      const targetGeography = benchmarkGeography(
        fact.country_code,
        fact.subdivision_code,
        fact.locality,
        fact.geography_scope,
      );
      const directInput = directBenchmarkInput(fact, "anchor", 1);
      if (!targetGeography || !directInput) return null;
      return {
        kind: "direct",
        factId: fact.fact_id,
        taxonomyVersion: safeText(fact.taxonomy_version) ?? "unknown",
        roleFamilyCode: safeText(fact.role_family_code) ?? "unknown",
        seniorityLabel: safeText(fact.seniority_label) ?? "unknown",
        targetGeography,
        component: fact.component,
        asOfDate: safeText(fact.as_of_date) ?? "unknown",
        observedAt: safeText(fact.fetched_at) ?? "unknown",
        freshUntil: safeText(fact.fresh_until) ?? "unknown",
        directInputs: [directInput],
        priceLevelInputs: [],
      };
    }

    const fact = getRow<ExtrapolatedFactRow>(
      db,
      `SELECT * FROM compensation_extrapolated_benchmark_facts
        WHERE tenant_id = ? AND fact_id = ?`,
      [tenantId, factId],
    );
    if (!fact || fact.extrapolation_method !== "evidence_weighted_shrinkage")
      return null;
    const targetGeography = benchmarkGeography(
      fact.target_country_code,
      fact.target_subdivision_code,
      fact.target_locality,
      fact.target_geography_scope,
    );
    if (!targetGeography) return null;

    const directRows = allRows<DirectInputRow>(
      db,
      `SELECT input.input_role, input.weight AS input_weight, direct.*
         FROM compensation_extrapolation_direct_inputs AS input
         JOIN compensation_direct_benchmark_facts AS direct
           ON direct.tenant_id = input.tenant_id
          AND direct.fact_id = input.direct_fact_id
        WHERE input.tenant_id = ? AND input.extrapolated_fact_id = ?
        ORDER BY input.input_role, input.direct_fact_id`,
      [tenantId, factId],
    );
    const directInputs = directRows
      .map((row) => directBenchmarkInput(row, row.input_role, row.input_weight))
      .filter(
        (row): row is MarketCompensationDirectBenchmarkInput => row !== null,
      );
    if (directInputs.length !== directRows.length) return null;

    const priceRows = allRows<PriceInputRow>(
      db,
      `SELECT input.input_role, input.weight AS input_weight, price.*
         FROM compensation_extrapolation_price_inputs AS input
         JOIN compensation_price_level_facts AS price
           ON price.tenant_id = input.tenant_id
          AND price.fact_id = input.price_level_fact_id
        WHERE input.tenant_id = ? AND input.extrapolated_fact_id = ?
        ORDER BY input.input_role, input.price_level_fact_id`,
      [tenantId, factId],
    );
    const priceLevelInputs = priceRows
      .map(priceLevelInput)
      .filter((row): row is MarketCompensationPriceLevelInput => row !== null);
    if (priceLevelInputs.length !== priceRows.length) return null;

    const anchor = directInputs.find(
      (input) =>
        input.inputRole === "anchor" &&
        input.factId === fact.anchor_direct_fact_id,
    );
    const factorBoundState = factorState(fact.factor_bound_state);
    if (!anchor || !factorBoundState) return null;

    return {
      kind: "extrapolated",
      factId: fact.fact_id,
      taxonomyVersion: safeText(fact.taxonomy_version) ?? "unknown",
      roleFamilyCode: safeText(fact.role_family_code) ?? "unknown",
      seniorityLabel: safeText(fact.seniority_label) ?? "unknown",
      targetGeography,
      component: fact.component,
      asOfDate: safeText(fact.as_of_date) ?? "unknown",
      observedAt: safeText(fact.derived_at) ?? "unknown",
      freshUntil: safeText(fact.fresh_until) ?? "unknown",
      directInputs,
      priceLevelInputs,
      anchorDirectFactId: fact.anchor_direct_fact_id,
      anchorGeography: anchor.geography,
      extrapolationMethod: "evidence_weighted_shrinkage",
      rawFactor: finiteNumber(fact.raw_factor),
      shrinkageWeight: finiteNumber(fact.shrinkage_weight),
      lowerFactorBound: finiteNumber(fact.lower_factor_bound),
      upperFactorBound: finiteNumber(fact.upper_factor_bound),
      factorBoundState,
      matchedCompanyCount: Math.max(
        0,
        Math.trunc(finiteNumber(fact.matched_company_count)),
      ),
      formulaVersion: safeText(fact.formula_version) ?? "unknown",
    };
  } catch {
    return null;
  }
}

function loadDirectFact(
  db: SqliteDatabase,
  tenantId: string,
  factId: string,
): DirectFactRow | null {
  return (
    getRow<DirectFactRow>(
      db,
      `SELECT * FROM compensation_direct_benchmark_facts
        WHERE tenant_id = ? AND fact_id = ?`,
      [tenantId, factId],
    ) ?? null
  );
}

function directBenchmarkInput(
  row: DirectFactRow,
  rawInputRole: string,
  rawWeight: number,
): MarketCompensationDirectBenchmarkInput | null {
  if (
    !DIRECT_INPUT_ROLES.has(
      rawInputRole as MarketCompensationDirectBenchmarkInput["inputRole"],
    )
  ) {
    return null;
  }
  if (
    !SOURCE_PROVENANCE.has(
      row.source_provenance as MarketCompensationDirectBenchmarkInput["sourceProvenance"],
    )
  ) {
    return null;
  }
  const geography = benchmarkGeography(
    row.country_code,
    row.subdivision_code,
    row.locality,
    row.geography_scope,
  );
  if (
    !geography ||
    !FACT_ID.test(row.fact_id) ||
    !["market", "company"].includes(row.market_scope)
  ) {
    return null;
  }
  return {
    factId: row.fact_id,
    inputRole:
      rawInputRole as MarketCompensationDirectBenchmarkInput["inputRole"],
    weight: finiteNumber(rawWeight),
    geography,
    marketScope:
      row.market_scope as MarketCompensationDirectBenchmarkInput["marketScope"],
    normalizedCompany: safeText(row.normalized_company),
    minimumAmountEur: Math.trunc(finiteNumber(row.eur_annual_minimum_amount)),
    maximumAmountEur: Math.trunc(finiteNumber(row.eur_annual_maximum_amount)),
    confidenceScore: finiteNumber(row.confidence_score),
    sampleCount: Math.max(0, Math.trunc(finiteNumber(row.sample_count))),
    sourceId: safeText(row.source_id) ?? "unknown",
    sourceProvenance:
      row.source_provenance as MarketCompensationDirectBenchmarkInput["sourceProvenance"],
    sourceSnapshotId: safeText(row.source_snapshot_id) ?? "unknown",
    asOfDate: safeText(row.as_of_date) ?? "unknown",
    fetchedAt: safeText(row.fetched_at) ?? "unknown",
    freshUntil: safeText(row.fresh_until) ?? "unknown",
  };
}

function priceLevelInput(
  row: PriceInputRow,
): MarketCompensationPriceLevelInput | null {
  if (
    !PRICE_INPUT_ROLES.has(
      row.input_role as MarketCompensationPriceLevelInput["inputRole"],
    )
  )
    return null;
  if (
    !PRICE_CATEGORIES.has(
      row.category as MarketCompensationPriceLevelInput["category"],
    )
  )
    return null;
  if (
    !PRICE_SOURCE_IDS.has(
      row.source_id as MarketCompensationPriceLevelInput["sourceId"],
    )
  )
    return null;
  if (!FACT_ID.test(row.fact_id) || !/^[A-Z]{2}$/.test(row.country_code))
    return null;
  return {
    factId: row.fact_id,
    inputRole: row.input_role as MarketCompensationPriceLevelInput["inputRole"],
    weight: finiteNumber(row.input_weight),
    countryCode: row.country_code,
    category: row.category as MarketCompensationPriceLevelInput["category"],
    referenceYear: Math.trunc(finiteNumber(row.reference_year)),
    baseGeographyCode: safeText(row.base_geography_code) ?? "unknown",
    indexValue: finiteNumber(row.index_value),
    sourceId: row.source_id as MarketCompensationPriceLevelInput["sourceId"],
    sourceSnapshotId: safeText(row.source_snapshot_id) ?? "unknown",
    asOfDate: safeText(row.as_of_date) ?? "unknown",
    fetchedAt: safeText(row.fetched_at) ?? "unknown",
    freshUntil: safeText(row.fresh_until) ?? "unknown",
  };
}

function benchmarkGeography(
  countryCode: string,
  subdivisionCode: string,
  locality: string,
  rawScope: string,
): MarketCompensationBenchmarkGeography | null {
  if (!/^[A-Z]{2}$/.test(countryCode)) return null;
  if (!["country", "country_subdivision", "locality"].includes(rawScope))
    return null;
  return {
    countryCode,
    subdivisionCode: safeText(subdivisionCode),
    locality: safeText(locality),
    scope: rawScope as MarketCompensationBenchmarkGeography["scope"],
  };
}

function factorState(
  value: string,
): "within_bounds" | "below_lower_bound" | "above_upper_bound" | null {
  return ["within_bounds", "below_lower_bound", "above_upper_bound"].includes(
    value,
  )
    ? (value as "within_bounds" | "below_lower_bound" | "above_upper_bound")
    : null;
}

function finiteNumber(value: unknown): number {
  const number = Number(value);
  return Number.isFinite(number) ? number : 0;
}

function safeText(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const text = value
    .replace(/[\u0000-\u001f\u007f]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (!text || UNSAFE_LINEAGE_TEXT.test(text)) return null;
  return text.length > 160 ? `${text.slice(0, 157).trimEnd()}...` : text;
}
