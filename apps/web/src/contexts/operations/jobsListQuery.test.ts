import { describe, expect, it, vi } from "vitest";
import type { JobsListInput } from "./types.js";
import { makeJobsPage, sampleJob } from "../../test/fixtures/projections.js";
import { fetchJobsList } from "./jobsListQuery.js";

describe("fetchJobsList", () => {
  it.each<JobsListInput>([
    {},
    { stage: "discover" },
    { stages: [] },
    { stages: ["apply"] },
    { stages: ["discover", "apply"] },
  ])("returns the one server page unchanged for %j", async (input) => {
    const page = {
      ...makeJobsPage([sampleJob]),
      pagination: { page: 100, pageSize: 50, total: 5001, pages: 101 },
    };
    const jobs = vi.fn().mockResolvedValue(page);
    expect(
      await fetchJobsList({ jobs }, { ...input, page: 100, pageSize: 50 }),
    ).toBe(page);
    expect(jobs).toHaveBeenCalledExactlyOnceWith({
      ...input,
      page: 100,
      pageSize: 50,
    });
  });

  it("deduplicates explicit stages, overriding scalar stage and forwarding every other query field", async () => {
    const jobs = vi.fn().mockResolvedValue(makeJobsPage([]));
    const query = {
      page: 100,
      pageSize: 50,
      q: "synthetic",
      sort: "compensation_posted" as const,
      dir: "asc" as const,
      state: "failed" as const,
      jobStates: ["active", "hidden"] as const,
      deleted: "all" as const,
      source: "board",
      company: "Example",
      applyStatus: "applied" as const,
      minFitScore: 4,
      maxFitScore: 9,
      discoveredSince: "2026-01-01T00:00:00Z",
      scoredSince: "2026-02-01T00:00:00Z",
      normalizedScoreKeyword: "cloud",
    };
    await fetchJobsList(
      { jobs },
      {
        ...query,
        jobStates: [...query.jobStates],
        stage: "score",
        stages: ["apply", "discover", "apply"],
      },
    );
    expect(jobs).toHaveBeenCalledExactlyOnceWith({
      ...query,
      stages: ["apply", "discover"],
    });
  });

  it("honors an explicit empty stage array over the scalar and keeps empty metadata", async () => {
    const page = makeJobsPage([]);
    const jobs = vi.fn().mockResolvedValue(page);
    expect(await fetchJobsList({ jobs }, { stage: "apply", stages: [] })).toBe(
      page,
    );
    expect(jobs).toHaveBeenCalledExactlyOnceWith({ stages: [] });
  });

  it("propagates the combined failure without partial pages or fallback calls", async () => {
    const failure = new Error("combined read unavailable");
    const jobs = vi.fn().mockRejectedValue(failure);
    await expect(
      fetchJobsList({ jobs }, { stages: ["discover", "apply"], page: 100 }),
    ).rejects.toBe(failure);
    expect(jobs).toHaveBeenCalledTimes(1);
  });
});
