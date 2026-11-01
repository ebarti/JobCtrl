import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const script = fileURLToPath(new URL("./release-resume-pypi.sh", import.meta.url));
const digest = (bytes) => createHash("sha256").update(bytes).digest("hex");
const required = [
  "Resolve the audited release identity and protected public trust",
  "Build unsigned candidate once",
  "Preflight checkout-free GitHub publication access",
  "Sign and notarize on a fresh protected runner",
  "Package signed audit evidence without credentials",
  "Qualify the latest stable transition",
  "Publish the signed immutable candidate from a fresh runner",
  "Smoke public assets and verify the native and Homebrew lifecycles",
  "Atomically promote only the signer-rooted pointer",
  "Publish the verified stable Homebrew formula",
];

test("PyPI resumption accepts only the verified release and its successful original gates", async (context) => {
  assert.doesNotMatch(
    await readFile(script, "utf8"),
    /^\s*\[\[.*\]\]\s*$/m,
    "a bare Bash assertion may not stop the system shell",
  );
  const root = await mkdtemp(path.join(os.tmpdir(), "jobctrl-pypi-resume-test-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  const bin = path.join(root, "bin");
  await mkdir(bin);
  const fakeGh = `#!${process.execPath}
const fs = require('node:fs');
const state = JSON.parse(fs.readFileSync(process.env.TASK_STATE, 'utf8'));
const args = process.argv.slice(2);
fs.appendFileSync(process.env.TASK_CALLS, JSON.stringify(args) + '\\n');
if (args[0] === 'api') {
  const endpoint = args[1];
  if (endpoint.includes('/commits/')) process.stdout.write(endpoint.endsWith(state.tag) ? state.source : state.recovery);
  else if (endpoint.includes('/compare/')) process.stdout.write(endpoint.includes(state.recovery + '...main') ? state.recoveryRelation : state.sourceRelation);
  else if (endpoint.includes('/actions/runs/') && endpoint.includes('/jobs?')) process.stdout.write(JSON.stringify({jobs: state.jobs}));
  else if (endpoint.includes('/actions/runs/')) process.stdout.write(JSON.stringify(state.run));
  else if (endpoint.endsWith('/releases/latest')) process.stdout.write(state.latest);
  else process.exit(7);
} else if (args[0] === 'release' && args[1] === 'view') process.stdout.write(JSON.stringify(state.release));
else if (args[0] === 'release' && args[1] === 'verify') process.stdout.write('verified');
else process.exit(8);
`;
  const fakeGit = `#!${process.execPath}
const state = JSON.parse(require('node:fs').readFileSync(process.env.TASK_STATE, 'utf8'));
const args = process.argv.slice(2);
if (args[0] === 'rev-parse') process.stdout.write(state.recovery);
else if (args[0] === 'show') process.stdout.write('1700000000');
else process.exit(9);
`;
  const fakeCurl = `#!${process.execPath}
const fs = require('node:fs');
const state = JSON.parse(fs.readFileSync(process.env.TASK_STATE, 'utf8'));
const args = process.argv.slice(2);
if (!args.includes('https://releases.jobctrl.dev/v1/stable/darwin-arm64.json')) process.exit(10);
fs.writeFileSync(args[args.indexOf('-o') + 1], state.pointer);
`;
  for (const [name, contents] of [["gh", fakeGh], ["git", fakeGit], ["curl", fakeCurl]]) {
    await writeFile(path.join(bin, name), contents);
    await chmod(path.join(bin, name), 0o755);
  }

  const source = "a".repeat(40), recovery = "b".repeat(40), tag = "v0.3.5";
  const pointer = `${JSON.stringify({ channel: "stable", sequence: 13, buildId: `0.3.5-${source}-darwin-arm64` })}\n`;
  const baseline = {
    source, recovery, tag, pointer, recoveryRelation: "ahead", sourceRelation: "ahead", latest: tag,
    run: { path: ".github/workflows/release-distribution.yml", event: "workflow_dispatch", head_branch: tag, head_sha: source, status: "completed", conclusion: "failure" },
    jobs: [...required.map((name) => ({ name, conclusion: "success" })), { name: "Publish the verified GitHub Release", conclusion: "failure" }],
    release: { isDraft: false, isPrerelease: false, isImmutable: true, targetCommitish: source, assets: [{ name: "channel-pointer.json", digest: `sha256:${digest(pointer)}` }] },
  };
  const cases = [
    ["verified", () => {}, true],
    ["identical commits", (s) => { s.recoveryRelation = "identical"; s.sourceRelation = "identical"; }, true],
    ["invalid tag", (_s, env) => { env.RELEASE_TAG = "not-a-version"; }, false, true],
    ["invalid sequence", (_s, env) => { env.RELEASE_SEQUENCE = "0"; }, false, true],
    ["invalid pointer digest", (_s, env) => { env.EXPECTED_CHANNEL_POINTER_SHA256 = "invalid"; }, false, true],
    ["invalid recovery sha", (_s, env) => { env.GITHUB_SHA = "invalid"; }, false, true],
    ["invalid key id", (_s, env) => { env.JOBCTRL_RELEASE_KEY_ID = "invalid key"; }, false, true],
    ["wrong recovery ref", (_s, env) => { env.GITHUB_REF = "refs/tags/unrelated"; }, false, true],
    ["invalid original run", (_s, env) => { env.GITHUB_REF = `refs/tags/${tag}-pypi-resume.0`; }, false, true],
    ["wrong original commit", (s) => { s.run.head_sha = "c".repeat(40); }, false],
    ["missing signing proof", (s) => { s.jobs.find((j) => j.name.startsWith("Sign and notarize")).conclusion = "failure"; }, false],
    ["missing lifecycle proof", (s) => { s.jobs.find((j) => j.name.startsWith("Smoke public assets")).conclusion = "skipped"; }, false],
    ["mutable release", (s) => { s.release.isImmutable = false; }, false],
    ["stale latest release", (s) => { s.latest = "v0.5.0"; }, false],
    ["different live pointer", (s) => { s.pointer += " "; }, false],
    ["unrelated recovery commit", (s) => { s.recoveryRelation = "diverged"; }, false],
    ["unrelated source commit", (s) => { s.sourceRelation = "diverged"; }, false],
  ];
  for (const [label, mutate, accepted, noGh] of cases) {
    const state = structuredClone(baseline);
    const overrides = {};
    mutate(state, overrides);
    const dir = path.join(root, label.replaceAll(" ", "-"));
    await mkdir(dir);
    const statePath = path.join(dir, "state.json"), output = path.join(dir, "output"), calls = path.join(dir, "calls");
    await writeFile(statePath, JSON.stringify(state));
    await writeFile(output, "");
    // GitHub's macOS runners also ship Bash 3.2 at this path. A newer Bash
    // earlier in PATH must not hide differences in fail-closed behavior.
    const shell = process.platform === "darwin" ? "/bin/bash" : "bash";
    const result = spawnSync(shell, [script], {
      encoding: "utf8", timeout: 10000,
      env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, TASK_STATE: statePath, TASK_CALLS: calls, RUNNER_TEMP: dir, GITHUB_OUTPUT: output, GITHUB_REPOSITORY: "fixture/repo", GITHUB_REF: `refs/tags/${tag}-pypi-resume.123`, GITHUB_SHA: recovery, RELEASE_TAG: tag, RELEASE_SEQUENCE: "13", EXPECTED_CHANNEL_POINTER_SHA256: digest(pointer), JOBCTRL_RELEASE_PUBLIC_KEY: Buffer.alloc(32, 1).toString("base64"), JOBCTRL_RELEASE_KEY_ID: "fixture-key", ...overrides },
    });
    assert.equal(result.status === 0, accepted, `${label}: ${result.stderr}`);
    const value = await readFile(output, "utf8");
    if (accepted) {
      assert.match(value, new RegExp(`source_commit=${source}`));
      assert.match(value, /original_run_id=123/);
      assert.match(value, /source_date_epoch=1700000000/);
      assert.match(await readFile(calls, "utf8"), /"release","verify"/);
    } else {
      assert.equal(value, "", `${label} must fail before authorizing PyPI`);
      if (noGh) {
        const recorded = await readFile(calls, "utf8").catch((error) => {
          if (error.code === "ENOENT") return "";
          throw error;
        });
        assert.equal(recorded, "", `${label} must fail before querying GitHub`);
      }
    }
  }
});
