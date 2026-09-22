import assert from "node:assert/strict";
import { spawnSync, execFileSync } from "node:child_process";
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

test("final publication shell accepts exact and immutable reruns and refuses altered drafts before publishing", async (context) => {
  const { mkdir, chmod } = await import("node:fs/promises");
  const workflow = loadYaml(workflowUrl);
  const run = stepRun(workflow, "publish-github-release", "Verify asset digests, enforce immutability, and publish");
  const temporary = await mkdtemp(path.join(os.tmpdir(), "jobctrl-publish-shell-"));
  context.after(() => rm(temporary, { recursive: true, force: true }));
  const names = ["jobctrl-fixture-darwin-arm64.zip", "jobctrl-installer", "install.sh", "release-descriptor.json", "release-descriptor.json.sig", "channel-pointer.json", "manifest.json", "manifest.sig", "release-keys.json", "release-metadata.json", "SHA256SUMS", "jobctrl-release-audit.tar"];
  const notes = "# Fixture release\n\nTest publication only.\n";
  const ref = "a".repeat(40);
  for (const scenario of ["new", "immutable rerun", "wrong digest", "missing digest", "missing asset", "unexpected asset"]) {
    const root = path.join(temporary, scenario);
    for (const directory of ["release", "release-notes", "smoke-evidence", "bin"]) await mkdir(path.join(root, directory), { recursive: true });
    const assets = [];
    for (const name of names) {
      const bytes = name === "release-metadata.json" ? JSON.stringify({ archive: { file: names[0] } }) : `fixture ${name}\n`;
      await writeFile(path.join(root, "release", name), bytes);
      assets.push({ name, digest: `sha256:${sha256(bytes)}` });
    }
    const smoke = "{}\n";
    await writeFile(path.join(root, "smoke-evidence", "published-candidate-smoke.json"), smoke);
    await writeFile(path.join(root, "release-notes", "v0.2.1.md"), notes);
    if (scenario === "wrong digest") assets[0].digest = `sha256:${"0".repeat(64)}`;
    if (scenario === "missing digest") delete assets[0].digest;
    if (scenario === "missing asset") assets.shift();
    if (scenario === "unexpected asset") assets.push({ name: "unexpected.exe", digest: `sha256:${"0".repeat(64)}` });
    if (scenario === "immutable rerun") {
      assets.push({ name: "published-candidate-smoke.json", digest: `sha256:${sha256(smoke)}` });
      await writeFile(path.join(root, "published"), "yes");
    }
    await writeFile(path.join(root, "remote.json"), JSON.stringify({ targetCommitish: ref, isPrerelease: false, body: notes, assets }));
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
      env: { ...process.env, PATH: `${path.join(root, "bin")}:${process.env.PATH}`, RUNNER_TEMP: root, RELEASE_REF: ref, RELEASE_TAG: "v0.2.1", RELEASE_CHANNEL: "stable", EXPECTED_RELEASE_NOTES_SHA256: sha256(notes), GITHUB_REPOSITORY: "fixture/release", ADMIN_READ_TOKEN: "fixture" },
    });
    const accepted = scenario === "new" || scenario === "immutable rerun";
    assert.equal(result.status === 0, accepted, `${scenario}: ${result.stderr}`);
    const calls = (await readFile(path.join(root, "calls.jsonl"), "utf8")).trim().split("\n").map(JSON.parse);
    assert.equal(calls.some(args => args[1] === "edit"), scenario === "new", scenario);
    assert.equal(calls.filter(args => args[1] === "verify-asset").length, accepted ? names.length + 1 : 0, scenario);
    assert.equal(calls.some(args => args[1] === "download"), false);
  }
});
