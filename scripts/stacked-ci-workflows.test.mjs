import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import test from "node:test";

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

async function parseWorkflow(name) {
  const workflowPath = fileURLToPath(new URL(`../.github/workflows/${name}.yml`, import.meta.url));
  const { stdout } = await execFileAsync(
    "ruby",
    ["-ryaml", "-rjson", "-e", rubyYamlToJson, workflowPath],
    { maxBuffer: 4 * 1024 * 1024 },
  );
  return JSON.parse(stdout);
}

test("one unfiltered CI workflow owns every pull-request check record", async () => {
  const ci = await parseWorkflow("ci");
  assert.deepEqual(ci.on.pull_request.types, ["opened", "synchronize", "reopened", "stacked"]);
  assert.equal(ci.on.merge_group, null);
  assert.ok(ci.jobs.plan);
  assert.equal(ci.jobs.required.name, "CI / required");
  assert.equal(ci.jobs.required.if, "always()");
  assert.equal(ci.concurrency["cancel-in-progress"], true);

  for (const workflowName of ["python", "typescript", "docs-site", "demo-site", "launcher"]) {
    const workflow = await parseWorkflow(workflowName);
    assert.equal(workflow.on.pull_request, undefined, `${workflowName} must not independently admit pull requests`);
    assert.ok(Object.hasOwn(workflow.on, "workflow_call"), `${workflowName} must be callable by CI`);
  }
});

test("the plan rejects forks and lower stack layers before dependency execution", async () => {
  const ci = await parseWorkflow("ci");
  const steps = ci.jobs.plan.steps;
  const admission = steps.find((step) => step.id === "admission");
  const checkout = steps.find((step) => step.name === "Checkout cumulative head");
  const base = steps.find((step) => step.id === "base");
  assert.match(admission.run, /SAME_REPOSITORY.*!= true/s);
  assert.match(admission.run, /STACK_POSITION.*!=.*STACK_SIZE/s);
  assert.equal(checkout.if, "steps.admission.outputs.admitted == 'true'");
  assert.equal(base.if, "steps.admission.outputs.admitted == 'true'");
  assert.match(base.run, /git merge-base "origin\/\$DEFAULT_BRANCH" HEAD/);
});

test("the aggregate result depends on every conditionally routed workflow", async () => {
  const ci = await parseWorkflow("ci");
  assert.deepEqual(ci.jobs.required.needs, [
    "plan",
    "meta",
    "distribution",
    "python",
    "typescript",
    "docs",
    "demo",
    "launcher",
  ]);
  assert.equal(ci.jobs.python.uses, "./.github/workflows/python.yml");
  assert.equal(ci.jobs.typescript.uses, "./.github/workflows/typescript.yml");
  assert.equal(ci.jobs.docs.uses, "./.github/workflows/docs-site.yml");
  assert.equal(ci.jobs.demo.uses, "./.github/workflows/demo-site.yml");
  assert.equal(ci.jobs.launcher.uses, "./.github/workflows/launcher.yml");

  const checkout = ci.jobs.required.steps.find((step) => step.name === "Checkout result validator");
  const admitted = ci.jobs.required.steps.find((step) => step.name === "Require every routed surface to pass");
  const notAdmitted = ci.jobs.required.steps.find((step) => step.name === "Require a dependency-free non-admitted result");
  assert.equal(checkout.if, "needs.plan.outputs.admitted == 'true'");
  assert.equal(admitted.if, "needs.plan.outputs.admitted == 'true'");
  assert.equal(notAdmitted.if, "needs.plan.outputs.admitted != 'true'");
  assert.match(notAdmitted.run, /non-admitted route .* must be false/);
});

test("TypeScript surface inputs gate independent parallel jobs", async () => {
  const ci = await parseWorkflow("ci");
  const workflow = await parseWorkflow("typescript");
  const expected = {
    api: "inputs.api",
    web: "inputs.web",
    storybook: "inputs.storybook",
    e2e: "inputs.e2e",
    extension: "inputs.extension",
    "demo-edge": "inputs.demo_edge",
  };
  for (const [jobName, input] of Object.entries(expected)) {
    assert.match(workflow.jobs[jobName].if, new RegExp(input.replace(".", "\\.")));
    assert.ok(workflow.jobs[jobName]["timeout-minutes"] <= 20);
    const callerInput = jobName === "demo-edge" ? "demo_edge" : jobName;
    assert.equal(
      ci.jobs.typescript.with[callerInput],
      `\${{ needs.plan.outputs.${callerInput} == 'true' }}`,
      `${callerInput} route must reach the reusable TypeScript workflow`,
    );
  }
});

test("demo edge validation has one owner per automatic event", async () => {
  const typescript = await parseWorkflow("typescript");
  const demo = await parseWorkflow("demo-site");
  const demoEdgeStep = demo.jobs.build.steps.find((step) => step.name === "Verify edge workers");

  assert.equal(typescript.jobs["demo-edge"].if, "${{ github.event_name == 'workflow_dispatch' || inputs.demo_edge }}");
  assert.equal(demoEdgeStep.if, "${{ github.event_name == 'push' || inputs.verify_edge }}");
  assert.equal(demo.on.workflow_call.inputs.verify_edge.default, false);
  assert.equal(demo.on.workflow_dispatch.inputs.verify_edge.default, true);
  assert.ok(!typescript.on.push.paths.includes("apps/demo-edge/**"));

  const ci = await parseWorkflow("ci");
  assert.equal(ci.jobs.demo.with.verify_edge, false);
});

test("aggregate docs validation cannot publish", async () => {
  const docs = await parseWorkflow("docs-site");
  const ci = await parseWorkflow("ci");

  assert.equal(docs.on.workflow_call.inputs.deploy.default, false);
  assert.equal(docs.on.workflow_dispatch.inputs.deploy.default, true);
  assert.equal(ci.jobs.docs.with.deploy, false);
  assert.match(docs.jobs.deploy.if, /github\.event_name == 'push' \|\| inputs\.deploy/);
});

test("routing policy admits only trusted standalone or cumulative top heads", () => {
  const admitted = ({ eventName, trusted, stack }) =>
    eventName !== "pull_request" || (trusted && (stack === null || stack.position === stack.size));
  assert.equal(admitted({ eventName: "pull_request", trusted: true, stack: null }), true);
  assert.equal(admitted({ eventName: "pull_request", trusted: true, stack: { position: 3, size: 3 } }), true);
  assert.equal(admitted({ eventName: "pull_request", trusted: true, stack: { position: 2, size: 3 } }), false);
  assert.equal(admitted({ eventName: "pull_request", trusted: false, stack: null }), false);
});

test("stack attachment cancels and reclassifies the provisional opened run", async () => {
  const ci = await parseWorkflow("ci");
  const actionlint = await readFile(new URL("../.github/actionlint.yaml", import.meta.url), "utf8");
  assert.equal(ci.concurrency.group, "ci-${{ github.event.pull_request.number || github.ref }}");
  assert.equal(ci.concurrency["cancel-in-progress"], true);

  const admitted = (stack) => stack === null || stack.position === stack.size;
  const lowerLayerEvents = [
    { action: "opened", stack: null },
    { action: "stacked", stack: { position: 1, size: 2 } },
  ];
  assert.deepEqual(lowerLayerEvents.map(({ stack }) => admitted(stack)), [true, false]);
  assert.ok(ci.on.pull_request.types.includes("stacked"));
  assert.match(
    actionlint,
    /\.github\/workflows\/ci\.yml:[\s\S]+invalid activity type "stacked" for "pull_request" Webhook event/,
    "the temporary linter exception must stay scoped to the one preview event in ci.yml",
  );
});
