import type { DashboardSummary } from "@jobctl/contracts";
import type { UseQueryResult } from "@tanstack/react-query";
import { expectTypeOf, test } from "vitest";

import { useDashboardSummaryQuery } from "../../src/contexts/operations/hooks/useDashboardSummaryQuery.js";

test("useDashboardSummaryQuery returns UseQueryResult<DashboardSummary>", () => {
  expectTypeOf(useDashboardSummaryQuery).returns.toEqualTypeOf<UseQueryResult<DashboardSummary>>();
});
