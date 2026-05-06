import type { UseQueryResult } from "@tanstack/react-query";
import { expectTypeOf, test } from "vitest";

import {
  useApplyRunsListQuery,
  type ApplyRunSummary,
} from "../../src/contexts/operations/hooks/useApplyRunsListQuery.js";

test("useApplyRunsListQuery returns UseQueryResult<readonly ApplyRunSummary[]>", () => {
  expectTypeOf(useApplyRunsListQuery).returns.toEqualTypeOf<
    UseQueryResult<readonly ApplyRunSummary[]>
  >();
});
