import type { JobDetail } from "@jobctl/contracts";
import type { UseQueryResult } from "@tanstack/react-query";
import { expectTypeOf, test } from "vitest";

import { useJobDetailQuery } from "../../src/contexts/operations/hooks/useJobDetailQuery.js";

test("useJobDetailQuery returns UseQueryResult<JobDetail>", () => {
  expectTypeOf(useJobDetailQuery).returns.toEqualTypeOf<UseQueryResult<JobDetail>>();
});
