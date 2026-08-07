import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const workflowPath = fileURLToPath(new URL("../.github/workflows/python.yml", import.meta.url));
const workflow = await readFile(workflowPath, "utf8");

// Parse the real YAML the same way scripts/stacked-ci-workflows.test.mjs does
// (Ruby ships on the hosted runners; this step installs no Node dependencies),
// so the trigger contract holds for what GitHub will actually evaluate rather
// than for one canonical spelling. A string match false-passes on flow-style
// lists, unquoted entries, or reordered keys.
const execFileAsync = promisify(execFile);
const rubyYamlToJson = String.raw`
document = YAML.safe_load(
  File.read(ARGV.fetch(0)),
  permitted_classes: [],
  permitted_symbols: [],
  aliases: false,
)
events = document.delete("on") || document.delete(true)
document["on"] = events
puts JSON.generate(document)
`;
const { stdout } = await execFileAsync(
  "ruby",
  ["-ryaml", "-rjson", "-e", rubyYamlToJson, workflowPath],
  { maxBuffer: 1024 * 1024 },
);
const parsed = JSON.parse(stdout);

// Every layer of a GitHub stack must instantiate this workflow so that layer
// gets a check record; a filtered-out workflow reports nothing at all rather
// than reporting a skip. Cost belongs on the job-level trusted-cumulative-head
// `if:`, which is the pattern GitHub documents for stacks.
// scripts/stacked-ci-workflows.test.mjs asserts the same invariant; this keeps
// it enforced by the workflow's own contract step too. A bare `pull_request:`
// parses to null; a missing trigger or any filter (`branches`, `paths`,
// `types`, ...) parses to something else and fails.
assert.equal(
  parsed.on.pull_request,
  null,
  "Python CI must trigger on every pull request, with no branches or paths filter; every stack layer needs a check record.",
);

// `packages/**` holds the shared cross-runtime parity fixtures and the
// domain-event sources; `packaging/**` holds provider-packs.lock.json and
// capability-policy.json; the apps/ entries are the outreach sources scanned by
// the INV-1 no-send-transport guard; package.json, README.md, LICENSE, and
// NOTICE feed the byline/attribution tests; the release-scan tests read
// workflow files. All sit outside workers/ and scripts/, so dropping any of
// them would let a push that breaks Python CI land on main without ever
// running it.
const pushPaths = parsed.on.push?.paths ?? [];
for (const required of [
  "workers/**",
  "scripts/**",
  "packages/**",
  "packaging/**",
  "apps/web/src/contexts/outreach/**",
  "apps/web/src/views/outreach/**",
  "apps/api/src/outreach.ts",
  "package.json",
  "README.md",
  "LICENSE",
  "NOTICE",
  ".github/workflows/**",
]) {
  assert.ok(
    pushPaths.includes(required),
    `Python CI must run when a push changes ${required}; the suite reads files from it.`,
  );
}

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
