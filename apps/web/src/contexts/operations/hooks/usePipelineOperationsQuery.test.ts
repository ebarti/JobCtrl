import type { PipelineOperationsSnapshot } from "@jobctrl/contracts";
import { LOCAL_TENANT } from "@jobctrl/domain-types";
import { waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { pipelineKeys } from "../../pipeline/queryKeys.js";
import { renderHookWithProviders } from "../../../test/render.js";
import { buildTestPorts } from "../../../test/testPorts.js";
import { usePipelineOperationsQuery } from "./usePipelineOperationsQuery.js";

const snapshot: PipelineOperationsSnapshot = {
  generatedAt: "2026-07-14T10:00:00.000Z",
  etaEstimatorVersion: "pipeline-eta-v1",
  freshness: { status: "fresh", asOf: "2026-07-14T10:00:00.000Z", staleAfterSeconds: 45 },
  execution: null,
  capacity: {
    status: "unavailable",
    asOf: "2026-07-14T10:00:00.000Z",
    staleAfterSeconds: 45,
    taskQueue: null,
    reason: "Worker runtime telemetry is unavailable.",
    approximateTaskQueue: {
      status: "unavailable",
      observedAt: "2026-07-14T10:00:00.000Z",
      reasonCode: "telemetry_unavailable",
    },
  },
  sourceFamilies: null,
  reconciliation: null,
  projectionCoverage: {
    status: "ready",
    mode: "native",
    decoderVersion: 1,
    historyEventId: 0,
    membershipCount: 0,
    stepCount: 0,
    updatedAt: "2026-07-14T10:00:00.000Z",
  },
  stages: [],
  activeStageCounts: [],
  activeItems: [],
  activeItemsTotal: 0,
  activeItemsTruncated: false,
  overallEta: { status: "unavailable", reason: "no_work", asOf: "2026-07-14T10:00:00.000Z" },
};

describe("usePipelineOperationsQuery", () => {
  it("reads the pipeline operations snapshot through the operations port", async () => {
    const pipelineOperations = vi.fn(async () => snapshot);
    const { result, queryClient } = renderHookWithProviders(() => usePipelineOperationsQuery(), {
      ports: buildTestPorts({ api: { pipelineOperations } }),
    });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));

    expect(pipelineOperations).toHaveBeenCalledOnce();
    expect(result.current.data).toEqual(snapshot);
    expect(queryClient.getQueryData(pipelineKeys.operations(LOCAL_TENANT))).toEqual(snapshot);
  });

  it("surfaces pipeline operations read errors", async () => {
    const pipelineOperations = vi.fn(async () => {
      throw new Error("operations unavailable");
    });
    const { result } = renderHookWithProviders(() => usePipelineOperationsQuery(), {
      ports: buildTestPorts({ api: { pipelineOperations } }),
    });

    await waitFor(() => expect(result.current.isError).toBe(true));

    expect(result.current.error?.message).toBe("operations unavailable");
  });
});
