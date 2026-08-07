import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

const workflowPath = new URL("../../../.github/workflows/typescript.yml", import.meta.url);

/**
 * Collects the `paths` filter of a single `on:` trigger without a YAML parser,
 * which `apps/api` does not depend on. Returns an empty list when the trigger is
 * absent or carries no filter.
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

  it("leaves pull requests entirely unfiltered", () => {
    const block = onBlock();
    const triggerStart = block.indexOf("\n  pull_request:");

    // Deleting the trigger outright is the strongest violation of this
    // invariant — the workflow would stop instantiating for pull requests
    // altogether — so an absent trigger must fail here, not pass vacuously
    // (indexOf would return -1, slicing the block's last character, and
    // triggerPaths would report an absent trigger as "no filter").
    expect(triggerStart).toBeGreaterThanOrEqual(0);
    const pullRequest = block.slice(triggerStart);

    // Every layer of a GitHub stack must instantiate this workflow so that layer
    // gets a check record; a filtered-out workflow reports nothing at all rather
    // than reporting a skip. Cost belongs at the job level, on the trusted
    // cumulative-head `if:`, which is the pattern GitHub documents for stacks.
    // scripts/stacked-ci-workflows.test.mjs asserts the same invariant by
    // parsing the YAML; this keeps it visible to the suite that owns the file.
    expect(pullRequest).not.toContain("branches:");
    expect(triggerPaths(block, "pull_request")).toHaveLength(0);
  });

  it("pushes run whenever a file the suite reads can change", () => {
    const pushPaths = triggerPaths(onBlock(), "push");

    // `workers/**` supplies schema_v7.sql, schema_manifest.py, and config.py to
    // the cross-runtime parity and schema-guard tests; `scripts/**` supplies the
    // install script the install contract test executes. Both sit outside apps/
    // and packages/, so without them a push that breaks this suite would land on
    // main without ever running it.
    for (const required of [
      "apps/**",
      "packages/**",
      "workers/**",
      "scripts/**",
      ".github/workflows/typescript.yml",
    ]) {
      expect(pushPaths).toContain(required);
    }
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
