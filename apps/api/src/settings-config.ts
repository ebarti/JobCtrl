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
  scoreCriteria: "",
  targetCriteria: "",
  preferredModels: {},
};

type SettingsEnvironment = Readonly<Record<string, string | undefined>>;

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
      scoreCriteria: normalizedText(
        raw.scoreCriteria ?? raw.score_criteria,
        DEFAULT_DASHBOARD_SETTINGS.scoreCriteria,
      ),
      targetCriteria: normalizedText(
        raw.targetCriteria ?? raw.target_criteria,
        DEFAULT_DASHBOARD_SETTINGS.targetCriteria,
      ),
      preferredModels: normalizedPreferredModels(raw.preferredModels ?? raw.preferred_models),
    },
    effectiveSettings: {
      dailyBudgetUsd,
      applyConcurrency,
      workerActivitySlots,
    },
  };
}

export function workerActivitySlotsManagedByEnvironment(
  environment: SettingsEnvironment = process.env,
): boolean {
  return environment.JOBCTRL_MAX_CONCURRENT_ACTIVITIES?.trim() !== "" &&
    environment.JOBCTRL_MAX_CONCURRENT_ACTIVITIES !== undefined;
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
