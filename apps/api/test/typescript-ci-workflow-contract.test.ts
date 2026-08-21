import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

const workflowPath = new URL("../../../.github/workflows/typescript.yml", import.meta.url);
const ciWorkflowPath = new URL("../../../.github/workflows/ci.yml", import.meta.url);

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

  it("gives pull requests one cumulative routing owner", () => {
    const block = onBlock();
    const ciWorkflow = readFileSync(ciWorkflowPath, "utf8");

    // The stable aggregate workflow must instantiate for every PR. It computes
    // the cumulative main...HEAD ownership plan and calls this workflow only
    // when one of its independently gated TypeScript surfaces changed.
    expect(block).toContain("\n  workflow_call:");
    expect(block).not.toContain("\n  pull_request:");
    expect(ciWorkflow).toContain("\n  pull_request:");
    expect(ciWorkflow).toContain("uses: ./.github/workflows/typescript.yml");
    expect(ciWorkflow).toContain("if: needs.plan.outputs.typescript == 'true'");
  });

  it("pushes run whenever a file the suite reads can change", () => {
    const pushPaths = triggerPaths(onBlock(), "push");

    // `workers/**` supplies schema_v7.sql, schema_manifest.py, and config.py to
    // the cross-runtime parity and schema-guard tests; `scripts/**` supplies the
    // install script the install contract test executes. Both sit outside apps/
    // and packages/, so without them a push that breaks this suite would land on
    // main without ever running it.
    for (const required of [
      "apps/api/**",
      "apps/web/**",
      "apps/extension/**",
      "packages/**",
      "workers/**",
      "scripts/**",
      ".github/workflows/typescript.yml",
    ]) {
      expect(pushPaths).toContain(required);
    }
    expect(pushPaths).not.toContain("apps/demo-edge/**");
  });
});

describe("TypeScript CI browser provisioning contract", () => {
  it("installs the Python Playwright Chromium revision before browser E2E", () => {
    const workflow = readFileSync(workflowPath, "utf8");
    const nodeChromiumInstall =
      "corepack pnpm --filter @jobctrl/web exec playwright install --with-deps chromium";
    const pythonChromiumInstall =
      "uv --project workers/automation run --locked --all-extras playwright install chromium";
    const e2eCommand = "corepack pnpm web:e2e";

    expect(workflow).toContain("- name: Install Playwright browsers");
    expect(workflow).toContain(pythonChromiumInstall);
    expect(workflow.indexOf(nodeChromiumInstall)).toBeGreaterThanOrEqual(0);
    expect(workflow.indexOf(pythonChromiumInstall)).toBeGreaterThan(
      workflow.indexOf(nodeChromiumInstall),
    );
    expect(workflow.indexOf(e2eCommand)).toBeGreaterThan(workflow.indexOf(pythonChromiumInstall));
  });
});

describe("TypeScript CI shared package ownership", () => {
  it("checks and tests the domain-types package directly", () => {
    const workflow = readFileSync(workflowPath, "utf8");

    expect(workflow).toContain("corepack pnpm --filter @jobctrl/domain-types check");
    expect(workflow).toContain("corepack pnpm --filter @jobctrl/domain-types test");
  });
});
