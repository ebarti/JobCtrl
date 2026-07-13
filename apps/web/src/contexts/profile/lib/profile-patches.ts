import type {
  CredentialKey,
  ProfileUpdateRequest,
} from "@jobctrl/contracts";

import type {
  CredentialsResponse,
  ProfileConfigResponse,
} from "../../operations/types.js";

function isProfileResponse(value: unknown): value is ProfileConfigResponse {
  return (
    typeof value === "object" &&
    value !== null &&
    "profile" in value &&
    "style" in value &&
    "templateText" in value
  );
}

function isCredentialsResponse(value: unknown): value is CredentialsResponse {
  return (
    typeof value === "object" &&
    value !== null &&
    "credentials" in value &&
    Array.isArray((value as CredentialsResponse).credentials)
  );
}

function tryParseObject(text: string): Record<string, unknown> | undefined {
  try {
    const parsed = JSON.parse(text) as unknown;
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
  } catch {
    return undefined;
  }
  return undefined;
}

export function patchProfileResponse(
  current: unknown,
  body: ProfileUpdateRequest,
): unknown {
  if (!isProfileResponse(current)) {
    return current;
  }
  const next: Record<string, unknown> = { ...current };
  if (body.profileText !== undefined) {
    const parsed = tryParseObject(body.profileText);
    if (!parsed) {
      return current;
    }
    next["profile"] = parsed;
  }
  if (body.styleText !== undefined) {
    const parsed = tryParseObject(body.styleText);
    if (!parsed) {
      return current;
    }
    next["style"] = parsed;
  }
  if (body.templateText !== undefined) {
    next["templateText"] = body.templateText;
  }
  return next;
}

export { patchSettingsResponse } from "../../../shared/lib/settings-patches.js";

export function patchCredentialConfigured(
  current: unknown,
  key: CredentialKey,
  configured: boolean,
): unknown {
  if (!isCredentialsResponse(current)) {
    return current;
  }
  return {
    ...current,
    credentials: current.credentials.map((entry) =>
      entry.key === key
        ? {
            ...entry,
            configured,
            effectiveSource: configured ? "keychain" as const : "absent" as const,
          }
        : entry,
    ),
  };
}
