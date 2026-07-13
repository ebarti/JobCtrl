import fs from "node:fs";

import type {
  DashboardSettings,
  EffectiveDashboardSettings,
  EffectiveSetting,
} from "./contracts.js";

export const DEFAULT_DASHBOARD_SETTINGS: DashboardSettings = {
  targetRole: "",
  locationFilter: "",
  minFitScore: 7,
  autoApply: false,
  applyApprovalRequired: true,
  applyConcurrency: 1,
  workerActivitySlots: 4,
  dailyBudgetUsd: 25,
  analysisLegs: ["claude", "codex", "google"],
  tailoringGeneratorModels: null,
  tailoringJudgeModel: null,
  tailoringJudgeMinScore: 0.82,
  applyMaxBudgetUsd: 5,
  applyTimeoutSeconds: 900,
  scoreCriteria: "",
  targetCriteria: "",
  preferredModels: {},
};

type SettingsEnvironment = Readonly<Record<string, string | undefined>>;
export type EnvironmentManagedDashboardField =
  | "workerActivitySlots"
  | "analysisLegs"
  | "tailoringGeneratorModels"
  | "tailoringJudgeModel"
  | "tailoringJudgeMinScore"
  | "applyMaxBudgetUsd"
  | "applyTimeoutSeconds";

export interface ResolvedDashboardSettings {
  settings: DashboardSettings;
  effectiveSettings: EffectiveDashboardSettings;
}

export function readDashboardSettings(
  settingsPath: string,
  environment: SettingsEnvironment = process.env,
): ResolvedDashboardSettings {
  const raw = readSettingsObject(settingsPath);
  const dailyBudgetUsd = persistedNumber(
    raw,
    ["dailyBudgetUsd", "daily_budget_usd"],
    DEFAULT_DASHBOARD_SETTINGS.dailyBudgetUsd,
    0,
    Number.POSITIVE_INFINITY,
    "live",
  );
  const applyConcurrency = persistedInteger(
    raw,
    ["applyConcurrency", "apply_concurrency"],
    DEFAULT_DASHBOARD_SETTINGS.applyConcurrency,
    1,
    16,
    "next_poll",
  );
  const workerActivitySlots = resolveWorkerActivitySlots(raw, environment);
  const analysisLegs = resolveAnalysisLegs(raw, environment);
  const tailoringGeneratorModels = resolveNullableModels(
    raw,
    ["tailoringGeneratorModels", "tailoring_generator_models"],
    environment,
    ["TAILORING_GENERATOR_MODELS", "TAILORING_GENERATOR_MODEL", "TAILOR_LLM_MODELS"],
  );
  const tailoringJudgeModel = resolveNullableModel(
    raw,
    ["tailoringJudgeModel", "tailoring_judge_model"],
    environment,
    ["TAILORING_JUDGE_MODEL", "TAILOR_JUDGE_MODEL"],
  );
  const tailoringJudgeMinScore = resolveEnvironmentNumber(
    persistedNumber(raw, ["tailoringJudgeMinScore", "tailoring_judge_min_score"], 0.82, 0, 1, "next_workflow"),
    environment,
    ["TAILORING_JUDGE_MIN_SCORE", "TAILOR_JUDGE_MIN_SCORE"],
    0.82,
    0,
    1,
  );
  const applyMaxBudgetUsd = resolveEnvironmentNumber(
    persistedNumber(raw, ["applyMaxBudgetUsd", "apply_max_budget_usd"], 5, 0, Number.POSITIVE_INFINITY, "next_apply_job"),
    environment,
    ["JOBCTRL_APPLY_MAX_BUDGET_USD"],
    5,
    0,
    Number.POSITIVE_INFINITY,
  );
  const applyTimeoutSeconds = resolveEnvironmentInteger(
    persistedInteger(raw, ["applyTimeoutSeconds", "apply_timeout_seconds"], 900, 60, 3600, "next_apply_job"),
    environment,
    ["JOBCTRL_APPLY_TIMEOUT_SECONDS"],
    900,
    60,
    3600,
  );
  const scoreCriteria = persistedString(raw, ["scoreCriteria", "score_criteria"], "", "next_run");
  const targetCriteria = persistedString(raw, ["targetCriteria", "target_criteria"], "", "next_run");

  return {
    settings: {
      targetRole: normalizedText(raw.targetRole ?? raw.target_role, DEFAULT_DASHBOARD_SETTINGS.targetRole),
      locationFilter: normalizedText(
        raw.locationFilter ?? raw.location_filter,
        DEFAULT_DASHBOARD_SETTINGS.locationFilter,
      ),
      minFitScore: normalizedInteger(
        raw.minFitScore ?? raw.min_fit_score,
        DEFAULT_DASHBOARD_SETTINGS.minFitScore,
        0,
        10,
      ),
      autoApply: normalizedBoolean(raw.autoApply ?? raw.auto_apply, DEFAULT_DASHBOARD_SETTINGS.autoApply),
      applyApprovalRequired: normalizedBoolean(
        raw.applyApprovalRequired ?? raw.apply_approval_required,
        DEFAULT_DASHBOARD_SETTINGS.applyApprovalRequired,
      ),
      applyConcurrency: applyConcurrency.value,
      workerActivitySlots: workerActivitySlots.value,
      dailyBudgetUsd: dailyBudgetUsd.value,
      analysisLegs: analysisLegs.value,
      tailoringGeneratorModels: tailoringGeneratorModels.value,
      tailoringJudgeModel: tailoringJudgeModel.value,
      tailoringJudgeMinScore: tailoringJudgeMinScore.value,
      applyMaxBudgetUsd: applyMaxBudgetUsd.value,
      applyTimeoutSeconds: applyTimeoutSeconds.value,
      scoreCriteria: scoreCriteria.value,
      targetCriteria: targetCriteria.value,
      preferredModels: normalizedPreferredModels(raw.preferredModels ?? raw.preferred_models),
    },
    effectiveSettings: {
      dailyBudgetUsd,
      applyConcurrency,
      workerActivitySlots,
      analysisLegs,
      tailoringGeneratorModels,
      tailoringJudgeModel,
      tailoringJudgeMinScore,
      applyMaxBudgetUsd,
      applyTimeoutSeconds,
      scoreCriteria,
      targetCriteria,
    },
  };
}

export function workerActivitySlotsManagedByEnvironment(
  environment: SettingsEnvironment = process.env,
): boolean {
  return environment.JOBCTRL_MAX_CONCURRENT_ACTIVITIES?.trim() !== "" &&
    environment.JOBCTRL_MAX_CONCURRENT_ACTIVITIES !== undefined;
}

export function managedDashboardSetting(
  field: EnvironmentManagedDashboardField,
  environment: SettingsEnvironment = process.env,
): EffectiveSetting<unknown>["activation"] | null {
  const keys: Record<EnvironmentManagedDashboardField, readonly string[]> = {
    workerActivitySlots: ["JOBCTRL_MAX_CONCURRENT_ACTIVITIES"],
    analysisLegs: ["JOBCTRL_ANALYSIS_LEGS"],
    tailoringGeneratorModels: ["TAILORING_GENERATOR_MODELS", "TAILORING_GENERATOR_MODEL", "TAILOR_LLM_MODELS"],
    tailoringJudgeModel: ["TAILORING_JUDGE_MODEL", "TAILOR_JUDGE_MODEL"],
    tailoringJudgeMinScore: ["TAILORING_JUDGE_MIN_SCORE", "TAILOR_JUDGE_MIN_SCORE"],
    applyMaxBudgetUsd: ["JOBCTRL_APPLY_MAX_BUDGET_USD"],
    applyTimeoutSeconds: ["JOBCTRL_APPLY_TIMEOUT_SECONDS"],
  };
  const managed = keys[field].some((key) => Object.hasOwn(environment, key) && environment[key]?.trim() !== "");
  if (!managed) return null;
  if (field === "workerActivitySlots") return "restart";
  if (field === "analysisLegs") return "next_analysis";
  if (field.startsWith("apply")) return "next_apply_job";
  return "next_workflow";
}

function resolveWorkerActivitySlots(
  raw: Record<string, unknown>,
  environment: SettingsEnvironment,
): EffectiveSetting<number> {
  if (workerActivitySlotsManagedByEnvironment(environment)) {
    const configured = Number.parseInt(environment.JOBCTRL_MAX_CONCURRENT_ACTIVITIES ?? "", 10);
    return {
      value: Number.isFinite(configured)
        ? Math.max(1, configured)
        : DEFAULT_DASHBOARD_SETTINGS.workerActivitySlots,
      source: "environment",
      activation: "restart",
      editable: false,
    };
  }
  return persistedInteger(
    raw,
    ["workerActivitySlots", "worker_activity_slots"],
    DEFAULT_DASHBOARD_SETTINGS.workerActivitySlots,
    1,
    64,
    "restart",
  );
}

function resolveAnalysisLegs(
  raw: Record<string, unknown>,
  environment: SettingsEnvironment,
): EffectiveSetting<DashboardSettings["analysisLegs"]> {
  const selected = selectedValue(raw, ["analysisLegs", "analysis_legs"]);
  const persisted = normalizeAnalysisLegs(selected.value);
  const base: EffectiveSetting<DashboardSettings["analysisLegs"]> = selected.present && persisted
    ? { value: persisted, source: "persisted", activation: "next_analysis", editable: true }
    : { value: DEFAULT_DASHBOARD_SETTINGS.analysisLegs, source: "default", activation: "next_analysis", editable: true };
  if (!managedDashboardSetting("analysisLegs", environment)) return base;
  return {
    value: normalizeAnalysisLegs(environment.JOBCTRL_ANALYSIS_LEGS) ?? DEFAULT_DASHBOARD_SETTINGS.analysisLegs,
    source: "environment",
    activation: "next_analysis",
    editable: false,
  };
}

function resolveNullableModels(
  raw: Record<string, unknown>,
  persistedKeys: readonly string[],
  environment: SettingsEnvironment,
  environmentKeys: readonly string[],
): EffectiveSetting<string[] | null> {
  const selected = selectedValue(raw, persistedKeys);
  const persisted = normalizeModels(selected.value);
  const base: EffectiveSetting<string[] | null> = selected.present
    ? { value: persisted, source: "persisted", activation: "next_workflow", editable: true }
    : { value: null, source: "default", activation: "next_workflow", editable: true };
  const envValue = firstEnvironmentValue(environment, environmentKeys);
  if (envValue === undefined) return base;
  return { value: normalizeModels(envValue), source: "environment", activation: "next_workflow", editable: false };
}

function resolveNullableModel(
  raw: Record<string, unknown>,
  persistedKeys: readonly string[],
  environment: SettingsEnvironment,
  environmentKeys: readonly string[],
): EffectiveSetting<string | null> {
  const selected = selectedValue(raw, persistedKeys);
  const persisted = typeof selected.value === "string" ? selected.value.trim() || null : null;
  const base: EffectiveSetting<string | null> = selected.present
    ? { value: persisted, source: "persisted", activation: "next_workflow", editable: true }
    : { value: null, source: "default", activation: "next_workflow", editable: true };
  const envValue = firstEnvironmentValue(environment, environmentKeys);
  if (envValue === undefined) return base;
  return { value: envValue.trim() || null, source: "environment", activation: "next_workflow", editable: false };
}

function resolveEnvironmentNumber(
  base: EffectiveSetting<number>,
  environment: SettingsEnvironment,
  keys: readonly string[],
  fallback: number,
  minimum: number,
  maximum: number,
): EffectiveSetting<number> {
  const raw = firstEnvironmentValue(environment, keys);
  if (raw === undefined) return base;
  const parsed = Number(raw);
  const value = Number.isFinite(parsed) ? Math.min(maximum, Math.max(minimum, parsed)) : fallback;
  return { value, source: "environment", activation: base.activation, editable: false };
}

function resolveEnvironmentInteger(
  base: EffectiveSetting<number>,
  environment: SettingsEnvironment,
  keys: readonly string[],
  fallback: number,
  minimum: number,
  maximum: number,
): EffectiveSetting<number> {
  const raw = firstEnvironmentValue(environment, keys);
  if (raw === undefined) return base;
  const parsed = Number.parseInt(raw, 10);
  const value = Number.isFinite(parsed) ? Math.min(maximum, Math.max(minimum, parsed)) : fallback;
  return { value, source: "environment", activation: base.activation, editable: false };
}

function readSettingsObject(settingsPath: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(fs.readFileSync(settingsPath, "utf8")) as unknown;
    return isRecord(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

function persistedInteger(
  raw: Record<string, unknown>,
  keys: readonly string[],
  fallback: number,
  minimum: number,
  maximum: number,
  activation: EffectiveSetting<number>["activation"],
): EffectiveSetting<number> {
  const selected = selectedValue(raw, keys);
  const parsed = Number.parseInt(stringValue(selected.value), 10);
  if (!selected.present || !Number.isFinite(parsed)) {
    return { value: fallback, source: "default", activation, editable: true };
  }
  return {
    value: Math.min(maximum, Math.max(minimum, parsed)),
    source: "persisted",
    activation,
    editable: true,
  };
}

function persistedNumber(
  raw: Record<string, unknown>,
  keys: readonly string[],
  fallback: number,
  minimum: number,
  maximum: number,
  activation: EffectiveSetting<number>["activation"],
): EffectiveSetting<number> {
  const selected = selectedValue(raw, keys);
  const parsed = Number(selected.value);
  if (
    !selected.present ||
    selected.value === null ||
    selected.value === undefined ||
    (typeof selected.value === "string" && selected.value.trim() === "") ||
    !Number.isFinite(parsed)
  ) {
    return { value: fallback, source: "default", activation, editable: true };
  }
  return {
    value: Math.min(maximum, Math.max(minimum, parsed)),
    source: "persisted",
    activation,
    editable: true,
  };
}

function persistedString(
  raw: Record<string, unknown>,
  keys: readonly string[],
  fallback: string,
  activation: EffectiveSetting<string>["activation"],
): EffectiveSetting<string> {
  const selected = selectedValue(raw, keys);
  if (!selected.present || typeof selected.value !== "string") {
    return { value: fallback, source: "default", activation, editable: true };
  }
  return { value: selected.value.slice(0, 8000), source: "persisted", activation, editable: true };
}

function firstEnvironmentValue(
  environment: SettingsEnvironment,
  keys: readonly string[],
): string | undefined {
  for (const key of keys) {
    const value = environment[key];
    if (Object.hasOwn(environment, key) && value?.trim()) return value;
  }
  return undefined;
}

function normalizeModels(value: unknown): string[] | null {
  const values = Array.isArray(value)
    ? value
    : typeof value === "string"
      ? value.split(",")
      : [];
  const normalized = values
    .map((item) => String(item).trim())
    .filter((item, index, items) => item && item.length <= 160 && items.indexOf(item) === index);
  return normalized.length > 0 ? normalized : null;
}

function normalizeAnalysisLegs(value: unknown): DashboardSettings["analysisLegs"] | null {
  const values = Array.isArray(value)
    ? value
    : typeof value === "string"
      ? value.replaceAll(";", ",").replaceAll(" ", ",").split(",")
      : [];
  const aliases: Record<string, DashboardSettings["analysisLegs"][number]> = {
    claude: "claude",
    anthropic: "claude",
    codex: "codex",
    openai: "codex",
    google: "google",
    gemini: "google",
    antigravity: "google",
  };
  const normalized = values
    .map((item) => aliases[String(item).trim().toLowerCase()])
    .filter((item): item is DashboardSettings["analysisLegs"][number] => Boolean(item));
  return normalized.length > 0 ? [...new Set(normalized)] : null;
}

function selectedValue(
  raw: Record<string, unknown>,
  keys: readonly string[],
): { present: boolean; value: unknown } {
  for (const key of keys) {
    if (Object.prototype.hasOwnProperty.call(raw, key)) {
      return { present: true, value: raw[key] };
    }
  }
  return { present: false, value: undefined };
}

function normalizedText(value: unknown, fallback: string): string {
  const text = stringValue(value).trim();
  return text.length <= 160 ? text : fallback;
}

function normalizedInteger(
  value: unknown,
  fallback: number,
  minimum: number,
  maximum: number,
): number {
  const parsed = Number.parseInt(stringValue(value), 10);
  return Number.isFinite(parsed) ? Math.min(maximum, Math.max(minimum, parsed)) : fallback;
}

function normalizedBoolean(value: unknown, fallback: boolean): boolean {
  if (typeof value === "boolean") return value;
  if (typeof value === "number") return value !== 0;
  const normalized = stringValue(value).trim().toLowerCase();
  if (["1", "true", "yes", "on"].includes(normalized)) return true;
  if (["0", "false", "no", "off"].includes(normalized)) return false;
  return fallback;
}

function normalizedPreferredModels(value: unknown): DashboardSettings["preferredModels"] {
  if (!isRecord(value)) return {};
  const result: DashboardSettings["preferredModels"] = {};
  for (const provider of ["codex", "claude", "google"] as const) {
    const model = typeof value[provider] === "string" ? value[provider].trim() : "";
    if (model && model.length <= 160) result[provider] = model;
  }
  return result;
}

function stringValue(value: unknown): string {
  return value === null || value === undefined ? "" : String(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
