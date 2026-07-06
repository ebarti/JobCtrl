import { LOCAL_TENANT } from "@jobhunter/domain-types";
import { waitFor } from "@testing-library/react";
import { act } from "react";
import { describe, expect, it, vi } from "vitest";

import { sampleDailyDigest } from "../../../test/fixtures/projections.js";
import { renderHookWithProviders } from "../../../test/render.js";
import { buildTestPorts } from "../../../test/testPorts.js";
import { digestKeys } from "../digestKeys.js";
import { useAcknowledgeDigestMutation, useDigestQuery } from "./useDigestQuery.js";

describe("useDigestQuery", () => {
  it("reads the local digest through the operations API port", async () => {
    const digest = vi.fn(async () => sampleDailyDigest);
    const { result } = renderHookWithProviders(() => useDigestQuery(), {
      ports: buildTestPorts({ api: { digest } }),
    });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));

    expect(result.current.data?.newMatches.count).toBe(3);
    expect(result.current.data?.followUpsDue.dayBoundary).toBe("UTC");
    expect(digest).toHaveBeenCalledTimes(1);
  });
});

describe("useAcknowledgeDigestMutation", () => {
  it("posts the explicit acknowledge timestamp and invalidates the digest cache", async () => {
    const acknowledgeDigest = vi.fn(async (body) => ({
      ok: true as const,
      state: {
        lastAcknowledgedAt: body?.acknowledgedAt ?? sampleDailyDigest.generatedAt,
        updatedAt: sampleDailyDigest.generatedAt,
      },
    }));
    const { result, queryClient } = renderHookWithProviders(
      () => useAcknowledgeDigestMutation(),
      {
        ports: buildTestPorts({ api: { acknowledgeDigest } }),
      },
    );
    const invalidateSpy = vi.spyOn(queryClient, "invalidateQueries");

    await act(async () => {
      await result.current.mutateAsync({ acknowledgedAt: sampleDailyDigest.generatedAt });
    });

    expect(acknowledgeDigest).toHaveBeenCalledWith({
      acknowledgedAt: sampleDailyDigest.generatedAt,
    });
    expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: digestKeys.all(LOCAL_TENANT) });
  });
});
