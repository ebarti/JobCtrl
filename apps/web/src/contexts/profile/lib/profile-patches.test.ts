// @vitest-environment node

import { describe, expect, it } from "vitest";

import { sampleSettingsResponse } from "../../../test/fixtures/projections.js";
import { patchSettingsResponse } from "./profile-patches.js";

describe("patchSettingsResponse", () => {
  it("patches and clears one effort while preserving the others", () => {
    const current = { ...sampleSettingsResponse, settings: { ...sampleSettingsResponse.settings, codexReasoningEfforts: { "model-a": "high", "model-b": "low" } }, effectiveSettings: { ...sampleSettingsResponse.effectiveSettings, codexReasoningEfforts: { ...sampleSettingsResponse.effectiveSettings.codexReasoningEfforts, value: { "model-a": "high", "model-b": "low" } } } };
    const updated = patchSettingsResponse(current, { codexReasoningEfforts: { "model-a": "max" } });
    expect(updated).toMatchObject({ settings: { codexReasoningEfforts: { "model-a": "max", "model-b": "low" } }, effectiveSettings: { codexReasoningEfforts: { value: { "model-a": "max", "model-b": "low" }, source: "persisted" } } });
    expect(patchSettingsResponse(updated, { codexReasoningEfforts: { "model-a": null } })).toMatchObject({ settings: { codexReasoningEfforts: { "model-b": "low" } } });
  });
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
