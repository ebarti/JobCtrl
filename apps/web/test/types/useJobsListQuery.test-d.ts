import type { JobSummary, PaginatedResponse, Stage } from "@jobctrl/contracts";
import type { UseQueryResult } from "@tanstack/react-query";
import { expectTypeOf, test } from "vitest";

import { useJobsListQuery } from "../../src/contexts/operations/hooks/useJobsListQuery.js";
import type { JobId, JobsListInput } from "../../src/contexts/operations/types.js";

test("useJobsListQuery returns UseQueryResult<PaginatedResponse<JobSummary>>", () => {
  expectTypeOf(useJobsListQuery).returns.toEqualTypeOf<UseQueryResult<PaginatedResponse<JobSummary>>>();
});

test("Jobs inputs retain readonly stage selections and string identifiers", () => {
  expectTypeOf<{ stages: readonly Stage[] }>().toExtend<JobsListInput>();
  expectTypeOf<JobsListInput>().toEqualTypeOf<
    Parameters<typeof useJobsListQuery>[0]
  >();
  expectTypeOf<JobId>().toEqualTypeOf<string>();
});
