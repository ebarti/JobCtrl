import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { chmodSync, existsSync, lstatSync, mkdtempSync, mkdirSync, readFileSync, readlinkSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import os from "node:os";
import path from "node:path";
import test from "node:test";

const ROOT = path.resolve(import.meta.dirname, "..");
const GET = path.join(ROOT, "scripts", "get");
const PUBLIC_INSTALL = path.join(ROOT, "docs", "public", "install.sh");
const SYSTEM_BASH = "/bin/bash";

function makeTmp() { return mkdtempSync(path.join(os.tmpdir(), "jobctrl-get-test-")); }
function sha256(value) { return createHash("sha256").update(value).digest("hex"); }
function run(args, env, installer = GET) { return spawnSync(SYSTEM_BASH, [installer, ...args], { encoding: "utf8", env: { ...process.env, ...env } }); }
const GNU_STAT = process.platform === "linux" ? "/usr/bin/stat" : ["/opt/homebrew/bin/gstat", "/usr/local/bin/gstat"].find(existsSync);

function fixture(root, { validDigest = true } = {}) {
  const bin = path.join(root, "bin");
  mkdirSync(bin);
  const uname = path.join(bin, "uname");
  writeFileSync(uname, "#!/bin/sh\n[ \"$1\" = -s ] && printf Darwin || printf arm64\n");
  chmodSync(uname, 0o755);
  const args = path.join(root, "installer-args.txt");
  const installer = path.join(root, "installer");
  writeFileSync(installer, "#!/bin/sh\nprintf '%s\n' \"$@\" > \"" + args + "\"\nhome=\"$JOBCTRL_RUNTIME_HOME\"\nwhile [ $# -gt 0 ]; do\n  if [ \"$1\" = --home ]; then home=\"$2\"; shift 2; continue; fi\n  shift\ndone\nmkdir -p \"$home/bin\"\nprintf selector > \"$home/bin/jobctrl\"\nchmod 700 \"$home/bin/jobctrl\"\n");
  chmodSync(installer, 0o755);
  const descriptor = path.join(root, "descriptor.json");
  const signature = path.join(root, "descriptor.json.sig");
  const archive = path.join(root, "release.zip");
  writeFileSync(descriptor, "{}"); writeFileSync(signature, "{}"); writeFileSync(archive, "zip");
  const contract = path.join(root, "fixture.contract");
  const digest = validDigest ? sha256(readFileSync(installer)) : "0".repeat(64);
  writeFileSync(contract, [
    "MODE=local-fixture", "PLATFORM=darwin-arm64", "INSTALLER_URL=file://" + installer,
    "INSTALLER_SHA256=" + digest, "INSTALLER_VERSION=fixture", "DESCRIPTOR_FILE=" + descriptor,
    "SIGNATURE_FILE=" + signature, "ARCHIVE_FILE=" + archive, "",
  ].join("\n"));
  const runtime = path.join(root, "runtime");
  return { args, contract, runtime, env: { HOME: root, JOBCTRL_RUNTIME_HOME: runtime, SHELL: "/bin/zsh", PATH: bin + ":" + process.env.PATH } };
}

test("get is transport-only and delegates an explicit local fixture to the native installer", () => {
  const root = makeTmp(); try {
    const value = fixture(root);
    const result = run(["--local-fixture-contract", value.contract, "--home", path.join(root, "runtime")], value.env);
    assert.equal(result.status, 0, result.stderr || result.stdout);
    assert.deepEqual(readFileSync(value.args, "utf8").trim().split("\n"), [
      "--allow-unsigned-local", "--descriptor-file", path.join(root, "descriptor.json"),
      "--signature-file", path.join(root, "descriptor.json.sig"), "--archive-file", path.join(root, "release.zip"),
      "--home", path.join(root, "runtime"),
    ]);
    const link = path.join(root, ".local", "bin", "jobctrl");
    assert.equal(readlinkSync(link), path.join(value.runtime, "bin", "jobctrl"));
    const profile = path.join(root, ".zprofile");
    const firstProfile = readFileSync(profile, "utf8");
    assert.match(firstProfile, /JobCtrl managed path/);
    assert.equal(statSync(profile).mode & 0o777, 0o600);
    assert.deepEqual(JSON.parse(readFileSync(path.join(value.runtime, "acquisition.json"), "utf8")), {
      schemaVersion: 1,
      source: "curl",
      publicLink: link,
      selector: path.join(value.runtime, "bin", "jobctrl"),
      profile,
      pathLine: `export PATH="${path.dirname(link)}:$PATH" # JobCtrl managed path`,
    });
    const repeated = run(["--local-fixture-contract", value.contract, "--home", value.runtime], value.env);
    assert.equal(repeated.status, 0, repeated.stderr);
    assert.equal(readFileSync(profile, "utf8"), firstProfile);
    const source = readFileSync(GET, "utf8");
    assert.ok(source.lastIndexOf("persist_curl_acquisition \"$RELEASE_HOME\" \"$BIN_DIR\"") < source.lastIndexOf("expose_command \"$RELEASE_HOME\" \"$BIN_DIR\""));
    assert.equal(readFileSync(PUBLIC_INSTALL, "utf8"), source);
    assert.doesNotMatch(source, /git clone|git pull|corepack|pnpm|uv sync|scripts\/install/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("get supports custom home/bin links, opt-out, and refuses unrelated command/profile paths", () => {
  const root = makeTmp(); try {
    const value = fixture(root);
    const home = path.join(root, "custom runtime");
    const bin = path.join(root, "custom-bin");
    const custom = run(["--local-fixture-contract", value.contract, "--home", home, "--bin-dir", bin, "--no-modify-path"], value.env);
    assert.equal(custom.status, 0, custom.stderr || custom.stdout);
    assert.equal(readlinkSync(path.join(bin, "jobctrl")), path.join(home, "bin", "jobctrl"));
    assert.throws(() => readFileSync(path.join(root, ".zprofile"), "utf8"));
    rmSync(path.join(bin, "jobctrl"));
    writeFileSync(path.join(bin, "jobctrl"), "not ours\n");
    const unrelated = run(["--local-fixture-contract", value.contract, "--home", home, "--bin-dir", bin, "--no-modify-path"], value.env);
    assert.equal(unrelated.status, 1);
    assert.match(unrelated.stderr, /refusing to replace existing non-symlink command/);
    rmSync(path.join(bin, "jobctrl"));
    mkdirSync(path.join(root, "profile-target"));
    symlinkSync(path.join(root, "profile-target"), path.join(root, ".zprofile"));
    const profile = run(["--local-fixture-contract", value.contract, "--home", home, "--bin-dir", bin], value.env);
    assert.equal(profile.status, 1);
    assert.match(profile.stderr, /refusing to modify symlinked login profile/);
    assert.equal(lstatSync(path.join(root, ".zprofile")).isSymbolicLink(), true);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("get rejects relative runtime homes and profile-injection bin paths", () => {
  const root = makeTmp(); try {
    const value = fixture(root);
    const relative = run(["--local-fixture-contract", value.contract, "--home", "relative-runtime", "--no-modify-path"], value.env);
    assert.equal(relative.status, 1);
    assert.match(relative.stderr, /runtime home must be an absolute path/);
    const injected = run(["--local-fixture-contract", value.contract, "--bin-dir", path.join(root, "bin$bad"), "--no-modify-path"], value.env);
    assert.equal(injected.status, 1);
    assert.match(injected.stderr, /--bin-dir contains unsafe characters/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("get appends one managed line while preserving a regular login profile's contents and mode", () => {
  const root = makeTmp(); try {
    const value = fixture(root);
    const profile = path.join(root, ".zprofile");
    writeFileSync(profile, "export EXISTING=1\n");
    chmodSync(profile, 0o640);
    const result = run(["--local-fixture-contract", value.contract], value.env);
    assert.equal(result.status, 0, result.stderr || result.stdout);
    const contents = readFileSync(profile, "utf8");
    assert.match(contents, /^export EXISTING=1$/m);
    assert.equal((contents.match(/JobCtrl managed path/g) ?? []).length, 1);
    assert.equal(statSync(profile).mode & 0o777, 0o640);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("get preserves a profile's mode through the GNU stat fallback", { skip: GNU_STAT === undefined }, () => {
  const root = makeTmp(); try {
    const value = fixture(root);
    const profile = path.join(root, ".zprofile");
    const gnuGet = path.join(root, "get-with-gnu-stat");
    writeFileSync(gnuGet, readFileSync(GET, "utf8").replaceAll("/usr/bin/stat", GNU_STAT));
    writeFileSync(profile, "export EXISTING=1\n");
    chmodSync(profile, 0o640);
    const result = run(["--local-fixture-contract", value.contract], value.env, gnuGet);
    assert.equal(result.status, 0, result.stderr || result.stdout);
    assert.equal(statSync(profile).mode & 0o777, 0o640);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("get rejects tampered installer bytes and does not execute them", () => {
  const root = makeTmp(); try {
    const value = fixture(root, { validDigest: false });
    const result = run(["--local-fixture-contract", value.contract], value.env);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /SHA-256 mismatch/);
    assert.throws(() => readFileSync(value.args, "utf8"));
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("local fixture mode cannot select a network release and the released path carries immutable P6 pins", () => {
  const root = makeTmp(); try {
    const value = fixture(root);
    const local = run(["--local-fixture-contract", value.contract, "--release-url", "https://attacker.example/release"], value.env);
    assert.equal(local.status, 1);
    assert.match(local.stderr, /cannot use --release-url/);
    const source = readFileSync(GET, "utf8");
    assert.match(source, /^INSTALLER_URL="https:\/\/releases\.jobctrl\.dev\/v1\/artifacts\/2\.0\.8-92770fe5fcc99e73c0a06e73315acbb7b506a7af-darwin-arm64\/jobctrl-installer"$/m);
    assert.match(source, /^INSTALLER_SHA256="be91015004c63d0f26f9ed6891d70e393058e99cc975cd4737a4e907a8229ccb"$/m);
    assert.match(source, /^INSTALLER_VERSION="2\.0\.8"$/m);
    assert.doesNotMatch(source, /^INSTALLER_URL=""$/m);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
