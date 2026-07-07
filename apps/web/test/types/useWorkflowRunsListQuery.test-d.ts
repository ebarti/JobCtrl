import type { PaginatedResponse, WorkflowRunSummary } from "@jobctl/contracts";
import type { UseQueryResult } from "@tanstack/react-query";
import { expectTypeOf, test } from "vitest";

import { useWorkflowRunsListQuery } from "../../src/contexts/operations/hooks/useWorkflowRunsListQuery.js";

test("useWorkflowRunsListQuery returns UseQueryResult<PaginatedResponse<WorkflowRunSummary>>", () => {
  expectTypeOf(useWorkflowRunsListQuery).returns.toEqualTypeOf<
    UseQueryResult<PaginatedResponse<WorkflowRunSummary>>
  >();
});
