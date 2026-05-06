import type { UseQueryResult } from "@tanstack/react-query";
import { expectTypeOf, test } from "vitest";

import {
  useApplyRunQuery,
  type ApplyRunSummary,
} from "../../src/contexts/operations/hooks/useApplyRunQuery.js";

test("useApplyRunQuery returns UseQueryResult<ApplyRunSummary | null>", () => {
  expectTypeOf(useApplyRunQuery).returns.toEqualTypeOf<UseQueryResult<ApplyRunSummary | null>>();
});
