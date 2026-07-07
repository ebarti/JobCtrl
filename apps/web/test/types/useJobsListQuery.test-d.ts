import type { JobSummary, PaginatedResponse } from "@jobctl/contracts";
import type { UseQueryResult } from "@tanstack/react-query";
import { expectTypeOf, test } from "vitest";

import { useJobsListQuery } from "../../src/contexts/operations/hooks/useJobsListQuery.js";

test("useJobsListQuery returns UseQueryResult<PaginatedResponse<JobSummary>>", () => {
  expectTypeOf(useJobsListQuery).returns.toEqualTypeOf<UseQueryResult<PaginatedResponse<JobSummary>>>();
});
