import { execFileSync } from "node:child_process";
import { appendFile, writeFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { fileURLToPath, pathToFileURL } from "node:url";

export const ROUTE_NAMES = [
  "meta",
  "distribution",
  "python",
  "api",
  "web",
  "storybook",
  "e2e",
  "extension",
  "demo_edge",
  "demo",
  "docs",
  "launcher",
  "typescript",
];

const JAVASCRIPT_ROUTES = ["api", "web", "storybook", "e2e", "extension", "demo_edge", "demo"];
const ALL_OWNED_ROUTES = ROUTE_NAMES.filter((name) => name !== "typescript");
const ROOT_DOC_DEPENDENCIES = new Set([
  "@iconify-json/tabler",
  "@tabler/icons-vue",
  "mermaid",
  "vitepress",
  "vitepress-plugin-mermaid",
]);
const ROOT_DISTRIBUTION_DEPENDENCIES = new Set(["ajv", "esbuild"]);
const PACKAGE_SECTIONS = ["dependencies", "devDependencies", "optionalDependencies", "peerDependencies", "scripts"];
const PNPM_DEPENDENCY_GROUPS = new Set(["dependencies", "devDependencies", "optionalDependencies"]);

function normalizeFiles(files) {
  return [...new Set(files.map((file) => file.trim().replaceAll("\\", "/")).filter(Boolean))].sort();
}

function isPublishedDoc(file) {
  return file.startsWith("docs/") && !file.startsWith("docs/plans/") && !file.startsWith("docs/incidents/");
}

function yamlScalar(value) {
  const trimmed = value.trim();
  if (trimmed.startsWith("'") && trimmed.endsWith("'")) return trimmed.slice(1, -1).replaceAll("''", "'");
  if (trimmed.startsWith('"') && trimmed.endsWith('"')) {
    try {
      return JSON.parse(trimmed);
    } catch {
      return trimmed.slice(1, -1);
    }
  }
  return trimmed;
}

function pnpmSection(contents, name) {
  const lines = contents.split("\n");
  const start = lines.findIndex((line) => line === `${name}:`);
  if (start < 0) return [];
  let end = lines.length;
  for (let index = start + 1; index < lines.length; index += 1) {
    if (/^[A-Za-z][A-Za-z0-9_-]*:\s*$/.test(lines[index])) {
      end = index;
      break;
    }
  }
  return lines.slice(start + 1, end);
}

function pnpmRecords(contents, sectionName) {
  const records = new Map();
  let key = null;
  let lines = [];
  const flush = () => {
    if (key !== null) records.set(key, lines.join("\n"));
  };
  for (const line of pnpmSection(contents, sectionName)) {
    const record = line.match(/^ {2}(\S.*):[ \t]*(.*)$/);
    if (record) {
      flush();
      key = yamlScalar(record[1]);
      lines = record[2] ? [`<inline>${record[2]}`] : [];
    } else if (key !== null) {
      lines.push(line);
    }
  }
  flush();
  return records;
}

function pnpmDependencyRefs(block) {
  const refs = [];
  let group = null;
  let dependency = null;
  for (const line of block.split("\n")) {
    const groupMatch = line.match(/^ {4}([A-Za-z][A-Za-z0-9_-]*):\s*$/);
    if (groupMatch) {
      group = PNPM_DEPENDENCY_GROUPS.has(groupMatch[1]) ? groupMatch[1] : null;
      dependency = null;
      continue;
    }
    if (!group) continue;
    const dependencyMatch = line.match(/^ {6}(\S.*?):(?:\s+(.+))?$/);
    if (dependencyMatch) {
      dependency = yamlScalar(dependencyMatch[1]);
      if (dependencyMatch[2]) refs.push([dependency, yamlScalar(dependencyMatch[2])]);
      continue;
    }
    const versionMatch = dependency && line.match(/^ {8}version:\s+(.+)$/);
    if (versionMatch) refs.push([dependency, yamlScalar(versionMatch[1])]);
    if (/^ {0,4}\S/.test(line)) {
      group = null;
      dependency = null;
    }
  }
  return refs;
}

function packageBaseKey(key) {
  const peerContext = key.indexOf("(");
  return peerContext < 0 ? key : key.slice(0, peerContext);
}

function resolvePnpmSnapshot(dependency, version, snapshots) {
  if (version.startsWith("link:") || version.startsWith("workspace:")) return null;
  let targetName = dependency;
  let targetVersion = version;
  if (version.startsWith("npm:")) {
    const alias = version.slice(4);
    const separator = alias.lastIndexOf("@");
    if (separator <= 0) return undefined;
    targetName = alias.slice(0, separator);
    targetVersion = alias.slice(separator + 1);
  }
  if (snapshots.has(targetVersion)) return targetVersion;
  const exact = `${targetName}@${targetVersion}`;
  if (snapshots.has(exact)) return exact;
  const prefix = `${targetName}@${targetVersion}(`;
  const candidates = [...snapshots.keys()].filter((key) => key.startsWith(prefix));
  return candidates.length === 1 ? candidates[0] : undefined;
}

function linkedImporter(importer, version) {
  if (!version.startsWith("link:")) return null;
  const importerRoot = importer === "." ? "" : importer;
  return path.posix.normalize(path.posix.join(importerRoot, version.slice("link:".length)));
}

function pnpmImporterClosures(contents) {
  const importers = pnpmRecords(contents, "importers");
  const snapshots = pnpmRecords(contents, "snapshots");
  const closures = new Map();
  const unresolved = new Set();

  const visitSnapshot = (snapshot, visited) => {
    if (visited.has(snapshot)) return;
    visited.add(snapshot);
    const block = snapshots.get(snapshot);
    if (block === undefined) {
      unresolved.add(`snapshot:${snapshot}`);
      return;
    }
    for (const [dependency, version] of pnpmDependencyRefs(block)) {
      const target = resolvePnpmSnapshot(dependency, version, snapshots);
      if (target === undefined) unresolved.add(`${snapshot}:${dependency}@${version}`);
      else if (target !== null) visitSnapshot(target, visited);
    }
  };

  const visitImporter = (importer, visitedImporters, visitedSnapshots) => {
    if (visitedImporters.has(importer)) return;
    visitedImporters.add(importer);
    const block = importers.get(importer);
    if (block === undefined) {
      unresolved.add(`importer:${importer}`);
      return;
    }
    for (const [dependency, version] of pnpmDependencyRefs(block)) {
      const linked = linkedImporter(importer, version);
      if (linked !== null) {
        visitImporter(linked, visitedImporters, visitedSnapshots);
        continue;
      }
      const target = resolvePnpmSnapshot(dependency, version, snapshots);
      if (target === undefined) unresolved.add(`${importer}:${dependency}@${version}`);
      else if (target !== null) visitSnapshot(target, visitedSnapshots);
    }
  };

  for (const importer of importers.keys()) {
    const visitedSnapshots = new Set();
    visitImporter(importer, new Set(), visitedSnapshots);
    closures.set(importer, new Set([...visitedSnapshots].map(packageBaseKey)));
  }
  return { importers, snapshots, closures, unresolved };
}

function changedRecordKeys(before, after) {
  const changed = new Set();
  for (const key of new Set([...before.keys(), ...after.keys()])) {
    if (before.get(key) !== after.get(key)) changed.add(packageBaseKey(key));
  }
  return changed;
}

function setDiffers(left = new Set(), right = new Set()) {
  return left.size !== right.size || [...left].some((item) => !right.has(item));
}

function pnpmNonGraphText(contents) {
  const graphSections = new Set(["importers", "packages", "snapshots"]);
  const lines = contents.split("\n");
  const kept = [];
  let omitted = false;
  for (const line of lines) {
    const section = line.match(/^([A-Za-z][A-Za-z0-9_-]*):\s*$/)?.[1];
    if (section) omitted = graphSections.has(section);
    if (!omitted) kept.push(line);
  }
  return kept.join("\n");
}

export function analyzePnpmLockOwnership(beforeText, afterText, changedManifestImporters = []) {
  try {
    const before = pnpmImporterClosures(beforeText);
    const after = pnpmImporterClosures(afterText);
    const changedNodes = new Set([
      ...changedRecordKeys(pnpmRecords(beforeText, "packages"), pnpmRecords(afterText, "packages")),
      ...changedRecordKeys(before.snapshots, after.snapshots),
    ]);
    const affected = new Set();
    const ownedNodes = new Set();
    for (const importer of new Set([...before.importers.keys(), ...after.importers.keys()])) {
      const beforeClosure = before.closures.get(importer) ?? new Set();
      const afterClosure = after.closures.get(importer) ?? new Set();
      const ownership = new Set([...beforeClosure, ...afterClosure]);
      ownership.forEach((item) => ownedNodes.add(item));
      if (
        before.importers.get(importer) !== after.importers.get(importer) ||
        setDiffers(beforeClosure, afterClosure) ||
        [...changedNodes].some((item) => ownership.has(item))
      ) {
        affected.add(importer);
      }
    }
    const changedManifests = new Set(changedManifestImporters);
    const owners = [...affected].filter((importer) => !changedManifests.has(importer)).sort();
    const unownedNodes = [...changedNodes].filter((item) => !ownedNodes.has(item)).sort();
    const metadataChanged = pnpmNonGraphText(beforeText) !== pnpmNonGraphText(afterText);
    const unresolved = [...new Set([...before.unresolved, ...after.unresolved])].sort();
    return {
      complete: unownedNodes.length === 0 && !metadataChanged && unresolved.length === 0,
      owners,
      changedNodes: [...changedNodes].sort(),
      unownedNodes,
      unresolved,
      metadataChanged,
    };
  } catch (error) {
    return {
      complete: false,
      owners: [],
      changedNodes: [],
      unownedNodes: [],
      unresolved: [error instanceof Error ? error.message : String(error)],
      metadataChanged: false,
    };
  }
}

function packageManifestImporter(file) {
  if (file === "package.json") return ".";
  return file.endsWith("/package.json") ? file.slice(0, -"/package.json".length) : null;
}

/**
 * Classify a cumulative pull-request diff by the repository surface that owns
 * each changed input. The classifier is deliberately conservative for shared
 * contracts, but a root lockfile no longer makes every workspace look changed
 * when the owning package.json is present in the same diff.
 */
export function classifyPaths(
  inputFiles,
  {
    forceAll = false,
    rootPackageChanges = null,
    rootLockOwners = null,
    rootLockAttributionComplete = false,
  } = {},
) {
  const files = normalizeFiles(inputFiles);
  const routes = Object.fromEntries(ROUTE_NAMES.map((name) => [name, false]));
  const reasons = Object.fromEntries(ROUTE_NAMES.map((name) => [name, []]));

  const add = (route, file) => {
    routes[route] = true;
    if (!reasons[route].includes(file)) reasons[route].push(file);
  };
  const addMany = (routeNames, file) => routeNames.forEach((route) => add(route, file));

  if (forceAll) {
    for (const route of ALL_OWNED_ROUTES) add(route, "manual full validation");
  }

  if (files.includes("pnpm-lock.yaml")) {
    if (!rootLockAttributionComplete || !Array.isArray(rootLockOwners)) {
      addMany([...JAVASCRIPT_ROUTES, "docs", "launcher"], "pnpm-lock.yaml: dependency ownership is incomplete");
    } else {
      for (const importer of rootLockOwners) {
        const evidence = `pnpm-lock.yaml: ${importer} dependency closure changed`;
        if (importer === ".") addMany(["meta", "docs", ...JAVASCRIPT_ROUTES], evidence);
        else if (importer === "apps/api") addMany(["api", "launcher"], evidence);
        else if (importer === "apps/web") addMany(["web", "storybook", "e2e", "demo"], evidence);
        else if (importer === "apps/extension") add("extension", evidence);
        else if (importer === "apps/demo-edge") addMany(["demo_edge", "demo"], evidence);
        else if (importer.startsWith("packages/")) addMany(["python", ...JAVASCRIPT_ROUTES], evidence);
        else addMany(ALL_OWNED_ROUTES, `${evidence}: unknown importer`);
      }
    }
  }

  for (const file of files) {
    if (file === ".github/workflows/ci.yml" || file.startsWith("scripts/ci-plan") || file.startsWith("scripts/ci-required")) {
      addMany(ALL_OWNED_ROUTES, file);
      continue;
    }

    if (file.startsWith(".github/")) {
      add("meta", file);
      if (file === ".github/workflows/python.yml") add("python", file);
      if (file === ".github/workflows/typescript.yml") addMany(JAVASCRIPT_ROUTES, file);
      if (file === ".github/workflows/docs-site.yml") add("docs", file);
      if (file === ".github/workflows/demo-site.yml") addMany(["demo", "demo_edge"], file);
      if (file === ".github/workflows/launcher.yml") add("launcher", file);
      if (
        file === ".github/workflows/release-distribution.yml" ||
        file === ".github/workflows/sync-homebrew-tap.yml"
      ) {
        add("distribution", file);
      }
      continue;
    }

    if (file === "pnpm-workspace.yaml") {
      addMany([...JAVASCRIPT_ROUTES, "docs", "distribution", "launcher"], file);
      continue;
    }

    if (file === "pnpm-lock.yaml") {
      add("distribution", file);
      continue;
    }

    if (file === "package.json") {
      add("distribution", file);
      if (!Array.isArray(rootPackageChanges) || rootPackageChanges.length === 0) {
        addMany(["meta", "docs", ...JAVASCRIPT_ROUTES], `${file}: ownership unavailable`);
        continue;
      }
      for (const changedKey of rootPackageChanges) {
        const [section, ...nameParts] = changedKey.split(".");
        const dependencyName = nameParts.join(".");
        const evidence = `${file}: ${changedKey}`;
        if (section === "scripts" || !PACKAGE_SECTIONS.includes(section)) {
          addMany(ALL_OWNED_ROUTES, evidence);
        } else if (ROOT_DOC_DEPENDENCIES.has(dependencyName)) {
          add("docs", evidence);
        } else if (ROOT_DISTRIBUTION_DEPENDENCIES.has(dependencyName)) {
          add("distribution", evidence);
        } else if (dependencyName === "typescript") {
          addMany(["meta", ...JAVASCRIPT_ROUTES], evidence);
        } else {
          addMany(["meta", "docs", ...JAVASCRIPT_ROUTES], evidence);
        }
      }
      continue;
    }

    if (file.startsWith("packaging/distribution/")) {
      add("distribution", file);
      if (
        file === "packaging/distribution/capability-policy.json" ||
        file === "packaging/distribution/provider-packs.lock.json"
      ) {
        add("python", file);
      }
      continue;
    }

    if (file.startsWith("workers/automation/")) {
      add("python", file);
      if (file === "workers/automation/uv.lock" || file === "workers/automation/pyproject.toml") {
        addMany(["distribution", "launcher"], file);
      }
      if (file.startsWith("workers/automation/src/")) {
        // API parity/adapter tests read Python config, launchers, projections,
        // RPC handlers, schemas, and event contracts directly. Keeping source
        // changes on this conservative boundary prevents either runtime from
        // silently drifting away from the other.
        addMany(["api", "e2e"], file);
      }
      if (
        file === "workers/automation/src/jobctrl/database.py" ||
        file.startsWith("workers/automation/src/jobctrl/domain/") ||
        file.startsWith("workers/automation/src/jobctrl/infrastructure/migrations/") ||
        file.startsWith("workers/automation/src/jobctrl/infrastructure/projections/") ||
        file.startsWith("workers/automation/src/jobctrl/infrastructure/scoring/") ||
        file.startsWith("workers/automation/src/jobctrl/infrastructure/temporal/") ||
        file.includes("schema_v7") ||
        file.includes("schema_manifest") ||
        file.includes("v6_migration_fixture") ||
        file.includes("shipped_v6_schema")
      ) {
        addMany(["api", "launcher"], file);
      }
      continue;
    }

    if (file.startsWith("packages/")) {
      addMany(["python", ...JAVASCRIPT_ROUTES], file);
      if (file.startsWith("packages/tsconfig/")) add("launcher", file);
      continue;
    }

    if (file.startsWith("apps/api/")) {
      add("api", file);
      if (
        file === "apps/api/package.json" ||
        file === "apps/api/tsconfig.json" ||
        file === "apps/api/src/db.ts" ||
        file === "apps/api/src/schema-manifest.ts" ||
        file === "apps/api/test/support/reopen-exact-v8.ts"
      ) {
        add("launcher", file);
      }
      if (file === "apps/api/src/outreach.ts") add("python", file);
      continue;
    }

    if (file.startsWith("apps/web/")) {
      addMany(["web", "storybook", "e2e", "demo"], file);
      if (
        file.startsWith("apps/web/src/contexts/outreach/") ||
        file.startsWith("apps/web/src/views/outreach/")
      ) {
        add("python", file);
      }
      continue;
    }

    if (file.startsWith("apps/extension/")) {
      add("extension", file);
      continue;
    }

    if (file.startsWith("apps/demo-edge/")) {
      addMany(["demo_edge", "demo"], file);
      continue;
    }

    if (file.startsWith("launcher/")) {
      add("launcher", file);
      continue;
    }

    if (isPublishedDoc(file)) {
      add("docs", file);
      continue;
    }

    if (
      file.startsWith("scripts/distribution-") ||
      file === "scripts/dependency-security.test.mjs" ||
      file === "scripts/release_check.py" ||
      file === "scripts/version-contract.test.mjs"
    ) {
      add("distribution", file);
      continue;
    }

    if (
      file.startsWith("scripts/check-docs-") ||
      file.startsWith("scripts/capture-docs-") ||
      file.startsWith("scripts/docs-") ||
      file === "scripts/check-install-asset.mjs" ||
      file === "scripts/get" ||
      file === "scripts/get.test.mjs"
    ) {
      add("docs", file);
      continue;
    }

    if (file.startsWith("scripts/demo-")) {
      add("demo", file);
      continue;
    }

    if (file === "scripts/install") {
      addMany(["api", "docs"], file);
      continue;
    }

    if (file.startsWith("scripts/ttfv-real")) {
      add("docs", file);
      continue;
    }

    if (file === "scripts/check-python-workflow-contract.mjs") {
      addMany(["meta", "python"], file);
      continue;
    }

    if (file === "scripts/stacked-ci-workflows.test.mjs" || file === "scripts/dependabot-config.test.mjs") {
      add("meta", file);
      continue;
    }

    if (file.startsWith("scripts/")) {
      // A new script has no declared owner yet. Fail safe until its consumer
      // and focused contract are added above instead of producing a cheap but
      // misleading meta-only pass.
      addMany(ALL_OWNED_ROUTES, file);
      continue;
    }

    if (["README.md", "LICENSE", "NOTICE"].includes(file)) {
      addMany(["python", "distribution", "docs"], file);
      continue;
    }

    if ([".env.example", "ROADMAP.md", "LAUNCH_CHECKLIST.md"].includes(file)) {
      add("docs", file);
      continue;
    }

    if (file.startsWith("docs/")) continue;

    // A new top-level or otherwise unclassified input has no declared owner.
    // Never turn that omission into an empty green plan: route it
    // conservatively until a focused ownership rule and contract exist.
    addMany(ALL_OWNED_ROUTES, `${file}: unclassified input`);
  }

  routes.typescript = ["api", "web", "storybook", "e2e", "extension", "demo_edge"].some((route) => routes[route]);
  if (routes.typescript) {
    reasons.typescript = ["one or more TypeScript-owned surfaces changed"];
  }

  return {
    schemaVersion: 1,
    files,
    routes,
    reasons,
  };
}

export function changedFilesFromGit(base, head = "HEAD", cwd = process.cwd()) {
  const output = execFileSync("git", ["diff", "--name-only", "-z", base, head], {
    cwd,
    encoding: "utf8",
    maxBuffer: 16 * 1024 * 1024,
  });
  return output.split("\0").filter(Boolean);
}

function gitFile(ref, file, cwd = process.cwd()) {
  try {
    return execFileSync("git", ["show", `${ref}:${file}`], {
      cwd,
      encoding: "utf8",
      maxBuffer: 4 * 1024 * 1024,
    });
  } catch (error) {
    if (error.status === 128) return "";
    throw error;
  }
}

export function changedRootPackageKeys(beforeText, afterText) {
  const before = beforeText ? JSON.parse(beforeText) : {};
  const after = afterText ? JSON.parse(afterText) : {};
  const changes = [];
  for (const section of PACKAGE_SECTIONS) {
    const beforeEntries = before[section] ?? {};
    const afterEntries = after[section] ?? {};
    for (const key of new Set([...Object.keys(beforeEntries), ...Object.keys(afterEntries)])) {
      if (JSON.stringify(beforeEntries[key]) !== JSON.stringify(afterEntries[key])) changes.push(`${section}.${key}`);
    }
  }
  for (const key of new Set([...Object.keys(before), ...Object.keys(after)])) {
    if (PACKAGE_SECTIONS.includes(key)) continue;
    if (JSON.stringify(before[key]) !== JSON.stringify(after[key])) changes.push(key);
  }
  return changes.sort();
}

export function changedRootPackageKeysFromGit(base, head = "HEAD", cwd = process.cwd()) {
  return changedRootPackageKeys(gitFile(base, "package.json", cwd), gitFile(head, "package.json", cwd));
}

export function planMarkdown(plan) {
  const lines = ["## CI route plan", "", `Changed files: ${plan.files.length}`, "", "| Surface | Run | Evidence |", "| --- | --- | --- |"];
  for (const route of ROUTE_NAMES) {
    const evidence = plan.reasons[route].slice(0, 4).map((item) => `\`${item}\``).join("<br>") || "—";
    lines.push(`| ${route} | ${plan.routes[route] ? "yes" : "no"} | ${evidence} |`);
  }
  return `${lines.join("\n")}\n`;
}

async function writeGitHubOutputs(plan, outputPath) {
  if (!outputPath) return;
  const lines = ROUTE_NAMES.map((route) => `${route}=${plan.routes[route]}`);
  lines.push(`plan_json=${JSON.stringify(plan)}`);
  await appendFile(outputPath, `${lines.join("\n")}\n`, "utf8");
}

export async function main(argv = process.argv.slice(2)) {
  const options = new Map();
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--all") {
      options.set("all", true);
      continue;
    }
    if (!argument.startsWith("--")) throw new Error(`unknown argument: ${argument}`);
    const value = argv[index + 1];
    if (!value || value.startsWith("--")) throw new Error(`${argument} requires a value`);
    options.set(argument.slice(2), value);
    index += 1;
  }

  const forceAll = options.get("all") === true;
  const base = options.get("base");
  const head = options.get("head") ?? "HEAD";
  if (!forceAll && !base) throw new Error("--base is required unless --all is used");
  const files = forceAll ? [] : changedFilesFromGit(base, head);
  const rootPackageChanges = !forceAll && files.includes("package.json")
    ? changedRootPackageKeysFromGit(base, head)
    : [];
  const changedManifestImporters = files.map(packageManifestImporter).filter((value) => value !== null);
  const rootLockAnalysis = !forceAll && files.includes("pnpm-lock.yaml")
    ? analyzePnpmLockOwnership(
      gitFile(base, "pnpm-lock.yaml"),
      gitFile(head, "pnpm-lock.yaml"),
      changedManifestImporters,
    )
    : { complete: true, owners: [] };
  const plan = classifyPaths(files, {
    forceAll,
    rootPackageChanges,
    rootLockOwners: rootLockAnalysis.owners,
    rootLockAttributionComplete: rootLockAnalysis.complete,
  });
  plan.rootPackageChanges = rootPackageChanges;
  plan.rootLockAnalysis = rootLockAnalysis;
  await writeGitHubOutputs(plan, options.get("github-output") ?? process.env.GITHUB_OUTPUT);
  const markdown = planMarkdown(plan);
  const summaryPath = options.get("summary") ?? process.env.GITHUB_STEP_SUMMARY;
  if (summaryPath) await appendFile(summaryPath, markdown, "utf8");
  else process.stdout.write(markdown);
  if (options.get("json")) await writeFile(options.get("json"), `${JSON.stringify(plan, null, 2)}\n`, "utf8");
  return plan;
}

const invokedPath = process.argv[1] ? pathToFileURL(path.resolve(process.argv[1])).href : "";
if (import.meta.url === invokedPath && path.basename(fileURLToPath(import.meta.url)) === "ci-plan.mjs") {
  main().catch((error) => {
    process.stderr.write(`${error.stack ?? error.message}\n`);
    process.exitCode = 1;
  });
}
