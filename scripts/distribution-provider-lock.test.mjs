import assert from "node:assert/strict";
import test from "node:test";

import { parseExportedRequirements } from "./distribution-provider-lock.mjs";

function requirement(name, version, marker) {
  return `${name}==${version} ; ${marker} \\\n`;
}

test("provider requirements select the CPython 3.12 NumPy resolution", () => {
  const requirements = requirement("numpy", "1.26.3", "python_full_version < '3.14'")
    + requirement("numpy", "2.5.2", "python_full_version >= '3.14'");
  assert.deepEqual([...parseExportedRequirements(requirements)], [["numpy", "1.26.3"]]);
});

test("provider requirements include their target Python minor boundary", () => {
  const requirements = requirement("numpy", "1.26.3", "python_full_version >= '3.12'")
    + requirement("numpy", "2.5.2", "python_full_version < '3.12'");
  assert.deepEqual([...parseExportedRequirements(requirements)], [["numpy", "1.26.3"]]);
});

test("provider requirements still reject unsupported Python selectors", () => {
  assert.throws(
    () => parseExportedRequirements(requirement("numpy", "1.26.3", "python_full_version >= '3.12.1'")),
    /unsupported provider-lock marker/,
  );
});

test("provider requirements still exclude Windows-only packages", () => {
  const requirements = "numpy==1.26.3\n" + requirement("colorama", "0.4.6", "sys_platform == 'win32'");
  assert.deepEqual([...parseExportedRequirements(requirements)], [["numpy", "1.26.3"]]);
});
