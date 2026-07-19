import { WorkflowRunsListQuerySchema } from "@jobctrl/contracts";
import { describe, expect, it } from "vitest";

describe("WorkflowRunsListQuerySchema", () => {
  it("normalizes valid workflow type and UTC timestamp filters", () => {
    expect(
      WorkflowRunsListQuerySchema.parse({
        workflowType: " DiscoverWorkflow ",
        startedSince: "2026-04-29T10:15:00.1Z",
        startedBefore: "2026-04-29T10:20:00Z",
      }),
    ).toMatchObject({
      page: 1,
      pageSize: 50,
      status: "all",
      workflowType: "DiscoverWorkflow",
      startedSince: "2026-04-29T10:15:00.100Z",
      startedBefore: "2026-04-29T10:20:00.000Z",
      sort: "started_at",
      dir: "desc",
    });
  });

  it("normalizes malformed optional workflow filters away", () => {
    const query = WorkflowRunsListQuerySchema.parse({
      workflowType: "   ",
      startedSince: "not-a-timestamp",
      startedBefore: "2026-04-29T10:20:00+00:00",
    });

    expect(query.workflowType).toBeUndefined();
    expect(query.startedSince).toBeUndefined();
    expect(query.startedBefore).toBeUndefined();
  });
});
