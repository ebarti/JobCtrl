import { execFileSync, spawnSync } from "node:child_process";
import { upgradeRevisions } from "../apps/web/e2e/harness/upgrade-revisions.mjs";

const missing = upgradeRevisions.filter((revision) =>
  spawnSync("git", ["cat-file", "-e", `${revision}^{commit}`], { stdio: "ignore" }).status !== 0,
);
if (missing.length) {
  execFileSync("git", ["fetch", "--no-tags", "--depth=1", "origin", ...missing], { stdio: "inherit" });
}
for (const revision of upgradeRevisions) {
  execFileSync("git", ["cat-file", "-e", `${revision}^{commit}`], { stdio: "inherit" });
}
console.log(`Verified ${upgradeRevisions.length} fixed source-upgrade predecessors.`);
