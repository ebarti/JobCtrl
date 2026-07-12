import {
  CREDENTIAL_VALUE_MAX_LENGTH,
  CredentialBatchUpdateRequestSchema,
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

  it("accepts an allowlisted mixed set/delete batch and rejects duplicate keys", () => {
    expect(
      CredentialBatchUpdateRequestSchema.safeParse({
        operations: [
          { operation: "set", key: "ANTHROPIC_API_KEY", value: "secret" },
          { operation: "delete", key: "CLAUDE_CODE_USE_VERTEX" },
        ],
      }).success,
    ).toBe(true);

    expect(
      CredentialBatchUpdateRequestSchema.safeParse({
        operations: [
          { operation: "set", key: "GEMINI_API_KEY", value: "first" },
          { operation: "delete", key: "GEMINI_API_KEY" },
        ],
      }).success,
    ).toBe(false);
  });

  it("rejects unknown batch keys without retaining a rejected value", () => {
    const parsed = CredentialBatchUpdateRequestSchema.safeParse({
      operations: [
        {
          operation: "set",
          key: "AWS_SECRET_ACCESS_KEY",
          value: REJECTED_VALUE_MARKER,
        },
      ],
    });

    expect(parsed.success).toBe(false);
    if (!parsed.success) {
      expect(JSON.stringify(parsed.error.issues)).not.toContain(
        REJECTED_VALUE_MARKER,
      );
    }
  });
});
