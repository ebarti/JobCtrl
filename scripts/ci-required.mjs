import { appendFile } from "node:fs/promises";
import process from "node:process";
import { pathToFileURL } from "node:url";

const ROUTE_TO_JOB = {
  meta: "meta",
  distribution: "distribution",
  python: "python",
  typescript: "typescript",
  docs: "docs",
  demo: "demo",
  launcher: "launcher",
};

const REQUIRED_PLAN_ROUTES = [
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

function validatePlan(plan) {
  if (!plan || typeof plan !== "object" || Array.isArray(plan)) throw new Error("CI route plan must be an object");
  if (plan.schemaVersion !== 1) throw new Error(`unsupported CI route plan schema: ${String(plan.schemaVersion)}`);
  if (!plan.routes || typeof plan.routes !== "object" || Array.isArray(plan.routes)) {
    throw new Error("CI route plan routes must be an object");
  }
  const actualRoutes = Object.keys(plan.routes).sort();
  const expectedRoutes = [...REQUIRED_PLAN_ROUTES].sort();
  if (JSON.stringify(actualRoutes) !== JSON.stringify(expectedRoutes)) {
    throw new Error(`CI route plan must contain exactly: ${expectedRoutes.join(", ")}`);
  }
  for (const route of REQUIRED_PLAN_ROUTES) {
    if (typeof plan.routes[route] !== "boolean") throw new Error(`CI route ${route} must be a boolean`);
  }
}

export function validateRequiredResults(plan, results) {
  if (results.plan !== "success") throw new Error(`route plan did not succeed: ${results.plan ?? "missing"}`);
  validatePlan(plan);
  const rows = [];
  for (const [route, job] of Object.entries(ROUTE_TO_JOB)) {
    const required = Boolean(plan.routes?.[route]);
    const result = results[job] ?? "missing";
    rows.push({ route, job, required, result });
    if (required && result !== "success") {
      throw new Error(`${route} was routed to ${job}, but the job result was ${result}`);
    }
    if (!required && !["success", "skipped"].includes(result)) {
      throw new Error(`${job} was not routed but finished with ${result}`);
    }
  }
  return rows;
}

export function resultsMarkdown(rows) {
  const lines = ["## Required CI result", "", "| Surface | Required | Job result |", "| --- | --- | --- |"];
  for (const row of rows) lines.push(`| ${row.route} | ${row.required ? "yes" : "no"} | ${row.result} |`);
  return `${lines.join("\n")}\n`;
}

export async function main() {
  const plan = JSON.parse(process.env.CI_PLAN_JSON ?? "{}");
  const results = JSON.parse(process.env.CI_RESULTS_JSON ?? "{}");
  const rows = validateRequiredResults(plan, results);
  const markdown = resultsMarkdown(rows);
  if (process.env.GITHUB_STEP_SUMMARY) await appendFile(process.env.GITHUB_STEP_SUMMARY, markdown, "utf8");
  else process.stdout.write(markdown);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    process.stderr.write(`${error.stack ?? error.message}\n`);
    process.exitCode = 1;
  });
}
