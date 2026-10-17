import { JobListQuerySchema, type JobListQuery, type Stage } from "@jobctrl/contracts";
import { describe, expect, it, vi } from "vitest";

import { sampleJob } from "../../test/fixtures/projections.js";
import { fetchJobsList } from "./jobsListQuery.js";
import type { JobsListInput } from "./types.js";

// This annotated assignment is also compiled by web:check. It rejects an
// accidental intersection with the shared contract's mutable Stage[] field.
const readonlyStages: readonly Stage[] = Object.freeze(["discover", "apply"]);
const readonlyInput: JobsListInput = { stages: readonlyStages };
const undefinedInput: JobsListInput = { stage: "apply", stages: undefined };

function stageApi() {
  const jobs = [
    { ...sampleJob, jobKey: "job-a", currentStage: "discover" as const, currentSubstage: "discover" as const, fitScore: 5 },
    { ...sampleJob, jobKey: "job-b", currentStage: "apply" as const, currentSubstage: "apply" as const, fitScore: 5 },
  ];
  return {
    jobs: vi.fn(async (input: Partial<JobListQuery> = {}) => {
      const query = JobListQuerySchema.parse(input);
      const stages = query.stages ?? (query.stage ? [query.stage] : []);
      // Independent two-job membership/page oracle, with equal score keys.
      const selected = jobs.filter((job) => !stages.length || stages.includes(job.currentStage));
      const pages = Math.max(1, Math.ceil(selected.length / query.pageSize));
      const page = Math.min(query.page, pages);
      return {
        ok: true as const,
        items: selected.slice((page - 1) * query.pageSize, page * query.pageSize),
        pagination: { page, pageSize: query.pageSize, pages, total: selected.length },
        sort: { field: query.sort, dir: query.dir },
        filter: { stage: query.stage ?? "", stages },
      };
    }),
  };
}

describe("browser stage-array handoff", () => {
  const cases: Array<{ name: string; input: JobsListInput; ids: string[]; stages: Stage[]; stageEcho?: string }> = [
    { name: "omitted", input: { stage: "apply" }, ids: ["job-b"], stages: ["apply"] },
    { name: "undefined", input: undefinedInput, ids: ["job-b"], stages: ["apply"] },
    { name: "empty overrides scalar", input: { stage: "apply", stages: [] }, ids: ["job-a", "job-b"], stages: [] },
    { name: "single overrides scalar", input: { stage: "discover", stages: ["apply"] }, ids: ["job-b"], stages: ["apply"] },
    { name: "six duplicates", input: { stage: "discover", stages: Array<Stage>(6).fill("apply") }, ids: ["job-b"], stages: ["apply"] },
    { name: "seven duplicates fall back", input: { stage: "discover", stages: Array<Stage>(7).fill("apply") }, ids: ["job-a"], stages: ["discover"] },
    { name: "oversized without scalar", input: { stages: Array<Stage>(7).fill("apply") }, ids: ["job-a", "job-b"], stages: [] },
    { name: "readonly combined", input: readonlyInput, ids: ["job-a", "job-b"], stages: ["discover", "apply"] },
    { name: "combined overrides scalar", input: { stage: "score", stages: ["discover", "apply", "discover"] }, ids: ["job-a", "job-b"], stages: ["discover", "apply"] },
    { name: "empty membership", input: { stages: ["score", "cover"] }, ids: [], stages: ["score", "cover"] },
    // Malformed/wire-shaped values can arrive from persisted URL state. They
    // deliberately bypass the typed input to exercise shared runtime parsing.
    { name: "invalid member", input: { stage: "discover", stages: ["invalid"] } as unknown as JobsListInput, ids: ["job-a"], stages: ["discover"] },
    { name: "comma groups", input: { stages: ["apply,discover", "apply"] } as unknown as JobsListInput, ids: ["job-a", "job-b"], stages: ["apply", "discover"] },
    { name: "invalid scalar with combined array", input: { stage: "invalid", stages: ["apply", "discover"] } as unknown as JobsListInput, ids: ["job-a", "job-b"], stages: ["apply", "discover"], stageEcho: "" },
  ];

  it.each(cases)("preserves $name across first, adjacent and clamped pages", async ({ input, ids, stages, stageEcho }) => {
    const api = stageApi();
    for (const page of [1, 2, 999]) {
      const query = { ...input, page, pageSize: 1, sort: "fit_score" as const, dir: "asc" as const };
      const result = await fetchJobsList(api, query);
      const pages = Math.max(1, ids.length), safePage = Math.min(page, pages);
      expect(result.pagination).toEqual({ page: safePage, pageSize: 1, pages, total: ids.length });
      expect(result.items.map((job) => job.jobKey)).toEqual(ids.slice(safePage - 1, safePage));
      expect(result.filter).toEqual({ stage: stageEcho ?? input.stage ?? "", stages });
    }
    expect(readonlyStages).toEqual(["discover", "apply"]);
  });

  it("propagates a rejected read and allows the same request to recover", async () => {
    const api = stageApi();
    api.jobs.mockRejectedValueOnce(new Error("synthetic read failure"));
    await expect(fetchJobsList(api, readonlyInput)).rejects.toThrow("synthetic read failure");
    expect((await fetchJobsList(api, readonlyInput)).items.map((job) => job.jobKey)).toEqual(["job-a", "job-b"]);
  });
});
