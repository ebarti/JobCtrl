import type {
  EffectiveJobCtrlSettings,
  EffectiveSetting,
  JobCtrlSettings,
} from "./contracts.js";
import { isRecord, readConfigObject } from "./config-file.js";

export const DEFAULT_JOBCTRL_SETTINGS: JobCtrlSettings = {
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

export interface ResolvedJobCtrlSettings {
  settings: JobCtrlSettings;
  effectiveSettings: EffectiveJobCtrlSettings;
}

export function readJobCtrlSettings(configPath: string): ResolvedJobCtrlSettings {
  const raw = readConfigObject(configPath);
  const dailyBudgetUsd = persistedNumber(
    raw,
    "daily_budget_usd",
    DEFAULT_JOBCTRL_SETTINGS.dailyBudgetUsd,
    0,
    Number.POSITIVE_INFINITY,
    "live",
  );
  const applyConcurrency = persistedInteger(
    raw,
    "apply_concurrency",
    DEFAULT_JOBCTRL_SETTINGS.applyConcurrency,
    1,
    16,
    "next_poll",
  );
  const workerActivitySlots = persistedInteger(
    raw,
    "worker_activity_slots",
    DEFAULT_JOBCTRL_SETTINGS.workerActivitySlots,
    1,
    64,
    "restart",
  );
  const analysisLegs = persistedAnalysisLegs(raw);
  const tailoringGeneratorModels = persistedModels(raw, "tailoring_generator_models");
  const tailoringJudgeModel = persistedNullableModel(raw, "tailoring_judge_model");
  const tailoringJudgeMinScore = persistedNumber(
    raw,
    "tailoring_judge_min_score",
    DEFAULT_JOBCTRL_SETTINGS.tailoringJudgeMinScore,
    0,
    1,
    "next_workflow",
  );
  const applyMaxBudgetUsd = persistedNumber(
    raw,
    "apply_max_budget_usd",
    DEFAULT_JOBCTRL_SETTINGS.applyMaxBudgetUsd,
    0,
    Number.POSITIVE_INFINITY,
    "next_apply_job",
  );
  const applyTimeoutSeconds = persistedInteger(
    raw,
    "apply_timeout_seconds",
    DEFAULT_JOBCTRL_SETTINGS.applyTimeoutSeconds,
    60,
    3600,
    "next_apply_job",
  );
  const scoreCriteria = persistedString(raw, "score_criteria", "", "next_run");
  const targetCriteria = persistedString(raw, "target_criteria", "", "next_run");

  return {
    settings: {
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
      preferredModels: normalizedPreferredModels(raw.preferred_models),
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

function persistedInteger(
  raw: Record<string, unknown>,
  key: string,
  fallback: number,
  minimum: number,
  maximum: number,
  activation: EffectiveSetting<number>["activation"],
): EffectiveSetting<number> {
  const value = raw[key];
  const parsed = Number.parseInt(stringValue(value), 10);
  if (!Object.hasOwn(raw, key) || !Number.isFinite(parsed)) {
    return defaultSetting(fallback, activation);
  }
  return persistedSetting(Math.min(maximum, Math.max(minimum, parsed)), activation);
}

function persistedNumber(
  raw: Record<string, unknown>,
  key: string,
  fallback: number,
  minimum: number,
  maximum: number,
  activation: EffectiveSetting<number>["activation"],
): EffectiveSetting<number> {
  const value = raw[key];
  const parsed = Number(value);
  if (
    !Object.hasOwn(raw, key) ||
    value === null ||
    value === undefined ||
    (typeof value === "string" && value.trim() === "") ||
    !Number.isFinite(parsed)
  ) {
    return defaultSetting(fallback, activation);
  }
  return persistedSetting(Math.min(maximum, Math.max(minimum, parsed)), activation);
}

function persistedString(
  raw: Record<string, unknown>,
  key: string,
  fallback: string,
  activation: EffectiveSetting<string>["activation"],
): EffectiveSetting<string> {
  const value = raw[key];
  return Object.hasOwn(raw, key) && typeof value === "string"
    ? persistedSetting(value.slice(0, 8000), activation)
    : defaultSetting(fallback, activation);
}

function persistedModels(
  raw: Record<string, unknown>,
  key: string,
): EffectiveSetting<string[] | null> {
  return Object.hasOwn(raw, key)
    ? persistedSetting(normalizeModels(raw[key]), "next_workflow")
    : defaultSetting(null, "next_workflow");
}

function persistedNullableModel(
  raw: Record<string, unknown>,
  key: string,
): EffectiveSetting<string | null> {
  if (!Object.hasOwn(raw, key)) {
    return defaultSetting(null, "next_workflow");
  }
  const value = typeof raw[key] === "string" ? raw[key].trim() || null : null;
  return persistedSetting(value, "next_workflow");
}

function persistedAnalysisLegs(
  raw: Record<string, unknown>,
): EffectiveSetting<JobCtrlSettings["analysisLegs"]> {
  const value = normalizeAnalysisLegs(raw.analysis_legs);
  return Object.hasOwn(raw, "analysis_legs") && value
    ? persistedSetting(value, "next_analysis")
    : defaultSetting(DEFAULT_JOBCTRL_SETTINGS.analysisLegs, "next_analysis");
}

function persistedSetting<T>(
  value: T,
  activation: EffectiveSetting<T>["activation"],
): EffectiveSetting<T> {
  return { value, source: "persisted", activation, editable: true };
}

function defaultSetting<T>(
  value: T,
  activation: EffectiveSetting<T>["activation"],
): EffectiveSetting<T> {
  return { value, source: "default", activation, editable: true };
}

function normalizeModels(value: unknown): string[] | null {
  if (!Array.isArray(value)) return null;
  const normalized = value
    .map((item) => String(item).trim())
    .filter((item, index, items) => item && item.length <= 160 && items.indexOf(item) === index);
  return normalized.length > 0 ? normalized : null;
}

function normalizeAnalysisLegs(value: unknown): JobCtrlSettings["analysisLegs"] | null {
  if (!Array.isArray(value)) return null;
  const allowed = new Set(["claude", "codex", "google"]);
  const normalized = value
    .map((item) => String(item).trim().toLowerCase())
    .filter((item): item is JobCtrlSettings["analysisLegs"][number] => allowed.has(item));
  return normalized.length > 0 ? [...new Set(normalized)] : null;
}

function normalizedPreferredModels(value: unknown): JobCtrlSettings["preferredModels"] {
  if (!isRecord(value)) return {};
  const result: JobCtrlSettings["preferredModels"] = {};
  for (const provider of ["codex", "claude", "google"] as const) {
    const model = typeof value[provider] === "string" ? value[provider].trim() : "";
    if (model && model.length <= 160) result[provider] = model;
  }
  return result;
}

function stringValue(value: unknown): string {
  return value === null || value === undefined ? "" : String(value);
}
