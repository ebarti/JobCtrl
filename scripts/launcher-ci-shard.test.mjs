import assert from "node:assert/strict";
import { spawnSync, execFileSync } from "node:child_process";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const workflowPath = fileURLToPath(new URL("../.github/workflows/launcher.yml", import.meta.url));
const yamlReader = "require 'yaml'; require 'json'; puts JSON.generate(YAML.safe_load(File.read(ARGV[0]), permitted_classes: [], permitted_symbols: [], aliases: true))";

test("native CI requires both isolated shards and executes every listed test exactly once", async (context) => {
  const workflow = JSON.parse(execFileSync("ruby", ["-e", yamlReader, workflowPath], { encoding: "utf8" }));
  assert.deepEqual(Object.keys(workflow.jobs), ["launcher-shard"], "real matrix jobs must determine workflow success without a replacement summary runner");
  const shard = workflow.jobs["launcher-shard"];
  assert.deepEqual(shard.strategy, { "fail-fast": false, matrix: { shard: [0, 1] } });
  assert.equal(shard["runs-on"], "macos-15");
  assert.equal(shard.if, undefined, "neither shard may be skipped by a job condition");
  assert.equal(shard["continue-on-error"] ?? false, false, "both shards must fail the workflow on failure");
  for (const step of shard.steps) {
    assert.equal(step["continue-on-error"] ?? false, false, `${step.name} must preserve failure evidence`);
  }
  const vet = shard.steps.find((step) => step.name === "Vet native launcher");
  assert.equal(vet.if, "${{ matrix.shard == 0 }}");
  assert.equal(vet.run, "go vet ./...");
  const nativeTests = shard.steps.find((step) => step.name === "Test native launcher shard");
  assert.equal(nativeTests.if, undefined, "both shards must execute their assigned native tests");
  const prPath = fileURLToPath(new URL("../.github/workflows/pr-ci.yml", import.meta.url));
  const pr = JSON.parse(execFileSync("ruby", ["-e", yamlReader, prPath], { encoding: "utf8" }));
  const expected = JSON.parse(JSON.stringify(shard.steps).replaceAll("matrix.shard == 0", "env.TEST_SHARD == '0'").replaceAll("matrix.shard", "env.TEST_SHARD"));
  for (const index of [0, 1]) {
    const job = pr.jobs["launcher" + index];
    assert.deepEqual(job.steps, expected, "PR native proof must retain the manual command body");
    assert.equal(job.env.TEST_SHARD, String(index));
    assert.equal(job["runs-on"], "macos-15");
    assert.equal(job.strategy, undefined);
    assert.equal(job.needs, "preflight");
    assert.equal(job.if, "$" + "{{ needs.preflight.result == 'success' && needs.preflight.outputs.launcher != 'false' }}");
  }
  const run = nativeTests.run;
  const root = await mkdtemp(path.join(os.tmpdir(), "jobctrl-launcher-ci-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  const bin = path.join(root, "bin"), list = path.join(root, "tests"), log = path.join(root, "go.log");
  await mkdir(bin);
  const go = path.join(bin, "go");
  await writeFile(go, `#!/bin/sh
if [ "$1" = test ] && [ "$3" = -list ]; then cat "$TEST_LIST"; exit 0; fi
if [ "$1" = list ]; then printf '%s\\n' example/internal/launcher example/internal/other; exit 0; fi
printf '%s\\n' "$*" >> "$TEST_LOG"
if [ "$1" = test ] && [ "$2" = -race ] && [ "\${TEST_NATIVE_FAILURE:-0}" != 0 ]; then
  echo "Synthetic native launcher test failure" >&2
  exit "$TEST_NATIVE_FAILURE"
fi
`);
  await chmod(go, 0o700);
  for (const shell of ["/bin/bash", "bash"]) {
    await writeFile(list, "TestAlpha\nTestBeta\nTestGamma_One\nTestDelta\nok example/pkg 0.1s\n");
    const patterns = [];
    for (const index of [0, 1]) {
      await writeFile(log, "");
      const result = spawnSync(shell, ["-c", run], { encoding: "utf8", env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, TEST_SHARD: String(index), TEST_LIST: list, TEST_LOG: log, TEST_NATIVE_FAILURE: "0" } });
      assert.equal(result.status, 0, `${shell}: ${result.stderr}`);
      const commands = (await readFile(log, "utf8")).trim().split("\n");
      assert.equal(commands.length, index === 0 ? 2 : 1);
      assert.match(commands[0], /-race .* -count=1 .* -run /);
      if (index === 0) assert.match(commands[1], /example\/internal\/other/);
      patterns.push(new RegExp(commands[0].split(" -run ")[1]));
      await writeFile(log, "");
      const failed = spawnSync(shell, ["-c", run], { encoding: "utf8", env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, TEST_SHARD: String(index), TEST_LIST: list, TEST_LOG: log, TEST_NATIVE_FAILURE: "23" } });
      assert.equal(failed.status, 23, `${shell}: shard ${index} must propagate its native test failure`);
      assert.match(failed.stderr, /Synthetic native launcher test failure/);
      const failedCommands = (await readFile(log, "utf8")).trim().split("\n");
      assert.equal(failedCommands.length, 1, `${shell}: shard ${index} must stop after its native test failure`);
      assert.match(failedCommands[0], /test -race .* \.\/internal\/launcher -run /);
    }
    for (const name of ["TestAlpha", "TestBeta", "TestGamma_One", "TestDelta"]) {
      assert.equal(patterns.filter((pattern) => pattern.test(name)).length, 1, `${shell}: ${name} must run in exactly one shard`);
    }
    await writeFile(list, "ok example/pkg 0.1s\n");
    const empty = spawnSync(shell, ["-c", run], { encoding: "utf8", env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, TEST_SHARD: "0", TEST_LIST: list, TEST_LOG: log, TEST_NATIVE_FAILURE: "0" } });
    assert.notEqual(empty.status, 0, `${shell}: empty native selection must fail`);
  }
});
