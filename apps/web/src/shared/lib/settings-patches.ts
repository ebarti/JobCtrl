import type {
  EffectiveDashboardSettings,
  EffectiveSetting,
  SettingsResponse,
  SettingsUpdateRequest,
} from "@jobctrl/contracts";
import { SettingsResponseSchema } from "@jobctrl/contracts";

function isSettingsResponse(value: unknown): value is SettingsResponse {
  return SettingsResponseSchema.safeParse(value).success;
}

function persistedValue<T>(
  metadata: EffectiveSetting<T>,
  value: T | undefined,
): EffectiveSetting<T> {
  if (value === undefined || !metadata.editable) {
    return metadata;
  }
  return { ...metadata, value, source: "persisted" };
}

export function patchSettingsResponse(
  current: unknown,
  body: SettingsUpdateRequest,
): unknown {
  if (!isSettingsResponse(current)) {
    return current;
  }

  const preferredModels = body.preferredModels
    ? Object.fromEntries(
        Object.entries({
          ...current.settings.preferredModels,
          ...body.preferredModels,
        }).filter(([, value]) => typeof value === "string" && value.length > 0),
      )
    : current.settings.preferredModels;
  const effectiveSettings: EffectiveDashboardSettings = {
    ...current.effectiveSettings,
    dailyBudgetUsd: persistedValue(
      current.effectiveSettings.dailyBudgetUsd,
      body.dailyBudgetUsd,
    ),
    applyConcurrency: persistedValue(
      current.effectiveSettings.applyConcurrency,
      body.applyConcurrency,
    ),
    workerActivitySlots: persistedValue(
      current.effectiveSettings.workerActivitySlots,
      body.workerActivitySlots,
    ),
    analysisLegs: persistedValue(
      current.effectiveSettings.analysisLegs,
      body.analysisLegs,
    ),
    tailoringGeneratorModels: persistedValue(
      current.effectiveSettings.tailoringGeneratorModels,
      body.tailoringGeneratorModels,
    ),
    tailoringJudgeModel: persistedValue(
      current.effectiveSettings.tailoringJudgeModel,
      body.tailoringJudgeModel,
    ),
    tailoringJudgeMinScore: persistedValue(
      current.effectiveSettings.tailoringJudgeMinScore,
      body.tailoringJudgeMinScore,
    ),
    applyMaxBudgetUsd: persistedValue(
      current.effectiveSettings.applyMaxBudgetUsd,
      body.applyMaxBudgetUsd,
    ),
    applyTimeoutSeconds: persistedValue(
      current.effectiveSettings.applyTimeoutSeconds,
      body.applyTimeoutSeconds,
    ),
    scoreCriteria: persistedValue(
      current.effectiveSettings.scoreCriteria,
      body.scoreCriteria,
    ),
    targetCriteria: persistedValue(
      current.effectiveSettings.targetCriteria,
      body.targetCriteria,
    ),
  };

  return {
    ...current,
    settings: {
      ...current.settings,
      ...(body.targetRole !== undefined ? { targetRole: body.targetRole } : {}),
      ...(body.locationFilter !== undefined ? { locationFilter: body.locationFilter } : {}),
      ...(body.minFitScore !== undefined ? { minFitScore: body.minFitScore } : {}),
      ...(body.autoApply !== undefined ? { autoApply: body.autoApply } : {}),
      ...(body.applyApprovalRequired !== undefined
        ? { applyApprovalRequired: body.applyApprovalRequired }
        : {}),
      ...(body.applyConcurrency !== undefined
        ? { applyConcurrency: body.applyConcurrency }
        : {}),
      ...(body.workerActivitySlots !== undefined
        ? { workerActivitySlots: body.workerActivitySlots }
        : {}),
      ...(body.dailyBudgetUsd !== undefined ? { dailyBudgetUsd: body.dailyBudgetUsd } : {}),
      ...(body.analysisLegs !== undefined ? { analysisLegs: body.analysisLegs } : {}),
      ...(body.tailoringGeneratorModels !== undefined
        ? { tailoringGeneratorModels: body.tailoringGeneratorModels }
        : {}),
      ...(body.tailoringJudgeModel !== undefined
        ? { tailoringJudgeModel: body.tailoringJudgeModel }
        : {}),
      ...(body.tailoringJudgeMinScore !== undefined
        ? { tailoringJudgeMinScore: body.tailoringJudgeMinScore }
        : {}),
      ...(body.applyMaxBudgetUsd !== undefined
        ? { applyMaxBudgetUsd: body.applyMaxBudgetUsd }
        : {}),
      ...(body.applyTimeoutSeconds !== undefined
        ? { applyTimeoutSeconds: body.applyTimeoutSeconds }
        : {}),
      ...(body.scoreCriteria !== undefined ? { scoreCriteria: body.scoreCriteria } : {}),
      ...(body.targetCriteria !== undefined ? { targetCriteria: body.targetCriteria } : {}),
      preferredModels,
    },
    effectiveSettings,
  };
}
