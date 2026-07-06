import { LOCAL_TENANT } from "@jobhunter/domain-types";
import { waitFor } from "@testing-library/react";
import { act } from "react";
import { describe, expect, it, vi } from "vitest";

import { renderHookWithProviders } from "../../../test/render.js";
import { buildTestPorts } from "../../../test/testPorts.js";
import { applyReviewKeys } from "../applyReviewKeys.js";
import { artifactsKeys } from "../artifactsKeys.js";
import { dashboardKeys } from "../dashboardKeys.js";
import { jobsKeys } from "../jobsKeys.js";
import { sampleDataKeys } from "../sampleDataKeys.js";
import {
  useClearSampleDataMutation,
  useLoadSampleDataMutation,
} from "./useSampleDataMutations.js";
import { useSampleDataStatusQuery } from "./useSampleDataQuery.js";

const emptyStatus = {
  ok: true as const,
  state: "empty" as const,
  dbExists: true,
  canLoad: true,
  canClear: false,
  jobCount: 0,
  sampleJobCount: 0,
  loadedAt: null,
  sampleJobs: [],
  message: "This empty workspace can load JobHunter sample data.",
};

const loadedStatus = {
  ...emptyStatus,
  state: "loaded" as const,
  canLoad: false,
  canClear: true,
  jobCount: 2,
  sampleJobCount: 2,
  loadedAt: "2026-07-06T10:00:00.000Z",
  sampleJobs: [
    {
      jobKey: "https://sample.jobhunter.local/jobs/platform-engineering-director",
      title: "Director of Platform Engineering",
      company: "Northstar Robotics",
      fitScore: 9,
      hasPdf: true,
    },
  ],
  message: "Sample data is loaded. Clear it before starting real job discovery.",
};

const loadedResponse = {
  ok: true as const,
  loaded: true,
  cleared: false,
  status: loadedStatus,
  message: "Sample data loaded.",
};

const clearedResponse = {
  ok: true as const,
  loaded: false,
  cleared: true,
  status: emptyStatus,
  message: "Sample data cleared.",
};

const invalidatedKeys = [
  sampleDataKeys.all(LOCAL_TENANT),
  dashboardKeys.summary(LOCAL_TENANT),
  jobsKeys.lists(LOCAL_TENANT),
  jobsKeys.details(LOCAL_TENANT),
  applyReviewKeys.queue(LOCAL_TENANT),
  artifactsKeys.lists(LOCAL_TENANT),
];

describe("useSampleDataStatusQuery", () => {
  it("reads sample-data status through the operations API port", async () => {
    const sampleDataStatus = vi.fn(async () => emptyStatus);
    const { result } = renderHookWithProviders(() => useSampleDataStatusQuery(), {
      ports: buildTestPorts({ api: { sampleDataStatus } }),
    });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));

    expect(result.current.data).toMatchObject({ state: "empty", canLoad: true });
    expect(sampleDataStatus).toHaveBeenCalledTimes(1);
  });
});

describe("useLoadSampleDataMutation", () => {
  it("loads sample data and invalidates read surfaces", async () => {
    const loadSampleData = vi.fn(async () => loadedResponse);
    const { result, queryClient } = renderHookWithProviders(() => useLoadSampleDataMutation(), {
      ports: buildTestPorts({ api: { loadSampleData } }),
    });
    const invalidateSpy = vi.spyOn(queryClient, "invalidateQueries");

    await act(async () => {
      await expect(result.current.mutateAsync()).resolves.toBe(loadedResponse);
    });

    expect(loadSampleData).toHaveBeenCalledTimes(1);
    for (const queryKey of invalidatedKeys) {
      expect(invalidateSpy).toHaveBeenCalledWith({ queryKey });
    }
  });

  it("still invalidates sample surfaces when loading fails", async () => {
    const loadSampleData = vi.fn(async () => {
      throw new Error("load failed");
    });
    const { result, queryClient } = renderHookWithProviders(() => useLoadSampleDataMutation(), {
      ports: buildTestPorts({ api: { loadSampleData } }),
    });
    const invalidateSpy = vi.spyOn(queryClient, "invalidateQueries");

    await act(async () => {
      await expect(result.current.mutateAsync()).rejects.toThrow("load failed");
    });

    expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: sampleDataKeys.all(LOCAL_TENANT) });
  });
});

describe("useClearSampleDataMutation", () => {
  it("clears sample data and invalidates read surfaces", async () => {
    const clearSampleData = vi.fn(async () => clearedResponse);
    const { result, queryClient } = renderHookWithProviders(() => useClearSampleDataMutation(), {
      ports: buildTestPorts({ api: { clearSampleData } }),
    });
    const invalidateSpy = vi.spyOn(queryClient, "invalidateQueries");

    await act(async () => {
      await expect(result.current.mutateAsync()).resolves.toBe(clearedResponse);
    });

    expect(clearSampleData).toHaveBeenCalledTimes(1);
    for (const queryKey of invalidatedKeys) {
      expect(invalidateSpy).toHaveBeenCalledWith({ queryKey });
    }
  });

  it("still invalidates sample surfaces when clearing fails", async () => {
    const clearSampleData = vi.fn(async () => {
      throw new Error("clear failed");
    });
    const { result, queryClient } = renderHookWithProviders(() => useClearSampleDataMutation(), {
      ports: buildTestPorts({ api: { clearSampleData } }),
    });
    const invalidateSpy = vi.spyOn(queryClient, "invalidateQueries");

    await act(async () => {
      await expect(result.current.mutateAsync()).rejects.toThrow("clear failed");
    });

    expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: sampleDataKeys.all(LOCAL_TENANT) });
  });
});
