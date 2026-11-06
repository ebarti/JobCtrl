import type { FeatureFlagPort } from "../ports/FeatureFlagPort.js";

/** The owning feature names its capability; demo defaults unknown names to unavailable. */
export type ApiCapabilityOperation = string;

export const LOCAL_INSTALL_GUIDE_URL =
  "https://jobctrl.dev/user/getting-started";

export interface ApiCapabilityAvailability {
  readonly available: boolean;
  readonly isDemo: boolean;
  readonly reason: string | null;
}

export function apiCapabilityFlagKey(
  operation: ApiCapabilityOperation,
  field: "available" | "reason",
): string {
  return `apiCapability:${operation}:${field}`;
}

/**
 * Local adapters support their normal API surface. Demo adapters override the
 * capability flags from its explicit manifest and fails closed for unknown names.
 */
export function getApiCapabilityAvailability(
  featureFlags: FeatureFlagPort,
  operation: ApiCapabilityOperation,
): ApiCapabilityAvailability {
  const isDemo = featureFlags.get("demoMode", false);
  if (!isDemo) {
    return { available: true, isDemo: false, reason: null };
  }

  return {
    available: featureFlags.get(
      apiCapabilityFlagKey(operation, "available"),
      false,
    ),
    isDemo: true,
    reason: featureFlags.get(
      apiCapabilityFlagKey(operation, "reason"),
      "This action is available in the local JobCtrl app.",
    ),
  };
}
