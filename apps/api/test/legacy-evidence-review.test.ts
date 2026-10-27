import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import Database from "better-sqlite3";
import { afterEach, expect, it } from "vitest";
import { readProfileConfig } from "../src/profile-store.js";
import { requiresLegacyEvidenceReview } from "../src/legacy-evidence-review.js";
import { buildApp } from "../src/server.js";

const root = path.resolve(fileURLToPath(new URL("../../..", import.meta.url)));
const directories: string[] = [];
afterEach(() => { for (const directory of directories.splice(0)) fs.rmSync(directory, { recursive: true, force: true }); });

function python(dbPath: string, action: string) {
  const directory = path.dirname(dbPath);
  fs.mkdirSync(path.join(directory, "home"), { recursive: true });
  const result = spawnSync(process.env["JOBCTRL_MIGRATION_TEST_PYTHON"] ?? path.join(root, "workers/automation/.venv/bin/python"),
    [path.join(root, "workers/automation/tests/legacy_evidence_fixture.py"), dbPath, action], {
      cwd: root, encoding: "utf8", env: { ...process.env, HOME: path.join(directory, "home"), JOBCTRL_DIR: directory,
        LANGFUSE_DISABLE: "1", PYTHONPATH: [path.join(root, "workers/automation/src"), path.join(root, "workers/automation")].join(path.delimiter) },
    });
  expect(result.status, result.stderr).toBe(0);
}

it("reads Python migration and human review authority through real Profile HTTP without mutating confirmations", async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "jobctrl-legacy-evidence-"));
  directories.push(directory);
  const dbPath = path.join(directory, "jobctrl.db");
  python(dbPath, "create");
  const db = new Database(dbPath);
  const app = buildApp({ dbPath, configPath: path.join(directory, "config.json"), appDir: directory });
  try {
    const before = db.prepare("SELECT * FROM candidate_profile_achievement_evidence").all();
    const history = db.prepare("SELECT * FROM job_events").all();
    const response = await app.inject({ method: "GET", url: "/v1/profile" });
    expect(response.statusCode, response.body).toBe(200);
    expect(response.json().legacyEvidenceReview).toEqual({ status: "review_required", count: 3 });
    expect(response.json().profile.resume.experience_entries[0].achievement_evidence[0])
      .toMatchObject({ id: "role_bullet_1", scope: "Authored  scope\t", user_confirmed: true, confirmation_review_required: true });
    expect(db.prepare("SELECT * FROM candidate_profile_achievement_evidence").all()).toEqual(before);
    expect(db.prepare("SELECT * FROM job_events").all()).toEqual(history);
    expect(requiresLegacyEvidenceReview(db, "foreign", "default", "role", "role_bullet_1")).toBe(false);
    const reference = JSON.stringify(["default", "role", "role_bullet_1"]);
    const inventory = db.prepare("SELECT event_id,payload_json FROM job_events WHERE entity_ref=?").get(reference) as { event_id: number; payload_json: string };
    db.prepare("UPDATE job_events SET payload_json=json_set(payload_json,'$.result.status','unconfirmed') WHERE event_id=?").run(inventory.event_id);
    expect(() => readProfileConfig(db)).toThrow("legacy_evidence_review_invalid_history");
    db.prepare("UPDATE job_events SET payload_json=? WHERE event_id=?").run(inventory.payload_json, inventory.event_id);
    python(dbPath, "review");
    const reviewed = readProfileConfig(db);
    expect(reviewed.legacyEvidenceReview).toBeUndefined();
    expect(requiresLegacyEvidenceReview(db, "local", "default", "role", "role_bullet_1")).toBe(false);
    expect(db.prepare("SELECT user_confirmed FROM candidate_profile_achievement_evidence WHERE evidence_id='role_bullet_2'").get())
      .toEqual({ user_confirmed: 0 });
    db.prepare("UPDATE candidate_profile_achievement_evidence SET scope='newer edit' WHERE evidence_id='role_bullet_1'").run();
    expect(readProfileConfig(db).legacyEvidenceReview?.count).toBe(1);
  } finally { db.close(); await app.close(); }
});
