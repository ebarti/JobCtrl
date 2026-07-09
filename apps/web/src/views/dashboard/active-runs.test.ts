import { describe, expect, it } from "vitest";

import {
  sampleWorkflowRun,
  sampleWorkflowRunCompleted,
} from "../../test/fixtures/projections.js";
import { mergeActiveRuns } from "./active-runs.js";

describe("mergeActiveRuns", () => {
  it("keeps only live lifecycle states, de-duplicates, and sorts newest first", () => {
    const starting = {
      ...sampleWorkflowRun,
      workflowId: "starting-new",
      runId: "starting-new",
      status: "starting" as const,
      startedAt: "2026-05-06T08:00:00Z",
    };
    const older = {
      ...sampleWorkflowRun,
      workflowId: "progress-old",
      runId: "progress-old",
      startedAt: "2026-05-06T07:00:00Z",
    };

    expect(
      mergeActiveRuns(
        [starting, sampleWorkflowRunCompleted],
        [older, starting, sampleWorkflowRunCompleted],
      ).map((run) => run.workflowId),
    ).toEqual(["starting-new", "progress-old"]);
  });
});
