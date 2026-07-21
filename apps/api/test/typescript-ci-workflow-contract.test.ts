import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

const workflowPath = new URL("../../../.github/workflows/typescript.yml", import.meta.url);

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
