import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const workflow = await readFile(new URL("../.github/workflows/python.yml", import.meta.url), "utf8");
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
