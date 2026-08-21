import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import test from "node:test";

const workflowsDirectory = new URL("../.github/workflows/", import.meta.url);
const minimumMajor = new Map([
  ["actions/checkout", 7],
  ["actions/download-artifact", 8],
  ["actions/github-script", 9],
  ["actions/setup-go", 7],
  ["actions/setup-node", 7],
  ["actions/setup-python", 7],
  ["actions/upload-artifact", 7],
  ["astral-sh/setup-uv", 10],
  ["cloudflare/wrangler-action", 4],
  ["KineticCafe/actions-dco", 3],
  ["pnpm/action-setup", 6],
]);

test("external Actions are immutable and use supported runtime generations", async () => {
  const workflowNames = (await readdir(workflowsDirectory)).filter((name) => name.endsWith(".yml")).sort();
  assert.ok(workflowNames.length > 0);
  for (const workflowName of workflowNames) {
    const workflow = await readFile(new URL(workflowName, workflowsDirectory), "utf8");
    for (const match of workflow.matchAll(/^\s*uses:\s*([^\s#]+)(?:\s+#\s+v(\d+)(?:\.[^\s]+)?)?\s*$/gm)) {
      const target = match[1];
      if (target.startsWith("./")) continue;
      const separator = target.lastIndexOf("@");
      assert.ok(separator > 0, `${workflowName}: action has no ref: ${target}`);
      const action = target.slice(0, separator);
      const ref = target.slice(separator + 1);
      assert.match(ref, /^[a-f0-9]{40}$/, `${workflowName}: ${action} must use an immutable commit SHA`);
      assert.ok(match[2], `${workflowName}: ${action} SHA must carry a reviewable version comment`);
      const floor = minimumMajor.get(action);
      if (floor !== undefined) {
        assert.ok(Number(match[2]) >= floor, `${workflowName}: ${action} v${match[2]} is below supported major v${floor}`);
      }
    }
  }
});

test("pnpm exists before setup-node initializes a pnpm cache", async () => {
  const workflowNames = (await readdir(workflowsDirectory)).filter((name) => name.endsWith(".yml")).sort();
  for (const workflowName of workflowNames) {
    const workflow = await readFile(new URL(workflowName, workflowsDirectory), "utf8");
    const jobBlocks = workflow.split(/^  (?=[a-zA-Z0-9_-]+:\s*$)/m).slice(1);
    for (const jobBlock of jobBlocks) {
      const setupNodeIndex = jobBlock.indexOf("uses: actions/setup-node@");
      if (setupNodeIndex < 0) continue;
      const nextStepIndex = jobBlock.indexOf("\n      - name:", setupNodeIndex);
      const setupNodeBlock = jobBlock.slice(setupNodeIndex, nextStepIndex < 0 ? undefined : nextStepIndex);
      if (!/^\s+cache:\s*pnpm\s*$/m.test(setupNodeBlock)) continue;
      const setupPnpmIndex = jobBlock.indexOf("uses: pnpm/action-setup@");
      assert.ok(
        setupPnpmIndex >= 0 && setupPnpmIndex < setupNodeIndex,
        `${workflowName}: pnpm/action-setup must run before setup-node enables the pnpm cache`,
      );
    }
  }
});

test("workflows do not create floating Python package environments", async () => {
  const workflowNames = (await readdir(workflowsDirectory)).filter((name) => name.endsWith(".yml")).sort();
  for (const workflowName of workflowNames) {
    const workflow = await readFile(new URL(workflowName, workflowsDirectory), "utf8");
    assert.doesNotMatch(
      workflow,
      /^[ \t]*(?:sudo[ \t]+)?(?:python(?:\d+(?:\.\d+)*)?[ \t]+-m[ \t]+pip|pip(?:\d+(?:\.\d+)*)?)[ \t]+install\b/m,
      `${workflowName}: Python packages must come from a reviewed lockfile`,
    );
  }
});

test("native migration CI provisions and binds its cross-runtime probes", async () => {
  const workflow = await readFile(new URL("launcher.yml", workflowsDirectory), "utf8");
  const setupPnpm = workflow.indexOf("uses: pnpm/action-setup@");
  const setupNode = workflow.indexOf("uses: actions/setup-node@");
  const installNode = workflow.indexOf("corepack pnpm install --frozen-lockfile");
  const bindNode = workflow.indexOf("JOBCTRL_MIGRATION_TEST_NODE=");
  const bindPython = workflow.indexOf("JOBCTRL_MIGRATION_TEST_PYTHON=");
  const tests = workflow.indexOf("go test -race ./...");

  assert.ok(setupPnpm >= 0 && setupPnpm < setupNode);
  assert.ok(setupNode < installNode && installNode < bindNode && bindNode < tests);
  assert.ok(bindPython >= 0 && bindPython < tests);
});
