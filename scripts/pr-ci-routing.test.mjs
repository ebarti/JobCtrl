import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { parseDiff, planPullRequest, selectSurfaces, SUITE_CONTEXTS, SURFACES } from "./pr-ci-routing.mjs";

const helper = fileURLToPath(new URL("./pr-ci-routing.mjs", import.meta.url));
const names = (scope) => Object.entries(scope.selected).filter(([, selected]) => selected).map(([key]) => key).sort();
const changed = (path, status = "M") => ({ path, status });
const assertFull = (scope) => {
  assert.equal(scope.mode, "full");
  assert.deepEqual(names(scope), [...SURFACES].sort());
  assert.equal(scope.headPrivacy, true);
};

test("ordinary surface changes select complete real consumer groups", () => {
  for (const [path, expected] of [
    ["docs/user/getting-started.md", ["docs"]],
    ["docs/plans/synthetic-plan.md", []],
    ["docs/incidents/synthetic-incident.md", []],
    ["docs/decisions.md", []],
    ["docs/research/interview-preparation/compiler-input.json", ["docs", "python"]],
    ["apps/web/src/views/Overview.tsx", ["demo", "e2e", "storybook", "web"]],
    ["apps/web/src/views/outreach/Contact.tsx", ["demo", "e2e", "python", "storybook", "web"]],
    ["apps/web/e2e/screening.spec.ts", ["demo", "e2e", "python", "storybook", "web"]],
    ["apps/web/src/styles/tokens.css", ["demo", "docs", "e2e", "storybook", "web"]],
    ["apps/api/src/jobs.ts", ["api", "e2e"]],
    ["apps/api/src/outreach.ts", ["api", "e2e", "python"]],
    ["workers/automation/src/jobctrl/domain/jobs.py", ["api", "e2e", "launcher", "python"]],
    ["workers/automation/tests/test_saved_posting_availability_runtime.py", ["api", "e2e", "launcher", "python"]],
    ["apps/extension/src/background.ts", ["extension"]],
    ["apps/demo-edge/src/worker.ts", ["edge"]],
  ]) {
    const result = selectSurfaces([changed(path)]);
    assert.equal(result.mode, "affected", path);
    assert.equal(result.headPrivacy, false, path);
    assert.deepEqual(names(result), expected, path);
    assert.equal(Object.keys(result.selected).length, 13);
  }
});

test("shared, dependency, CI, privacy, migration and submission inputs retain full proof", () => {
  for (const path of [
    ".github/workflows/python.yml", ".github/dependabot.yml", "scripts/dev-supervisor.mjs",
    "packages/shared/src/contracts.ts", "packaging/distribution/api-native/package.json", "launcher/internal/launcher/run.go",
    "pnpm-lock.yaml", "pnpm-workspace.yaml", "workers/automation/uv.lock", "workers/automation/pyproject.toml",
    "apps/web/tsconfig.json", ".npmrc", ".node-version", ".python-version", "launcher/go.sum",
    "docs/public/install.sh", "apps/extension/public/manifest.json", "apps/api/src/credentials.ts",
    "apps/api/src/config.ts", "apps/api/src/contracts.ts", "apps/api/src/db.ts", "apps/api/src/schema-manifest.ts",
    "apps/api/test/credential-mutation-lock.test.ts", "apps/api/test/native-credential-store.test.ts",
    "apps/api/test/support/reopen-exact-v8.ts", "workers/automation/src/jobctrl/infrastructure/migrations/v15.py",
    "workers/automation/src/jobctrl/domain/apply/models.py", "workers/automation/src/jobctrl/infrastructure/apply/browser.py",
    "workers/automation/src/jobctrl/apply/submit.py", "workers/automation/src/jobctrl/infrastructure/gmail/token.py",
    "workers/automation/src/jobctrl/infrastructure/database.py", "workers/automation/src/jobctrl/runtime.py",
    "workers/automation/tests/test_v15_migration.py", "workers/automation/tests/v6_migration_fixture.py",
    "workers/automation/tests/fixtures/shipped_v6_schema.sql", "workers/automation/tests/test_gmail_token_privacy.py",
    "workers/automation/tests/test_gmail_windows_acl.py", "README.md", "SECURITY.md", "new-product/new-surface.ts",
  ]) assertFull(selectSurfaces([changed(path), changed("docs/user/getting-started.md")]));
  assertFull(selectSurfaces([]));
  assertFull(selectSurfaces([changed("docs/user/getting-started.md", "T")]));
  assertFull(selectSurfaces([changed("docs/../unregistered") ]));
});

test("NUL diff parsing preserves names and rejects incomplete or unknown formats", () => {
  assert.deepEqual(parseDiff(Buffer.from("D\0docs/old name.md\0A\0apps/web/src/with\nnewline.tsx\0")), [
    changed("docs/old name.md", "D"), changed("apps/web/src/with\nnewline.tsx", "A"),
  ]);
  for (const raw of ["M\0docs/lost.md", "M\0", "R100\0docs/old.md\0docs/new.md\0", "X\0docs/x.md\0"]) {
    assert.throws(() => parseDiff(Buffer.from(raw)));
  }
  assert.throws(() => parseDiff(Buffer.from([77, 0, 255, 0])));
});

function fixture(t, mutate = (f) => f.write("docs/user/getting-started.md", "changed\n")) {
  const root = mkdtempSync(join(tmpdir(), "jobctrl-ci-scope-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const repository = join(root, "repo");
  const home = join(root, "home");
  const temporary = join(root, "tmp");
  for (const path of [repository, home, temporary]) mkdirSync(path);
  const environment = {
    ...process.env, HOME: home, TMPDIR: temporary, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_AUTHOR_NAME: "Synthetic CI", GIT_AUTHOR_EMAIL: "synthetic@example.invalid",
    GIT_COMMITTER_NAME: "Synthetic CI", GIT_COMMITTER_EMAIL: "synthetic@example.invalid",
    GIT_AUTHOR_DATE: "2026-01-01T00:00:00Z", GIT_COMMITTER_DATE: "2026-01-01T00:00:00Z",
    GITHUB_EVENT_NAME: "pull_request", GITHUB_REPOSITORY: "example/JobCtrl", GITHUB_REF: "refs/pull/17/merge",
    GITHUB_RUN_ID: "99123", GITHUB_RUN_ATTEMPT: "2",
  };
  const git = (...args) => execFileSync("git", ["-c", "core.hooksPath=/dev/null", "-c", "commit.gpgsign=false", "-C", repository, ...args], { env: environment, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
  const write = (path, content) => { const target = join(repository, path); mkdirSync(dirname(target), { recursive: true }); writeFileSync(target, content); };
  git("init", "-b", "main");
  write("scripts/pr-ci-routing.mjs", readFileSync(helper));
  for (const path of ["docs/user/getting-started.md", "apps/api/src/jobs.ts", "workers/automation/src/jobctrl/domain/jobs.py"]) write(path, "base\n");
  git("add", ".");
  git("commit", "-m", "chore: synthetic base");
  const base = git("rev-parse", "HEAD");
  git("checkout", "-b", "candidate");
  const f = { root, repository, environment, git, write };
  mutate(f);
  git("add", "--all");
  git("commit", "--allow-empty", "-m", "test: synthetic candidate");
  const head = git("rev-parse", "HEAD");
  const merge = git("commit-tree", `${head}^{tree}`, "-p", base, "-p", head, "-m", "Synthetic tested merge");
  git("checkout", "--detach", merge);
  environment.GITHUB_SHA = merge;
  const repo = { id: 42, full_name: "example/JobCtrl", default_branch: "main" };
  const event = { number: 17, repository: repo, pull_request: { number: 17, base: { ref: "main", sha: base, repo: { ...repo } }, head: { sha: head, repo: { ...repo } }, merge_commit_sha: merge } };
  return { ...f, event, base, head, merge, policy: base, plan(options = {}) { return planPullRequest({ event, repository, environment, policy: base, ...options }); } };
}

test("trusted proof binds repository, PR, producer, base, head, merge and helper blob", (t) => {
  const f = fixture(t);
  const proof = f.plan();
  assert.equal(proof.schemaVersion, 1);
  assert.deepEqual(proof.repository, { id: 42, fullName: "example/JobCtrl" });
  assert.equal(proof.pullRequest, 17);
  assert.deepEqual(proof.run, { id: 99123, attempt: 2 });
  assert.equal(proof.mergeSha, f.merge);
  assert.equal(proof.head.sha, f.head);
  assert.equal(proof.base.sha, f.base);
  assert.deepEqual(proof.policy, { commit: f.base, blob: f.git("rev-parse", `${f.base}:scripts/pr-ci-routing.mjs`) });
  assert.deepEqual(names(proof), ["docs"]);
  assert.equal(Object.keys(proof.contexts).length, 18);
  assert.equal(proof.contexts["Release check"], true);
  assert.equal(proof.contexts["Script unit tests"], true);
  assert.equal(proof.contexts["Build (dead-link gate)"], true);
  for (const python of ["Python / Python 3.12"]) assert.equal(proof.contexts[python], false);
  assert.equal(new Set(Object.values(SUITE_CONTEXTS).flat()).size, 16);
});

test("credential ownership tests retain every native adapter OS context", (t) => {
  const f = fixture(t, ({ write }) => write("apps/api/test/credential-mutation-lock.test.ts", "synthetic ownership regression\n"));
  const proof = f.plan();
  assertFull(proof);
  for (const os of ["macos-latest", "windows-latest", "ubuntu-latest"]) assert.equal(proof.contexts[`Native credentials (${os})`], true);
});

test("forks, stacked bases and moving policies expand every group", (t) => {
  const f = fixture(t);
  const fork = structuredClone(f.event);
  fork.pull_request.head.repo = { id: 99, full_name: "fork/JobCtrl" };
  assertFull(f.plan({ event: fork }));
  const stacked = structuredClone(f.event);
  stacked.pull_request.base.ref = "stack-parent";
  assertFull(f.plan({ event: stacked }));
  const movingPolicy = f.git("commit-tree", `${f.base}^{tree}`, "-p", f.base, "-m", "New default-main policy");
  const proof = f.plan({ policy: movingPolicy });
  assertFull(proof);
  assert.equal(proof.policy.commit, movingPolicy);
  assert.equal(proof.reason, "moving-policy-base");
});

test("malformed event or producer identities cannot publish an affected scope", (t) => {
  const f = fixture(t);
  for (const mutate of [
    (event) => { event.repository.id = 0; },
    (event) => { event.number = 18; },
    (event) => { event.pull_request.base.repo.id = 100; },
    (event) => { event.pull_request.head.sha = "not-a-sha"; },
    (event) => { delete event.pull_request.head.repo; },
  ]) {
    const event = structuredClone(f.event);
    mutate(event);
    assert.throws(() => f.plan({ event }));
  }
  for (const overrides of [
    { GITHUB_REPOSITORY: "other/JobCtrl" }, { GITHUB_EVENT_NAME: "push" },
    { GITHUB_REF: "refs/pull/18/merge" }, { GITHUB_RUN_ID: "1e3" },
    { GITHUB_RUN_ATTEMPT: "0" }, { GITHUB_SHA: f.head },
  ]) assert.throws(() => f.plan({ environment: { ...f.environment, ...overrides } }));
});

test("the exact merge parents prove a candidate despite null or stale event merge metadata", (t) => {
  const f = fixture(t);
  const event = structuredClone(f.event);
  for (const metadata of [null, f.base]) {
    event.pull_request.merge_commit_sha = metadata;
    assert.deepEqual(names(f.plan({ event })), ["docs"]);
  }
  const extra = f.git("commit-tree", `${f.head}^{tree}`, "-p", f.head, "-m", "Extra merge parent");
  for (const parents of [[f.head, f.base], [f.base], [f.base, f.head, extra]]) {
    const wrong = f.git("commit-tree", `${f.head}^{tree}`, ...parents.flatMap((sha) => ["-p", sha]), "-m", "Wrong merge parents");
    f.git("checkout", "--detach", wrong);
    assert.throws(() => f.plan({ event, environment: { ...f.environment, GITHUB_SHA: wrong } }), /parents/);
  }
});

test("missing objects, wrong checkout and a changed policy helper block", (t) => {
  const f = fixture(t);
  assert.throws(() => f.plan({ policy: "1".repeat(40) }), /Git objects/);
  const emptyTree = f.git("hash-object", "-t", "tree", "-w", "--stdin");
  const absentHelperPolicy = f.git("commit-tree", emptyTree, "-p", f.base, "-m", "Policy missing the helper");
  assert.throws(() => f.plan({ policy: absentHelperPolicy }), /policy blob/);
  const absentHead = structuredClone(f.event);
  absentHead.pull_request.head.sha = "2".repeat(40);
  assert.throws(() => f.plan({ event: absentHead }), /Git objects/);
  f.git("checkout", "--detach", f.head);
  assert.throws(() => f.plan(), /Checkout/);
  f.write("scripts/pr-ci-routing.mjs", `${readFileSync(helper, "utf8")}\n// A different policy blob.\n`);
  f.git("add", ".");
  f.git("commit", "-m", "test: different policy helper");
  const policy = f.git("rev-parse", "HEAD");
  f.git("checkout", "--detach", f.merge);
  assert.throws(() => f.plan({ policy }), /policy blob/);
});

test("deletions and both rename sides retain their owners", (t) => {
  const f = fixture(t, ({ repository }) => {
    renameSync(join(repository, "docs/user/getting-started.md"), join(repository, "apps/api/src/renamed.ts"));
    rmSync(join(repository, "workers/automation/src/jobctrl/domain/jobs.py"));
  });
  assert.deepEqual(names(f.plan()), ["api", "docs", "e2e", "launcher", "python"]);
});

test("complete local diffs exceed hosted file-list limits and preserve unusual names", (t) => {
  const f = fixture(t, ({ write }) => {
    for (let index = 0; index < 450; index += 1) write(`docs/user/generated-${index}.md`, "synthetic\n");
    write("apps/web/src/with\nnewline-and-ü.tsx", "synthetic\n");
  });
  assert.deepEqual(names(f.plan()), ["demo", "docs", "e2e", "storybook", "web"]);
});

test("an actual file type change and an empty tree diff expand scope", (t) => {
  const typed = fixture(t, ({ repository }) => {
    const path = join(repository, "docs/user/getting-started.md");
    rmSync(path);
    symlinkSync("../../apps/api/src/jobs.ts", path);
  });
  assertFull(typed.plan());
  assertFull(fixture(t, () => {}).plan());
});

test("a merge-resolution surface is included even when absent from head", (t) => {
  const f = fixture(t);
  f.write("apps/web/src/views/merge-resolution.tsx", "synthetic merge resolution\n");
  f.git("add", ".");
  const tree = f.git("write-tree");
  const merge = f.git("commit-tree", tree, "-p", f.base, "-p", f.head, "-m", "Additional merge resolution");
  f.git("checkout", "--detach", merge);
  const event = structuredClone(f.event);
  event.pull_request.merge_commit_sha = merge;
  assert.deepEqual(names(f.plan({ event, environment: { ...f.environment, GITHUB_SHA: merge } })), ["demo", "docs", "e2e", "storybook", "web"]);
});

test("candidate diff drivers and inherited Git overrides never execute", (t) => {
  const f = fixture(t);
  const marker = join(f.root, "executed");
  const driver = join(f.root, "hostile-driver");
  writeFileSync(driver, `#!/bin/sh\ntouch '${marker}'\n`, { mode: 0o755 });
  f.git("config", "diff.external", driver);
  f.git("config", "diff.hostile.textconv", driver);
  f.git("config", "log.showSignature", "true");
  f.git("config", "gpg.program", driver);
  assert.deepEqual(names(f.plan({ environment: { ...f.environment, GIT_DIR: "/nonexistent", GIT_EXTERNAL_DIFF: driver } })), ["docs"]);
  assert.equal(existsSync(marker), false);
});

function cli(f, { event = f.event, policy = f.base, notice = true, source = helper, output = join(f.root, "outputs"), extra = [] } = {}) {
  const eventPath = join(f.root, "event.json");
  writeFileSync(eventPath, typeof event === "string" ? event : JSON.stringify(event));
  const args = [source, "--event", eventPath, "--repository", f.repository, "--policy", policy, "--output", output, ...extra];
  if (notice) args.push("--notice");
  return { ...spawnSync(process.execPath, args, { env: f.environment, encoding: "utf8" }), output };
}

test("CLI atomically publishes fourteen literal booleans and one compact bound notice", (t) => {
  const f = fixture(t);
  const output = join(f.root, "outputs");
  writeFileSync(output, "existing=true\n");
  const result = cli(f, { output });
  assert.equal(result.status, 0, result.stderr);
  const lines = readFileSync(output, "utf8").trimEnd().split("\n");
  assert.equal(lines.shift(), "existing=true");
  assert.equal(lines.length, 14);
  assert.ok(lines.every((line) => /^[a-z_0-9]+=(true|false)$/.test(line)));
  assert.deepEqual(lines.map((line) => line.split("=")[0]), [...SURFACES, "head_privacy"]);
  const notice = result.stdout.match(/^::notice title=JobCtrl CI scope v1::([^\n]+)\n$/);
  assert.ok(notice, result.stdout);
  assert.deepEqual(JSON.parse(notice[1]), f.plan());
  assert.equal(readdirSync(f.root).some((name) => name.endsWith(".tmp")), false);
  assert.equal(cli(f, { notice: false }).stdout, "");
});

test("CLI failures leave accepted output bytes and emit no scope notice", (t) => {
  const f = fixture(t);
  const output = join(f.root, "outputs");
  writeFileSync(output, "accepted=true\n");
  for (const options of [
    { event: "{malformed" }, { policy: "1".repeat(40) },
    { extra: ["--unknown"] }, { extra: ["--policy", f.base] },
  ]) {
    const result = cli(f, { output, ...options });
    assert.notEqual(result.status, 0);
    assert.equal(result.stdout, "");
    assert.equal(readFileSync(output, "utf8"), "accepted=true\n");
  }
  const linked = join(f.root, "linked-output");
  symlinkSync(output, linked);
  assert.notEqual(cli(f, { output: linked }).status, 0);
  assert.equal(readFileSync(output, "utf8"), "accepted=true\n");
});

test("CLI executes the accepted helper when invoked through a symlink", (t) => {
  const f = fixture(t);
  const linked = join(f.root, "linked-helper.mjs");
  symlinkSync(helper, linked);
  const result = cli(f, { source: linked });
  assert.equal(result.status, 0, result.stderr);
  assert.ok(existsSync(result.output), "symlinked invocation must run the CLI");
  assert.match(readFileSync(result.output, "utf8"), /^docs=true$/m);
});

test("only the accepted helper runs; changed head code cannot choose its own scope", (t) => {
  const f = fixture(t, ({ write }) => write("scripts/pr-ci-routing.mjs", "throw new Error('candidate helper executed');\n"));
  const result = cli(f);
  assert.equal(result.status, 0, result.stderr);
  assert.ok(readFileSync(result.output, "utf8").trimEnd().split("\n").every((line) => line.endsWith("=true")));
  const otherSource = join(f.root, "modified-helper.mjs");
  writeFileSync(otherSource, `${readFileSync(helper, "utf8")}\n// Different helper bytes.\n`);
  const refused = cli(f, { source: otherSource });
  assert.notEqual(refused.status, 0);
  assert.match(refused.stderr, /policy blob/);
});
