#!/usr/bin/env node

import { spawn } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { fileURLToPath, pathToFileURL } from "node:url";

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(SCRIPT_DIR, "..");
const PROVIDER_TOP_LEVEL = ["claude-agent-sdk", "google-antigravity", "openai-codex", "openai-codex-cli-bin"];
const PACKS = [
  {
    id: "claude-agent-sdk",
    version: "0.2.87",
    owner: "Anthropic PBC",
    source: "https://pypi.org/project/claude-agent-sdk/",
    license: "MIT AND LicenseRef-Anthropic-Commercial-Terms",
    keep: ["claude-agent-sdk"],
  },
  {
    id: "codex-provider-runtime",
    version: "0.137.0a4",
    owner: "OpenAI",
    source: "https://pypi.org/project/openai-codex-cli-bin/",
    license: "Apache-2.0",
    keep: ["openai-codex", "openai-codex-cli-bin"],
  },
  {
    id: "antigravity-provider-runtime",
    version: "0.1.2",
    owner: "Google LLC",
    source: "https://pypi.org/project/google-antigravity/",
    license: "Apache-2.0",
    keep: ["google-antigravity"],
  },
];

function invariant(condition, message) {
  if (!condition) throw new Error(message);
}

function canonicalName(value) {
  return value.toLowerCase().replace(/[_.]+/g, "-");
}

function bytewiseCompare(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}

function run(command, args, cwd) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.on("error", reject);
    child.on("close", (code) => code === 0
      ? resolve(stdout)
      : reject(new Error(`${command} ${args.join(" ")} failed (${code}): ${stderr.trim()}`)));
  });
}

function markerMatchesDarwinArm64Cpython(marker) {
  if (!marker) return true;
  if (marker.includes("sys_platform == 'win32'")) return false;
  if (marker.includes("platform_python_implementation != 'PyPy'")) return true;
  if (marker.includes("implementation_name != 'PyPy'")) return true;
  if (marker.includes("sys_platform != 'emscripten'")) return true;
  throw new Error(`unsupported provider-lock marker for darwin-arm64 CPython: ${marker}`);
}

export function parseExportedRequirements(contents) {
  const packages = new Map();
  for (const line of contents.split("\n")) {
    const match = line.match(/^([A-Za-z0-9_.-]+)==([^ ;\\]+)(?: ; (.*?))? \\$/) ?? line.match(/^([A-Za-z0-9_.-]+)==([^ ;]+)$/);
    if (!match) continue;
    const marker = match[3] ?? null;
    if (!markerMatchesDarwinArm64Cpython(marker)) continue;
    const name = canonicalName(match[1]);
    const version = match[2];
    const previous = packages.get(name);
    invariant(previous === undefined || previous === version, `${name}: export selected conflicting versions`);
    packages.set(name, version);
  }
  invariant(packages.size > 0, "uv export produced no target-compatible packages");
  return packages;
}

async function exportedClosure(root, keep) {
  const pruned = PROVIDER_TOP_LEVEL.filter((name) => !keep.includes(name));
  const args = [
    "export",
    "--project", path.join(root, "workers", "automation"),
    "--frozen",
    "--no-dev",
    "--no-emit-project",
    "--no-header",
    "--no-annotate",
    "--python", "3.12",
  ];
  for (const name of pruned) args.push("--prune", name);
  return parseExportedRequirements(await run("uv", args, root));
}

export function parseUvLockPackages(contents) {
  const packages = new Map();
  for (const block of contents.split(/\n(?=\[\[package\]\]\n)/)) {
    const name = block.match(/^name = "([^"]+)"$/m)?.[1];
    const version = block.match(/^version = "([^"]+)"$/m)?.[1];
    if (!name || !version) continue;
    const wheelsBlock = block.match(/^wheels = \[\n([\s\S]*?)^\]$/m)?.[1] ?? "";
    const wheels = [...wheelsBlock.matchAll(/\{ url = "([^"]+)", hash = "sha256:([a-f0-9]{64})", size = ([0-9]+),/g)].map((match) => ({
      url: match[1],
      sha256: match[2],
      sizeBytes: Number.parseInt(match[3], 10),
    }));
    packages.set(canonicalName(name), { name: canonicalName(name), version, wheels });
  }
  return packages;
}

function wheelCompatibilityScore(url) {
  const filename = url.slice(url.lastIndexOf("/") + 1).toLowerCase();
  if (/-py3-none-any\.whl$/.test(filename) || /-py2\.py3-none-any\.whl$/.test(filename)) return 10;
  if (!filename.includes("macosx") || !filename.includes("arm64.whl")) return -1;
  if (filename.includes("-cp312-cp312-")) return 50;
  if (/-cp3(?:9|10|11|12)-abi3-/.test(filename)) return 40;
  if (filename.includes("-py3-none-macosx")) return 30;
  return -1;
}

function selectWheel(packageRecord, expectedVersion) {
  invariant(packageRecord, "package is missing from uv.lock");
  invariant(packageRecord.version === expectedVersion, `${packageRecord.name}: uv.lock version does not match export`);
  const candidates = packageRecord.wheels
    .map((wheel) => ({ ...wheel, score: wheelCompatibilityScore(wheel.url) }))
    .filter((wheel) => wheel.score >= 0)
    .sort((left, right) => right.score - left.score || bytewiseCompare(left.url, right.url));
  invariant(candidates.length > 0, `${packageRecord.name}: no darwin-arm64 CPython 3.12 wheel is locked`);
  const [{ score: _score, ...wheel }] = candidates;
  return { package: packageRecord.name, version: expectedVersion, ...wheel };
}

export async function generateProviderPackLock(root = REPO_ROOT) {
  const [core, uvLockContents] = await Promise.all([
    exportedClosure(root, []),
    readFile(path.join(root, "workers", "automation", "uv.lock"), "utf8"),
  ]);
  const uvPackages = parseUvLockPackages(uvLockContents);
  const packs = [];
  for (const pack of PACKS) {
    const combined = await exportedClosure(root, pack.keep);
    const delta = [...combined.entries()]
      .filter(([name]) => !core.has(name))
      .sort(([left], [right]) => bytewiseCompare(left, right));
    invariant(delta.length > 0, `${pack.id}: provider delta is empty`);
    const wheels = delta.map(([name, version]) => selectWheel(uvPackages.get(name), version));
    packs.push({
      id: pack.id,
      version: pack.version,
      owner: pack.owner,
      source: pack.source,
      license: pack.license,
      redistribution: "official-download",
      isolation: "independent-site-packages",
      exactPackages: delta.map(([name]) => name),
      wheels,
    });
  }
  return {
    schemaVersion: 1,
    platform: "darwin-arm64",
    python: "cpython-3.12",
    coreSelector: "uv export --frozen --no-dev --no-emit-project with all provider top-level packages pruned",
    packs,
  };
}

async function main(argv = process.argv.slice(2)) {
  const command = argv[0] ?? "check";
  const lockPath = path.join(REPO_ROOT, "packaging", "distribution", "provider-packs.lock.json");
  const generated = `${JSON.stringify(await generateProviderPackLock(), null, 2)}\n`;
  if (command === "generate") {
    await writeFile(lockPath, generated, { mode: 0o644 });
    process.stdout.write(`updated ${path.relative(REPO_ROOT, lockPath)}\n`);
    return;
  }
  if (command === "check") {
    const checkedIn = await readFile(lockPath, "utf8");
    invariant(checkedIn === generated, "provider-packs.lock.json drifted; run distribution:provider-lock:generate intentionally");
    process.stdout.write(`${JSON.stringify({ status: "ok", packs: generated.match(/"id":/g)?.length ?? 0 })}\n`);
    return;
  }
  throw new Error(`unknown provider lock command: ${command}`);
}

const invokedPath = process.argv[1] ? pathToFileURL(path.resolve(process.argv[1])).href : "";
if (import.meta.url === invokedPath) {
  main().catch((error) => {
    process.stderr.write(`distribution-provider-lock: ${error.message}\n`);
    process.exitCode = 1;
  });
}
