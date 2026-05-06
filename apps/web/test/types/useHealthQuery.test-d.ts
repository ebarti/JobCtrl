import type { UseQueryResult } from "@tanstack/react-query";
import { expectTypeOf, test } from "vitest";

import { useHealthQuery } from "../../src/contexts/operations/hooks/useHealthQuery.js";
import type { ApiHealthResponse } from "../../src/shared/ports/ApiClientPort.js";

test("useHealthQuery returns UseQueryResult<ApiHealthResponse>", () => {
  expectTypeOf(useHealthQuery).returns.toEqualTypeOf<UseQueryResult<ApiHealthResponse>>();
});
