import assert from "node:assert/strict";
import test from "node:test";

import { analyzePnpmLockOwnership, changedRootPackageKeys, classifyPaths } from "./ci-plan.mjs";

const attributedRootLock = {
  rootLockOwners: [],
  rootLockAttributionComplete: true,
};

test("routes a docs-only root dependency without launching product suites", () => {
  const plan = classifyPaths(["package.json", "pnpm-lock.yaml"], {
    rootPackageChanges: ["devDependencies.mermaid"],
    ...attributedRootLock,
  });
  assert.equal(plan.routes.docs, true);
  assert.equal(plan.routes.distribution, true);
  assert.equal(plan.routes.python, false);
  assert.equal(plan.routes.typescript, false);
  assert.equal(plan.routes.demo, false);
  assert.equal(plan.routes.launcher, false);
});

test("routes the root TypeScript toolchain to every TypeScript-owned surface", () => {
  const plan = classifyPaths(["package.json", "pnpm-lock.yaml"], {
    rootPackageChanges: ["devDependencies.typescript"],
    ...attributedRootLock,
  });
  for (const route of ["api", "web", "storybook", "e2e", "extension", "demo_edge", "demo", "typescript"]) {
    assert.equal(plan.routes[route], true, route);
  }
  assert.equal(plan.routes.python, false);
  assert.equal(plan.routes.launcher, false);
});

test("fails safe when root package ownership cannot be resolved", () => {
  const plan = classifyPaths(["package.json", "pnpm-lock.yaml"]);
  for (const route of ["api", "web", "storybook", "e2e", "extension", "demo_edge", "demo", "docs", "typescript"]) {
    assert.equal(plan.routes[route], true, route);
  }
});

test("detects dependency and script changes inside the root package manifest", () => {
  const before = JSON.stringify({ scripts: { check: "old" }, devDependencies: { mermaid: "1", typescript: "1" } });
  const after = JSON.stringify({ scripts: { check: "new" }, devDependencies: { mermaid: "2", typescript: "1" } });
  assert.deepEqual(changedRootPackageKeys(before, after), ["devDependencies.mermaid", "scripts.check"]);
});

test("routes a uv lock to locked Python and distribution contracts", () => {
  const plan = classifyPaths(["workers/automation/uv.lock"]);
  assert.equal(plan.routes.python, true);
  assert.equal(plan.routes.distribution, true);
  assert.equal(plan.routes.typescript, false);
  assert.equal(plan.routes.launcher, true);
});

test("routes cross-runtime Python source through API parity and browser integration coverage", () => {
  const plan = classifyPaths(["workers/automation/src/jobctrl/config.py"]);
  assert.equal(plan.routes.python, true);
  assert.equal(plan.routes.api, true);
  assert.equal(plan.routes.e2e, true);
  assert.equal(plan.routes.typescript, true);
  assert.equal(plan.routes.launcher, false);
});

test("routes every Python source imported by repeat-application E2E", () => {
  for (const file of [
    "workers/automation/src/jobctrl/apply/launcher.py",
    "workers/automation/src/jobctrl/database.py",
    "workers/automation/src/jobctrl/state.py",
  ]) {
    const plan = classifyPaths([file]);
    assert.equal(plan.routes.python, true, file);
    assert.equal(plan.routes.api, true, file);
    assert.equal(plan.routes.e2e, true, file);
    assert.equal(plan.routes.typescript, true, file);
  }
});

test("routes TypeScript outreach changes through the Python no-send safety guard", () => {
  for (const file of [
    "apps/api/src/outreach.ts",
    "apps/web/src/contexts/outreach/ports.ts",
    "apps/web/src/views/outreach/contact.tsx",
  ]) {
    const plan = classifyPaths([file]);
    assert.equal(plan.routes.python, true, file);
    assert.equal(plan.routes.typescript, true, file);
  }
});

test("routes Python-owned release capability inputs back through Python", () => {
  for (const file of [
    "packaging/distribution/capability-policy.json",
    "packaging/distribution/provider-packs.lock.json",
  ]) {
    const plan = classifyPaths([file]);
    assert.equal(plan.routes.python, true, file);
    assert.equal(plan.routes.distribution, true, file);
  }
});

test("routes transitive migration imports to Python, API parity, and the launcher", () => {
  const plan = classifyPaths(["workers/automation/src/jobctrl/infrastructure/projections/projection_builder.py"]);
  assert.equal(plan.routes.python, true);
  assert.equal(plan.routes.api, true);
  assert.equal(plan.routes.launcher, true);
});

test("routes an API dependency by its attributed importer instead of the root lock", () => {
  const plan = classifyPaths(["apps/api/package.json", "pnpm-lock.yaml"], attributedRootLock);
  assert.equal(plan.routes.api, true);
  assert.equal(plan.routes.distribution, true);
  assert.equal(plan.routes.web, false);
  assert.equal(plan.routes.docs, false);
  assert.equal(plan.routes.demo, false);
  assert.equal(plan.routes.launcher, true);
});

test("routes web dependencies through web, Storybook, browser, and demo coverage", () => {
  const plan = classifyPaths(["apps/web/package.json", "pnpm-lock.yaml"], attributedRootLock);
  assert.equal(plan.routes.web, true);
  assert.equal(plan.routes.storybook, true);
  assert.equal(plan.routes.e2e, true);
  assert.equal(plan.routes.demo, true);
  assert.equal(plan.routes.api, false);
  assert.equal(plan.routes.python, false);
});

test("routes native migration TypeScript inputs through the launcher", () => {
  for (const file of [
    "apps/api/package.json",
    "apps/api/tsconfig.json",
    "apps/api/src/db.ts",
    "apps/api/src/schema-manifest.ts",
    "apps/api/test/support/reopen-exact-v8.ts",
    "pnpm-workspace.yaml",
    "packages/tsconfig/base.json",
    "packages/tsconfig/node.json",
  ]) {
    const plan = classifyPaths([file]);
    assert.equal(plan.routes.api || file === "pnpm-workspace.yaml", true, file);
    assert.equal(plan.routes.launcher, true, file);
  }
});

test("routes an API-owned transitive root-lock delta through the launcher", () => {
  const plan = classifyPaths(
    ["pnpm-lock.yaml"],
    { rootLockOwners: ["apps/api"], rootLockAttributionComplete: true },
  );
  assert.equal(plan.routes.api, true);
  assert.equal(plan.routes.launcher, true);
});

test("treats a lock-only JavaScript change conservatively", () => {
  const plan = classifyPaths(["pnpm-lock.yaml"]);
  for (const route of ["api", "web", "storybook", "e2e", "extension", "demo_edge", "demo", "docs", "distribution", "launcher"]) {
    assert.equal(plan.routes[route], true, route);
  }
});

test("does not let an isolated manifest suppress an owned root lock delta", () => {
  const plan = classifyPaths(
    ["pnpm-lock.yaml", "packaging/distribution/api-native/package.json"],
    { rootLockOwners: ["."], rootLockAttributionComplete: true },
  );
  for (const route of ["api", "web", "storybook", "e2e", "extension", "demo_edge", "demo", "docs"]) {
    assert.equal(plan.routes[route], true, route);
  }
});

test("fails safe when root lock ownership analysis is incomplete", () => {
  const plan = classifyPaths(
    ["pnpm-lock.yaml", "apps/api/package.json"],
    { rootLockOwners: ["apps/api"], rootLockAttributionComplete: false },
  );
  for (const route of ["api", "web", "storybook", "e2e", "extension", "demo_edge", "demo", "docs", "launcher"]) {
    assert.equal(plan.routes[route], true, route);
  }
});

test("attributes mixed direct and transitive lock changes to every affected importer", () => {
  const before = `lockfileVersion: '9.0'
importers:
  .:
    devDependencies:
      root-tool:
        specifier: 1.0.0
        version: 1.0.0
  apps/api:
    dependencies:
      api-tool:
        specifier: 1.0.0
        version: 1.0.0
packages:
  root-tool@1.0.0: {}
  api-tool@1.0.0: {}
snapshots:
  root-tool@1.0.0: {}
  api-tool@1.0.0: {}
`;
  const after = before
    .replaceAll("root-tool@1.0.0", "root-tool@1.0.1")
    .replace("version: 1.0.0\n  apps/api:", "version: 1.0.1\n  apps/api:")
    .replaceAll("api-tool@1.0.0", "api-tool@1.0.1")
    .replace(/(api-tool:\n        specifier: 1\.0\.0\n        version:) 1\.0\.0/, "$1 1.0.1");
  const analysis = analyzePnpmLockOwnership(before, after, ["apps/api"]);
  assert.equal(analysis.complete, true, JSON.stringify(analysis));
  assert.deepEqual(analysis.owners, ["."]);
});

test("runs the complete topology when the router itself changes", () => {
  const plan = classifyPaths([".github/workflows/ci.yml"]);
  for (const [route, enabled] of Object.entries(plan.routes)) assert.equal(enabled, true, route);
});

test("routes the release scanner through the distribution contract", () => {
  const plan = classifyPaths(["scripts/release_check.py"]);
  assert.equal(plan.routes.distribution, true);
  assert.equal(plan.routes.python, false);
});

test("routes release publication workflows through distribution contracts", () => {
  for (const file of [
    ".github/workflows/release-distribution.yml",
    ".github/workflows/sync-homebrew-tap.yml",
  ]) {
    const plan = classifyPaths([file]);
    assert.equal(plan.routes.meta, true, file);
    assert.equal(plan.routes.distribution, true, file);
  }
});

test("routes the first-run installer to its API and docs contract owners", () => {
  const plan = classifyPaths(["scripts/install"]);
  assert.equal(plan.routes.api, true);
  assert.equal(plan.routes.docs, true);
  assert.equal(plan.routes.python, false);
  assert.equal(plan.routes.launcher, false);
});

test("fails safe across owned surfaces for an unclassified script", () => {
  const plan = classifyPaths(["scripts/new-production-tool"]);
  for (const [route, enabled] of Object.entries(plan.routes)) assert.equal(enabled, true, route);
});

test("does not build unpublished planning documents", () => {
  const plan = classifyPaths(["docs/plans/example.md", "docs/incidents/example.md"]);
  assert.equal(plan.routes.docs, false);
});

test("routes root launch and environment copy through docs contracts", () => {
  for (const file of [".env.example", "ROADMAP.md", "LAUNCH_CHECKLIST.md"]) {
    const plan = classifyPaths([file]);
    assert.equal(plan.routes.docs, true, file);
    assert.equal(plan.routes.typescript, false, file);
  }
});

test("fails safe rather than emitting an empty plan for an unknown input", () => {
  const plan = classifyPaths(["NEW_ROOT_CONTRACT"]);
  for (const [route, enabled] of Object.entries(plan.routes)) assert.equal(enabled, true, route);
});
