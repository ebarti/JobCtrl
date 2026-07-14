import type {
  CompensationSourceAccessMode,
  CompensationSourcePolicyUpdateRequest,
  CompensationSourcePolicySummary,
  CompensationSourceRegistryResponse,
  CompensationSupportedField,
} from "./contracts.js";
import {
  ConfigFileInputError,
  isRecord,
  readConfigObject,
  updateConfigObject,
} from "./config-file.js";
import {
  GLASSDOOR_COMPENSATION_ACCESS_MODES,
  LEVELS_FYI_COMPENSATION_ACCESS_MODES,
} from "./contracts.js";

interface StoredCompensationSourcePreference {
  enabled: boolean;
  accessMode: CompensationSourceAccessMode | null;
  europeCoverageConfirmed: boolean;
}

interface CompensationSourcePreferences {
  levels_fyi?: StoredCompensationSourcePreference;
  glassdoor?: StoredCompensationSourcePreference;
}

const LEVELS_ACCESS_MODES = new Set<CompensationSourceAccessMode>(
  LEVELS_FYI_COMPENSATION_ACCESS_MODES,
);
const GLASSDOOR_ACCESS_MODES = new Set<CompensationSourceAccessMode>(
  GLASSDOOR_COMPENSATION_ACCESS_MODES,
);
const TRUE_VALUES = new Set(["1", "true", "yes", "on"]);

export function listCompensationSources(
  preferences: CompensationSourcePreferences = {},
): CompensationSourceRegistryResponse {
  return {
    ok: true,
    sources: [
      postedSalarySource(),
      levelsSource(preferences.levels_fyi),
      glassdoorSource(preferences.glassdoor),
      manualReportedCompensationSource(),
      euroTopTechSource(),
    ],
  };
}

export class CompensationSourcePolicyInputError extends Error {}

export function readCompensationSourcePreferences(
  configPath: string,
): CompensationSourcePreferences {
  let settings: Record<string, unknown>;
  try {
    settings = readConfigObject(configPath);
  } catch (error) {
    if (error instanceof ConfigFileInputError) {
      return {};
    }
    throw error;
  }
  const rawSources = isRecord(settings["compensation_sources"])
    ? settings["compensation_sources"]
    : {};
  const levels = parseStoredPreference(
    rawSources["levels_fyi"],
    LEVELS_ACCESS_MODES,
    true,
  );
  const glassdoor = parseStoredPreference(
    rawSources["glassdoor"],
    GLASSDOOR_ACCESS_MODES,
    false,
  );
  return {
    ...(levels ? { levels_fyi: levels } : {}),
    ...(glassdoor ? { glassdoor } : {}),
  };
}

export function updateCompensationSourcePolicy(
  configPath: string,
  request: CompensationSourcePolicyUpdateRequest,
): CompensationSourceRegistryResponse {
  try {
    updateConfigObject(configPath, (settings) => {
      const currentSources = isRecord(settings["compensation_sources"])
        ? settings["compensation_sources"]
        : {};
      const nextSources: Record<string, unknown> = { ...currentSources };
      nextSources[request.sourceId] =
        request.sourceId === "levels_fyi"
          ? {
              enabled: request.enabled,
              access_mode: request.accessMode,
              europe_coverage_confirmed: request.europeCoverageConfirmed,
            }
          : {
              enabled: request.enabled,
              access_mode: request.accessMode,
            };
      settings["compensation_sources"] = nextSources;
    });
  } catch (error) {
    if (error instanceof ConfigFileInputError) {
      throw new CompensationSourcePolicyInputError(error.message);
    }
    throw error;
  }
  return listCompensationSources(readCompensationSourcePreferences(configPath));
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
    control: { kind: "fixed", enabled: true },
    coverage: {
      geography: "posting",
      regions: ["Europe"],
      notes: "Coverage follows the job posting location and text captured by JobCtrl.",
    },
    notes: ["No external compensation provider is queried for this source."],
  };
}

function levelsSource(
  preference: StoredCompensationSourcePreference | undefined,
): CompensationSourcePolicySummary {
  // Public provider-authored Markdown is the safe, tokenless default access
  // basis. It remains disabled until the user opts in, but does not pretend a
  // commercial license is required merely because no preference is stored.
  const accessMode = preference?.accessMode ?? "public_markdown";
  const enabled = preference?.enabled ?? false;
  const accessPermitted = accessMode ? LEVELS_ACCESS_MODES.has(accessMode) : false;
  const publicMarkdown = accessMode === "public_markdown";
  const europeCoverageConfirmed = preference?.europeCoverageConfirmed ?? false;
  const available =
    enabled &&
    accessPermitted &&
    (publicMarkdown || europeCoverageConfirmed);
  const disabledReason =
    !enabled
      ? "Disabled in Compensation sources settings."
      : levelsDisabledReason(
          accessMode,
          accessPermitted,
          europeCoverageConfirmed,
        );
  const reportedAccessMode: CompensationSourceAccessMode =
    accessPermitted && accessMode ? accessMode : "unavailable_until_permitted";

  return {
    sourceId: "levels_fyi",
    displayName: "Levels.fyi",
    sourceType: "reported_compensation",
    accessMode: reportedAccessMode,
    availability: available ? "available" : "unavailable",
    licenseStatus: accessPermitted ? "permitted" : "requires_license",
    termsUrl: "https://www.levels.fyi/about/terms.html",
    sourceUrl: "https://www.levels.fyi/llms.txt",
    freshnessPolicy: available
      ? publicMarkdown
        ? "Reads the provider-published public salary page during compensation refresh."
        : "Use only the freshness window provided by the licensed data agreement."
      : "Disabled until the user enables this source in Compensation sources settings.",
    attributionRequirement: available
      ? publicMarkdown
        ? "Display Data source: Levels.fyi (https://www.levels.fyi) and preserve the canonical page URL."
        : "Follow the active licensed data agreement."
      : "Do not display Levels.fyi compensation data until the source is enabled.",
    supportedFields: available
      ? publicMarkdown
        ? publicLevelsFields()
        : licensedBenchmarkFields()
      : [],
    disabledReason,
    configured: available,
    control: {
      kind: "user_preference",
      enabled,
      accessMode: accessPermitted && accessMode ? accessMode : null,
      allowedAccessModes: [...LEVELS_FYI_COMPENSATION_ACCESS_MODES],
      europeCoverageRequired: !publicMarkdown,
      europeCoverageConfirmed,
    },
    coverage: {
      geography: publicMarkdown
        ? "job_matched_public_pages"
        : "licensed_provider_configured",
      regions: available
        ? publicMarkdown
          ? ["job-matched locations"]
          : ["Europe"]
        : [],
      notes: publicMarkdown
        ? "Coverage follows public Levels.fyi pages matched to current job roles and locations."
        : europeCoverageConfirmed
          ? "Europe coverage has been explicitly configured."
          : "Europe coverage is not configured.",
    },
    notes: [
      publicMarkdown
        ? "Refresh reads tokenless provider-published Markdown pages and falls back to the same public page's structured data when needed."
        : "Refresh automatically loads configured licensed rows from JOBCTRL_LEVELS_FYI_OBSERVATIONS_PATH or JOBCTRL_LEVELS_FYI_OBSERVATIONS_URL when access is permitted.",
    ],
  };
}

function glassdoorSource(
  preference: StoredCompensationSourcePreference | undefined,
): CompensationSourcePolicySummary {
  const accessMode = preference?.accessMode ?? null;
  const enabled = preference?.enabled ?? false;
  const accessPermitted = accessMode
    ? GLASSDOOR_ACCESS_MODES.has(accessMode)
    : false;
  const available = enabled && accessPermitted;
  const disabledReason =
    preference && !enabled
      ? "Disabled by the user in Compensation sources settings."
      : glassdoorDisabledReason(accessMode, accessPermitted);
  const reportedAccessMode: CompensationSourceAccessMode =
    accessPermitted && accessMode ? accessMode : "unavailable_until_permitted";

  return {
    sourceId: "glassdoor",
    displayName: "Glassdoor",
    sourceType: "reported_compensation",
    accessMode: reportedAccessMode,
    availability: available ? "available" : "unavailable",
    licenseStatus: accessPermitted ? "permitted" : "requires_permission",
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
    control: {
      kind: "user_preference",
      enabled,
      accessMode: accessPermitted && accessMode ? accessMode : null,
      allowedAccessModes: [...GLASSDOOR_COMPENSATION_ACCESS_MODES],
      europeCoverageRequired: false,
      europeCoverageConfirmed: false,
    },
    coverage: {
      geography: "licensed_provider_configured",
      regions: available ? ["configured agreement scope"] : [],
      notes: available
        ? "Coverage is limited to the active permission scope."
        : "Coverage is not configured.",
    },
    notes: [
      "Refresh automatically loads configured permitted rows from JOBCTRL_GLASSDOOR_OBSERVATIONS_PATH or JOBCTRL_GLASSDOOR_OBSERVATIONS_URL when access is permitted.",
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
    control: { kind: "fixed", enabled: true },
    coverage: {
      geography: "import_file",
      regions: ["Europe", "configured import scope"],
      notes: "Coverage follows the rows supplied to the temporary compensation-refresh command.",
    },
    notes: ["Explicit local imports are additive with configured licensed sources and Euro Top Tech refresh data."],
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
    control: { kind: "fixed", enabled: true },
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

function publicLevelsFields(): CompensationSupportedField[] {
  return [
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
    value === "public_markdown" ||
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

function parseStoredPreference(
  value: unknown,
  permittedModes: ReadonlySet<CompensationSourceAccessMode>,
  hasEuropeCoverage: boolean,
): StoredCompensationSourcePreference | null {
  if (!isRecord(value) || typeof value["enabled"] !== "boolean") {
    return null;
  }
  const rawAccessMode = normalizeAccessMode(
    stringValue(value["access_mode"] ?? value["accessMode"]),
  );
  return {
    enabled: value["enabled"],
    accessMode:
      rawAccessMode && permittedModes.has(rawAccessMode)
        ? rawAccessMode
        : null,
    europeCoverageConfirmed: hasEuropeCoverage
      ? booleanValue(
          value["europe_coverage_confirmed"] ??
            value["europeCoverageConfirmed"],
        )
      : false,
  };
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function booleanValue(value: unknown): boolean {
  if (typeof value === "boolean") {
    return value;
  }
  return isTrue(stringValue(value));
}

function levelsDisabledReason(
  accessMode: CompensationSourceAccessMode | null,
  accessPermitted: boolean,
  europeCoverageConfirmed: boolean,
): string | null {
  if (accessMode === "public_markdown") {
    return null;
  }
  if (accessPermitted && europeCoverageConfirmed) {
    return null;
  }
  if (!accessMode) {
    return "Choose public Markdown or a licensed Levels.fyi access mode.";
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
