import { expect, test } from "@playwright/test";
import Database from "better-sqlite3";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { loadE2eDbPath } from "../fixtures/e2e-state.js";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../..");
const JOB_ID = "b0410000-0000-4000-8000-000000000041";
const COORDINATE = "https://jobs.lever.co/qa-jobctrl-1041";
const POSTING = `${COORDINATE}/posting-one`;
const NOW = "2026-10-18T09:00:00Z";

function cli(...args: string[]) {
  // The only transport seam is public DNS. Retain the real CLI, schema admission,
  // learner, queue, source decisions and worker-side URL-safety checks.
  const script = `
import socket, sys
from pathlib import Path
from jobctrl import config
from jobctrl.infrastructure.discovery import posting_source_proposals as proposals
from jobctrl.infrastructure.network.url_safety import validate_public_http_url
config.DB_PATH = Path(sys.argv[1])
config.APP_DIR = config.DB_PATH.parent
config.load_env = lambda: None
def public_dns(*args, **kwargs):
    return [(socket.AF_INET, socket.SOCK_STREAM, 6, "", ("93.184.216.34", 443))]
proposals.validate_public_http_url = lambda url: validate_public_http_url(url, resolver=public_dns)
from jobctrl.cli import app
sys.argv = ["jobctrl", "source-proposals", *sys.argv[2:]]
app()
`;
  return JSON.parse(execFileSync(path.join(repoRoot, "workers/automation/.venv/bin/python"), ["-c", script, loadE2eDbPath(), ...args], {
    cwd: repoRoot, env: { ...process.env, LANGFUSE_DISABLE: "1", JOBCTRL_RUNTIME_MODE: "source" }, encoding: "utf8", timeout: 30_000,
  }));
}

function fingerprint(db: Database.Database) {
  const tables = ["jobs", "job_enrichments", "job_canonical_identities", "job_application_locators", "discovery_settings", "source_registry_entries"];
  const applyTables = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name LIKE 'apply_%' ORDER BY name").all() as { name: string }[];
  return JSON.stringify([...tables, ...applyTables.map((row) => row.name)].map((name) => [name, db.prepare(`SELECT * FROM "${name}"`).all()]));
}

test.afterEach(() => {
  const db = new Database(loadE2eDbPath());
  try {
    db.pragma("foreign_keys = ON");
    db.transaction(() => {
      db.prepare("DELETE FROM source_locator_candidates WHERE tenant_id = 'local' AND candidate_url = ?").run(COORDINATE);
      db.prepare("DELETE FROM job_events WHERE tenant_id = 'local' AND json_valid(payload_json) AND json_extract(payload_json, '$.coordinateKey') = ?").run(COORDINATE);
      db.prepare("DELETE FROM jobs WHERE tenant_id = 'local' AND job_id = ?").run(JOB_ID);
    })();
  } finally { db.close(); }
});

for (const mobile of [false, true]) {
  test(`history source proposals retain evidence through review, rejection and reset${mobile ? " @mobile" : ""}`, async ({ page }, testInfo) => {
    test.setTimeout(90_000);
    await page.setViewportSize(mobile ? { width: 390, height: 844 } : { width: 1440, height: 1000 });
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    page.on("console", (message) => { if (message.type() === "error") errors.push(message.text()); });
    const db = new Database(loadE2eDbPath());
    try {
      expect(db.prepare("SELECT 1 FROM jobs WHERE job_id = ?").get(JOB_ID)).toBeUndefined();
      db.prepare("INSERT INTO jobs (tenant_id, job_id, url, title, company, description, discovered_at) VALUES ('local', ?, ?, 'QA Platform Engineer', 'Synthetic Acme', 'Build reliable synthetic systems.', ?)").run(JOB_ID, POSTING, NOW);
      db.prepare("INSERT INTO job_enrichments (tenant_id, job_id, current_status, full_description, application_url, extraction_tier, enriched_at, updated_at) VALUES ('local', ?, 'succeeded', 'Build reliable synthetic systems.', ?, 'json_ld', ?, ?)").run(JOB_ID, `${POSTING}/apply`, NOW, NOW);
      db.prepare("INSERT INTO job_source_observations (tenant_id, source_observation_id, job_id, source_id, source_native_id, observed_url, normalized_observed_url, run_id, observed_at) VALUES ('local', 'qa-1041-observation', ?, 'manual_capture:extension', 'qa-1041-posting', ?, ?, 'qa-1041-capture-run', ?)").run(JOB_ID, POSTING, POSTING, NOW);
      const before = fingerprint(db);
      expect(cli("list").candidates.some((row: { candidate_url: string }) => row.candidate_url === COORDINATE)).toBe(false);
      expect(cli("from-history", "--job-id", JOB_ID).counts.proposed).toBe(2);
      const candidates = cli("list").candidates.filter((row: { candidate_url: string }) => row.candidate_url === COORDINATE);
      expect(candidates).toHaveLength(1);
      const candidateId = candidates[0].candidate_id;
      await page.goto("/discovery");
      await page.getByRole("tab", { name: "Source locator", exact: true }).click();
      const panel = page.getByRole("tabpanel").filter({ has: page.getByRole("heading", { name: "Source locator", exact: true }) });
      await expect(panel).toContainText("Board: lever:qa-jobctrl-1041");
      await expect(panel).toContainText("Completeness unknown");
      await expect(panel).toContainText("QA Platform Engineer · Synthetic Acme · Build reliable synthetic systems.");
      await expect(panel).toContainText("qa-1041-capture-run");
      await expect(panel).toContainText("Extraction: json_ld");
      expect(page.url()).toContain("/discovery");
      await expect(page).toHaveTitle(/JobCtrl/);
      await expect(page.locator("vite-error-overlay")).toHaveCount(0);
      await panel.scrollIntoViewIfNeeded();
      const screenshot = path.join(process.env["JOBCTRL_QA_SCREENSHOT_DIR"] ?? os.tmpdir(), `jobctrl-1041-${mobile ? "mobile" : "desktop"}.png`);
      await page.screenshot({ path: screenshot, fullPage: false });
      await testInfo.attach("source-proposal-review", { body: fs.readFileSync(screenshot), contentType: "image/png" });
      expect(fingerprint(db)).toBe(before);
      await page.getByRole("button", { name: `Reject ${COORDINATE}`, exact: true }).click();
      await expect(panel.getByRole("button", { name: `Reject ${COORDINATE}`, exact: true })).toHaveCount(0);
      expect(cli("from-history", "--job-id", JOB_ID).counts.suppressed).toBe(2);
      expect(cli("list").candidates.some((row: { candidate_url: string }) => row.candidate_url === COORDINATE)).toBe(false);
      expect(cli("reset", candidateId).decision).toBe("reset");
      expect(cli("from-history", "--job-id", JOB_ID).counts.proposed).toBe(2);
      await page.reload();
      await page.getByRole("tab", { name: "Source locator", exact: true }).click();
      await expect(page.getByRole("button", { name: `Reject ${COORDINATE}`, exact: true })).toBeVisible();
      expect(fingerprint(db)).toBe(before);
      expect(errors).toEqual([]);
    } finally { db.close(); }
  });
}
