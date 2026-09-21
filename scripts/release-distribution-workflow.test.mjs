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
    "Byte-verify every draft asset, enforce immutability, and publish",
  );

  assert.match(resolve, /release_notes_path="\.github\/releases\/\$RELEASE_TAG\.md"/);
  assert.match(resolve, /test -f "\$release_notes_path" && test ! -L "\$release_notes_path"/);
  assert.match(resolve, /grep -q '\[\^\[:space:\]\]' "\$release_notes_path"/);
  assert.match(resolve, /release_notes_sha256=/);
  assert.match(source, /name: jobctrl-release-notes-\$\{\{ github\.run_id \}\}/);

  assert.match(preflight, /--json isDraft,targetCommitish,tagName,body/);
  assert.match(preflight, /require_exact_release_body "\$release"/);
  assert.ok(
    draft.indexOf("require_exact_release_body \"$draft\"") <
      draft.indexOf("gh release download"),
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
