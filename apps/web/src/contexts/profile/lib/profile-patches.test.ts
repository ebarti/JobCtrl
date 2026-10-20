// @vitest-environment node

import { describe, expect, it } from "vitest";

import { sampleSettingsResponse } from "../../../test/fixtures/projections.js";
import { patchSettingsResponse } from "./profile-patches.js";

describe("patchSettingsResponse", () => {
  it("patches and clears the default route with its effective source", () => {
    const updated = patchSettingsResponse(sampleSettingsResponse, { defaultLlmModel: "codex:gpt-6.1-sol" });
    expect(updated).toMatchObject({ settings: { defaultLlmModel: "codex:gpt-6.1-sol" }, effectiveSettings: { defaultLlmModel: { value: "codex:gpt-6.1-sol", source: "persisted" } } });
    expect(patchSettingsResponse(updated, { defaultLlmModel: null })).toMatchObject({ settings: { defaultLlmModel: null }, effectiveSettings: { defaultLlmModel: { value: null, source: "persisted" } } });
  });
  it("preserves an unknown cache value when the nested response contract is invalid", () => {
    const current = { ok: true, settings: {}, effectiveSettings: {} };

    expect(patchSettingsResponse(current, { dailyBudgetUsd: 12 })).toBe(current);
  });

  it("merges one provider preference without replacing the other providers", () => {
    const current = {
      ...sampleSettingsResponse,
      settings: {
        ...sampleSettingsResponse.settings,
        preferredModels: { claude: "sonnet", google: "gemini-2.5-pro" },
      },
    };

    expect(
      patchSettingsResponse(current, { preferredModels: { codex: "gpt-5.5" } }),
    ).toMatchObject({
      settings: {
        preferredModels: {
          claude: "sonnet",
          codex: "gpt-5.5",
          google: "gemini-2.5-pro",
        },
      },
    });
  });

  it("removes a provider preference when the update uses null", () => {
    const current = {
      ...sampleSettingsResponse,
      settings: {
        ...sampleSettingsResponse.settings,
        preferredModels: { claude: "sonnet", codex: "gpt-5.5" },
      },
    };

    expect(
      patchSettingsResponse(current, { preferredModels: { claude: null } }),
    ).toMatchObject({
      settings: { preferredModels: { codex: "gpt-5.5" } },
    });
  });
});
