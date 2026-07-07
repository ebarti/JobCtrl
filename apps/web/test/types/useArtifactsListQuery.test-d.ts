import type { ArtifactSummary, PaginatedResponse } from "@jobctl/contracts";
import type { UseQueryResult } from "@tanstack/react-query";
import { expectTypeOf, test } from "vitest";

import { useArtifactsListQuery } from "../../src/contexts/operations/hooks/useArtifactsListQuery.js";

test("useArtifactsListQuery returns UseQueryResult<PaginatedResponse<ArtifactSummary>>", () => {
  expectTypeOf(useArtifactsListQuery).returns.toEqualTypeOf<
    UseQueryResult<PaginatedResponse<ArtifactSummary>>
  >();
});
