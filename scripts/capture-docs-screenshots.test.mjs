import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import ownedWorkspace from "../apps/web/e2e/fixtures/owned-workspace.cjs";

const {
  OWNERSHIP_MARKER,
  canonicalTemporaryRoot,
  canonicalTemporaryRoots,
  createOwnedE2eWorkspace,
  assertOwnedE2eWorkspace,
  removeOwnedE2eWorkspace,
  configureE2eWorkspace,
  workspaceEnvironment,
  assertE2eWorkspaceEnvironment,
} = ownedWorkspace;
const repoRoot = path.resolve(fileURLToPath(new URL("../", import.meta.url)));

function parentFixture(t) {
  const parent = fs.mkdtempSync(
    path.join(canonicalTemporaryRoot(), "jobctrl-workspace-test-"),
  );
  t.after(() => fs.rmSync(parent, { force: true, recursive: true }));
  return parent;
}

test("workspace overrides cannot adopt the system temp root or an external directory", (t) => {
  const parent = parentFixture(t);
  const file = path.join(parent, "not-a-directory");
  fs.writeFileSync(file, "preserved");
  for (const root of canonicalTemporaryRoots())
    assert.throws(() => createOwnedE2eWorkspace(root), /strict descendant/);
  assert.throws(() => createOwnedE2eWorkspace(repoRoot), /strict descendant/);
  assert.throws(() => createOwnedE2eWorkspace(file), /must be a directory/);
  assert.equal(fs.readFileSync(file, "utf8"), "preserved");
});

test("ordinary runs create unique children and preserve the supplied parent sentinel", (t) => {
  const parent = parentFixture(t);
  const sentinel = path.join(parent, "caller-data");
  fs.writeFileSync(sentinel, "preserved");
  const firstEnv = { JOBCTRL_E2E_APP_DIR: parent };
  const secondEnv = { JOBCTRL_E2E_APP_DIR: parent };
  const first = configureE2eWorkspace(firstEnv);
  const second = configureE2eWorkspace(secondEnv);
  assert.notEqual(first.appDir, second.appDir);
  assert.notEqual(first.token, second.token);
  assert.equal(path.dirname(first.appDir), parent);
  assert.deepEqual(configureE2eWorkspace(firstEnv), first);
  removeOwnedE2eWorkspace(first);
  assertOwnedE2eWorkspace(second);
  assert.equal(fs.readFileSync(sentinel, "utf8"), "preserved");
});

test("caller DB/config/state overrides cannot select foreign data", (t) => {
  const parent = parentFixture(t);
  for (const name of [
    "JOBCTRL_E2E_DB_PATH",
    "JOBCTRL_E2E_CONFIG_PATH",
    "JOBCTRL_E2E_STATE_FILE",
    "JOBCTRL_E2E_SERVICE_HOME",
  ])
    assert.throws(
      () =>
        configureE2eWorkspace({
          JOBCTRL_E2E_APP_DIR: parent,
          [name]: path.join(parent, "sentinel"),
        }),
      /allocated workspace/,
    );
  assert.deepEqual(fs.readdirSync(parent), []);
});

test("copied ownership markers cannot authorize another directory or changed inode", (t) => {
  const parent = parentFixture(t);
  const first = createOwnedE2eWorkspace(parent);
  const second = createOwnedE2eWorkspace(parent);
  const sentinel = path.join(second.appDir, "must-survive");
  fs.writeFileSync(sentinel, "preserved");
  fs.copyFileSync(
    path.join(first.appDir, OWNERSHIP_MARKER),
    path.join(second.appDir, OWNERSHIP_MARKER),
  );
  assert.throws(() => removeOwnedE2eWorkspace(second), /marker does not match/);
  assert.throws(
    () => removeOwnedE2eWorkspace({ ...first, appDir: second.appDir }),
    /identity changed/,
  );
  assert.equal(fs.readFileSync(sentinel, "utf8"), "preserved");
});

test("directory, parent and marker symlinks never authorize cleanup", (t) => {
  const parent = parentFixture(t);
  const first = createOwnedE2eWorkspace(parent);
  const second = createOwnedE2eWorkspace(parent);
  fs.writeFileSync(path.join(second.appDir, "sentinel"), "preserved");
  const alias = path.join(parent, "parent-alias");
  fs.symlinkSync(second.appDir, alias, "dir");
  assert.throws(() => createOwnedE2eWorkspace(alias), /symlink/);
  fs.renameSync(first.appDir, first.appDir + "-retained");
  fs.symlinkSync(second.appDir, first.appDir, "dir");
  assert.throws(() => removeOwnedE2eWorkspace(first), /symlink/);
  const marker = path.join(second.appDir, OWNERSHIP_MARKER);
  fs.renameSync(marker, marker + ".retained");
  fs.symlinkSync(marker + ".retained", marker);
  assert.throws(() => removeOwnedE2eWorkspace(second));
  assert.equal(
    fs.readFileSync(path.join(second.appDir, "sentinel"), "utf8"),
    "preserved",
  );
});

test("required independent capability and contained paths cannot be replaced by state", (t) => {
  const workspace = createOwnedE2eWorkspace(parentFixture(t));
  const env = workspaceEnvironment(workspace);
  assert.deepEqual(assertE2eWorkspaceEnvironment(env), workspace);
  assert.throws(
    () =>
      assertE2eWorkspaceEnvironment({
        ...env,
        JOBCTRL_E2E_WORKSPACE: undefined,
      }),
    /ownership capability/,
  );
  for (const name of [
    "JOBCTRL_E2E_APP_DIR",
    "JOBCTRL_E2E_DB_PATH",
    "JOBCTRL_E2E_STATE_FILE",
    "TMPDIR",
  ])
    assert.throws(
      () => assertE2eWorkspaceEnvironment({ ...env, [name]: repoRoot }),
      /environment mismatch/,
    );
});
