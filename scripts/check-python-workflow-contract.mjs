import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const workflowPath = fileURLToPath(new URL("../.github/workflows/python.yml", import.meta.url));
const workflow = await readFile(workflowPath, "utf8");
const ciWorkflow = await readFile(new URL("../.github/workflows/ci.yml", import.meta.url), "utf8");
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

assert.equal(parsed.on.workflow_call, null, "Python CI must be callable by the cumulative PR router.");
assert.equal(parsed.on.pull_request, undefined, "Python PR execution must have one owner: the aggregate CI router.");
assert.match(ciWorkflow, /uses: \.\/\.github\/workflows\/python\.yml/);
assert.match(ciWorkflow, /if: needs\.plan\.outputs\.python == 'true'/);

const quality = parsed.jobs.quality;
const tests = parsed.jobs.tests;
assert.equal(quality["timeout-minutes"], 10);
assert.equal(tests["timeout-minutes"], 20);
assert.equal(tests.strategy["fail-fast"], false);
assert.deepEqual(tests.strategy.matrix["python-version"], ["3.11", "3.12", "3.13"]);
assert.deepEqual(tests.strategy.matrix.shard, ["core", "temporal", "migration"]);

assert.doesNotMatch(workflow, /cache:\s*pip|pip install -e/);
assert.equal((workflow.match(/sync --locked --all-extras/g) ?? []).length, 2);
assert.match(workflow, /cache-dependency-glob: workers\/automation\/uv\.lock/);
assert.match(workflow, /uv --project workers\/automation tree --locked/);
assert.match(workflow, /--randomly-seed="\$PYTEST_RANDOMLY_SEED"/);
assert.match(workflow, /--durations=50/);
assert.match(workflow, /--junitxml=/);
assert.match(workflow, /if: always\(\)/);
assert.match(workflow, /\/dev\/shm\/jobctrl-/);
assert.match(workflow, /test_v6_to_v7_preflight\.py/);
assert.doesNotMatch(workflow, /name: Release scan/);
assert.equal((workflow.match(/name: Build package once/g) ?? []).length, 1);
assert.match(workflow, /python -m build --no-isolation workers\/automation/);

const setupIndex = workflow.indexOf("      - name: Enable Linux user namespaces for Bubblewrap\n");
const testIndex = workflow.indexOf("      - name: Test shard\n");
assert.ok(setupIndex >= 0 && setupIndex < testIndex, "Bubblewrap setup must precede every Python test shard.");

console.log("python workflow contract passed: locked graph, bounded shards, deterministic diagnostics");
