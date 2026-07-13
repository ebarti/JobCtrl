import { LOCAL_TENANT } from "@jobctrl/domain-types";
import { waitFor } from "@testing-library/react";
import { act } from "react";
import { http, HttpResponse } from "msw";
import { describe, expect, it } from "vitest";

import { sampleSettingsResponse } from "../../../test/fixtures/projections.js";
import { server } from "../../../test/msw/server.js";
import { renderHookWithProviders } from "../../../test/render.js";
import { settingsKeys } from "../../operations/settingsKeys.js";
import { useUpdateAiExecutionPolicyMutation } from "./useUpdateAiExecutionPolicyMutation.js";

describe("useUpdateAiExecutionPolicyMutation", () => {
  it("rolls back the real optimistic patch on failure", async () => {
    server.use(http.patch("*/v1/settings", () => new HttpResponse(null, { status: 500 })));
    const { result, queryClient } = renderHookWithProviders(() => useUpdateAiExecutionPolicyMutation());
    queryClient.setQueryData(settingsKeys.settings(LOCAL_TENANT), sampleSettingsResponse);

    await act(async () => result.current.mutate({ tailoringJudgeMinScore: 0.9 }));

    await waitFor(() => expect(result.current.isError).toBe(true));
    expect(queryClient.getQueryData(settingsKeys.settings(LOCAL_TENANT))).toEqual(sampleSettingsResponse);
  });
});
