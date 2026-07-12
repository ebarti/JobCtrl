import type {
  EffectiveDashboardSettings,
  EffectiveSetting,
  SettingsResponse,
  SettingsUpdateRequest,
} from "@jobctrl/contracts";

export function patchSettingsResponse(
  current: SettingsResponse,
  body: SettingsUpdateRequest,
): SettingsResponse {
  const overrides = Object.fromEntries(
    Object.entries(body).filter(([key, value]) => key !== "preferredModels" && value !== undefined),
  );
  const preferredModels = body.preferredModels
    ? Object.fromEntries(Object.entries({
        ...current.settings.preferredModels,
        ...body.preferredModels,
      }).filter(([, value]) => typeof value === "string" && value.length > 0))
    : current.settings.preferredModels;
  const effectiveSettings: EffectiveDashboardSettings = { ...current.effectiveSettings };
  const effectiveRecord = effectiveSettings as unknown as Record<string, EffectiveSetting<unknown>>;
  for (const field of Object.keys(effectiveRecord)) {
    const value = body[field as keyof SettingsUpdateRequest];
    const metadata = effectiveRecord[field];
    if (value !== undefined && metadata.editable) {
      effectiveRecord[field] = { ...metadata, value, source: "persisted" };
    }
  }
  return {
    ...current,
    settings: { ...current.settings, ...overrides, preferredModels },
    effectiveSettings,
  };
}
