import type { CompensationSourceRegistryResponse } from "@jobctrl/contracts";
import { LOCAL_TENANT } from "@jobctrl/domain-types";
import { waitFor } from "@testing-library/react";
import { act } from "react";
import { describe, expect, it, vi } from "vitest";

import { renderHookWithProviders } from "../../../test/render.js";
import { buildTestPorts } from "../../../test/testPorts.js";
import { compensationKeys } from "../../operations/compensationKeys.js";
import { useUpdateCompensationSourcePolicyMutation } from "./useUpdateCompensationSourcePolicyMutation.js";

const response: CompensationSourceRegistryResponse = {
  ok: true,
  sources: [],
};

describe("useUpdateCompensationSourcePolicyMutation", () => {
  it("updates a source through the API port and invalidates the registry", async () => {
    const updateCompensationSourcePolicy = vi.fn(async () => response);
    const { result, queryClient } = renderHookWithProviders(
      () => useUpdateCompensationSourcePolicyMutation(),
      {
        ports: buildTestPorts({
          api: { updateCompensationSourcePolicy },
        }),
      },
    );
    const invalidateSpy = vi.spyOn(queryClient, "invalidateQueries");
    const request = {
      sourceId: "glassdoor" as const,
      enabled: true,
      accessMode: "written_permission" as const,
    };

    await act(async () => {
      await expect(result.current.mutateAsync(request)).resolves.toBe(response);
    });

    expect(updateCompensationSourcePolicy).toHaveBeenCalledWith(request);
    await waitFor(() =>
      expect(invalidateSpy).toHaveBeenCalledWith({
        queryKey: compensationKeys.sources(LOCAL_TENANT),
      }),
    );
  });

  it("leaves cached source policy intact when the API update fails", async () => {
    const updateCompensationSourcePolicy = vi.fn(async () => {
      throw new Error("source update failed");
    });
    const { result, queryClient } = renderHookWithProviders(
      () => useUpdateCompensationSourcePolicyMutation(),
      {
        ports: buildTestPorts({
          api: { updateCompensationSourcePolicy },
        }),
      },
    );
    queryClient.setQueryData(
      compensationKeys.sources(LOCAL_TENANT),
      response,
    );

    await act(async () => {
      await expect(
        result.current.mutateAsync({
          sourceId: "levels_fyi",
          enabled: false,
          accessMode: null,
          europeCoverageConfirmed: false,
        }),
      ).rejects.toThrow("source update failed");
    });

    expect(
      queryClient.getQueryData(
        compensationKeys.sources(LOCAL_TENANT),
      ),
    ).toBe(response);
  });
});
