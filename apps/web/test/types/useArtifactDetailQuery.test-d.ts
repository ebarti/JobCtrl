import type { ArtifactDetail } from "@jobhunter/contracts";
import type { UseQueryResult } from "@tanstack/react-query";
import { expectTypeOf, test } from "vitest";

import { useArtifactDetailQuery } from "../../src/contexts/operations/hooks/useArtifactDetailQuery.js";

test("useArtifactDetailQuery returns UseQueryResult<ArtifactDetail>", () => {
  expectTypeOf(useArtifactDetailQuery).returns.toEqualTypeOf<UseQueryResult<ArtifactDetail>>();
});
