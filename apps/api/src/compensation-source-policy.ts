import type {
  CompensationSourceAccessMode,
  CompensationSourcePolicySummary,
  CompensationSourceRegistryResponse,
  CompensationSupportedField,
} from "./contracts.js";

type EnvLike = Readonly<Record<string, string | undefined>>;

const LEVELS_ACCESS_MODES = new Set<CompensationSourceAccessMode>([
  "licensed_api",
  "licensed_data_feed",
  "enterprise_mcp",
]);
const GLASSDOOR_ACCESS_MODES = new Set<CompensationSourceAccessMode>([
  "partner_api",
  "written_permission",
]);
const TRUE_VALUES = new Set(["1", "true", "yes", "on"]);

export function listCompensationSources(
  env: EnvLike = process.env,
): CompensationSourceRegistryResponse {
  return {
    ok: true,
    sources: [
      postedSalarySource(),
      eurostatSource(),
      escoSource(),
      spainIneSource(),
      levelsSource(env),
      glassdoorSource(env),
    ],
  };
}

function postedSalarySource(): CompensationSourcePolicySummary {
  return {
    sourceId: "posted_salary_text",
    displayName: "Job posting salary text",
    sourceType: "posted_salary",
    accessMode: "local_posting_text",
    availability: "available",
    licenseStatus: "not_required",
    termsUrl: null,
    sourceUrl: null,
    freshnessPolicy: "Captured from the job posting at discovery/enrichment time.",
    attributionRequirement: "Show as employer-posted compensation text when present.",
    supportedFields: ["posted_range", "freshness", "attribution"],
    disabledReason: null,
    configured: true,
    coverage: {
      geography: "posting",
      regions: ["Europe"],
      notes: "Coverage follows the job posting location and text captured by JobHunter.",
    },
    notes: ["No external compensation provider is queried for this source."],
  };
}

function eurostatSource(): CompensationSourcePolicySummary {
  return {
    sourceId: "eurostat_structure_of_earnings",
    displayName: "Eurostat Structure of Earnings Survey",
    sourceType: "public_wage_baseline",
    accessMode: "public_dataset",
    availability: "available",
    licenseStatus: "not_required",
    termsUrl: "https://ec.europa.eu/eurostat/about-us/policies/copyright",
    sourceUrl: "https://ec.europa.eu/eurostat/web/microdata/structure-of-earnings-survey",
    freshnessPolicy: "Use the latest published Eurostat SES release available to the importer.",
    attributionRequirement: "Attribute Eurostat as the public statistical source.",
    supportedFields: [
      "base_salary",
      "gross_annual_salary",
      "gross_monthly_salary",
      "wage_percentiles",
      "sample_count",
      "freshness",
      "attribution",
    ],
    disabledReason: null,
    configured: true,
    coverage: {
      geography: "europe",
      regions: ["EU", "EEA", "candidate countries where published"],
      notes: "Europe-first public wage baseline for country and occupation level estimates.",
    },
    notes: ["Public statistical baseline; not employer-specific compensation intelligence."],
  };
}

function escoSource(): CompensationSourcePolicySummary {
  return {
    sourceId: "esco_occupation_taxonomy",
    displayName: "ESCO occupation taxonomy",
    sourceType: "occupation_taxonomy",
    accessMode: "public_taxonomy",
    availability: "available",
    licenseStatus: "not_required",
    termsUrl: "https://esco.ec.europa.eu/en/about-esco/terms-use",
    sourceUrl: "https://esco.ec.europa.eu/en",
    freshnessPolicy: "Use the latest published ESCO taxonomy snapshot available to the importer.",
    attributionRequirement: "Attribute ESCO when occupation mappings are displayed.",
    supportedFields: ["occupation_mapping", "freshness", "attribution"],
    disabledReason: null,
    configured: true,
    coverage: {
      geography: "europe",
      regions: ["Europe"],
      notes: "Occupation mapping baseline for normalizing European job titles.",
    },
    notes: ["Taxonomy source only; it does not provide salary observations."],
  };
}

function spainIneSource(): CompensationSourcePolicySummary {
  return {
    sourceId: "spain_ine_salary_structure",
    displayName: "Spain INE salary structure survey",
    sourceType: "public_wage_baseline",
    accessMode: "public_dataset",
    availability: "available",
    licenseStatus: "not_required",
    termsUrl: "https://www.ine.es/aviso_legal",
    sourceUrl: "https://www.ine.es/en/prensa/ees_en.htm",
    freshnessPolicy: "Use the latest published INE salary structure survey available to the importer.",
    attributionRequirement: "Attribute INE as the public statistical source for Spain-specific rows.",
    supportedFields: [
      "base_salary",
      "gross_annual_salary",
      "gross_monthly_salary",
      "wage_percentiles",
      "sample_count",
      "freshness",
      "attribution",
    ],
    disabledReason: null,
    configured: true,
    coverage: {
      geography: "spain",
      regions: ["Spain"],
      notes: "Spain-specific public wage baseline for Spanish target locations.",
    },
    notes: ["Public statistical baseline; not company-specific compensation intelligence."],
  };
}

function levelsSource(env: EnvLike): CompensationSourcePolicySummary {
  const accessMode = normalizeAccessMode(env["JOBHUNTER_LEVELS_FYI_ACCESS_MODE"]);
  const accessPermitted = accessMode ? LEVELS_ACCESS_MODES.has(accessMode) : false;
  const europeCoverageConfirmed = isTrue(env["JOBHUNTER_LEVELS_FYI_EUROPE_COVERAGE"]);
  const available = accessPermitted && europeCoverageConfirmed;
  const disabledReason = levelsDisabledReason(accessMode, accessPermitted, europeCoverageConfirmed);
  const reportedAccessMode: CompensationSourceAccessMode =
    accessPermitted && accessMode ? accessMode : "unavailable_until_permitted";

  return {
    sourceId: "levels_fyi",
    displayName: "Levels.fyi",
    sourceType: "licensed_market_benchmark",
    accessMode: reportedAccessMode,
    availability: available ? "available" : "unavailable",
    licenseStatus: available ? "permitted" : "requires_license",
    termsUrl: "https://www.levels.fyi/offerings/data/",
    sourceUrl: "https://www.levels.fyi/",
    freshnessPolicy: available
      ? "Use only the freshness window provided by the licensed data agreement."
      : "Unavailable until permitted access and Europe coverage are explicitly configured.",
    attributionRequirement: available
      ? "Follow the active licensed data agreement."
      : "Do not display imported Levels.fyi compensation data.",
    supportedFields: available ? licensedBenchmarkFields() : [],
    disabledReason,
    configured: available,
    coverage: {
      geography: "licensed_provider_configured",
      regions: europeCoverageConfirmed ? ["Europe"] : [],
      notes: europeCoverageConfirmed
        ? "Europe coverage has been explicitly configured."
        : "Europe coverage is not configured.",
    },
    notes: [
      "Policy seam only; no Levels.fyi fetch, scrape, cache, credential, or salary import path is registered here.",
    ],
  };
}

function glassdoorSource(env: EnvLike): CompensationSourcePolicySummary {
  const accessMode = normalizeAccessMode(env["JOBHUNTER_GLASSDOOR_ACCESS_MODE"]);
  const available = accessMode ? GLASSDOOR_ACCESS_MODES.has(accessMode) : false;
  const disabledReason = glassdoorDisabledReason(accessMode, available);
  const reportedAccessMode: CompensationSourceAccessMode =
    available && accessMode ? accessMode : "unavailable_until_permitted";

  return {
    sourceId: "glassdoor",
    displayName: "Glassdoor",
    sourceType: "licensed_market_benchmark",
    accessMode: reportedAccessMode,
    availability: available ? "available" : "unavailable",
    licenseStatus: available ? "permitted" : "requires_permission",
    termsUrl: "https://www.glassdoor.com/about/terms/",
    sourceUrl: "https://www.glassdoor.com/",
    freshnessPolicy: available
      ? "Use only the freshness window allowed by the active partner or written-permission agreement."
      : "Unavailable until partner API or written permission is configured.",
    attributionRequirement: available
      ? "Follow the active partner or written-permission agreement."
      : "Do not display imported Glassdoor compensation data.",
    supportedFields: available ? licensedBenchmarkFields() : [],
    disabledReason,
    configured: available,
    coverage: {
      geography: "licensed_provider_configured",
      regions: available ? ["configured agreement scope"] : [],
      notes: available
        ? "Coverage is limited to the active permission scope."
        : "Coverage is not configured.",
    },
    notes: [
      "Policy seam only; no Glassdoor fetch, scrape, cache, credential, or salary import path is registered here.",
    ],
  };
}

function licensedBenchmarkFields(): CompensationSupportedField[] {
  return [
    "base_salary",
    "market_range",
    "total_compensation",
    "sample_count",
    "freshness",
    "attribution",
  ];
}

function normalizeAccessMode(value: string | undefined): CompensationSourceAccessMode | null {
  const normalized = value?.trim().toLowerCase();
  if (!normalized) {
    return null;
  }
  return isCompensationSourceAccessMode(normalized) ? normalized : null;
}

function isCompensationSourceAccessMode(value: string): value is CompensationSourceAccessMode {
  return (
    value === "local_posting_text" ||
    value === "public_dataset" ||
    value === "public_taxonomy" ||
    value === "licensed_api" ||
    value === "licensed_data_feed" ||
    value === "enterprise_mcp" ||
    value === "partner_api" ||
    value === "written_permission" ||
    value === "unavailable_until_permitted"
  );
}

function isTrue(value: string | undefined): boolean {
  return TRUE_VALUES.has(value?.trim().toLowerCase() ?? "");
}

function levelsDisabledReason(
  accessMode: CompensationSourceAccessMode | null,
  accessPermitted: boolean,
  europeCoverageConfirmed: boolean,
): string | null {
  if (accessPermitted && europeCoverageConfirmed) {
    return null;
  }
  if (!accessMode) {
    return "Requires licensed Levels.fyi access mode and explicit Europe coverage confirmation.";
  }
  if (!accessPermitted) {
    return "Configured Levels.fyi access mode is not permitted for compensation import.";
  }
  return "Requires explicit Levels.fyi Europe coverage confirmation.";
}

function glassdoorDisabledReason(
  accessMode: CompensationSourceAccessMode | null,
  accessPermitted: boolean,
): string | null {
  if (accessPermitted) {
    return null;
  }
  if (!accessMode) {
    return "Requires Glassdoor partner API access or written permission.";
  }
  return "Configured Glassdoor access mode is not permitted for compensation import.";
}
