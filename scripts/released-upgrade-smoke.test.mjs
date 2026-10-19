import assert from "node:assert/strict";
import { cp, mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { pathToFileURL } from "node:url";
import test from "node:test";
import { selectReleasedUpgradeCases } from "./released-upgrade-smoke.mjs";

test("release cases cover distinct source schemas and reported recovery states with one full round trip", () => {
  const cases = selectReleasedUpgradeCases();
  assert.deepEqual(cases.map((entry) => entry.id), ["from-0.2.0", "from-0.2.1", "from-0.3.0", "recovery-0.2.1", "unused-0.2.1"]);
  assert.deepEqual(cases.filter((entry) => entry.roundTrip).map((entry) => entry.id), ["from-0.2.0"]);
  assert.equal(selectReleasedUpgradeCases("from-0.2.1").length, 1);
  assert.equal(selectReleasedUpgradeCases("recovery-0.2.1")[0].kind, "recovery");
});

test("a mistyped matrix selector fails instead of running the complete serial suite", () => {
  assert.throws(() => selectReleasedUpgradeCases("from-0.2.2"), /unknown/);
});

test("verification modules load without installing application development dependencies", async (context) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "jobctrl-proof-no-dependencies-"));
  context.after(() => rm(directory, { recursive: true, force: true }));
  await cp(new URL(".", import.meta.url), path.join(directory, "scripts"), { recursive: true });
  execFileSync(process.execPath, ["--input-type=module", "-e", `await import(${JSON.stringify(pathToFileURL(path.join(directory, "scripts/released-upgrade-smoke.mjs")).href)});`], { cwd: directory, env: { PATH: process.env.PATH } });
});
