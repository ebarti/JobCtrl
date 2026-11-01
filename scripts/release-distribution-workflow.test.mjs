import assert from "node:assert/strict";
import { spawnSync, execFileSync } from "node:child_process";
import { readdirSync, readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const workflowUrl = new URL(
  "../.github/workflows/release-distribution.yml",
  import.meta.url,
);

function loadYaml(url) {
  const source =
    "require 'yaml'; require 'json'; puts JSON.generate(YAML.safe_load(File.read(ARGV[0]), permitted_classes: [], permitted_symbols: [], aliases: false))";
  return JSON.parse(
    execFileSync("ruby", ["-e", source, fileURLToPath(url)], {
      encoding: "utf8",
    }),
  );
}

function stepRun(workflow, jobName, stepName) {
  const step = workflow.jobs[jobName].steps.find(
    (candidate) => candidate.name === stepName,
  );
  assert.ok(step, `${jobName} must contain ${stepName}`);
  assert.equal(typeof step.run, "string", `${stepName} must be a run step`);
  return step.run;
}

function shellFunction(source, name) {
  const match = source.match(
    new RegExp(`^${name}\\(\\) \\{\\n[\\s\\S]*?^\\}`, "m"),
  );
  assert.ok(match, `missing ${name} shell function`);
  return match[0];
}

function sha256(content) {
  return createHash("sha256").update(content).digest("hex");
}

function assertShellSyntax(label, source) {
  const result = spawnSync("bash", ["-n"], { input: source, encoding: "utf8" });
  assert.equal(result.status, 0, `${label}: ${result.stderr}`);
}

test("notarization diagnostics find synthetic payloads under the operating system temporary directory", async (context) => {
  const { mkdir } = await import("node:fs/promises");
  const root = await mkdtemp(path.join(os.tmpdir(), "jobctrl-notary-diagnostics-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  const fixtureTemp = path.join(root, "system-temp"), runnerTemp = path.join(root, "runner-temp");
  await mkdir(fixtureTemp);
  await mkdir(runnerTemp);
  for (const [url, job, step, relative, message] of [
    [workflowUrl, "verify-released-upgrades", "Diagnose a retained predecessor notarization failure", "jobctrl-released-upgrades-fixture/latest-stable/runtime/staging/digest", "Rechecking the retained predecessor"],
  ]) {
    const binary = path.join(fixtureTemp, relative, "payload/api/node_modules/better-sqlite3/build/Release/better_sqlite3.node");
    await mkdir(path.dirname(binary), { recursive: true });
    await writeFile(binary, "synthetic");
    const run = stepRun(loadYaml(url), job, step);
    const result = spawnSync("/bin/bash", ["-c", run], {
      encoding: "utf8", env: { ...process.env, TMPDIR: fixtureTemp, RUNNER_TEMP: runnerTemp },
    });
    assert.equal(result.status, 0, result.stderr);
    assert.ok(result.stdout.includes(message), `${step} did not find its retained fixture: ${result.stdout}`);
    assert.doesNotMatch(result.stdout, /No retained .* SQLite binary/);
  }
});

test("release lineage gates reject non-ancestor commits under the system shell", () => {
  const workflow = loadYaml(workflowUrl);
  const guards = [];
  for (const [jobName, job] of Object.entries(workflow.jobs)) {
    for (const step of job.steps ?? []) {
      const lines = (step.run ?? "").split("\n");
      for (let index = 0; index < lines.length; index += 1) {
        if (/^\s*main_relation=/.test(lines[index])) {
          const guard = lines
            .slice(index + 1)
            .find((line) => line.includes("$main_relation"))
            ?.trim();
          assert.ok(guard, `${jobName}: missing main lineage guard`);
          guards.push({ jobName, guard });
        }
      }
    }
  }
  assert.ok(guards.length > 0, "release workflow must check main lineage");
  const shell = process.platform === "darwin" ? "/bin/bash" : "bash";
  for (const { jobName, guard } of guards) {
    for (const [relation, accepted] of [
      ["ahead", true], ["identical", true], ["diverged", false],
      ["behind", false], ["unknown", false], ["", false],
    ]) {
      const result = spawnSync(
        shell,
        ["-c", `set -euo pipefail\nmain_relation=$1\n${guard}\nprintf accepted`, "release-lineage-test", relation],
        { encoding: "utf8", env: { ...process.env, BASH_ENV: "" } },
      );
      assert.equal(result.status === 0, accepted, `${jobName}: ${JSON.stringify(relation)}: ${result.stderr}`);
      assert.equal(result.stdout === "accepted", accepted, `${jobName}: unexpected continuation for ${JSON.stringify(relation)}`);
    }
  }
});

test("release workflow input validation fails closed under the system shell", () => {
  const workflow = loadYaml(workflowUrl);
  const samples = {
    JOBCTRL_RELEASE_KEY_ID: ["fixture-key", "invalid key"],
    R2_ACCOUNT_ID: ["a".repeat(32), "invalid"],
    R2_BUCKET: ["jobctrl-release", "invalid_bucket"],
    GITHUB_RUN_ID: ["123", "invalid"],
    GITHUB_RUN_ATTEMPT: ["1", "invalid"],
    RELEASE_TAG: ["v0.4.0", "invalid"],
    RELEASE_SEQUENCE: ["14", "0"],
    EXPECTED_SOURCE_COMMIT: ["a".repeat(40), "invalid"],
    EXPECTED_CHANNEL_POINTER_SHA256: ["a".repeat(64), "invalid"],
  };
  const shell = process.platform === "darwin" ? "/bin/bash" : "bash";
  let count = 0;
  for (const [jobName, job] of Object.entries(workflow.jobs)) {
    for (const step of job.steps ?? []) {
      assert.doesNotMatch(
        step.run ?? "",
        /^\s*\[\[.*\]\]\s*$/m,
        `${jobName}: a bare Bash assertion may not stop the system shell`,
      );
      for (const line of (step.run ?? "").split("\n")) {
        const match = line.match(/^\s*\[\[\s*"\$([A-Z0-9_]+)"\s*=~/);
        if (!match) continue;
        const name = match[1];
        assert.ok(samples[name], `${jobName}: add validation samples for ${name}`);
        count += 1;
        for (const [value, accepted] of [[samples[name][0], true], [samples[name][1], false]]) {
          const result = spawnSync(
            shell,
            ["-c", `set -euo pipefail\n${name}=$1\n${line.trim()}\nprintf accepted`, "release-input-test", value],
            { encoding: "utf8", env: { ...process.env, BASH_ENV: "" } },
          );
          assert.equal(result.status === 0, accepted, `${jobName}: ${name}=${JSON.stringify(value)}: ${result.stderr}`);
          assert.equal(result.stdout === "accepted", accepted, `${jobName}: unexpected continuation for ${name}`);
        }
      }
    }
  }
  assert.ok(count > 0, "release workflow must validate its inputs");
});

test("release workflow binds creation, reuse, and final readback to curated notes", async () => {
  const source = await readFile(workflowUrl, "utf8");
  const workflow = loadYaml(workflowUrl);
  const resolve = stepRun(
    workflow,
    "resolve",
    "Require explicit revocations, protected trust, and blocked tracked policy",
  );
  const preflight = stepRun(
    workflow,
    "publication-preflight",
    "Prove checkout-free release commands before signing",
  );
  const draft = stepRun(
    workflow,
    "publish-immutable",
    "Create or verify the rerunnable GitHub draft candidate",
  );
  const publish = stepRun(
    workflow,
    "publish-github-release",
    "Verify asset digests, enforce immutability, and publish",
  );
  for (const [label, run] of Object.entries({ resolve, preflight, draft, publish }))
    assertShellSyntax(label, run);

  assert.match(resolve, /release_notes_path="\.github\/releases\/\$RELEASE_TAG\.md"/);
  assert.match(resolve, /test -f "\$release_notes_path" && test ! -L "\$release_notes_path"/);
  assert.match(resolve, /grep -q '\[\^\[:space:\]\]' "\$release_notes_path"/);
  assert.match(resolve, /release_notes_sha256=/);
  assert.match(source, /name: jobctrl-release-notes-\$\{\{ github\.run_id \}\}/);

  assert.match(preflight, /--json isDraft,targetCommitish,tagName,body/);
  assert.match(preflight, /require_exact_release_body "\$release"/);
  assert.ok(
    draft.indexOf("require_exact_release_body \"$draft\"") <
      draft.indexOf('require_asset_digest "$draft" "$asset"'),
    "an existing release body must be verified before any asset reuse",
  );
  assert.match(draft, /gh release create[^\n]+--notes-file "\$notes"/);
  assert.ok(
    draft.indexOf("created-release-body.md") >
      draft.indexOf("gh release create"),
    "a newly created draft must be read back and compared",
  );
  assert.doesNotMatch(source, /--generate-notes/);

  assert.ok(
    publish.indexOf("final-existing-release-body.md") <
      publish.indexOf("gh release upload"),
    "the reused draft body must be checked before smoke upload",
  );
  assert.ok(
    publish.indexOf("final-draft-release-body.md") <
      publish.indexOf("gh release edit"),
    "the complete draft body must be checked before publication",
  );
  assert.ok(
    publish.indexOf("published-release-body.md") >
      publish.indexOf('test "$immutable" = true'),
    "the final immutable release readback must compare the exact notes",
  );
});

test("curated notes contract rejects blank, stale, and generated substitutions", async (context) => {
  const workflow = loadYaml(workflowUrl);
  const draft = stepRun(
    workflow,
    "publish-immutable",
    "Create or verify the rerunnable GitHub draft candidate",
  );
  const requireCurated = shellFunction(
    draft,
    "require_curated_release_notes",
  );
  const requireExact = shellFunction(draft, "require_exact_release_body");
  const temporary = await mkdtemp(
    path.join(os.tmpdir(), "jobctrl-release-notes-contract-"),
  );
  context.after(() => rm(temporary, { recursive: true, force: true }));
  const runner = path.join(temporary, "verify.sh");
  await writeFile(
    runner,
    `set -euo pipefail
notes="$1"
release_json="$2"
body_file="$3"
EXPECTED_RELEASE_NOTES_SHA256="$4"
${requireCurated}
${requireExact}
require_curated_release_notes "$notes"
require_exact_release_body "$release_json" "$body_file"
`,
  );

  const version = JSON.parse(
    await readFile(new URL("../package.json", import.meta.url), "utf8"),
  ).version;
  const curated = await readFile(
    new URL(`../.github/releases/v${version}.md`, import.meta.url),
  );
  assert.ok(curated.length > 0);

  async function verify(name, notes, body) {
    const notesPath = path.join(temporary, `${name}.md`);
    const jsonPath = path.join(temporary, `${name}.json`);
    const bodyPath = path.join(temporary, `${name}.body.md`);
    await writeFile(notesPath, notes);
    await writeFile(jsonPath, `${JSON.stringify({ body })}\n`);
    const result = spawnSync(
      "bash",
      [runner, notesPath, jsonPath, bodyPath, sha256(notes)],
      { encoding: "utf8" },
    );
    return { ...result, bodyPath };
  }

  const exact = await verify("exact", curated, curated.toString("utf8"));
  assert.equal(exact.status, 0, exact.stderr);
  assert.deepEqual(await readFile(exact.bodyPath), curated);

  const blank = Buffer.from(" \n\t");
  assert.notEqual(
    (await verify("blank", blank, blank.toString("utf8"))).status,
    0,
  );
  assert.notEqual(
    (
      await verify(
        "stale",
        curated,
        curated.toString("utf8").replace(`v${version}`, "v0.0.0"),
      )
    ).status,
    0,
  );
  assert.notEqual(
    (
      await verify(
        "generated",
        curated,
        "## What's Changed\n\nGenerated automatically.\n",
      )
    ).status,
    0,
  );
});

test("draft and final publication reject mismatched, absent, and duplicate asset digests", async (context) => {
  const workflow = loadYaml(workflowUrl);
  const temporary = await mkdtemp(path.join(os.tmpdir(), "jobctrl-release-digests-"));
  context.after(() => rm(temporary, { recursive: true, force: true }));
  const asset = path.join(temporary, "candidate with spaces.zip");
  const contents = Buffer.from("signed release fixture");
  await writeFile(asset, contents);
  const record = { name: path.basename(asset), digest: `sha256:${sha256(contents)}` };
  for (const [job, step] of [
    ["publish-immutable", "Create or verify the rerunnable GitHub draft candidate"],
    ["publish-github-release", "Verify asset digests, enforce immutability, and publish"],
  ]) {
    const run = stepRun(workflow, job, step);
    assertShellSyntax(job, run);
    assert.doesNotMatch(run, /gh release download/);
    const script = `set -euo pipefail\n${shellFunction(run, "require_asset_digest")}\nrequire_asset_digest "$1" "$2"\n`;
    for (const [name, assets, accepted] of [
      ["exact", [record], true],
      ["wrong digest", [{ ...record, digest: `sha256:${"0".repeat(64)}` }], false],
      ["missing digest", [{ name: record.name }], false],
      ["null digest", [{ ...record, digest: null }], false],
      ["missing asset", [], false],
      ["duplicate asset", [record, record], false],
    ]) {
      const metadata = path.join(temporary, "release.json");
      await writeFile(metadata, JSON.stringify({ assets }));
      const result = spawnSync("bash", ["-c", script, "verify", metadata, asset], { encoding: "utf8" });
      assert.equal(result.status === 0, accepted, `${job}: ${name}: ${result.stderr}`);
    }
  }
  const publish = stepRun(workflow, "publish-github-release", "Verify asset digests, enforce immutability, and publish");
  assert.ok(publish.indexOf('require_asset_digest "$release" "$asset"') < publish.indexOf("gh release edit"));
  assert.ok(publish.indexOf("gh release verify-asset") > publish.indexOf('test "$immutable" = true'));
});

test("public delivery keeps lifecycle and promotion gates without rerunning the acquisition matrix", () => {
  const workflow = loadYaml(workflowUrl);
  const smoke = workflow.jobs["smoke-and-verify"];
  assert.equal(smoke["timeout-minutes"], 20);
  const names = smoke.steps.map(step => step.name);
  for (const name of ["Verify the signed checksum closure before lifecycle execution", "Smoke immutable descriptor, installer, artifact, and lifecycle", "Verify formula promotion evidence", "Audit, install, test, and run the rendered formula lifecycle", "Seal the smoke-tested formula"])
    assert.ok(names.includes(name), name);
  assert.ok(names.indexOf("Verify formula promotion evidence") < names.indexOf("Seal the smoke-tested formula"));
  assert.ok(names.indexOf("Audit, install, test, and run the rendered formula lifecycle") < names.indexOf("Seal the smoke-tested formula"));
  assert.ok(workflow.jobs["promote-channel-pointer"].needs.includes("smoke-and-verify"));
  assert.match(workflow.jobs["promote-channel-pointer"].if, /needs\['smoke-and-verify'\]\.result == 'success'/);
  assert.doesNotMatch(JSON.stringify(smoke), /jobctrl-source-qa|actions\/setup-go@|released-acquisition-upgrade/);
  const directory = fileURLToPath(new URL("../.github/workflows/", import.meta.url));
  for (const name of readdirSync(directory).filter(name => name.endsWith(".yml")))
    assert.doesNotMatch(readFileSync(path.join(directory, name), "utf8"), /scripts\/released-acquisition-upgrade\.mjs/, name + " must not run the removed matrix");
  const diagnostic = loadYaml(new URL("../.github/workflows/released-acquisition-qa.yml", import.meta.url));
  const on = diagnostic.on ?? diagnostic.true;
  assert.deepEqual(Object.keys(on), ["workflow_dispatch"]);
  assert.equal(on.workflow_dispatch.inputs.candidate_run_id.required, true);
  assert.deepEqual(Object.keys(diagnostic.jobs), ["signed-candidate-upgrade"]);
  assert.match(stepRun(diagnostic, "signed-candidate-upgrade", "Qualify the actual released predecessor and signed candidate"), /node scripts\/released-upgrade-smoke\.mjs/);
});

test("Homebrew publishes only the signer-bound formula after its credential-free lifecycle passes", async (context) => {
  const workflow = loadYaml(workflowUrl);
  assert.equal(workflow.jobs["sync-homebrew"], undefined);
  const smoke = workflow.jobs["smoke-and-verify"];
  assert.equal(smoke.environment, undefined);
  const names = smoke.steps.map((step) => step.name);
  assert.ok(names.indexOf("Seal the smoke-tested formula") > names.indexOf("Audit, install, test, and run the rendered formula lifecycle"));
  assert.ok(names.indexOf("Upload the smoke-tested formula") > names.indexOf("Seal the smoke-tested formula"));
  const publish = workflow.jobs["publish-homebrew"];
  assert.ok(publish.needs.includes("smoke-and-verify"));
  assert.ok(publish.needs.includes("promote-channel-pointer"));
  assert.equal(publish.steps[0].with.name, smoke.steps.find((step) => step.name === "Upload the smoke-tested formula").with.name);
  assert.equal(smoke.steps.find((step) => step.name === "Upload the smoke-tested formula").if, "${{ inputs.channel == 'stable' }}");
  const temporary = await mkdtemp(path.join(os.tmpdir(), "jobctrl-formula-handoff-"));
  context.after(() => rm(temporary, { recursive: true, force: true }));
  const { mkdir } = await import("node:fs/promises");
  await mkdir(path.join(temporary, "jobctrl-verified"));
  const formula = path.join(temporary, "jobctrl-verified", "jobctrl.rb");
  const contents = "class Jobctrl < Formula\nend\n";
  await writeFile(formula, contents);
  const run = stepRun(workflow, "publish-homebrew", "Verify the sealed formula checksum");
  const check = () => spawnSync("bash", ["-c", run], { encoding: "utf8", env: { ...process.env, RUNNER_TEMP: temporary, EXPECTED_FORMULA_SHA256: sha256(contents) } });
  assert.equal(check().status, 0);
  await writeFile(formula, contents.replace("Jobctrl", "Altered"));
  assert.notEqual(check().status, 0);
});

test("Homebrew lifecycle isolates and trusts only its disposable formula", async (context) => {
  const workflow = loadYaml(workflowUrl);
  const step = workflow.jobs["smoke-and-verify"].steps.find(
    (candidate) => candidate.name === "Audit, install, test, and run the rendered formula lifecycle",
  );
  assert.ok(step);
  assertShellSyntax(step.name, step.run);
  assert.equal(step.env.XDG_CONFIG_HOME, "${{ runner.temp }}/homebrew-smoke-config");
  assert.match(step.run, /test "\$\{RUNNER_ENVIRONMENT:-\}" = github-hosted/);
  assert.match(step.run, /test ! -e "\$formula_bin"/);
  assert.match(step.run, /test ! -e "\$\(brew --cellar\)\/jobctrl"/);
  const trap = step.run.indexOf("trap cleanup EXIT");
  const trust = step.run.indexOf('brew trust --formula "$formula"');
  const audit = step.run.indexOf('brew audit --strict --formula "$formula"');
  const untrust = step.run.indexOf('brew untrust --formula "$formula"');
  const untap = step.run.indexOf('brew untap "$tap_name"');
  assert.ok(trap >= 0 && trust > trap && audit > trust, "install the cleanup trap and trust the exact formula before auditing it");
  assert.ok(untrust >= 0 && untap > untrust, "remove the temporary formula trust before removing its tap");
  assert.doesNotMatch(step.run, /HOMEBREW_NO_REQUIRE_TAP_TRUST/, "the check must not disable Homebrew trust globally");

  const { chmod, mkdir, symlink } = await import("node:fs/promises");
  const root = await mkdtemp(path.join(os.tmpdir(), "jobctrl-formula-guard-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  const bin = path.join(root, "bin"), prefix = path.join(root, "prefix"), calls = path.join(root, "calls");
  await mkdir(bin);
  await mkdir(path.join(prefix, "bin"), { recursive: true });
  await mkdir(path.join(prefix, "Cellar"), { recursive: true });
  await writeFile(calls, "");
  const brew = path.join(bin, "brew");
  await writeFile(brew, '#!/bin/bash\ncase "$1" in\n  --prefix) echo "$TASK_BREW_PREFIX" ;;\n  --cellar) echo "$TASK_BREW_PREFIX/Cellar" ;;\n  *) echo "$1" >> "$TASK_BREW_CALLS"; exit 55 ;;\nesac\n');
  await chmod(brew, 0o755);
  const run = (runnerEnvironment) => spawnSync("bash", ["-c", step.run], {
    encoding: "utf8",
    env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, RUNNER_TEMP: root, RUNNER_ENVIRONMENT: runnerEnvironment, GITHUB_RUN_ID: "123", TASK_BREW_PREFIX: prefix, TASK_BREW_CALLS: calls },
  });
  assert.notEqual(run("self-hosted").status, 0, "refuse a non-disposable runner");
  const installed = path.join(prefix, "bin", "jobctrl");
  await writeFile(installed, "preserve");
  assert.notEqual(run("github-hosted").status, 0, "refuse an existing executable");
  assert.equal(await readFile(installed, "utf8"), "preserve");
  await rm(installed);
  await symlink(path.join(root, "missing"), installed);
  assert.notEqual(run("github-hosted").status, 0, "refuse a dangling executable symlink");
  await rm(installed);
  await mkdir(path.join(prefix, "Cellar", "jobctrl"));
  assert.notEqual(run("github-hosted").status, 0, "refuse an existing cellar");
  assert.equal(await readFile(calls, "utf8"), "", "no mutation may occur before all guards pass");
});

test("smoke staging uploads only regular allowlisted reports for the selected channel", async (context) => {
  const { mkdir, readdir, symlink } = await import("node:fs/promises");
  const root = await mkdtemp(path.join(os.tmpdir(), "jobctrl-smoke-staging-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  const stage = stepRun(loadYaml(workflowUrl), "smoke-and-verify", "Stage the credential-free evidence with its stable artifact layout");
  for (const channel of ["stable", "beta"]) {
    const temporary = path.join(root, channel);
    await mkdir(path.join(temporary, "release"), { recursive: true });
    await writeFile(path.join(temporary, "release", "published-candidate-smoke.json"), "smoke\n");
    await writeFile(path.join(temporary, "release", "homebrew-promotion-evidence.json"), "formula\n");
    await writeFile(path.join(temporary, "release", "unrelated-synthetic-control.json"), "preserve\n");
    const result = spawnSync("bash", ["-c", stage], { encoding: "utf8", env: { ...process.env, RUNNER_TEMP: temporary, RELEASE_CHANNEL: channel } });
    assert.equal(result.status, 0, result.stderr);
    const names = (await readdir(path.join(temporary, "credential-free-smoke-evidence", "release"))).sort();
    assert.deepEqual(names, (channel === "stable" ? ["homebrew-promotion-evidence.json", "published-candidate-smoke.json"] : ["published-candidate-smoke.json"]).sort());
    assert.equal(await readFile(path.join(temporary, "release", "unrelated-synthetic-control.json"), "utf8"), "preserve\n");
  }
  const temporary = path.join(root, "linked-report");
  await mkdir(path.join(temporary, "release"), { recursive: true });
  await writeFile(path.join(temporary, "outside.json"), "preserve\n");
  await symlink(path.join(temporary, "outside.json"), path.join(temporary, "release", "published-candidate-smoke.json"));
  const result = spawnSync("bash", ["-c", stage], { encoding: "utf8", env: { ...process.env, RUNNER_TEMP: temporary, RELEASE_CHANNEL: "beta" } });
  assert.notEqual(result.status, 0, "a linked report cannot enter the artifact");
  assert.equal(await readFile(path.join(temporary, "outside.json"), "utf8"), "preserve\n");
});

test("final publication reads the smoke evidence from the uploaded artifact layout", async (context) => {
  const { mkdir, rename, symlink } = await import("node:fs/promises");
  const workflow = loadYaml(workflowUrl);
  const upload = workflow.jobs["smoke-and-verify"].steps.find(
    (step) => step.name === "Upload only credential-free smoke and promotion evidence",
  );
  assert.equal(upload.with.path, "${{ runner.temp }}/credential-free-smoke-evidence");
  assert.doesNotMatch(upload.with.path, /released-acquisition-upgrade\.json/);
  const root = await mkdtemp(path.join(os.tmpdir(), "jobctrl-smoke-layout-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(path.join(root, "release"), { recursive: true });
  const candidate = "signed fixture\n";
  await writeFile(path.join(root, "release", "candidate"), candidate);
  await writeFile(path.join(root, "release", "SHA256SUMS"), `${sha256(candidate)}  candidate\n`);
  await writeFile(path.join(root, "release", "jobctrl-release-audit.tar"), "audit fixture\n");
  await writeFile(path.join(root, "release", "published-candidate-smoke.json"), "{}\n");
  await writeFile(path.join(root, "release", "homebrew-promotion-evidence.json"), "{}\n");
  const stage = stepRun(workflow, "smoke-and-verify", "Stage the credential-free evidence with its stable artifact layout");
  const staged = spawnSync("bash", ["-c", stage], { encoding: "utf8", env: { ...process.env, RUNNER_TEMP: root, RELEASE_CHANNEL: "stable" } });
  assert.equal(staged.status, 0, staged.stderr);
  await rename(path.join(root, "credential-free-smoke-evidence"), path.join(root, "smoke-evidence"));
  const smoke = path.join(root, "smoke-evidence", "release", "published-candidate-smoke.json");
  const run = stepRun(workflow, "publish-github-release", "Verify the signer/package closure and separate smoke evidence");
  const check = () => spawnSync("bash", ["-c", run], { encoding: "utf8", env: { ...process.env, RUNNER_TEMP: root } });
  assert.equal(check().status, 0, "accept the actual downloaded artifact layout");
  await rename(smoke, path.join(root, "smoke-evidence", "published-candidate-smoke.json"));
  assert.notEqual(check().status, 0, "a root-only file does not satisfy the artifact contract");
  await symlink(path.join(root, "smoke-evidence", "published-candidate-smoke.json"), smoke);
  assert.notEqual(check().status, 0, "refuse a linked evidence file");
});

test("PyPI resumption keeps normal signing and publication gates separate", () => {
  const workflow = loadYaml(workflowUrl);
  const dispatch = (workflow.on ?? workflow.true).workflow_dispatch;
  assert.deepEqual(dispatch.inputs.resume_pypi, {
    description: "Resume only PyPI for an already published, verified stable release",
    required: false,
    default: false,
    type: "boolean",
  });
  assert.equal(workflow.jobs.resolve.if, "${{ !inputs.resume_pypi }}");
  const authority = workflow.jobs["resume-pypi-authority"];
  assert.equal(authority.if, "${{ inputs.resume_pypi && inputs.channel == 'stable' }}");
  assert.deepEqual(authority.permissions, { actions: "read", contents: "read" });
  assert.equal(authority.steps.find((step) => step.id === "authority").run, "bash scripts/release-resume-pypi.sh");
  const download = authority.steps.find((step) => step.name === "Download the original smoke evidence");
  assert.equal(download.with["run-id"], "${{ steps.authority.outputs.original_run_id }}");
  assert.equal(download.with.name, "jobctrl-smoke-evidence-${{ steps.authority.outputs.original_run_id }}");
  const gate = workflow.jobs["pypi-resolve"];
  assert.deepEqual(new Set(gate.needs), new Set(["resolve", "publish-github-release", "resume-pypi-authority"]));
  assert.match(gate.if, /!inputs\.resume_pypi.*publish-github-release.*success/);
  assert.match(gate.if, /inputs\.resume_pypi.*resume-pypi-authority.*success/);
  assert.equal(workflow.jobs["publish-pypi"].environment.name, "pypi");
  assert.equal(workflow.jobs["publish-pypi"].permissions["id-token"], "write");
});

test("PyPI recovery binds the immutable release to the original run's smoke evidence", async (context) => {
  const { chmod, mkdir } = await import("node:fs/promises");
  const workflow = loadYaml(workflowUrl);
  const run = stepRun(workflow, "resume-pypi-authority", "Bind the immutable release to the original smoke evidence");
  const root = await mkdtemp(path.join(os.tmpdir(), "jobctrl-pypi-smoke-binding-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(path.join(root, "original-smoke-evidence", "release"), { recursive: true });
  await mkdir(path.join(root, "bin"));
  const smoke = path.join(root, "original-smoke-evidence", "release", "published-candidate-smoke.json");
  const bytes = '{"status":"passed"}\n';
  await writeFile(smoke, bytes);
  const gh = path.join(root, "bin", "gh");
  await writeFile(gh, `#!${process.execPath}\nprocess.stdout.write(JSON.stringify({isImmutable: process.env.TASK_IMMUTABLE === 'true', assets: [{name: 'published-candidate-smoke.json', digest: process.env.TASK_SMOKE_DIGEST}]}));\n`);
  await chmod(gh, 0o755);
  const check = (immutable = "true") => spawnSync("bash", ["-c", run], {
    encoding: "utf8",
    env: { ...process.env, PATH: `${path.join(root, "bin")}:${process.env.PATH}`, RUNNER_TEMP: root, RELEASE_TAG: "v0.3.5", TASK_IMMUTABLE: immutable, TASK_SMOKE_DIGEST: `sha256:${sha256(bytes)}` },
  });
  assert.equal(check().status, 0);
  assert.notEqual(check("false").status, 0, "a mutable release cannot authorize PyPI");
  await writeFile(smoke, '{"status":"altered"}\n');
  assert.notEqual(check().status, 0, "different original evidence cannot authorize PyPI");
});

test("PyPI recovery refuses a release or pointer that changed before upload", async (context) => {
  const { chmod, mkdir } = await import("node:fs/promises");
  const workflow = loadYaml(workflowUrl);
  const step = workflow.jobs["publish-pypi"].steps.find((candidate) => candidate.name === "Recheck live stable identity before PyPI resumption");
  assert.equal(step.if, "${{ inputs.resume_pypi }}");
  assertShellSyntax(step.name, step.run);
  const root = await mkdtemp(path.join(os.tmpdir(), "jobctrl-pypi-final-authority-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(path.join(root, "bin"));
  const gh = path.join(root, "bin", "gh"), curl = path.join(root, "bin", "curl");
  await writeFile(gh, `#!${process.execPath}\nconst s=JSON.parse(require('node:fs').readFileSync(process.env.TASK_STATE,'utf8')); const a=process.argv.slice(2); if(a[0]==='api') process.stdout.write(s.latest); else if(a[0]==='release' && a[1]==='view') process.stdout.write(JSON.stringify(s.release)); else process.exit(3);\n`);
  await writeFile(curl, `#!${process.execPath}\nconst fs=require('node:fs'); const s=JSON.parse(fs.readFileSync(process.env.TASK_STATE,'utf8')); const a=process.argv.slice(2); if(!a.includes('https://releases.jobctrl.dev/v1/stable/darwin-arm64.json')) process.exit(4); fs.writeFileSync(a[a.indexOf('-o')+1],s.pointer);\n`);
  await chmod(gh, 0o755);
  await chmod(curl, 0o755);
  const source = "a".repeat(40);
  const pointer = `${JSON.stringify({ channel: "stable", sequence: 13, buildId: `0.3.5-${source}-darwin-arm64` })}\n`;
  const baseline = { latest: "v0.3.5", pointer, release: { isDraft: false, isPrerelease: false, isImmutable: true, targetCommitish: source, assets: [{ name: "channel-pointer.json", digest: `sha256:${sha256(pointer)}` }] } };
  const cases = [
    ["current", () => {}, true],
    ["new latest release", (s) => { s.latest = "v0.5.0"; }, false],
    ["changed live pointer", (s) => { s.pointer += " "; }, false],
    ["mutable release", (s) => { s.release.isImmutable = false; }, false],
    ["wrong source", (s) => { s.release.targetCommitish = "b".repeat(40); }, false],
  ];
  for (const [label, mutate, accepted] of cases) {
    const state = structuredClone(baseline);
    mutate(state);
    const dir = path.join(root, label.replaceAll(" ", "-"));
    await mkdir(dir);
    const statePath = path.join(dir, "state.json");
    await writeFile(statePath, JSON.stringify(state));
    const result = spawnSync("bash", ["-c", step.run], {
      encoding: "utf8", timeout: 10000,
      env: { ...process.env, PATH: `${path.join(root, "bin")}:${process.env.PATH}`, TASK_STATE: statePath, RUNNER_TEMP: dir, GITHUB_REPOSITORY: "fixture/repo", RELEASE_TAG: "v0.3.5", RELEASE_SEQUENCE: "13", EXPECTED_SOURCE_COMMIT: source, EXPECTED_CHANNEL_POINTER_SHA256: sha256(pointer) },
    });
    assert.equal(result.status === 0, accepted, `${label}: ${result.stderr}`);
  }
});

test("final publication shell accepts exact and immutable reruns and refuses altered drafts before publishing", async (context) => {
  const { mkdir, chmod } = await import("node:fs/promises");
  const workflow = loadYaml(workflowUrl);
  const run = stepRun(workflow, "publish-github-release", "Verify asset digests, enforce immutability, and publish");
  const temporary = await mkdtemp(path.join(os.tmpdir(), "jobctrl-publish-shell-"));
  context.after(() => rm(temporary, { recursive: true, force: true }));
  const names = ["jobctrl-fixture-darwin-arm64.zip", "jobctrl-installer", "install.sh", "release-descriptor.json", "release-descriptor.json.sig", "channel-pointer.json", "manifest.json", "manifest.sig", "release-keys.json", "release-metadata.json", "SHA256SUMS", "jobctrl-release-audit.tar"];
  const notes = "# Fixture release\n\nTest publication only.\n";
  const ref = "a".repeat(40);
  for (const scenario of ["new", "prerelease new", "immutable rerun", "wrong digest", "missing digest", "missing asset", "unexpected asset"]) {
    const root = path.join(temporary, scenario);
    for (const directory of ["release", "release-notes", "smoke-evidence/release", "bin"]) await mkdir(path.join(root, directory), { recursive: true });
    const assets = [];
    for (const name of names) {
      const bytes = name === "release-metadata.json" ? JSON.stringify({ archive: { file: names[0] } }) : `fixture ${name}\n`;
      await writeFile(path.join(root, "release", name), bytes);
      assets.push({ name, digest: `sha256:${sha256(bytes)}` });
    }
    const smoke = "{}\n";
    await writeFile(path.join(root, "smoke-evidence", "release", "published-candidate-smoke.json"), smoke);
    await writeFile(path.join(root, "release-notes", "v0.2.1.md"), notes);
    if (scenario === "wrong digest") assets[0].digest = `sha256:${"0".repeat(64)}`;
    if (scenario === "missing digest") delete assets[0].digest;
    if (scenario === "missing asset") assets.shift();
    if (scenario === "unexpected asset") assets.push({ name: "unexpected.exe", digest: `sha256:${"0".repeat(64)}` });
    if (scenario === "immutable rerun") {
      assets.push({ name: "published-candidate-smoke.json", digest: `sha256:${sha256(smoke)}` });
      await writeFile(path.join(root, "published"), "yes");
    }
    await writeFile(path.join(root, "remote.json"), JSON.stringify({ targetCommitish: ref, isPrerelease: scenario === "prerelease new", body: notes, assets }));
    const gh = path.join(root, "bin", "gh");
    await writeFile(gh, `#!${process.execPath}
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const root = process.env.RUNNER_TEMP;
const args = process.argv.slice(2);
const marker = path.join(root, 'published');
const remotePath = path.join(root, 'remote.json');
const remote = JSON.parse(fs.readFileSync(remotePath));
fs.appendFileSync(path.join(root, 'calls.jsonl'), JSON.stringify(args) + '\\n');
if (args[0] === 'api') {
  process.stdout.write(args.some(a => a.includes('/compare/')) ? 'identical' : args.some(a => a.includes('/commits/')) ? process.env.RELEASE_REF : 'true');
} else if (args[1] === 'view') {
  process.stdout.write(args.includes('--jq') ? String(fs.existsSync(marker)) : JSON.stringify({...remote, isDraft: !fs.existsSync(marker), isImmutable: fs.existsSync(marker)}));
} else if (args[1] === 'upload') {
  if (fs.existsSync(marker)) process.exit(2);
  const file = args.at(-1);
  remote.assets.push({name: path.basename(file), digest: 'sha256:' + crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex')});
  fs.writeFileSync(remotePath, JSON.stringify(remote));
} else if (args[1] === 'edit') {
  fs.writeFileSync(marker, 'yes');
} else if (args[1] === 'verify-asset') {
  const file = args.at(-1);
  const asset = remote.assets.find(a => a.name === path.basename(file));
  if (!fs.existsSync(marker) || asset?.digest !== 'sha256:' + crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex')) process.exit(3);
} else if (args[1] !== 'verify' || !fs.existsSync(marker)) {
  throw new Error('Unexpected gh invocation: ' + JSON.stringify(args));
}
`);
    await chmod(gh, 0o755);
    const result = spawnSync("bash", ["-c", run], {
      encoding: "utf8", timeout: 10000,
      env: { ...process.env, PATH: `${path.join(root, "bin")}:${process.env.PATH}`, RUNNER_TEMP: root, RELEASE_REF: ref, RELEASE_TAG: "v0.2.1", RELEASE_CHANNEL: scenario === "prerelease new" ? "prerelease" : "stable", EXPECTED_RELEASE_NOTES_SHA256: sha256(notes), GITHUB_REPOSITORY: "fixture/release", ADMIN_READ_TOKEN: "fixture" },
    });
    const accepted = scenario === "new" || scenario === "prerelease new" || scenario === "immutable rerun";
    assert.equal(result.status === 0, accepted, `${scenario}: ${result.stderr}`);
    const calls = (await readFile(path.join(root, "calls.jsonl"), "utf8")).trim().split("\n").map(JSON.parse);
    const edit = calls.find(args => args[1] === "edit");
    assert.equal(Boolean(edit), scenario === "new" || scenario === "prerelease new", scenario);
    if (edit) assert.equal(edit.includes("--latest"), scenario === "new", scenario);
    assert.equal(calls.filter(args => args[1] === "verify-asset").length, accepted ? names.length + 1 : 0, scenario);
    assert.equal(calls.some(args => args[1] === "download"), false);
  }
});
