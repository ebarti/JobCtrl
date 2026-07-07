import { waitFor } from "@testing-library/react";
import type { EvidenceMapResponse } from "@jobctrl/contracts";
import { describe, expect, it, vi } from "vitest";

import { buildTestPorts } from "../../../test/testPorts.js";
import { renderHookWithProviders } from "../../../test/render.js";
import { useEvidenceMapEntryQuery, useEvidenceMapQuery } from "./useEvidenceMapQuery.js";

const evidenceMapFixture: EvidenceMapResponse = {
  ok: true,
  generatedAt: "2026-07-05T12:00:00Z",
  entries: [
    {
      entryId: "ev-platform",
      kind: "achievement_evidence",
      evidenceId: "ev-platform",
      skillId: null,
      title: "Reduced latency through a platform migration",
      story: {
        scope: "Platform migration",
        action: "Led migration",
        outcome: "Reduced latency",
        metrics: ["40% latency reduction"],
      },
      skills: ["Python"],
      tags: ["migration"],
      freshness: {
        evidenceDateRange: "2024-2025",
        evidenceStrength: "verified",
        userConfirmed: true,
        claimConfidence: 0.95,
        lastUsedAt: "2026-07-05T12:00:00Z",
      },
      resumeUsages: [],
      requirementUsages: [],
      coverageUsages: [],
      gaps: [],
    },
  ],
  gaps: [],
};

describe("useEvidenceMapQuery", () => {
  it("reads the evidence map through the API port", async () => {
    const evidenceMap = vi.fn(async () => evidenceMapFixture);
    const { result } = renderHookWithProviders(() => useEvidenceMapQuery(), {
      ports: buildTestPorts({ api: { evidenceMap } }),
    });

    await waitFor(() => expect(result.current.data?.entries).toHaveLength(1));
    expect(evidenceMap).toHaveBeenCalledTimes(1);
  });

  it("selects one entry without changing the list endpoint contract", async () => {
    const evidenceMap = vi.fn(async () => evidenceMapFixture);
    const { result } = renderHookWithProviders(
      () => useEvidenceMapEntryQuery("ev-platform"),
      { ports: buildTestPorts({ api: { evidenceMap } }) },
    );

    await waitFor(() => expect(result.current.data?.entryId).toBe("ev-platform"));
    expect(evidenceMap).toHaveBeenCalledTimes(1);
  });
});
