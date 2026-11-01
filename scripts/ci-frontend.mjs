import { spawn } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import { createWriteStream } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { frontendRecipes } from "./ci-frontend-recipes.mjs";

const root = fileURLToPath(new URL("../", import.meta.url));
export const frontendLanes = Object.freeze({
  browsers: ["e2e"],
  core: ["web"],
  support: ["boundary", "storybook", "extension", "docs", "demo"],
});

export function selectedFrontend(environment) {
  return Object.fromEntries(["web", "storybook", "e2e", "extension", "docs", "demo"].map(suite => {
    const value = environment["CI_" + suite.toUpperCase()];
    if (value !== undefined && value !== "true" && value !== "false") throw Error("Invalid frontend selection: " + suite);
    return [suite, value !== "false"];
  }));
}

export function assertSingleFrontendProfile(selected) {
  const profiles = [selected.web, selected.e2e, selected.storybook || selected.extension || selected.docs || selected.demo];
  if (profiles.filter(Boolean).length > 1) throw Error("Web, supporting UI and E2E require separate runners");
}

// Commands remain in the runner's process tree. GitHub owns cancellation and
// the final disposable-VM boundary, including descendants and job timeouts.
export async function runFrontendLanes({ selected, recipes = frontendRecipes, environment = process.env, directory = root, logDirectory }) {
  assertSingleFrontendProfile(selected);
  await mkdir(logDirectory, { mode: 0o700 });
  const results = [];
  const runLane = async ([lane, suites]) => {
      const log = createWriteStream(path.join(logDirectory, lane + ".log"), { flags: "wx", mode: 0o600 });
      try {
        for (const suite of suites) {
          if (!selected[suite === "boundary" ? "storybook" : suite]) continue;
          for (const recipe of recipes[suite] ?? []) {
            const start = Date.now();
            const label = lane + "/" + recipe.name;
            console.log("Starting " + label);
            log.write("\n" + label + "\n");
            const env = { ...environment, CI_LANE: lane };
            for (const [key, value] of Object.entries(recipe.env ?? {}))
              env[key] = value.replaceAll("${{ runner.temp }}", environment.RUNNER_TEMP);
            const child = spawn("bash", ["-euo", "pipefail", "-c", recipe.run], {
              cwd: recipe["working-directory"] ? path.resolve(directory, recipe["working-directory"]) : directory,
              env, stdio: ["ignore", "pipe", "pipe"],
            });
            child.stdout.pipe(log, { end: false });
            child.stderr.pipe(log, { end: false });
            const outcome = await new Promise((resolve, reject) => {
              child.once("error", reject);
              child.once("close", (code, signal) => resolve({ code, signal }));
            });
            const passed = outcome.code === 0;
            results.push({ lane, suite, name: recipe.name, passed, code: outcome.code, signal: outcome.signal, seconds: (Date.now() - start) / 1000 });
            console.log((passed ? "Passed " : "Failed ") + label);
            if (!passed) break;
          }
        }
      } finally { await new Promise(resolve => log.end(resolve)); }
  };
  const lanes = [];
  for (const lane of Object.entries(frontendLanes)) {
    try { await runLane(lane); lanes.push({ status: "fulfilled" }); }
    catch (reason) { lanes.push({ status: "rejected", reason }); }
  }
  const errors = lanes.filter(lane => lane.status === "rejected").map(lane => String(lane.reason));
  await writeFile(path.join(logDirectory, "outcomes.json"), JSON.stringify({ errors, results }, null, 2) + "\n", { flag: "wx", mode: 0o600 });
  return !errors.length && results.every(result => result.passed);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (process.platform !== "linux" || process.env.CI !== "true" || process.env.RUNNER_ENVIRONMENT !== "github-hosted")
    throw Error("Frontend verification requires an isolated GitHub-hosted Linux runner");
  if (!path.isAbsolute(process.env.RUNNER_TEMP ?? "")) throw Error("An owned runner temporary directory is required");
  const selected = selectedFrontend(process.env);
  const success = await runFrontendLanes({ selected, logDirectory: path.join(process.env.RUNNER_TEMP, "ci-frontend-logs") });
  process.exitCode = success ? 0 : 1;
}
