import fs from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import { normalizeJobLocation } from "../src/location-normalization.js";

/**
 * Cases are loaded from the SHARED cross-runtime fixture
 * (packages/domain-types/test/fixtures/audit_projection_parity.json ->
 * `locationCases`) so this test and the Python test
 * (workers/automation/tests/test_location_normalization.py) assert byte-identical
 * output for the SAME inputs. The two normalization implementations cannot drift
 * without one of these tests going red. See the location-normalization module
 * docstrings for the lockstep contract.
 */
const FIXTURE_PATH = fileURLToPath(
  new URL(
    "../../../packages/domain-types/test/fixtures/audit_projection_parity.json",
    import.meta.url,
  ),
);

const { locationCases } = JSON.parse(fs.readFileSync(FIXTURE_PATH, "utf8")) as {
  locationCases: Array<{ input: string | null; expected: string }>;
};

describe("normalizeJobLocation", () => {
  it.each(locationCases)(
    "normalizes $input -> $expected (shared TS<->Python parity fixture)",
    ({ input, expected }) => {
      expect(normalizeJobLocation(input)).toBe(expected);
    },
  );
});
