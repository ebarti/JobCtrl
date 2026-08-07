import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const workflow = await readFile(new URL("../.github/workflows/docs-site.yml", import.meta.url), "utf8");
const config = await readFile(new URL("../docs/.vitepress/config.ts", import.meta.url), "utf8");

const onBlock = workflow.slice(workflow.indexOf("\non:"), workflow.indexOf("\npermissions:"));

/**
 * Collects the `paths` filter of a single `on:` trigger. Returns an empty list
 * when the trigger is absent or carries no filter, so a bare `pull_request:`
 * fails the contract.
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

const pullRequestPaths = triggerPaths("pull_request");

// A bare `pull_request:` trigger would build the site for every pull request,
// including ones that change no documentation at all.
assert.ok(
  pullRequestPaths.length > 0,
  "Docs Site must filter pull requests by path, not run on every pull request.",
);
assert.deepEqual(
  pullRequestPaths,
  triggerPaths("push"),
  "Docs Site must filter pull requests and pushes by the same paths.",
);

// Dropping `docs/**` would leave the published site with no dead-link gate.
assert.ok(
  pullRequestPaths.includes("docs/**"),
  "Docs Site must run when docs/** changes; that is the tree it builds.",
);

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
  pullRequestPaths.filter((entry) => entry.startsWith("!")).sort(),
  [...unpublishedDirs].sort(),
  "Docs Site must exclude exactly the directories srcExclude keeps out of the built site.",
);

// Stacked pull requests target their parent branch rather than main, so a
// `branches` filter here would silently skip every stacked layer.
assert.doesNotMatch(
  onBlock.slice(onBlock.indexOf("\n  pull_request:")),
  /branches:/,
  "Docs Site must not restrict pull requests to a base branch; stacked PRs target their parent.",
);

console.log(
  `docs workflow contract passed: ${pullRequestPaths.length} path filters, ${unpublishedDirs.length} unpublished directories excluded.`,
);
