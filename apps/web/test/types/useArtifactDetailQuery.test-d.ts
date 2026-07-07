import type { ArtifactDetail } from "@jobctrl/contracts";
import type { UseQueryResult } from "@tanstack/react-query";
import { expectTypeOf, test } from "vitest";

import { useArtifactDetailQuery } from "../../src/contexts/operations/hooks/useArtifactDetailQuery.js";

test("useArtifactDetailQuery returns UseQueryResult<ArtifactDetail>", () => {
  expectTypeOf(useArtifactDetailQuery).returns.toEqualTypeOf<UseQueryResult<ArtifactDetail>>();
});
