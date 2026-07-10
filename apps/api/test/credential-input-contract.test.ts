import {
  CREDENTIAL_VALUE_MAX_LENGTH,
  CredentialUpdateRequestSchema,
  type CredentialKey,
} from "@jobctrl/contracts";
import { describe, expect, it } from "vitest";

const REJECTED_VALUE_MARKER = "rejected-credential-must-not-appear";
const OVERLONG_VALUE = `${REJECTED_VALUE_MARKER}${"x".repeat(
  CREDENTIAL_VALUE_MAX_LENGTH + 1 - REJECTED_VALUE_MARKER.length,
)}`;

describe("credential input contract", () => {
  it.each([
    ["empty", ""],
    ["over 8,000 characters", OVERLONG_VALUE],
    ["carriage return", `${REJECTED_VALUE_MARKER}\rrest`],
    ["line feed", `${REJECTED_VALUE_MARKER}\nrest`],
    ["NUL", `${REJECTED_VALUE_MARKER}\0rest`],
  ])("rejects %s without retaining the submitted value in issues", (_label, value) => {
    const parsed = CredentialUpdateRequestSchema.safeParse({
      key: "OPENAI_API_KEY" satisfies CredentialKey,
      value,
    });

    expect(parsed.success).toBe(false);
    if (!parsed.success) {
      expect(JSON.stringify(parsed.error.issues)).not.toContain(
        REJECTED_VALUE_MARKER,
      );
    }
  });

  it.each([
    ["one-character API key", "OPENAI_API_KEY", "x"],
    [
      "8,000-character API key",
      "OPENAI_API_KEY",
      "x".repeat(CREDENTIAL_VALUE_MAX_LENGTH),
    ],
    [
      "provider API key punctuation",
      "OPENAI_API_KEY",
      "sk-proj_example-._~+/=",
    ],
    ["local LLM URL", "LLM_URL", "http://127.0.0.1:11434/v1"],
  ] satisfies ReadonlyArray<readonly [string, CredentialKey, string]>)(
    "preserves %s",
    (_label, key, value) => {
      expect(
        CredentialUpdateRequestSchema.safeParse({
          key,
          value,
        }).success,
      ).toBe(true);
    },
  );
});
