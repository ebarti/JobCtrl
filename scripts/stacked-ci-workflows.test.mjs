import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

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

const parseWorkflow = async (name) => {
  const path = fileURLToPath(
    new URL(`../.github/workflows/${name}.yml`, import.meta.url),
  );
  const { stdout } = await execFileAsync(
    "ruby",
    ["-ryaml", "-rjson", "-e", rubyYamlToJson, path],
    { maxBuffer: 1024 * 1024 },
  );
  return JSON.parse(stdout);
};

const sameRepositoryPullRequest =
  "github.event_name != 'pull_request' || github.event.pull_request.head.repo.full_name == github.repository";
const topOfStack =
  "github.event_name != 'pull_request' || github.event.pull_request.stack == null || github.event.pull_request.stack.position == github.event.pull_request.stack.size";

const findStep = (job, name) => {
  const step = job.steps.find((candidate) => candidate.name === name);
  assert.ok(step, `missing ${name} step`);
  return step;
};

test("same-repository pull requests targeting main admit correctness workflows", async () => {
  const specs = [
    { workflowName: "python", jobName: "python", pathFiltered: true },
    { workflowName: "typescript", jobName: "typescript", pathFiltered: true },
    { workflowName: "docs-site", jobName: "build", pathFiltered: true },
    { workflowName: "release-check", jobName: "release-check", pathFiltered: false },
  ];

  for (const spec of specs) {
    const workflow = await parseWorkflow(spec.workflowName);
    assert.deepEqual(
      workflow.on.pull_request.branches,
      ["main"],
      `${spec.workflowName} must admit every GitHub Stack layer as targeting main`,
    );
    assert.equal(
      workflow.jobs[spec.jobName].if,
      `\${{ ${sameRepositoryPullRequest} }}`,
      `${spec.workflowName} must continue to reject untrusted fork execution`,
    );
    if (spec.pathFiltered) {
      assert.deepEqual(
        workflow.on.pull_request.paths,
        workflow.on.push.paths,
        `${spec.workflowName} must use the same paths for stack PRs and main pushes`,
      );
    } else {
      assert.equal(workflow.on.pull_request.paths, undefined);
    }
  }
});

test("stack metadata gates cumulative Python product coverage", async () => {
  const workflow = await parseWorkflow("python");
  const job = workflow.jobs.python;
  const matrix =
    "fromJSON(github.event_name == 'pull_request' && github.event.pull_request.stack != null && github.event.pull_request.stack.position != github.event.pull_request.stack.size && '[\"3.11\"]' || '[\"3.11\",\"3.12\",\"3.13\"]')";

  assert.equal(
    job.strategy["fail-fast"],
    false,
    "one Python compatibility failure must not cancel the remaining top lanes",
  );
  assert.equal(job.strategy.matrix["python-version"], `\${{ ${matrix} }}`);
  for (const admissionStep of [
    "Lint",
    "Release scan",
    "Validate Python workflow contract",
    "Build package",
  ]) {
    assert.equal(
      findStep(job, admissionStep).if,
      undefined,
      `${admissionStep} must run as a fast Python 3.11 admission check on every matching stack PR`,
    );
  }
  assert.equal(
    findStep(job, "Test").if,
    `\${{ ${topOfStack} }}`,
    "the Python product suite must use the null-safe top-of-stack guard",
  );
});

test("stack metadata gates cumulative TypeScript product suites", async () => {
  const workflow = await parseWorkflow("typescript");
  const job = workflow.jobs.typescript;

  assert.equal(
    findStep(job, "Check").if,
    undefined,
    "the static workspace check must run on every matching stack PR",
  );

  for (const cumulativeStep of [
    "Set up Python",
    "Install uv",
    "Test",
    "Test web",
    "Test web types",
    "Build web",
    "Build web storybook",
    "Install Playwright Chromium",
    "Install Python Playwright Chromium",
    "Test web e2e",
    "Test web storybook",
  ]) {
    assert.equal(
      findStep(job, cumulativeStep).if,
      `\${{ ${topOfStack} }}`,
      `${cumulativeStep} must use the null-safe top-of-stack guard`,
    );
  }
});

test("stack routing keeps per-layer correctness and cumulative top coverage", () => {
  const routes = [
    {
      name: "push",
      eventName: "push",
      trusted: true,
      stack: null,
      expectedPython: ["3.11", "3.12", "3.13"],
      expectedCumulative: true,
    },
    {
      name: "ordinary same-repository pull request",
      eventName: "pull_request",
      trusted: true,
      stack: null,
      expectedPython: ["3.11", "3.12", "3.13"],
      expectedCumulative: true,
    },
    {
      name: "lower stack layer",
      eventName: "pull_request",
      trusted: true,
      stack: { position: 2, size: 3 },
      expectedPython: ["3.11"],
      expectedCumulative: false,
    },
    {
      name: "top stack layer",
      eventName: "pull_request",
      trusted: true,
      stack: { position: 3, size: 3 },
      expectedPython: ["3.11", "3.12", "3.13"],
      expectedCumulative: true,
    },
    {
      name: "public fork pull request",
      eventName: "pull_request",
      trusted: false,
      stack: null,
      expectedPython: [],
      expectedCumulative: false,
    },
  ];

  for (const route of routes) {
    const admitted = route.eventName !== "pull_request" || route.trusted;
    const isLowerStackLayer =
      route.eventName === "pull_request" &&
      route.stack !== null &&
      route.stack.position !== route.stack.size;
    const pythonVersions = admitted
      ? isLowerStackLayer
        ? ["3.11"]
        : ["3.11", "3.12", "3.13"]
      : [];
    const cumulative =
      admitted &&
      (route.eventName !== "pull_request" ||
        route.stack === null ||
        route.stack.position === route.stack.size);

    assert.deepEqual(pythonVersions, route.expectedPython, route.name);
    assert.equal(cumulative, route.expectedCumulative, route.name);
  }
});
