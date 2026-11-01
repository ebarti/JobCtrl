import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import test from "node:test";
import { check, rules } from "./lint-boundaries-fixtures.mjs";
import { webRoot } from "./lint-boundaries.mjs";

test("changed imported types cannot retain an earlier harmless capability verdict", () => {
  const view = "views/lint-builder-reuse/Page.ts";
  const types = "contexts/lint-builder-reuse/types.ts";
  const source = `import type { Client } from '../../contexts/lint-builder-reuse/types.js';
    declare const client: Client; client.health();`;
  const harmless = "export type Client = { health(): void };";
  const authority = "export type { ApiClientPort as Client } from '../../shared/ports/ApiClientPort.js';";
  for (const [text, expected] of [[harmless, []], [authority, ["view-api"]], [harmless, []], [authority, ["view-api"]]]) {
    const result = check({ [view]: source, [types]: text });
    assert.deepEqual(rules(result), expected);
    if (expected.length) assert.ok(result.some(d => d.file === view && d.rule === "view-api"));
  }
});

test("compiler errors follow changed overlays and disappear only when the real source is restored", () => {
  const file = "contexts/operations/readQueries.ts";
  const original = readFileSync(resolve(webRoot, "src", file), "utf8");
  const invalid = "const __fixtureCompilerError: string = 42;\n" + original;
  assert.deepEqual(check({ [file]: original }, {}, true).compilerDiagnostics, []);
  for (let pass = 0; pass < 2; pass++) {
    const broken = check({ [file]: invalid }, {}, true);
    assert.ok(broken.compilerDiagnostics.some(d => d.code === 2322 && d.file?.fileName === resolve(webRoot, "src", file)));
    assert.deepEqual(check({}, {}, true).compilerDiagnostics, []);
  }
});

test("adding and removing virtual modules invalidates unchanged importers", () => {
  const view = "views/lint-builder-resolution/Page.ts";
  const types = "contexts/lint-builder-resolution/types.ts";
  const source = "import type { Client } from '../../contexts/lint-builder-resolution/types.js'; declare const client: Client; client.health();";
  const missing = () => check({ [view]: source }, {}, true).compilerDiagnostics;
  assert.ok(missing().some(d => d.code === 2307 && d.file?.fileName === resolve(webRoot, "src", view)));
  assert.deepEqual(check({ [view]: source, [types]: "export type Client = { health(): void };" }, {}, true).compilerDiagnostics, []);
  assert.ok(missing().some(d => d.code === 2307 && d.file?.fileName === resolve(webRoot, "src", view)));
});
