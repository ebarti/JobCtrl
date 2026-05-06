import type { UseQueryResult } from "@tanstack/react-query";
import { expectTypeOf, test } from "vitest";

import {
  useActivityEventQuery,
  type ActivityEvent,
} from "../../src/contexts/operations/hooks/useActivityEventQuery.js";

test("useActivityEventQuery returns UseQueryResult<ActivityEvent | null>", () => {
  expectTypeOf(useActivityEventQuery).returns.toEqualTypeOf<UseQueryResult<ActivityEvent | null>>();
});
