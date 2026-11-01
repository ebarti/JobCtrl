import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { lstatSync, readFileSync, realpathSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const SUITE_CONTEXTS = Object.freeze({
  api: ["Backend / Core checks"],
  web: ["Frontend / UI checks"],
  storybook: ["Support / UI checks"],
  e2e: ["Browser / UI checks"],
  extension: ["Support / UI checks"],
  python: ["Backend / Core checks"],
  docs: ["Support / UI checks"],
  launcher: ["Native / Darwin launcher shard 0", "Native / Darwin launcher shard 1"],
  credentials: ["Credentials / Native credentials (macos-latest)", "Credentials / Native credentials (windows-latest)", "Credentials / Native credentials (ubuntu-latest)"],
  gmail: ["Gmail / Synthetic Gmail token ACL (Windows)"],
  distribution: ["Backend / Core checks"],
  demo: ["Support / UI checks"],
  edge: ["Backend / Core checks"],
});
export const SURFACES = Object.freeze(Object.keys(SUITE_CONTEXTS));
const HELPER = "scripts/pr-ci-routing.mjs";
const SHA = /^[a-f0-9]{40}$/;
const REPOSITORY = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const configuration = /(?:^|\/)(?:package\.json|pnpm-lock\.yaml|pnpm-workspace\.yaml|pyproject\.toml|uv\.lock|go\.(?:mod|sum)|\.npmrc|\.node-version|\.nvmrc|\.python-version|tsconfig[^/]*\.json)$/;
const apiSafety = new Set([
  "credentials.ts", "credential-mutation-lock.ts", "credential-process-identity.ts",
  "native-credential-store.ts", "config-file.ts", "config.ts", "contracts.ts", "db.ts", "schema-manifest.ts",
].map((name) => `apps/api/src/${name}`));
const workerSafety = /(?:^|\/)(?:database|browser_capabilities|config|state|runtime|native_credentials)\.py$/;

function requireValue(condition, message) {
  if (!condition) throw new Error(message);
}

function full(reason) {
  return { mode: "full", reason, selected: Object.fromEntries(SURFACES.map((key) => [key, true])), headPrivacy: true };
}

// --no-renames exposes each rename side as A/D. NUL delimiters preserve paths
// containing whitespace; there is no API pagination or file-count limit.
export function parseDiff(buffer) {
  if (!buffer.length) return [];
  const fields = new TextDecoder("utf-8", { fatal: true }).decode(buffer).split("\0");
  requireValue(fields.pop() === "" && fields.length % 2 === 0, "Incomplete changed-path diff");
  const changes = [];
  for (let index = 0; index < fields.length; index += 2) {
    const [status, path] = fields.slice(index, index + 2);
    requireValue(/^[ADMT]$/.test(status) && path.length > 0, "Unsupported changed-path diff");
    changes.push({ status, path });
  }
  return changes;
}

export function selectSurfaces(changes) {
  if (!changes.length) return full("empty-diff");
  const selected = Object.fromEntries(SURFACES.map((key) => [key, false]));
  const select = (...keys) => keys.forEach((key) => { selected[key] = true; });
  for (const { status, path } of changes) {
    if (status === "T") return full("file-type-change");
    if (!/^[ADM]$/.test(status) || !path || path.startsWith("/") || path.includes("\\") || path.split("/").some((part) => part === "." || part === "..")) return full("unknown-path");
    if (/^(?:\.github|scripts|packages|packaging|launcher)\//.test(path) || configuration.test(path)) return full("shared-input");
    if (path === "docs/public/install.sh" || path === "apps/extension/public/manifest.json" || apiSafety.has(path) || /^apps\/api\/test\/[^/]*credential[^/]*\.ts$/.test(path) || path === "apps/api/test/support/reopen-exact-v8.ts") return full("safety-input");
    if (path.startsWith("workers/automation/src/jobctrl/") && (
      /^workers\/automation\/src\/jobctrl\/(?:infrastructure\/(?:migrations|apply|gmail)|domain\/apply|apply)\//.test(path) || workerSafety.test(path)
    )) return full("safety-input");
    if (/^workers\/automation\/tests\/(?:test_gmail_token|test_gmail_windows_acl|test_v[0-9]|v[0-9][^/]*migration|fixtures\/shipped_v)/.test(path) || (path.startsWith("workers/automation/tests/") && path.includes("_migration_"))) return full("safety-input");
    if (path.startsWith("docs/")) {
      if (path.startsWith("docs/research/interview-preparation/")) select("docs", "python");
      else if (!/^docs\/(?:plans\/|incidents\/|(?:README|claims-ledger|decisions|delivered|requirements)\.md$)/.test(path)) select("docs");
    } else if (path.startsWith("apps/web/")) {
      select("web", "storybook", "e2e", "demo");
      if (/^apps\/web\/(?:src\/(?:contexts|views)\/outreach\/|e2e\/)/.test(path)) select("python");
      if (path === "apps/web/src/styles/tokens.css") select("docs");
    } else if (path.startsWith("apps/api/")) {
      select("api", "e2e");
      if (path === "apps/api/src/outreach.ts") select("python");
    } else if (path.startsWith("workers/automation/")) select("python", "api", "e2e", "launcher");
    else if (path.startsWith("apps/extension/")) select("extension");
    else if (path.startsWith("apps/demo-edge/")) select("edge");
    else return full("unknown-path");
  }
  return { mode: "affected", reason: "known-paths", selected, headPrivacy: false };
}

function gitReader(repository, environment) {
  const env = Object.fromEntries(Object.entries(environment).filter(([key]) => !key.startsWith("GIT_")));
  Object.assign(env, { GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null", GIT_NO_REPLACE_OBJECTS: "1", GIT_ATTR_NOSYSTEM: "1", GIT_TERMINAL_PROMPT: "0" });
  return (args) => {
    try {
      return execFileSync("git", ["--no-pager", "--literal-pathspecs", "-c", "core.fsmonitor=false", "-c", "core.hooksPath=/dev/null", "-C", repository, ...args], {
        env, maxBuffer: 32 * 1024 * 1024, stdio: ["ignore", "pipe", "pipe"],
      });
    } catch {
      throw new Error("Cannot prove the required Git objects or checkout identity");
    }
  };
}

function positiveInteger(value) {
  return Number.isSafeInteger(value) && value > 0;
}

function runInteger(value) {
  requireValue(typeof value === "string" && /^[1-9][0-9]*$/.test(value) && positiveInteger(Number(value)), "Invalid producer run identity");
  return Number(value);
}

export function planPullRequest({ event, repository, policy, environment = process.env }) {
  const pr = event?.pull_request;
  const repo = event?.repository;
  requireValue(environment.GITHUB_EVENT_NAME === "pull_request" && pr && repo, "A pull-request event is required");
  requireValue(positiveInteger(repo.id) && REPOSITORY.test(repo.full_name) && environment.GITHUB_REPOSITORY === repo.full_name, "Invalid repository identity");
  requireValue(positiveInteger(event.number) && pr.number === event.number && environment.GITHUB_REF === `refs/pull/${event.number}/merge`, "Invalid pull-request identity");
  requireValue(pr.base?.repo?.id === repo.id && pr.base.repo.full_name === repo.full_name && positiveInteger(pr.head?.repo?.id) && REPOSITORY.test(pr.head.repo.full_name), "Invalid pull-request repository identity");
  requireValue(typeof repo.default_branch === "string" && repo.default_branch.length > 0 && typeof pr.base.ref === "string" && pr.base.ref.length > 0, "Invalid base branch identity");
  requireValue(SHA.test(pr.base.sha) && SHA.test(pr.head.sha) && SHA.test(environment.GITHUB_SHA) && SHA.test(policy), "Invalid commit identity");
  // GitHub computes merge_commit_sha asynchronously; synchronize events can
  // retain the preceding preview. The checked-out workflow merge and its exact
  // ordered base/head parents below establish the tested source instead.
  const run = { id: runInteger(environment.GITHUB_RUN_ID), attempt: runInteger(environment.GITHUB_RUN_ATTEMPT) };
  const git = gitReader(resolve(repository), environment);
  for (const sha of new Set([pr.base.sha, pr.head.sha, environment.GITHUB_SHA, policy])) {
    requireValue(git(["rev-parse", "--verify", `${sha}^{commit}`]).toString("utf8").trim() === sha, "Commit identity is not exact");
  }
  requireValue(git(["rev-parse", "--verify", "HEAD"]).toString("utf8").trim() === environment.GITHUB_SHA, "Checkout is not the tested merge");
  const parents = git(["show", "--no-show-signature", "-s", "--format=%P", environment.GITHUB_SHA]).toString("utf8").trim().split(" ");
  requireValue(parents.length === 2 && parents[0] === pr.base.sha && parents[1] === pr.head.sha, "Tested merge does not have the event base and head parents");
  const treeEntry = git(["ls-tree", "-z", policy, "--", HELPER]).toString("utf8");
  const blob = treeEntry.match(/^100(?:644|755) blob ([a-f0-9]{40})\tscripts\/pr-ci-routing\.mjs\0$/)?.[1];
  requireValue(blob && git(["cat-file", "blob", blob]).equals(readFileSync(fileURLToPath(import.meta.url))), "Running helper does not match the policy blob");

  let scope;
  if (pr.head.repo.id !== repo.id || pr.head.repo.full_name !== repo.full_name) scope = full("fork");
  else if (pr.base.ref !== repo.default_branch) scope = full("non-default-base");
  else if (policy !== pr.base.sha) scope = full("moving-policy-base");
  else {
    const diff = (target) => parseDiff(git(["diff", "--no-ext-diff", "--no-textconv", "--no-renames", "--name-status", "-z", pr.base.sha, target, "--"]));
    // The union covers candidate input and the actual merge's conflict resolution.
    scope = selectSurfaces([...diff(pr.head.sha), ...diff(environment.GITHUB_SHA)]);
  }
  const contexts = selectedContexts(scope.selected);
  const proof = {
    schemaVersion: 1,
    repository: { id: repo.id, fullName: repo.full_name },
    pullRequest: event.number,
    run,
    event: "pull_request",
    base: { ref: pr.base.ref, sha: pr.base.sha },
    head: { repoId: pr.head.repo.id, sha: pr.head.sha },
    mergeSha: environment.GITHUB_SHA,
    policy: { commit: policy, blob },
    ...scope,
    contexts,
  };
  requireValue(Object.keys(proof.selected).join(",") === SURFACES.join(",") && Object.values(proof.selected).every((value) => typeof value === "boolean") && typeof proof.headPrivacy === "boolean" && Object.values(proof.contexts).every((value) => typeof value === "boolean"), "Incomplete scope output");
  return proof;
}

function selectedContexts(selected) {
  const contexts = { "Admission / Release check": true, "Backend / Core checks": true };
  for (const [key, names] of Object.entries(SUITE_CONTEXTS))
    for (const name of names) contexts[name] = Boolean(contexts[name] || selected[key]);
  return contexts;
}

export function planPush({ event, repository, policy, environment = process.env }) {
  const repo = event?.repository;
  requireValue(environment.GITHUB_EVENT_NAME === "push" && repo, "A main push event is required");
  requireValue(positiveInteger(repo.id) && REPOSITORY.test(repo.full_name) && environment.GITHUB_REPOSITORY === repo.full_name, "Invalid repository identity");
  requireValue(typeof repo.default_branch === "string" && repo.default_branch.length > 0 &&
    event.ref === `refs/heads/${repo.default_branch}` && environment.GITHUB_REF === event.ref && !event.deleted,
    "Only the accepted default branch can select affected main checks");
  requireValue(SHA.test(event.after) && event.after === environment.GITHUB_SHA && SHA.test(policy), "Invalid push commit identity");
  const run = { id: runInteger(environment.GITHUB_RUN_ID), attempt: runInteger(environment.GITHUB_RUN_ATTEMPT) };
  const git = gitReader(resolve(repository), environment);
  requireValue(git(["rev-parse", "--verify", "HEAD"]).toString("utf8").trim() === event.after, "Checkout is not the pushed source");
  for (const sha of new Set([event.after, policy]))
    requireValue(git(["rev-parse", "--verify", `${sha}^{commit}`]).toString("utf8").trim() === sha, "Commit identity is not exact");
  const entry = git(["ls-tree", "-z", policy, "--", HELPER]).toString("utf8");
  const blob = entry.match(/^100(?:644|755) blob ([a-f0-9]{40})\tscripts\/pr-ci-routing\.mjs\0$/)?.[1];
  requireValue(blob && git(["cat-file", "blob", blob]).equals(readFileSync(fileURLToPath(import.meta.url))), "Running helper does not match the policy blob");
  let scope = full(policy === event.after ? "unproven-before" : "moving-policy-base");
  if (policy === event.after && SHA.test(event.before) && event.before !== "0".repeat(40) && !event.forced) {
    try {
      requireValue(git(["rev-parse", "--verify", `${event.before}^{commit}`]).toString("utf8").trim() === event.before, "Missing before commit");
      git(["merge-base", "--is-ancestor", event.before, event.after]);
      scope = selectSurfaces(parseDiff(git(["diff", "--no-ext-diff", "--no-textconv", "--no-renames", "--name-status", "-z", event.before, event.after, "--"])));
    } catch { scope = full("unproven-before"); }
  }
  // These main builds and their isolated publication remain event-owned by
  // docs-site.yml and demo-site.yml. PR builds stay in the frontend worker.
  const publicationBuilds = { docs: scope.selected.docs, demo: scope.selected.demo };
  scope.selected.docs = false;
  scope.selected.demo = false;
  return { schemaVersion: 1, repository: { id: repo.id, fullName: repo.full_name }, run, event: "push",
    before: event.before ?? null, head: { sha: event.after }, policy: { commit: policy, blob },
    ...scope, publicationBuilds, contexts: selectedContexts(scope.selected) };
}

function publish(output, proof) {
  const target = resolve(output);
  let previous = Buffer.alloc(0);
  try {
    const stat = lstatSync(target);
    requireValue(stat.isFile() && stat.size <= 1024 * 1024, "Invalid workflow output file");
    previous = readFileSync(target);
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  const values = { ...proof.selected, head_privacy: proof.headPrivacy };
  const content = Object.entries(values).map(([key, value]) => `${key}=${value}\n`).join("");
  const temporary = `${target}.${process.pid}.${randomUUID()}.tmp`;
  try {
    writeFileSync(temporary, Buffer.concat([previous, Buffer.from(content)]), { flag: "wx", mode: 0o600 });
    renameSync(temporary, target);
  } finally {
    rmSync(temporary, { force: true });
  }
}

function main(args) {
  const options = {};
  for (let index = 0; index < args.length; index += 1) {
    const key = args[index];
    requireValue(["--event", "--repository", "--policy", "--output", "--notice"].includes(key) && options[key] === undefined, "Invalid routing arguments");
    options[key] = key === "--notice" ? true : args[++index];
    requireValue(options[key] !== undefined && (key === "--notice" || !options[key].startsWith("--")), "Missing routing argument");
  }
  requireValue(["--event", "--repository", "--policy", "--output"].every((key) => typeof options[key] === "string" && options[key].length > 0), "Missing routing arguments");
  requireValue(lstatSync(options["--event"]).size <= 8 * 1024 * 1024, "Event input is too large");
  const event = JSON.parse(readFileSync(options["--event"], "utf8"));
  const plan = process.env.GITHUB_EVENT_NAME === "push" ? planPush : planPullRequest;
  const proof = plan({ event, repository: options["--repository"], policy: options["--policy"] });
  const notice = JSON.stringify(proof).replaceAll("%", "%25").replaceAll("\r", "%0D").replaceAll("\n", "%0A");
  publish(options["--output"], proof);
  if (options["--notice"]) process.stdout.write(`::notice title=JobCtrl CI scope v1::${notice}\n`);
}

function invokedDirectly() {
  if (!process.argv[1]) return false;
  try {
    return realpathSync(resolve(process.argv[1])) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

if (invokedDirectly()) {
  try { main(process.argv.slice(2)); }
  catch (error) {
    process.stderr.write(`PR CI scope refused: ${error instanceof SyntaxError ? "Malformed event JSON" : error.message}\n`);
    process.exitCode = 1;
  }
}
