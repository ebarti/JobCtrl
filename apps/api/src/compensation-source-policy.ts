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
      levelsSource(env),
      glassdoorSource(env),
      manualReportedCompensationSource(),
      euroTopTechSource(),
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
    sourceType: "reported_compensation",
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
      "Automated access requires a permitted provider mode. Exported or licensed rows can be supplied to jobhunter compensation-refresh --observations-json.",
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
    sourceType: "reported_compensation",
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
      "Automated access requires partner API access or written permission. Exported or permitted rows can be supplied to jobhunter compensation-refresh --observations-json.",
    ],
  };
}

function manualReportedCompensationSource(): CompensationSourcePolicySummary {
  return {
    sourceId: "manual_reported_compensation",
    displayName: "Manual reported compensation import",
    sourceType: "reported_compensation",
    accessMode: "manual_import",
    availability: "available",
    licenseStatus: "not_required",
    termsUrl: null,
    sourceUrl: null,
    freshnessPolicy: "Uses the reported year/snapshot supplied in the local JSON import.",
    attributionRequirement: "Show as a manual reported-compensation import unless the row carries a provider attribution.",
    supportedFields: licensedBenchmarkFields(),
    disabledReason: null,
    configured: true,
    coverage: {
      geography: "import_file",
      regions: ["Europe", "configured import scope"],
      notes: "Coverage follows the rows supplied to the temporary compensation-refresh command.",
    },
    notes: ["Temporary local import path for reported company-role compensation rows."],
  };
}

function euroTopTechSource(): CompensationSourcePolicySummary {
  return {
    sourceId: "euro_top_tech",
    displayName: "Euro Top Tech",
    sourceType: "reported_compensation",
    accessMode: "public_dataset",
    availability: "available",
    licenseStatus: "not_required",
    termsUrl: "https://www.eurotoptech.com/terms",
    sourceUrl: "https://www.eurotoptech.com/data",
    freshnessPolicy: "Uses approved public data-entry rows exposed by Euro Top Tech at refresh time.",
    attributionRequirement: "Show as Euro Top Tech public crowdsourced compensation data.",
    supportedFields: ["total_compensation", "sample_count", "freshness", "attribution"],
    disabledReason: null,
    configured: true,
    coverage: {
      geography: "public_dataset",
      regions: ["Europe"],
      notes: "Coverage follows public approved Euro Top Tech data-entry rows.",
    },
    notes: ["Public crowdsourced compensation rows are loaded through the compensation refresh path."],
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
    value === "manual_import" ||
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
