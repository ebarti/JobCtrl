import assert from "node:assert/strict";
import test from "node:test";

import { validateRequiredResults } from "./ci-required.mjs";

const allRoutes = {
  meta: false,
  distribution: false,
  python: false,
  api: false,
  web: false,
  storybook: false,
  e2e: false,
  extension: false,
  demo_edge: false,
  demo: false,
  docs: false,
  launcher: false,
  typescript: false,
};
const plan = (routes) => ({ schemaVersion: 1, routes: { ...allRoutes, ...routes } });

test("accepts successful routed jobs and skipped irrelevant jobs", () => {
  const rows = validateRequiredResults(
    plan({ meta: true, distribution: false, python: false, typescript: true, docs: false, demo: false, launcher: false }),
    { plan: "success", meta: "success", distribution: "skipped", python: "skipped", typescript: "success", docs: "skipped", demo: "skipped", launcher: "skipped" },
  );
  assert.equal(rows.length, 7);
});

test("rejects a required job that GitHub skipped", () => {
  assert.throws(
    () => validateRequiredResults(
      plan({ meta: false, distribution: false, python: true, typescript: false, docs: false, demo: false, launcher: false }),
      { plan: "success", meta: "skipped", distribution: "skipped", python: "skipped", typescript: "skipped", docs: "skipped", demo: "skipped", launcher: "skipped" },
    ),
    /python was routed.*skipped/,
  );
});

test("rejects failures even when a job was not expected to run", () => {
  assert.throws(
    () => validateRequiredResults(
      plan({ meta: false, distribution: false, python: false, typescript: false, docs: false, demo: false, launcher: false }),
      { plan: "success", meta: "failure", distribution: "skipped", python: "skipped", typescript: "skipped", docs: "skipped", demo: "skipped", launcher: "skipped" },
    ),
    /not routed but finished with failure/,
  );
});

test("rejects a missing route plan instead of treating every route as false", () => {
  assert.throws(
    () => validateRequiredResults(
      {},
      { plan: "success", meta: "skipped", distribution: "skipped", python: "skipped", typescript: "skipped", docs: "skipped", demo: "skipped", launcher: "skipped" },
    ),
    /unsupported CI route plan schema/,
  );
});

test("rejects incomplete or non-boolean route outputs", () => {
  const results = { plan: "success", meta: "skipped", distribution: "skipped", python: "skipped", typescript: "skipped", docs: "skipped", demo: "skipped", launcher: "skipped" };
  assert.throws(
    () => validateRequiredResults({ schemaVersion: 1, routes: { meta: false } }, results),
    /must contain exactly/,
  );
  assert.throws(
    () => validateRequiredResults(plan({ python: "false" }), results),
    /python must be a boolean/,
  );
});
