import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const workflow = await readFile(new URL("../.github/workflows/docs-site.yml", import.meta.url), "utf8");
const ciWorkflow = await readFile(new URL("../.github/workflows/ci.yml", import.meta.url), "utf8");
const config = await readFile(new URL("../docs/.vitepress/config.ts", import.meta.url), "utf8");

const onBlock = workflow.slice(workflow.indexOf("\non:"), workflow.indexOf("\npermissions:"));

/**
 * Collects the `paths` filter of a single `on:` trigger. Returns an empty list
 * when the trigger is absent or carries no filter.
 */
function triggerPaths(trigger) {
  const triggerStart = onBlock.indexOf(`\n  ${trigger}:`);
  if (triggerStart < 0) {
    return [];
  }
  const rest = onBlock.slice(triggerStart + 1);
  const nextTrigger = rest.slice(1).search(/\n {2}\S/);
  const section = nextTrigger === -1 ? rest : rest.slice(0, nextTrigger + 1);
  const pathsStart = section.indexOf("\n    paths:");
  if (pathsStart < 0) {
    return [];
  }
  const entries = [];
  for (const line of section.slice(pathsStart + 1).split("\n").slice(1)) {
    const entry = /^ {6}- "(.+)"$/.exec(line)?.[1];
    if (entry === undefined) {
      break;
    }
    entries.push(entry);
  }
  return entries;
}

const pushPaths = triggerPaths("push");

assert.match(onBlock, /\n  workflow_call:\n/, "Docs Site must be callable by the cumulative CI router.");
assert.doesNotMatch(onBlock, /\n  pull_request:/, "Docs pull requests must route through the stable aggregate CI workflow.");
assert.match(ciWorkflow, /uses: \.\/\.github\/workflows\/docs-site\.yml/);
assert.match(
  onBlock,
  /workflow_call:\n    inputs:\n      deploy:[\s\S]*?default: false[\s\S]*?type: boolean/,
  "Reusable Docs validation must default to no deployment.",
);
assert.match(
  onBlock,
  /workflow_dispatch:\n    inputs:\n      deploy:[\s\S]*?default: true[\s\S]*?type: boolean/,
  "A direct manual Docs run must explicitly own its deployment default.",
);
assert.match(
  ciWorkflow,
  /uses: \.\/\.github\/workflows\/docs-site\.yml\n    with:\n      deploy: false/,
  "Aggregate CI must call Docs as validation-only.",
);
assert.match(
  workflow,
  /\(github\.event_name == 'push' \|\| inputs\.deploy\)/,
  "Docs publication must require a push or an explicit deploy input.",
);
assert.ok(pushPaths.length > 0, "Docs Site must retain a focused post-merge push trigger.");

// Dropping `docs/**` would leave the published site with no dead-link gate.
assert.ok(
  pushPaths.includes("docs/**"),
  "Docs Site must run when docs/** changes; that is the tree it builds.",
);
for (const requiredInput of [
  "pnpm-workspace.yaml",
  "scripts/check-docs-site-links.mjs",
  "scripts/check-docs-site-redirects.mjs",
  "scripts/check-docs-workflow-contract.mjs",
]) {
  assert.ok(pushPaths.includes(requiredInput), `Docs Site must run when ${requiredInput} changes.`);
}

// The excluded directories must be exactly the directories VitePress refuses to
// build. Excluding a directory the site *does* publish would ship dead links;
// leaving a never-published directory in the trigger burns CI on an artifact it
// cannot change. Either drift breaks this equality.
const srcExclude = config.slice(
  config.indexOf("srcExclude: ["),
  config.indexOf("]", config.indexOf("srcExclude: [")),
);
assert.ok(srcExclude.startsWith("srcExclude: ["), "docs/.vitepress/config.ts must declare srcExclude.");

const unpublishedDirs = [...srcExclude.matchAll(/"([^"]+\/\*\*)"/g)].map((match) => `!docs/${match[1]}`);
assert.ok(unpublishedDirs.length > 0, "srcExclude must list at least one unpublished directory.");
assert.deepEqual(
  pushPaths.filter((entry) => entry.startsWith("!")).sort(),
  [...unpublishedDirs].sort(),
  "Docs Site must exclude exactly the directories srcExclude keeps out of the built site.",
);

console.log(
  `docs workflow contract passed: ${pushPaths.length} post-merge inputs, ${unpublishedDirs.length} unpublished directories excluded.`,
);
