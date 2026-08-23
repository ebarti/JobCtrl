import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { promisify } from "node:util";
import test from "node:test";

const execFileAsync = promisify(execFile);
const root = new URL("../", import.meta.url);
const read = (path) => readFile(new URL(path, root), "utf8");
const readJson = async (path) => JSON.parse(await read(path));
const APP_VERSION = "0.1.0";

test("public application versions agree without resetting compatibility counters", async () => {
  const packageVersions = await Promise.all([
    "package.json",
    "apps/api/package.json",
    "apps/extension/package.json",
    "apps/web/package.json",
    "packages/api-client/package.json",
    "packages/contracts/package.json",
    "packages/domain-types/package.json",
    "packages/tsconfig/package.json",
  ].map(async (path) => [path, (await readJson(path)).version]));
  for (const [path, version] of packageVersions) {
    assert.equal(version, APP_VERSION, `${path} must carry the public application version`);
  }

  assert.equal((await readJson("apps/extension/public/manifest.json")).version, APP_VERSION);
  assert.match(await read("workers/automation/pyproject.toml"), /^version = "0\.1\.0"$/m);
  assert.match(await read("workers/automation/src/jobctrl/__init__.py"), /^__version__ = "0\.1\.0"$/m);
  assert.match(
    await read("workers/automation/uv.lock"),
    /\[\[package\]\]\nname = "jobctrl"\nversion = "0\.1\.0"\nsource = \{ editable = "\." \}/,
  );

  assert.match(await read("apps/api/src/schema-manifest.ts"), /EXACT_V9_SCHEMA_MANIFEST[\s\S]*?version: 9,/);
  assert.match(await read("workers/automation/src/jobctrl/database.py"), /^SCHEMA_VERSION = 9$/m);
  assert.equal((await readJson("launcher/runtime-manifest.json")).launcherProtocol, 1);
  assert.match(await read("launcher/internal/launcher/launcher.go"), /^\s*launcherProtocol\s+= 1$/m);
  assert.match(await read("launcher/internal/launcher/launcher.go"), /^\s*stateSchemaVersion\s+= 1$/m);
  const platforms = await readJson("packaging/distribution/platforms.json");
  assert.deepEqual(platforms.platforms[0].launcherCompatibility, { minimum: 1, maximum: 1 });
});

test("release parity gate accepts the reset tag v0.1.0", async () => {
  const { stdout, stderr } = await execFileAsync(
    "python3",
    ["scripts/release_check.py", "--release-tag", "v0.1.0"],
    { cwd: new URL("../", import.meta.url), maxBuffer: 16 * 1024 * 1024 },
  );
  assert.equal(stderr, "");
  assert.match(stdout, /release check passed/i);
});
