import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const workflow = await readFile(new URL("../.github/workflows/python.yml", import.meta.url), "utf8");

const onBlock = workflow.slice(workflow.indexOf("\non:"), workflow.indexOf("\njobs:"));

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

// A bare `pull_request:` trigger ran all three matrix lanes on every pull
// request, including ones that changed no Python at all.
assert.ok(
  pullRequestPaths.length > 0,
  "Python CI must filter pull requests by path, not run on every pull request.",
);
assert.deepEqual(
  pullRequestPaths,
  triggerPaths("push"),
  "Python CI must filter pull requests and pushes by the same paths.",
);

// `packages/**` holds the shared cross-runtime parity fixtures and the
// domain-event sources; `packaging/**` holds provider-packs.lock.json and
// capability-policy.json; the release-scan tests read workflow files. Dropping
// any of these would let a change that breaks Python CI merge without running it.
for (const required of [
  "workers/**",
  "scripts/**",
  "packages/**",
  "packaging/**",
  ".github/workflows/**",
]) {
  assert.ok(
    pullRequestPaths.includes(required),
    `Python CI must run when ${required} changes; the suite reads files from it.`,
  );
}

// Stacked pull requests target their parent branch rather than main, so a
// `branches` filter here would silently skip every stacked layer.
assert.doesNotMatch(
  onBlock.slice(onBlock.indexOf("\n  pull_request:")),
  /branches:/,
  "Python CI must not restrict pull requests to a base branch; stacked PRs target their parent.",
);

assert.doesNotMatch(
  workflow,
  /(?:Install LaTeX|texlive-)/,
  "Python CI must not install the retired LaTeX renderer toolchain.",
);
const setupStep = `      - name: Enable Linux user namespaces for Bubblewrap
        if: \${{ runner.os == 'Linux' && runner.environment == 'github-hosted' }}
        shell: bash
        run: |
          set -euo pipefail
`;
const usernsGuard = `          current_userns="$(sysctl -n kernel.unprivileged_userns_clone 2>/dev/null || true)"
          if [ -n "$current_userns" ] && [ "$current_userns" != "1" ]; then
            echo "Enabling kernel.unprivileged_userns_clone for Bubblewrap."
            sudo sysctl -w kernel.unprivileged_userns_clone=1
          fi`;
const apparmorGuard = `          current_apparmor="$(sysctl -n kernel.apparmor_restrict_unprivileged_userns 2>/dev/null || true)"
          if [ -n "$current_apparmor" ] && [ "$current_apparmor" != "0" ]; then
            echo "Disabling kernel.apparmor_restrict_unprivileged_userns for Bubblewrap."
            sudo sysctl -w kernel.apparmor_restrict_unprivileged_userns=0
          fi`;

assert.ok(workflow.includes(setupStep), "Python CI must scope Bubblewrap sysctl setup to hosted Linux.");
assert.ok(workflow.includes(usernsGuard), "Python CI must guard and enable unprivileged user namespaces.");
assert.ok(workflow.includes(apparmorGuard), "Python CI must guard and disable Ubuntu AppArmor userns restriction.");

const setupIndex = workflow.indexOf(setupStep);
const testIndex = workflow.indexOf("      - name: Test\n");
assert.ok(setupIndex >= 0 && setupIndex < testIndex, "Bubblewrap setup must precede the Python test step.");
