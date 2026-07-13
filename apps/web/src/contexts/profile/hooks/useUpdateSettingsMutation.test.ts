import { LOCAL_TENANT } from "@jobctrl/domain-types";
import { http, HttpResponse } from "msw";
import { waitFor } from "@testing-library/react";
import { act } from "react";
import { describe, expect, it } from "vitest";

import { server } from "../../../test/msw/server.js";
import { renderHookWithProviders } from "../../../test/render.js";
import { profileKeys } from "../queryKeys.js";
import { useUpdateSettingsMutation } from "./useUpdateSettingsMutation.js";

const initialSettings = {
  ok: true,
  settings: {
    targetRole: "Platform Engineering",
    locationFilter: "Remote",
    minFitScore: 7,
    autoApply: false,
    applyApprovalRequired: true,
    applyConcurrency: 2,
    workerActivitySlots: 4,
    dailyBudgetUsd: 25,
    analysisLegs: ["claude", "codex", "google"],
    tailoringGeneratorModels: null,
    tailoringJudgeModel: null,
    tailoringJudgeMinScore: 0.82,
    applyMaxBudgetUsd: 5,
    applyTimeoutSeconds: 900,
    scoreCriteria: "x",
    targetCriteria: "y",
    preferredModels: { claude: "sonnet" },
  },
  effectiveSettings: {
    llmModelOverride: { value: null, source: "default", activation: "next_workflow", editable: true },
    dailyBudgetUsd: { value: 25, source: "persisted", activation: "live", editable: true },
    applyConcurrency: { value: 2, source: "persisted", activation: "next_poll", editable: true },
    workerActivitySlots: { value: 4, source: "default", activation: "restart", editable: true },
    analysisLegs: { value: ["claude", "codex", "google"], source: "default", activation: "next_analysis", editable: true },
    tailoringGeneratorModels: { value: null, source: "default", activation: "next_workflow", editable: true },
    tailoringJudgeModel: { value: null, source: "default", activation: "next_workflow", editable: true },
    tailoringJudgeMinScore: { value: 0.82, source: "default", activation: "next_workflow", editable: true },
    applyMaxBudgetUsd: { value: 5, source: "default", activation: "next_apply_job", editable: true },
    applyTimeoutSeconds: { value: 900, source: "default", activation: "next_apply_job", editable: true },
    scoreCriteria: { value: "x", source: "persisted", activation: "next_run", editable: true },
    targetCriteria: { value: "y", source: "persisted", activation: "next_run", editable: true },
  },
  paths: { settingsPath: "/tmp/jh.json" },
};

describe("useUpdateSettingsMutation", () => {
  it("returns the mocked settings response after submit", async () => {
    const { result } = renderHookWithProviders(() => useUpdateSettingsMutation());
    await act(async () => {
      result.current.mutate({ targetRole: "Director of Platform" });
    });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(result.current.data?.settings.targetRole).toBe("Platform Engineering");
  });

  it("rolls back the optimistic settings when the PATCH fails", async () => {
    server.use(
      http.patch("*/v1/settings", () =>
        new HttpResponse(JSON.stringify({ ok: false }), { status: 500 }),
      ),
    );
    const { result, queryClient } = renderHookWithProviders(() => useUpdateSettingsMutation());
    queryClient.setQueryData(profileKeys.settings(LOCAL_TENANT), initialSettings);

    await act(async () => {
      result.current.mutate({ targetRole: "Forbidden Update" });
    });
    await waitFor(() => expect(result.current.isError).toBe(true));
    const restored = queryClient.getQueryData(profileKeys.settings(LOCAL_TENANT)) as {
      settings: { targetRole: string };
    };
    expect(restored.settings.targetRole).toBe("Platform Engineering");
  });
});
