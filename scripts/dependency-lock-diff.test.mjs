import assert from "node:assert/strict";
import test from "node:test";

import { diffPackageSets, parsePnpmPackages, parseUvPackages } from "./dependency-lock-diff.mjs";

test("extracts exact uv package identities", () => {
  const packages = parseUvPackages(`version = 1\n\n[[package]]\nname = "alpha"\nversion = "1.2.3"\n\n[[package]]\nname = "beta"\nversion = "2.0.0"\n`);
  assert.deepEqual([...packages], ["alpha@1.2.3", "beta@2.0.0"]);
});

test("extracts pnpm package records without importers or snapshots", () => {
  const packages = parsePnpmPackages(`lockfileVersion: '9.0'\nimporters:\n  .: {}\npackages:\n  '@scope/pkg@1.0.0': {}\n  plain@2.0.0:\n    resolution: {}\nsnapshots:\n  plain@2.0.0: {}\n`);
  assert.deepEqual([...packages], ["@scope/pkg@1.0.0", "plain@2.0.0"]);
});

test("reports additions and removals by identity", () => {
  assert.deepEqual(
    diffPackageSets(new Set(["a@1", "b@1"]), new Set(["a@2", "b@1"])),
    { added: ["a@2"], removed: ["a@1"] },
  );
});
