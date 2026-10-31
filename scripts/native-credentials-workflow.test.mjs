import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import test from "node:test";
import { fileURLToPath } from "node:url";

const workflowPath = fileURLToPath(new URL("../.github/workflows/native-credentials.yml", import.meta.url));
const yamlReader = "require 'yaml'; require 'json'; puts JSON.generate(YAML.safe_load(File.read(ARGV[0]), permitted_classes: [], permitted_symbols: [], aliases: false))";

test("native credential CI builds only the required native dependency and exercises fake batch ownership", () => {
  const workflow = JSON.parse(execFileSync("ruby", ["-e", yamlReader, workflowPath], { encoding: "utf8" }));
  // Ruby's YAML parser treats the YAML 1.1 key `on` as boolean true.
  const paths = (workflow.on ?? workflow.true).pull_request.paths;
  for (const source of ["credential-mutation-lock.ts", "credential-process-identity.ts"]) {
    assert.ok(paths.includes(`apps/api/src/${source}`), `${source} must trigger native credential CI`);
  }

  const job = workflow.jobs.native;
  assert.deepEqual(job.strategy.matrix.os, ["macos-latest", "windows-latest", "ubuntu-latest"]);
  const steps = job.steps;
  const commands = steps.flatMap((step) => typeof step.run === "string" ? step.run.split("\n").map((line) => line.trim()) : []);
  const installs = commands.filter((line) => /^corepack pnpm\b.*\binstall\b/.test(line));
  assert.equal(installs.length, 1);
  assert.match(installs[0], /(?:^|\s)--frozen-lockfile(?:\s|$)/);
  assert.match(installs[0], /(?:^|\s)--ignore-scripts(?:\s|$)/);
  const rebuilds = commands.filter((line) => /^corepack pnpm\b.*\brebuild\b/.test(line));
  assert.deepEqual(rebuilds, ["corepack pnpm --filter @jobctrl/api rebuild better-sqlite3"]);
  assert.ok(commands.indexOf(installs[0]) < commands.indexOf(rebuilds[0]));
  assert.ok(paths.includes("scripts/test_native_credentials_host.py"));
  const diagnostics = steps.find((step) => step.name === "Verify secret-free native harness diagnostics");
  assert.ok(diagnostics, "the fake diagnostic guard must be present");
  assert.equal(diagnostics.if, undefined, "diagnostic contracts must run on every host");
  assert.equal(diagnostics.run, "python scripts/test_native_credentials_host.py");
  assert.ok(steps.indexOf(diagnostics) > steps.findIndex((step) => step.name === "Install adapter test dependencies"));

  const python = steps.find((step) => step.id === "python");
  assert.match(python.uses, /^actions\/setup-python@/);
  const ownership = steps.find((step) => step.name === "Exercise fake credential batch ownership");
  assert.equal(ownership.if, undefined, "the fake ownership case must run on every matrix host");
  assert.equal(ownership.env.JOBCTRL_PYTHON_EXECUTABLE, "${{ steps.python.outputs.python-path }}");
  assert.match(ownership.run, /test\/credential-mutation-lock\.test\.ts/);
  assert.match(ownership.run, /serializes independent stores before rollback and keeps the newer successful value/);
  assert.ok(steps.indexOf(ownership) > steps.findIndex((step) => step.name === "Install adapter test dependencies"));
  assert.ok(steps.indexOf(diagnostics) < steps.indexOf(ownership));
});
