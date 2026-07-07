import { test, expect } from "@playwright/test";
import Database from "better-sqlite3";
import fs from "node:fs";
import path from "node:path";

interface State {
  workspace?: { dbPath?: string };
}

function findRepoRoot(start: string): string {
  let current = path.resolve(start);
  for (let i = 0; i < 10; i += 1) {
    if (fs.existsSync(path.join(current, "pnpm-workspace.yaml"))) {
      return current;
    }
    const next = path.dirname(current);
    if (next === current) {
      throw new Error(`Could not find repo root above ${start}`);
    }
    current = next;
  }
  throw new Error(`Could not find repo root within 10 ancestors of ${start}`);
}

function loadDbPath(): string {
  const stateFile = path.join(findRepoRoot(process.cwd()), ".jobctl-e2e-state.json");
  const raw = fs.readFileSync(stateFile, "utf-8");
  const state = JSON.parse(raw) as State;
  if (!state.workspace?.dbPath) {
    throw new Error("E2E state file is missing workspace.dbPath; global-setup did not run.");
  }
  return state.workspace.dbPath;
}

const JOB_URL = "https://boards.greenhouse.io/gitlab/jobs/qa-platform-director";

// The seeded worker heartbeat is written once at global-setup; the suite runs
// serially and can exceed the 45s staleness window before this spec runs. Refresh
// it to "now" so the worker-readiness gate passes regardless of suite ordering —
// the test owns its own worker-ready precondition.
function refreshWorkerHeartbeat(dbPath: string): void {
  const db = new Database(dbPath);
  try {
    db.prepare("UPDATE worker_runtime_heartbeats SET last_seen_at = ?").run(new Date().toISOString());
  } finally {
    db.close();
  }
}

// INSPECT-01: per-job material generation is invokable from the product surface.
// The generate-materials route returns 202 (not 400), the button is enabled, and
// the worker-confirmed approval reflects in-app via the SSE realtime loop. The
// dispatch is stubbed (JOBCTL_E2E_STUB_DISPATCH) so the spec exercises the
// route + UI wiring without a worker subprocess or LLM; the terminal
// ResumeApproved event is injected into SQLite exactly as dry-run.spec.ts does.
test("Generate materials: button enabled → dispatch queued → ResumeApproved surfaces in audit history", async ({
  page,
}) => {
  const dbPath = loadDbPath();
  refreshWorkerHeartbeat(dbPath);
  page.on("dialog", (dialog) => void dialog.accept());

  await page.goto("/jobs");
  const row = page
    .locator("table.jobs-data-grid-table tbody tr")
    .filter({ hasText: "Director of Platform Engineering" });
  await expect(row).toBeVisible({ timeout: 30_000 });
  // Row activation is the named per-row "Open" button, not a whole-row click:
  // structural rows stay non-interactive for accessibility.
  await row
    .getByRole("button", { name: /^Open job Director of Platform Engineering/ })
    .click();

  const drawer = page.getByRole("dialog", { name: "Job details" });
  await expect(drawer).toBeVisible({ timeout: 10_000 });

  // The button is enabled (no longer the disabled "not yet wired" stub).
  const generateButton = drawer.getByRole("button", { name: /generate materials/i });
  await expect(generateButton).toBeEnabled();

  // Capture the dispatch response to prove the route returns 202 (not 400).
  const [dispatchResponse] = await Promise.all([
    page.waitForResponse(
      (response) =>
        response.url().includes("/actions/generate-materials") && response.request().method() === "POST",
      { timeout: 30_000 },
    ),
    generateButton.click(),
  ]);
  expect(dispatchResponse.status()).toBe(202);
  expect(await dispatchResponse.json()).toMatchObject({ ok: true, action: "run_stage", status: "queued" });

  // Drive the worker-confirmed terminal state through the realtime loop: inject a
  // ResumeApproved event, which the SSE pipeline streams to the invalidation
  // router → refreshes the job detail → the drawer's audit history shows it.
  const occurredAt = new Date().toISOString();
  const db = new Database(dbPath);
  try {
    db.prepare(
      `INSERT INTO job_events (job_url, stage, event_type, level, message, occurred_at, payload_json)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      JOB_URL,
      "tailor",
      "ResumeApproved",
      "info",
      "QA E2E injected ResumeApproved event",
      occurredAt,
      JSON.stringify({
        tenantId: "local",
        jobId: JOB_URL,
        artifactId: "qa-e2e-resume",
        generation: 2,
        approvedAt: occurredAt,
      }),
    );
  } finally {
    db.close();
  }

  // Expand the audit history disclosure and assert the approval surfaced. The
  // disclosure summary is the stable target (the body may briefly render the
  // empty state before the injected event arrives via SSE).
  await drawer.locator("summary", { hasText: "Audit history" }).click();
  await expect(drawer.getByText(/resume approved/i)).toBeVisible({ timeout: 30_000 });
});
