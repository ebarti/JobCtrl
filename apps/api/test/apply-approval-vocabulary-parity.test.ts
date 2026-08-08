/**
 * Cross-runtime pin for the apply-review approval-gate vocabulary.
 *
 * The TypeScript source of truth is APPLY_REVIEW_APPROVAL_GATE_REASONS in
 * packages/contracts; the Python launcher's refusal subset is pinned to the
 * same fixture by workers/automation/tests/test_apply_approval_vocabulary.py.
 */
import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { APPLY_REVIEW_APPROVAL_GATE_REASONS } from "../src/contracts.js";

const FIXTURE_PATH = path.join(
  fileURLToPath(new URL("../../..", import.meta.url)),
  "packages/domain-types/test/fixtures/apply_approval_gate_reasons.json",
);

describe("apply approval-gate vocabulary parity", () => {
  const fixture = JSON.parse(fs.readFileSync(FIXTURE_PATH, "utf8")) as {
    reasons: string[];
    launcherRefusalReasons: string[];
  };

  it("matches the shared fixture exactly", () => {
    expect([...APPLY_REVIEW_APPROVAL_GATE_REASONS]).toEqual(fixture.reasons);
  });

  it("keeps the launcher refusal subset inside the vocabulary", () => {
    const reasons = new Set(fixture.reasons);
    for (const refusal of fixture.launcherRefusalReasons) {
      expect(reasons.has(refusal), refusal).toBe(true);
    }
  });
});
