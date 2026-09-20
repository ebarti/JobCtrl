import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import test from "node:test";

const require = createRequire(import.meta.url);
const pnpmLockPaths = [
  "pnpm-lock.yaml",
  "packaging/distribution/api-native/pnpm-lock.yaml",
  "packaging/distribution/playwright-mcp/pnpm-lock.yaml",
];

function compareVersions(left, right) {
  const leftParts = left.split(".").map(Number);
  const rightParts = right.split(".").map(Number);
  for (let index = 0; index < 3; index += 1) {
    const difference = (leftParts[index] ?? 0) - (rightParts[index] ?? 0);
    if (difference !== 0) return difference;
  }
  return 0;
}

function packageVersions(lockContents, packageName) {
  const escapedName = packageName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const entryPattern = new RegExp(
    `^  ['"]?${escapedName}@(\\d+\\.\\d+\\.\\d+)(?:\\([^\\n]+\\))?['"]?:$`,
    "gm",
  );
  return new Set([...lockContents.matchAll(entryPattern)].map((match) => match[1]));
}

function versionMajor(version) {
  return Number(version.split(".")[0]);
}

test("brace-expansion maintenance lines apply the default output-length cap", () => {
  const defaultMaxLength = 4_000_000;

  for (const version of ["1.1.18", "2.1.4", "5.0.9"]) {
    const packagePath = path.join(
      process.cwd(),
      "node_modules",
      ".pnpm",
      `brace-expansion@${version}`,
      "node_modules",
      "brace-expansion",
    );
    const packageExport = require(packagePath);
    const expand = typeof packageExport === "function"
      ? packageExport
      : packageExport.expand;
    const expansions = expand("{a,b}".repeat(80));
    const outputLength = expansions.reduce(
      (total, expansion) => total + expansion.length,
      0,
    );

    assert.ok(expansions.length > 0, `${version} should still produce expansions`);
    assert.ok(
      outputLength <= defaultMaxLength,
      `${version} should cap expansion output at ${defaultMaxLength} characters`,
    );
  }
});

test("source and packaging locks exclude every currently alerted dependency range", async () => {
  const lockContents = (await Promise.all(
    pnpmLockPaths.map(async (lockPath) => readFile(path.join(process.cwd(), lockPath), "utf8")),
  )).join("\n");
  const minimums = new Map([
    ["@platejs/core", "53.3.11"],
    ["baseline-browser-mapping", "2.11.0"],
    ["browserslist", "4.28.7"],
    ["fast-uri", "3.1.6"],
    ["hono", "4.13.5"],
    ["ip-address", "10.3.1"],
    ["js-yaml", "4.3.2"],
    ["pdfjs-dist", "6.2.108"],
    ["postcss", "8.5.23"],
    ["postcss-selector-parser", "7.1.3"],
    ["qs", "6.16.0"],
    ["sharp", "0.35.4"],
  ]);

  for (const [packageName, minimum] of minimums) {
    const versions = packageVersions(lockContents, packageName);
    assert.ok(versions.size > 0, `${packageName} must remain present in an audited lock`);
    for (const version of versions) {
      assert.ok(
        compareVersions(version, minimum) >= 0,
        `${packageName}@${version} is below patched ${minimum}`,
      );
    }
  }

  for (const version of packageVersions(lockContents, "brace-expansion")) {
    const major = versionMajor(version);
    const minimum = major === 1 ? "1.1.18" : major === 2 ? "2.1.4" : major >= 4 ? "5.0.9" : null;
    assert.ok(!minimum || compareVersions(version, minimum) >= 0, `brace-expansion@${version} remains vulnerable`);
  }
  for (const version of packageVersions(lockContents, "joi")) {
    const major = versionMajor(version);
    const minimum = major === 17 ? "17.13.6" : major >= 18 ? "18.2.5" : major >= 16 ? "17.13.6" : null;
    assert.ok(!minimum || compareVersions(version, minimum) >= 0, `joi@${version} remains vulnerable`);
  }
  for (const version of packageVersions(lockContents, "nanoid")) {
    assert.ok(
      versionMajor(version) < 4 || compareVersions(version, "5.1.16") >= 0,
      `nanoid@${version} remains vulnerable`,
    );
  }
  for (const version of packageVersions(lockContents, "undici")) {
    assert.ok(
      versionMajor(version) !== 7 || compareVersions(version, "7.29.0") >= 0,
      `undici@${version} remains vulnerable`,
    );
  }

  const uvLock = await readFile(path.join(process.cwd(), "workers/automation/uv.lock"), "utf8");
  const cryptographyVersion = uvLock.match(
    /\[\[package\]\]\nname = "cryptography"\nversion = "([^"]+)"/,
  )?.[1];
  assert.ok(cryptographyVersion, "cryptography must remain present in the worker lock");
  assert.ok(
    compareVersions(cryptographyVersion, "50.0.0") >= 0,
    `cryptography@${cryptographyVersion} remains vulnerable`,
  );
});
