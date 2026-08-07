import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

const workflowPath = new URL("../../../.github/workflows/typescript.yml", import.meta.url);

/**
 * Collects the `paths` filter of a single `on:` trigger without a YAML parser,
 * which `apps/api` does not depend on. Returns an empty list when the trigger is
 * absent or carries no filter, so a bare `pull_request:` fails the contract.
 */
function triggerPaths(onBlock: string, trigger: string): string[] {
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
  const entries: string[] = [];
  for (const line of section.slice(pathsStart + 1).split("\n").slice(1)) {
    const entry = /^ {6}- "(.+)"$/.exec(line)?.[1];
    if (entry === undefined) {
      break;
    }
    entries.push(entry);
  }
  return entries;
}

describe("TypeScript CI trigger contract", () => {
  const onBlock = () => {
    const workflow = readFileSync(workflowPath, "utf8");
    return workflow.slice(workflow.indexOf("\non:"), workflow.indexOf("\njobs:"));
  };

  it("filters pull requests to the same paths as pushes", () => {
    const block = onBlock();
    const pullRequestPaths = triggerPaths(block, "pull_request");

    // A bare `pull_request:` trigger ran the full suite - Playwright E2E and
    // Storybook included - on documentation-only pull requests, exposing them to
    // failures they could not have caused.
    expect(pullRequestPaths).not.toHaveLength(0);
    expect(pullRequestPaths).toEqual(triggerPaths(block, "push"));
  });

  it("runs whenever a file the suite reads can change", () => {
    const pullRequestPaths = triggerPaths(onBlock(), "pull_request");

    // `workers/**` supplies schema_v7.sql, schema_manifest.py, and config.py to
    // the cross-runtime parity and schema-guard tests; `scripts/**` supplies the
    // install script the install contract test executes. Dropping either would
    // let a change that breaks this suite merge without ever running it.
    for (const required of [
      "apps/**",
      "packages/**",
      "workers/**",
      "scripts/**",
      ".github/workflows/typescript.yml",
    ]) {
      expect(pullRequestPaths).toContain(required);
    }
  });

  it("does not restrict pull requests to a base branch", () => {
    const block = onBlock();
    const pullRequest = block.slice(block.indexOf("\n  pull_request:"));

    // Stacked pull requests target their parent branch rather than main, so a
    // `branches` filter here would silently skip every stacked layer.
    expect(pullRequest).not.toContain("branches:");
  });
});

describe("TypeScript CI browser provisioning contract", () => {
  it("installs the Python Playwright Chromium revision before browser E2E", () => {
    const workflow = readFileSync(workflowPath, "utf8");
    const nodeChromiumInstall =
      "pnpm --filter @jobctrl/web exec playwright install --with-deps chromium";
    const pythonChromiumInstall = "uv --project workers/automation run playwright install chromium";
    const e2eCommand = "pnpm --filter @jobctrl/web e2e";

    expect(workflow).toContain("- name: Install Python Playwright Chromium");
    expect(workflow).toContain(pythonChromiumInstall);
    expect(workflow.indexOf(nodeChromiumInstall)).toBeGreaterThanOrEqual(0);
    expect(workflow.indexOf(pythonChromiumInstall)).toBeGreaterThan(
      workflow.indexOf(nodeChromiumInstall),
    );
    expect(workflow.indexOf(e2eCommand)).toBeGreaterThan(workflow.indexOf(pythonChromiumInstall));
  });
});
