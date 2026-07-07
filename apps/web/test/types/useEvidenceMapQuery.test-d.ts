import type { EvidenceMapEntry, EvidenceMapResponse } from "@jobctl/contracts";
import type { UseQueryResult } from "@tanstack/react-query";
import { expectTypeOf, test } from "vitest";

import {
  useEvidenceMapEntryQuery,
  useEvidenceMapQuery,
} from "../../src/contexts/operations/hooks/useEvidenceMapQuery.js";

test("useEvidenceMapQuery returns UseQueryResult<EvidenceMapResponse>", () => {
  expectTypeOf(useEvidenceMapQuery).returns.toEqualTypeOf<UseQueryResult<EvidenceMapResponse>>();
});

test("useEvidenceMapEntryQuery returns UseQueryResult<EvidenceMapEntry | null>", () => {
  expectTypeOf(useEvidenceMapEntryQuery).returns.toEqualTypeOf<
    UseQueryResult<EvidenceMapEntry | null>
  >();
});
