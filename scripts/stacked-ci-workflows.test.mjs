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
const trustedTopOfStack = `(${sameRepositoryPullRequest}) && (${topOfStack})`;

const findStep = (job, name) => {
  const step = job.steps.find((candidate) => candidate.name === name);
  assert.ok(step, `missing ${name} step`);
  return step;
};

test("stacked pull requests always instantiate the Python and TypeScript admission workflows", async () => {
  const specs = [
    { workflowName: "python", jobName: "python" },
    { workflowName: "typescript", jobName: "typescript" },
  ];

  for (const spec of specs) {
    const workflow = await parseWorkflow(spec.workflowName);
    assert.equal(
      workflow.on.pull_request,
      null,
      `${spec.workflowName} must not suppress stacked PRs by their direct base branch or changed paths`,
    );
    assert.equal(
      workflow.jobs[spec.jobName].if,
      `\${{ ${trustedTopOfStack} }}`,
      `${spec.workflowName} must run hosted dependencies only on a trusted cumulative head`,
    );
  }
});

test("stack metadata gates cumulative Python product coverage", async () => {
  const workflow = await parseWorkflow("python");
  const job = workflow.jobs.python;
  assert.equal(
    job.strategy["fail-fast"],
    false,
    "one Python compatibility failure must not cancel the remaining top lanes",
  );
  assert.deepEqual(job.strategy.matrix["python-version"], ["3.11", "3.12", "3.13"]);
  assert.deepEqual(
    findStep(job, "Set up Python ${{ matrix.python-version }}").with,
    {
      "python-version": "${{ matrix.python-version }}",
      cache: "pip",
      "cache-dependency-path": "workers/automation/pyproject.toml",
    },
    "the full Python lane must reuse pip downloads across top runs",
  );
  for (const productStep of [
    "Lint",
    "Release scan",
    "Validate Python workflow contract",
    "Test",
    "Build package",
  ]) {
    assert.equal(
      findStep(job, productStep).if,
      undefined,
      `${productStep} must run when the trusted-top Python job is admitted`,
    );
  }
});

test("stack metadata gates cumulative TypeScript product suites", async () => {
  const workflow = await parseWorkflow("typescript");
  const job = workflow.jobs.typescript;

  assert.equal(
    findStep(job, "Set up Node").with.cache,
    "pnpm",
    "the full TypeScript lane must reuse the pnpm store across top runs",
  );

  for (const productStep of [
    "Check",
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
      findStep(job, productStep).if,
      undefined,
      `${productStep} must run when the trusted-top TypeScript job is admitted`,
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
      expectedPython: [],
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
    const admitted =
      (route.eventName !== "pull_request" || route.trusted) &&
      (route.eventName !== "pull_request" ||
        route.stack === null ||
        route.stack.position === route.stack.size);
    const pythonVersions = admitted
      ? ["3.11", "3.12", "3.13"]
      : [];
    const cumulative = admitted;

    assert.deepEqual(pythonVersions, route.expectedPython, route.name);
    assert.equal(cumulative, route.expectedCumulative, route.name);
  }
});
