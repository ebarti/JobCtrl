import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
  runFrontendLanes,
  selectedFrontend,
  assertSingleFrontendProfile,
} from "./ci-frontend.mjs";
const quote = (value) => "'" + value.replaceAll("'", "'\\''") + "'";
const recipe = (name, source) => ({
  name,
  run: quote(process.execPath) + " --input-type=module -e " + quote(source),
});
const all = {
  web: true,
  storybook: true,
  e2e: true,
  extension: true,
  docs: true,
  demo: true,
};
const none = Object.fromEntries(Object.keys(all).map((key) => [key, false]));
const support = {
  ...none,
  storybook: true,
  extension: true,
  docs: true,
  demo: true,
};
async function owned(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), "jobctrl-ci-profile-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  return {
    root,
    directory: root,
    logDirectory: path.join(root, "logs"),
    environment: { ...process.env, TASK_TEST_ROOT: root, RUNNER_TEMP: root },
  };
}
const append = (name) =>
  recipe(
    name,
    `import {appendFile} from "node:fs/promises";import path from "node:path";await appendFile(path.join(process.env.TASK_TEST_ROOT,"ran"),${JSON.stringify(name + "\n")});`,
  );
test("selection defaults to coverage and malformed exclusions fail closed", () => {
  assert.deepEqual(selectedFrontend({}), all);
  assert.equal(selectedFrontend({ CI_WEB: "false" }).web, false);
  for (const value of ["0", "FALSE", "", "false\n"])
    assert.throws(() => selectedFrontend({ CI_WEB: value }));
});
test("mixed heavy profiles are refused before any output or command", async (t) => {
  const f = await owned(t);
  for (const selected of [
    all,
    { ...none, web: true, e2e: true },
    { ...support, web: true },
  ])
    await assert.rejects(
      runFrontendLanes({ ...f, selected, recipes: {} }),
      /separate runners/,
    );
  for (const selected of [
    { ...none, web: true },
    { ...none, e2e: true },
    support,
  ])
    assert.doesNotThrow(() => assertSingleFrontendProfile(selected));
});
test("a failed support suite keeps the job red while independent diagnostics finish", async (t) => {
  const f = await owned(t);
  assert.equal(
    await runFrontendLanes({
      ...f,
      selected: support,
      recipes: {
        boundary: [append("boundary")],
        storybook: [
          recipe("failure", "process.exit(23)"),
          append("dependent-skipped"),
        ],
        extension: [append("extension")],
        docs: [append("docs")],
        demo: [append("demo")],
      },
    }),
    false,
  );
  assert.equal(
    await readFile(path.join(f.root, "ran"), "utf8"),
    "boundary\nextension\ndocs\ndemo\n",
  );
  const o = JSON.parse(
    await readFile(path.join(f.logDirectory, "outcomes.json"), "utf8"),
  );
  assert.equal(o.results.find((r) => !r.passed).code, 23);
});
test("web commands retain order and a failure stops dependent web commands", async (t) => {
  const f = await owned(t);
  assert.equal(
    await runFrontendLanes({
      ...f,
      selected: { ...none, web: true },
      recipes: {
        web: [
          append("lint"),
          recipe("types-fail", "process.exit(24)"),
          append("build-skipped"),
        ],
      },
    }),
    false,
  );
  assert.equal(await readFile(path.join(f.root, "ran"), "utf8"), "lint\n");
});
test("spawn failures are blocking and existing evidence is preserved", async (t) => {
  const f = await owned(t);
  const invalid = {
    ...recipe("missing", "process.exit(0)"),
    "working-directory": "missing",
  };
  assert.equal(
    await runFrontendLanes({
      ...f,
      selected: { ...none, web: true },
      recipes: { web: [invalid] },
    }),
    false,
  );
  const previous = await readFile(
    path.join(f.logDirectory, "outcomes.json"),
    "utf8",
  );
  assert.equal(JSON.parse(previous).errors.length, 1);
  await assert.rejects(
    runFrontendLanes({ ...f, selected: { ...none, web: true }, recipes: {} }),
    { code: "EEXIST" },
  );
  assert.equal(
    await readFile(path.join(f.logDirectory, "outcomes.json"), "utf8"),
    previous,
  );
});
test("browser entry refuses developer environments before creating output", () => {
  const result = spawnSync(
    process.execPath,
    [fileURLToPath(new URL("./ci-frontend.mjs", import.meta.url))],
    {
      env: { ...process.env, CI: "false", RUNNER_ENVIRONMENT: "" },
      encoding: "utf8",
    },
  );
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /isolated GitHub-hosted Linux runner/);
});
