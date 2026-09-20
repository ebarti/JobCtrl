import assert from "node:assert/strict";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";

const repoRoot = process.cwd();
const installer = path.join(repoRoot, "scripts", "install");

async function runInstallerWithNode(version, t) {
  const fakeBin = await mkdtemp(path.join(os.tmpdir(), "jobctrl-install-contract-"));
  t.after(async () => {
    await rm(fakeBin, { force: true, recursive: true });
  });

  await Promise.all([
    writeExecutable(
      path.join(fakeBin, "node"),
      `#!/bin/sh\nprintf '%s\\n' '${version}'\n`,
    ),
    ...["corepack", "temporal", "uv"].map((name) =>
      writeExecutable(path.join(fakeBin, name), "#!/bin/sh\nexit 0\n")),
  ]);

  return spawnSync(
    installer,
    ["--yes", "--dry-run", "--skip-browsers", "--skip-doctor"],
    {
      cwd: repoRoot,
      encoding: "utf8",
      env: {
        ...process.env,
        PATH: `${fakeBin}:/bin:/usr/bin`,
      },
    },
  );
}

async function writeExecutable(filePath, contents) {
  await writeFile(filePath, contents);
  await chmod(filePath, 0o755);
}

test("source install accepts the PDF.js 6 minimum Node release", async (t) => {
  const packageJson = JSON.parse(await readFile(path.join(repoRoot, "package.json"), "utf8"));
  assert.equal(packageJson.engines.node, ">=22.13.0 || >=24");

  const result = await runInstallerWithNode("22.13.0", t);

  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /ok: Node\.js 22\.13\.0/);
});

test("source install rejects Node releases below the PDF.js 6 minimum", async (t) => {
  const result = await runInstallerWithNode("22.12.9", t);

  assert.equal(result.status, 1);
  assert.match(result.stderr, /Node\.js 22\.13\+ is required; found 22\.12\.9/);
  assert.match(result.stderr, /Node\.js 22\.13\+ - install Node\.js/);
});
