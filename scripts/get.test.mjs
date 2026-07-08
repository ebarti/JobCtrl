import assert from "node:assert/strict";
import test from "node:test";
import { spawnSync } from "node:child_process";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const GET = path.join(here, "get");
const LAUNCHER = path.join(here, "jobctrl-launcher");

// macOS ships bash 3.2, where empty "$@" / "${arr[@]}" expansions are
// unbound-variable errors under `set -u`. Running the system bash (not the
// Homebrew one) is the point of these regressions.
const SYSTEM_BASH = "/bin/bash";

function makeTmp() {
  return mkdtempSync(path.join(tmpdir(), "jobctrl-get-test-"));
}

// A fake JobCtrl checkout: a git repo with a stub scripts/install that
// records its argv. The untracked stub keeps the tree dirty, which get
// treats as "skip pull, reuse as-is" — so no upstream is needed.
function makeStubCheckout(root) {
  const dir = path.join(root, "checkout");
  mkdirSync(path.join(dir, "scripts"), { recursive: true });
  const init = spawnSync("git", ["-C", dir, "init", "-q"], { encoding: "utf8" });
  assert.equal(init.status, 0, `git init failed: ${init.stderr}`);
  const argsFile = path.join(dir, "install-args.txt");
  writeFileSync(
    path.join(dir, "scripts", "install"),
    `#!/bin/sh\nprintf '%s\\n' "$@" > "${argsFile}"\necho STUB_INSTALL_OK\n`,
  );
  chmodSync(path.join(dir, "scripts", "install"), 0o755);
  return { dir, argsFile };
}

function run(bin, args, options = {}) {
  return spawnSync(SYSTEM_BASH, [bin, ...args], {
    encoding: "utf8",
    stdio: ["pipe", "pipe", "pipe"],
    ...options,
  });
}

test("get survives bash 3.2 with no installer args (empty-array regression)", (t) => {
  const root = makeTmp();
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const { dir, argsFile } = makeStubCheckout(root);

  // No -y and piped stdin: get either reattaches /dev/tty (empty INSTALL_ARGS
  // exec — the bash 3.2 crash site) or falls back to --yes. Both branches
  // must exit 0 under the system bash.
  const result = run(GET, ["--dir", dir]);
  assert.equal(result.status, 0, `stderr: ${result.stderr}`);
  assert.match(result.stdout, /STUB_INSTALL_OK/);
  const recorded = readFileSync(argsFile, "utf8").trim();
  assert.ok(
    recorded === "" || recorded === "--yes",
    `unexpected installer args: ${JSON.stringify(recorded)}`,
  );
});

test("get forwards -y and passthrough args after --", (t) => {
  const root = makeTmp();
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const { dir, argsFile } = makeStubCheckout(root);

  const result = run(GET, ["-y", "--dir", dir, "--", "--dry-run", "--skip-doctor"]);
  assert.equal(result.status, 0, `stderr: ${result.stderr}`);
  const recorded = readFileSync(argsFile, "utf8").trim().split("\n");
  assert.deepEqual(recorded, ["--dry-run", "--skip-doctor", "--yes"]);
});

test("get tolerates a bare trailing -- (empty \"$@\" append)", (t) => {
  const root = makeTmp();
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const { dir } = makeStubCheckout(root);

  const result = run(GET, ["-y", "--dir", dir, "--"]);
  assert.equal(result.status, 0, `stderr: ${result.stderr}`);
  assert.match(result.stdout, /STUB_INSTALL_OK/);
});

test("get refuses a non-empty directory that is not a clone", (t) => {
  const root = makeTmp();
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const dir = path.join(root, "occupied");
  mkdirSync(dir);
  writeFileSync(path.join(dir, "unrelated.txt"), "not a checkout\n");

  const result = run(GET, ["-y", "--dir", dir]);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /not a JobCtrl clone/);
});

test("launcher prints help and hints bootstrap when no checkout exists", (t) => {
  const root = makeTmp();
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const env = { ...process.env, JOBCTRL_HOME: path.join(root, "missing") };

  const help = run(LAUNCHER, ["--help"], { env });
  assert.equal(help.status, 0, `stderr: ${help.stderr}`);
  assert.match(help.stdout, /JobCtrl launcher/);
  assert.match(help.stdout, /No checkout found yet/);

  const doctor = run(LAUNCHER, ["doctor"], { env });
  assert.equal(doctor.status, 1);
  assert.match(doctor.stderr, /run: jobctrl bootstrap/);
});

test("launcher accepts a linked git worktree as a checkout (.git file, not dir)", (t) => {
  const root = makeTmp();
  t.after(() => rmSync(root, { recursive: true, force: true }));
  // Linked worktrees have a `.git` FILE pointing at the real gitdir; the
  // launcher must not misread that as "no checkout".
  const dir = path.join(root, "worktree-style");
  mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, ".git"), "gitdir: /somewhere/else\n");
  const env = { ...process.env, JOBCTRL_HOME: dir };

  const help = run(LAUNCHER, ["--help"], { env });
  assert.equal(help.status, 0, `stderr: ${help.stderr}`);
  assert.doesNotMatch(help.stdout, /No checkout found yet/);
});

test("brew-symlinked launcher resolves the baked libexec get (symlink regression)", (t) => {
  const root = makeTmp();
  t.after(() => rmSync(root, { recursive: true, force: true }));

  // Simulate the Homebrew layout: keg with bin/ + libexec/, the libexec path
  // baked in (as the formula's inreplace does), and a prefix bin symlink.
  const keg = path.join(root, "keg");
  mkdirSync(path.join(keg, "bin"), { recursive: true });
  mkdirSync(path.join(keg, "libexec"), { recursive: true });
  const bakedGet = path.join(keg, "libexec", "get");
  writeFileSync(bakedGet, readFileSync(GET, "utf8"));
  chmodSync(bakedGet, 0o755);
  const kegLauncher = path.join(keg, "bin", "jobctrl");
  writeFileSync(
    kegLauncher,
    readFileSync(LAUNCHER, "utf8").replace("@JOBCTRL_LIBEXEC_GET@", bakedGet),
  );
  chmodSync(kegLauncher, 0o755);
  const prefixBin = path.join(root, "prefix", "bin");
  mkdirSync(prefixBin, { recursive: true });
  symlinkSync(kegLauncher, path.join(prefixBin, "jobctrl"));

  const env = { ...process.env, JOBCTRL_HOME: path.join(root, "missing") };
  const result = run(path.join(prefixBin, "jobctrl"), ["bootstrap", "--help"], { env });
  assert.equal(result.status, 0, `stderr: ${result.stderr}`);
  assert.match(result.stdout, /Clones JobCtrl to \$JOBCTRL_HOME/);
});
