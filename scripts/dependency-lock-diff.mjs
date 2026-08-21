import { execFileSync } from "node:child_process";
import { appendFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { pathToFileURL } from "node:url";

export const DISTRIBUTION_LOCKS = [
  "pnpm-lock.yaml",
  "workers/automation/uv.lock",
  "packaging/distribution/api-native/pnpm-lock.yaml",
  "packaging/distribution/playwright-mcp/pnpm-lock.yaml",
];

export function parseUvPackages(contents) {
  const packages = new Set();
  for (const block of contents.split(/\n(?=\[\[package\]\])/)) {
    const name = block.match(/^name\s*=\s*"([^"]+)"/m)?.[1];
    const version = block.match(/^version\s*=\s*"([^"]+)"/m)?.[1];
    if (name && version) packages.add(`${name}@${version}`);
  }
  return packages;
}

export function parsePnpmPackages(contents) {
  const packageStart = contents.search(/^packages:\s*$/m);
  if (packageStart < 0) return new Set();
  const rest = contents.slice(packageStart).replace(/^packages:\s*\n/m, "");
  const snapshotStart = rest.search(/^snapshots:\s*$/m);
  const section = snapshotStart < 0 ? rest : rest.slice(0, snapshotStart);
  const packages = new Set();
  for (const line of section.split("\n")) {
    const match = line.match(/^ {2}(?! )(?:(['"])(.+)\1|([^'"][^:]*)):\s*(?:.*)?$/);
    const key = match?.[2] ?? match?.[3];
    if (key) packages.add(key);
  }
  return packages;
}

export function diffPackageSets(before, after) {
  return {
    added: [...after].filter((item) => !before.has(item)).sort(),
    removed: [...before].filter((item) => !after.has(item)).sort(),
  };
}

function gitFile(ref, file) {
  try {
    return execFileSync("git", ["show", `${ref}:${file}`], { encoding: "utf8", maxBuffer: 32 * 1024 * 1024 });
  } catch (error) {
    if (error.status === 128) return "";
    throw error;
  }
}

export function diffLocks(base, head = "HEAD") {
  return DISTRIBUTION_LOCKS.map((file) => {
    const parse = file.endsWith("uv.lock") ? parseUvPackages : parsePnpmPackages;
    const before = parse(gitFile(base, file));
    const after = parse(gitFile(head, file));
    return { file, before: before.size, after: after.size, ...diffPackageSets(before, after) };
  });
}

export function lockDiffMarkdown(diffs) {
  const lines = ["## Dependency closure delta", "", "Raw package-record totals are review evidence, not a compatibility invariant.", ""];
  for (const diff of diffs) {
    lines.push(`### \`${diff.file}\``, "", `Records: ${diff.before} → ${diff.after}; added ${diff.added.length}, removed ${diff.removed.length}.`, "");
    if (diff.added.length) lines.push("Added:", "", ...diff.added.slice(0, 100).map((item) => `- \`${item}\``), "");
    if (diff.removed.length) lines.push("Removed:", "", ...diff.removed.slice(0, 100).map((item) => `- \`${item}\``), "");
  }
  return `${lines.join("\n")}\n`;
}

export async function main(argv = process.argv.slice(2)) {
  const baseIndex = argv.indexOf("--base");
  if (baseIndex < 0 || !argv[baseIndex + 1]) throw new Error("--base is required");
  const headIndex = argv.indexOf("--head");
  const diffs = diffLocks(argv[baseIndex + 1], headIndex >= 0 ? argv[headIndex + 1] : "HEAD");
  const markdown = lockDiffMarkdown(diffs);
  if (process.env.GITHUB_STEP_SUMMARY) await appendFile(process.env.GITHUB_STEP_SUMMARY, markdown, "utf8");
  else process.stdout.write(markdown);
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main().catch((error) => {
    process.stderr.write(`${error.stack ?? error.message}\n`);
    process.exitCode = 1;
  });
}
