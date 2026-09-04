import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import Database from "better-sqlite3";
import { afterEach, describe, expect, it, vi } from "vitest";

import { openDatabase } from "../src/db.js";
import {
  executeJobDataPurge,
  inspectJobDataPurge,
  JOB_DATA_PURGE_CONFIRMATION,
  JobDataPurgeCommittedError,
} from "../src/job-data-purge.js";
import { initializeExactV7Database } from "./v7-schema.js";

const NOW = "2026-09-01T12:00:00Z";
const JOB_ID = "00000000-0000-4000-8000-000000000901";
const JOB_URL = "https://jobs.example.test/purge-command";
const DISCOVER_WORKFLOW_ID = "discover-local";
const DISCOVER_RUN_ID = "00000000-0000-4000-8000-000000000902";
const COMPENSATION_WORKFLOW_ID = "compensation-refresh-test";
const REPOSITORY_ROOT = path.resolve(import.meta.dirname, "../../..");
const cleanups: Array<() => void> = [];

afterEach(() => {
  vi.restoreAllMocks();
  while (cleanups.length) cleanups.pop()?.();
});

type Fixture = {
  appDir: string;
  baselineResume: string;
  configContents: string;
  dbPath: string;
  outsideFile: string;
};

function createFixture(options: {
  outsideArtifact?: boolean;
  revivableWorkflow?: boolean;
  running?: boolean;
} = {}): Fixture {
  const appDir = fs.mkdtempSync(path.join(os.tmpdir(), "jobctrl-job-data-purge-"));
  const dbPath = path.join(appDir, "jobctrl.db");
  const baselineResume = path.join(appDir, "resume.pdf");
  const outsideFile = path.join(path.dirname(appDir), `${path.basename(appDir)}-outside.pdf`);
  const configContents = JSON.stringify({ daily_budget_usd: 11, preferred_models: { codex: "test-model" } });
  cleanups.push(() => {
    fs.rmSync(appDir, { recursive: true, force: true });
    fs.rmSync(outsideFile, { force: true });
  });

  initializeExactV7Database(dbPath);
  for (const directory of ["backups", "cover_letters", "logs", "tailored_resumes"]) {
    fs.mkdirSync(path.join(appDir, directory), { recursive: true });
  }
  fs.writeFileSync(path.join(appDir, "config.json"), configContents);
  fs.writeFileSync(baselineResume, "baseline-profile-resume");

  const resumePath = options.outsideArtifact
    ? outsideFile
    : path.join(appDir, "tailored_resumes", "resume-approved.pdf");
  fs.mkdirSync(path.dirname(resumePath), { recursive: true });
  fs.writeFileSync(resumePath, "registered-tailored-resume");
  fs.mkdirSync(path.join(appDir, "tailored_resumes", "candidates"), { recursive: true });
  fs.writeFileSync(path.join(appDir, "tailored_resumes", "candidates", "rejected.html"), "orphan candidate");
  fs.writeFileSync(path.join(appDir, "cover_letters", "letter.txt"), "unregistered cover letter");
  const applyLog = path.join(appDir, "logs", "registered-apply.log");
  fs.writeFileSync(applyLog, "registered apply log");

  const db = openDatabase(dbPath);
  try {
    db.prepare(
      `INSERT INTO candidate_profiles (
         tenant_id, profile_id, personal_full_name, resume_baseline_text, updated_at
       ) VALUES ('local', 'default', 'Preserved Candidate', 'Preserved baseline', ?)`,
    ).run(NOW);
    db.prepare(
      `INSERT INTO discovery_settings (tenant_id, search_config_json, created_at, updated_at)
       VALUES ('local', '{"queries":["platform engineering"],"locations":["Remote"]}', ?, ?)`,
    ).run(NOW, NOW);
    db.prepare(
      `INSERT INTO source_registry_entries (
         tenant_id, source_id, kind, display_name, owner, priority, state,
         policy_id, seed_url, created_at, updated_at
       ) VALUES ('local', 'preserved-source', 'ats', 'Preserved source', 'user',
                 'standard', 'enabled', 'policy-1', 'https://jobs.example.test', ?, ?)`,
    ).run(NOW, NOW);
    db.prepare(
      `INSERT INTO source_quality_stats (
         tenant_id, source_id, window_start, window_end, run_count,
         observed_jobs, new_jobs, last_run_id, recommended_state, updated_at
       ) VALUES (
         'local', 'preserved-source', ?, ?, 1, 1, 1, ?, 'normal', ?
       )`,
    ).run(NOW, NOW, DISCOVER_RUN_ID, NOW);
    db.prepare(
      `INSERT INTO operational_attempt_metrics (
         tenant_id, occurred_at, stage, source_id, attempt_kind, outcome,
         run_id, total_count, new_count
       ) VALUES (
         'local', ?, 'discover', 'preserved-source', 'discovery_source',
         'succeeded', ?, 1, 1
       )`,
    ).run(NOW, DISCOVER_RUN_ID);
    db.prepare(
      `INSERT INTO operational_attempt_metrics (
         tenant_id, occurred_at, stage, attempt_kind, outcome, run_id
       ) VALUES (
         'local', ?, 'operations', 'activity_process', 'succeeded',
         'unrelated-operations-run'
       )`,
    ).run(NOW);
    db.prepare(
      `INSERT INTO resume_templates (tenant_id, template_id, display_name, status, created_at, updated_at)
       VALUES ('local', 'template-1', 'Preserved template', 'active', ?, ?)`,
    ).run(NOW, NOW);
    db.prepare(
      `INSERT INTO resume_template_versions (
         tenant_id, version_id, template_id, version_number, display_name,
         status, theme_json, layout_json, content_hash, created_at
       ) VALUES ('local', 'template-version-1', 'template-1', 1, 'Preserved template',
                 'active', '{}', '{}', 'hash-1', ?)`,
    ).run(NOW);
    db.prepare(
      `INSERT INTO resume_template_defaults (tenant_id, profile_id, template_id, version_id, updated_at)
       VALUES ('local', 'default', 'template-1', 'template-version-1', ?)`,
    ).run(NOW);
    db.prepare(
      `INSERT INTO jobs (tenant_id, job_id, url, title, company, site, discovered_at)
       VALUES ('local', ?, ?, 'Purge me', 'Example', 'example', ?)`,
    ).run(JOB_ID, JOB_URL, NOW);
    db.prepare(
      `INSERT INTO job_materials (
         tenant_id, job_id, generation, status, created_at, updated_at
       ) VALUES ('local', ?, 1, 'resume_approved', ?, ?)`,
    ).run(JOB_ID, NOW, NOW);
    db.prepare(
      `INSERT INTO job_materials_artifacts (
         tenant_id, job_id, generation, artifact_type, artifact_id, status,
         path, render_format, created_at
       ) VALUES ('local', ?, 1, 'resume_pdf', 'artifact-resume', 'approved', ?, 'pdf', ?)`,
    ).run(JOB_ID, resumePath, NOW);
    db.prepare(
      `INSERT INTO job_artifacts (
         tenant_id, job_id, stage, artifact_type, status, path, created_at
      ) VALUES ('local', ?, 'apply', 'apply_log', 'approved', ?, ?)`,
    ).run(JOB_ID, applyLog, NOW);
    db.prepare(
      `INSERT INTO workflow_run_projections (
         workflow_id, tenant_id, workflow_type, status, temporal_run_id,
         started_at, finished_at
       ) VALUES (?, 'local', 'DiscoverWorkflow', 'succeeded', ?, ?, ?)`,
    ).run(DISCOVER_WORKFLOW_ID, DISCOVER_RUN_ID, NOW, NOW);
    db.prepare(
      `INSERT INTO workflow_run_projections (
         workflow_id, tenant_id, workflow_type, status, temporal_run_id,
         started_at, finished_at
       ) VALUES (?, 'local', 'CompensationRefreshWorkflow', 'succeeded',
                 'compensation-run-1', ?, ?)`,
    ).run(COMPENSATION_WORKFLOW_ID, NOW, NOW);
    db.prepare(
      `INSERT INTO discovery_execution_jobs (
         tenant_id, discover_workflow_id, discover_run_id, job_id, cohort_kind,
         source_family, source_run_id, preparation_workflow_id, work_plan_state,
         required_steps_json, linked_at
       ) VALUES ('local', ?, ?, ?, 'observed_this_run', 'example', 'source-run-1',
                 'prep-test', 'planned', '["enrich"]', ?)`,
    ).run(DISCOVER_WORKFLOW_ID, DISCOVER_RUN_ID, JOB_ID, NOW);
    db.prepare(
      `INSERT INTO discovery_execution_recoveries (
         tenant_id, discover_workflow_id, discover_run_id, state, mode,
         decoder_version, history_event_id, expected_membership_count,
         persisted_membership_count, expected_step_count, persisted_step_count,
         key_digest, last_error_code, updated_at
       ) VALUES ('local', ?, ?, 'retrying', 'native', 3, 86, 84, 0, 17, 17,
                 'recovery-digest', 'temporal-history-read-failed', ?)`,
    ).run(DISCOVER_WORKFLOW_ID, DISCOVER_RUN_ID, NOW);
    db.prepare(
      `INSERT INTO discovery_runs (
         tenant_id, run_id, source_ids_json, status, counts_json, progress_json,
         error_classes_json, started_at, updated_at, completed_at, workflow_id
       ) VALUES ('local', ?, '["preserved-source"]', 'completed', '{}', '{}',
                 '[]', ?, ?, ?, ?)`,
    ).run(DISCOVER_RUN_ID, NOW, NOW, NOW, DISCOVER_WORKFLOW_ID);
    db.prepare(
      `INSERT INTO discovery_search_units (
         tenant_id, discover_workflow_id, discover_run_id, unit_id, ordinal,
         request_json, request_fingerprint, state, created_at, updated_at,
         completed_at
       ) VALUES ('local', ?, ?, 'unit-1', 0, '{}', 'request-fingerprint',
                 'completed', ?, ?, ?)`,
    ).run(DISCOVER_WORKFLOW_ID, DISCOVER_RUN_ID, NOW, NOW, NOW);
    db.prepare(
      `INSERT INTO discovery_search_unit_jobs (
         tenant_id, discover_workflow_id, discover_run_id, unit_id, job_id,
         was_new, accepted_at
       ) VALUES ('local', ?, ?, 'unit-1', ?, 1, ?)`,
    ).run(DISCOVER_WORKFLOW_ID, DISCOVER_RUN_ID, JOB_ID, NOW);
    db.prepare(
      `INSERT INTO discovery_search_unit_filtered_events (
         tenant_id, discover_workflow_id, discover_run_id, unit_id,
         provider_event_key_hash, filtered_at
       ) VALUES ('local', ?, ?, 'unit-1', ?, ?)`,
    ).run(DISCOVER_WORKFLOW_ID, DISCOVER_RUN_ID, "a".repeat(64), NOW);
    db.prepare(
      `INSERT INTO pipeline_step_projections (
         tenant_id, discover_workflow_id, discover_run_id, step_kind, item_key,
         state, attempt, finished_at, last_event_id, last_updated_at
       ) VALUES ('local', ?, ?, 'source_planning', 'plan', 'succeeded', 1, ?, 1, ?)`,
    ).run(DISCOVER_WORKFLOW_ID, DISCOVER_RUN_ID, NOW, NOW);
    db.prepare(
      `INSERT INTO apply_run_projections (
         run_id, tenant_id, job_id, job_title, job_employer, status, dry_run,
         started_at, finished_at
       ) VALUES ('apply-run-1', 'local', ?, 'Purge me', 'Example', 'succeeded', 1, ?, ?)`,
    ).run(JOB_ID, NOW, NOW);

    const insertEvent = db.prepare(
      `INSERT INTO job_events (
         tenant_id, job_id, identity_version, stage, event_type, occurred_at,
         payload_json
       ) VALUES ('local', NULL, 1, ?, ?, ?, ?)`,
    );
    for (const event of [
      {
        eventType: "WorkflowStarted",
        payload: { workflowId: DISCOVER_WORKFLOW_ID, workflowType: "DiscoverWorkflow" },
        stage: "workflow",
      },
      {
        eventType: "WorkflowCompleted",
        payload: { workflowId: DISCOVER_WORKFLOW_ID, workflowType: "DiscoverWorkflow" },
        stage: "workflow",
      },
      { eventType: "DiscoveryRunStarted", payload: { runId: DISCOVER_RUN_ID }, stage: "discover" },
      { eventType: "StageProgress", payload: { completed: 0, total: 84 }, stage: "discover" },
      { eventType: "PipelineStepQueued", payload: { itemKey: "plan" }, stage: "workflow" },
      { eventType: "EnrichmentLeaseClaimed", payload: { owner: "test" }, stage: "workflow" },
      {
        eventType: "WorkflowStarted",
        payload: {
          workflowId: COMPENSATION_WORKFLOW_ID,
          workflowType: "CompensationRefreshWorkflow",
        },
        stage: "workflow",
      },
      {
        eventType: "WorkflowCompleted",
        payload: {
          workflowId: COMPENSATION_WORKFLOW_ID,
          workflowType: "CompensationRefreshWorkflow",
        },
        stage: "workflow",
      },
      { eventType: "ProfileUpdated", payload: { profileId: "default" }, stage: null },
      { eventType: "SourceStateChanged", payload: { sourceId: "preserved-source" }, stage: "discover" },
    ]) {
      insertEvent.run(event.stage, event.eventType, NOW, JSON.stringify(event.payload));
    }
    if (options.running) {
      db.prepare(
        `INSERT INTO job_stage_states (tenant_id, job_id, stage, state, updated_at)
         VALUES ('local', ?, 'tailor', 'running', ?)`,
      ).run(JOB_ID, NOW);
    }
    if (options.revivableWorkflow) {
      db.prepare(
        `INSERT INTO workflow_run_projections (
           workflow_id, tenant_id, workflow_type, status, error_code,
           temporal_run_id, started_at, finished_at
         ) VALUES (
           'discover-revivable-local', 'local', 'DiscoverWorkflow', 'terminated',
           'reconciled_not_found', 'temporal-run-revivable', ?, ?
         )`,
      ).run(NOW, NOW);
    }
  } finally {
    db.close();
  }

  return { appDir, baselineResume, configContents, dbPath, outsideFile };
}

function rowCount(dbPath: string, tableName: string): number {
  const db = new Database(dbPath, { readonly: true });
  try {
    return Number((db.prepare(`SELECT COUNT(*) AS count FROM ${tableName}`).get() as { count: number }).count);
  } finally {
    db.close();
  }
}

function runConfirmedPurge(appDir: string): ReturnType<typeof spawnSync> {
  return spawnSync(
    "corepack",
    ["pnpm", "data:purge-jobs", "--app-dir", appDir, "--confirm", JOB_DATA_PURGE_CONFIRMATION],
    { cwd: REPOSITORY_ROOT, encoding: "utf8" },
  );
}

describe("guarded production job-data purge", () => {
  it("backs up and purges the complete Job graph and generated files while preserving profile and search data", () => {
    const fixture = createFixture();
    const plan = inspectJobDataPurge({ appDir: fixture.appDir });

    expect(plan).toMatchObject({
      activeStageCount: 0,
      activeWorkflowCount: 0,
      generatedFiles: 3,
      jobCount: 1,
      jobOperationRows: 17,
      materialArtifactRows: 1,
      registeredArtifactRows: 2,
      registeredFileCount: 2,
      registeredLogFileCount: 1,
    });

    const result = executeJobDataPurge({ appDir: fixture.appDir });

    expect(result).toMatchObject({
      jobOperationRowsDeleted: 17,
      jobsDeleted: 1,
      movedGeneratedFiles: 4,
      noOp: false,
    });
    expect(result.backupDirectory).not.toBeNull();
    expect(result.databaseBackupPath).not.toBeNull();
    expect(rowCount(fixture.dbPath, "jobs")).toBe(0);
    expect(rowCount(fixture.dbPath, "job_materials_artifacts")).toBe(0);
    expect(rowCount(fixture.dbPath, "job_artifacts")).toBe(0);
    expect(rowCount(fixture.dbPath, "discovery_execution_jobs")).toBe(0);
    expect(rowCount(fixture.dbPath, "discovery_execution_recoveries")).toBe(0);
    expect(rowCount(fixture.dbPath, "discovery_runs")).toBe(0);
    expect(rowCount(fixture.dbPath, "discovery_search_units")).toBe(0);
    expect(rowCount(fixture.dbPath, "discovery_search_unit_jobs")).toBe(0);
    expect(rowCount(fixture.dbPath, "discovery_search_unit_filtered_events")).toBe(0);
    expect(rowCount(fixture.dbPath, "pipeline_step_projections")).toBe(0);
    expect(rowCount(fixture.dbPath, "apply_run_projections")).toBe(0);
    expect(rowCount(fixture.dbPath, "source_quality_stats")).toBe(0);
    expect(rowCount(fixture.dbPath, "candidate_profiles")).toBe(1);
    expect(rowCount(fixture.dbPath, "discovery_settings")).toBe(1);
    expect(rowCount(fixture.dbPath, "source_registry_entries")).toBe(1);
    expect(rowCount(fixture.dbPath, "resume_templates")).toBe(1);
    const preservedDb = new Database(fixture.dbPath, { readonly: true });
    try {
      expect(
        preservedDb.prepare("SELECT workflow_type FROM workflow_run_projections ORDER BY workflow_type").pluck().all(),
      ).toEqual(["CompensationRefreshWorkflow"]);
      expect(
        preservedDb.prepare("SELECT event_type FROM job_events ORDER BY event_id").pluck().all(),
      ).toEqual(["WorkflowStarted", "WorkflowCompleted", "ProfileUpdated", "SourceStateChanged"]);
      expect(
        preservedDb.prepare("SELECT stage FROM operational_attempt_metrics ORDER BY metric_id").pluck().all(),
      ).toEqual(["operations"]);
    } finally {
      preservedDb.close();
    }
    expect(fs.readFileSync(path.join(fixture.appDir, "config.json"), "utf8")).toBe(fixture.configContents);
    expect(fs.readFileSync(fixture.baselineResume, "utf8")).toBe("baseline-profile-resume");
    expect(fs.readdirSync(path.join(fixture.appDir, "tailored_resumes"))).toEqual([]);
    expect(fs.readdirSync(path.join(fixture.appDir, "cover_letters"))).toEqual([]);
    expect(fs.existsSync(path.join(fixture.appDir, "logs", "registered-apply.log"))).toBe(false);

    const backupDirectory = result.backupDirectory!;
    expect(rowCount(result.databaseBackupPath!, "jobs")).toBe(1);
    expect(rowCount(result.databaseBackupPath!, "discovery_execution_recoveries")).toBe(1);
    expect(rowCount(result.databaseBackupPath!, "workflow_run_projections")).toBe(2);
    expect(rowCount(result.databaseBackupPath!, "job_events")).toBe(10);
    expect(rowCount(result.databaseBackupPath!, "source_quality_stats")).toBe(1);
    expect(rowCount(result.databaseBackupPath!, "operational_attempt_metrics")).toBe(2);
    expect(fs.readFileSync(path.join(backupDirectory, "files", "tailored_resumes", "resume-approved.pdf"), "utf8"))
      .toBe("registered-tailored-resume");
    expect(fs.readFileSync(path.join(backupDirectory, "files", "tailored_resumes", "candidates", "rejected.html"), "utf8"))
      .toBe("orphan candidate");
    expect(fs.readFileSync(path.join(backupDirectory, "files", "cover_letters", "letter.txt"), "utf8"))
      .toBe("unregistered cover letter");
    expect(fs.readFileSync(path.join(backupDirectory, "files", "logs", "registered-apply.log"), "utf8"))
      .toBe("registered apply log");

    expect(executeJobDataPurge({ appDir: fixture.appDir })).toMatchObject({
      jobOperationRows: 0,
      jobOperationRowsDeleted: 0,
      jobsDeleted: 0,
      noOp: true,
    });
  });

  it("clears stale Discover execution history even when an earlier purge already removed every job", () => {
    const fixture = createFixture();
    const db = openDatabase(fixture.dbPath);
    try {
      db.pragma("foreign_keys = ON");
      db.prepare("DELETE FROM apply_run_projections WHERE tenant_id = 'local'").run();
      db.prepare("DELETE FROM jobs WHERE tenant_id = 'local'").run();
    } finally {
      db.close();
    }
    for (const directoryName of ["tailored_resumes", "cover_letters"] as const) {
      const directory = path.join(fixture.appDir, directoryName);
      fs.rmSync(directory, { recursive: true, force: true });
      fs.mkdirSync(directory);
    }
    fs.rmSync(path.join(fixture.appDir, "logs", "registered-apply.log"), { force: true });

    expect(inspectJobDataPurge({ appDir: fixture.appDir })).toMatchObject({
      generatedEntries: 0,
      jobCount: 0,
      jobOperationRows: 14,
      registeredLogFileCount: 0,
    });

    const command = runConfirmedPurge(fixture.appDir);
    expect(command.status).toBe(0);
    expect(command.stdout).toMatch(/Purged 0 jobs and 14 job execution\/history rows; archived 0 generated files\./);
    const bundles = fs.readdirSync(path.join(fixture.appDir, "backups"));
    expect(bundles).toHaveLength(1);
    const databaseBackupPath = path.join(fixture.appDir, "backups", bundles[0]!, "jobctrl-before.db");
    expect(rowCount(databaseBackupPath, "jobs")).toBe(0);
    expect(rowCount(databaseBackupPath, "discovery_execution_recoveries")).toBe(1);
    expect(rowCount(databaseBackupPath, "source_quality_stats")).toBe(1);
    expect(rowCount(databaseBackupPath, "operational_attempt_metrics")).toBe(2);
    expect(rowCount(fixture.dbPath, "discovery_execution_recoveries")).toBe(0);
    expect(rowCount(fixture.dbPath, "pipeline_step_projections")).toBe(0);
    expect(rowCount(fixture.dbPath, "discovery_runs")).toBe(0);
    expect(rowCount(fixture.dbPath, "source_quality_stats")).toBe(0);
    expect(rowCount(fixture.dbPath, "candidate_profiles")).toBe(1);
    expect(rowCount(fixture.dbPath, "discovery_settings")).toBe(1);
    expect(rowCount(fixture.dbPath, "workflow_run_projections")).toBe(1);
    expect(rowCount(fixture.dbPath, "job_events")).toBe(4);
    const preservedDb = new Database(fixture.dbPath, { readonly: true });
    try {
      expect(
        preservedDb.prepare("SELECT stage FROM operational_attempt_metrics ORDER BY metric_id").pluck().all(),
      ).toEqual(["operations"]);
    } finally {
      preservedDb.close();
    }
  });

  it("refuses registered artifact paths outside the JobCtrl-owned generated-data boundary", () => {
    const fixture = createFixture({ outsideArtifact: true });

    expect(() => executeJobDataPurge({ appDir: fixture.appDir })).toThrow(/outside the owned generated-data boundary/i);
    expect(rowCount(fixture.dbPath, "jobs")).toBe(1);
    expect(fs.readFileSync(fixture.outsideFile, "utf8")).toBe("registered-tailored-resume");
    expect(fs.readdirSync(path.join(fixture.appDir, "backups"))).toEqual([]);
  });

  it("refuses a symlinked database authority before opening or backing it up", () => {
    const fixture = createFixture();
    const externalDatabase = path.join(path.dirname(fixture.appDir), `${path.basename(fixture.appDir)}-database.db`);
    fs.renameSync(fixture.dbPath, externalDatabase);
    fs.symlinkSync(externalDatabase, fixture.dbPath);
    cleanups.push(() => fs.rmSync(externalDatabase, { force: true }));

    expect(() => inspectJobDataPurge({ appDir: fixture.appDir })).toThrow(/jobctrl\.db is not a regular file/i);
    const command = runConfirmedPurge(fixture.appDir);
    expect(command.status).not.toBe(0);
    expect(`${command.stdout}${command.stderr}`).toMatch(/jobctrl\.db is not a regular file/i);
    expect(rowCount(externalDatabase, "jobs")).toBe(1);
    expect(fs.readdirSync(path.join(fixture.appDir, "backups"))).toEqual([]);
  });

  it("refuses a symlinked backup authority before mutating the database", () => {
    const fixture = createFixture();
    const backupsDirectory = path.join(fixture.appDir, "backups");
    const externalBackups = fs.mkdtempSync(path.join(os.tmpdir(), "jobctrl-job-data-purge-backups-"));
    fs.rmdirSync(backupsDirectory);
    fs.symlinkSync(externalBackups, backupsDirectory);
    cleanups.push(() => fs.rmSync(externalBackups, { recursive: true, force: true }));

    expect(() => inspectJobDataPurge({ appDir: fixture.appDir })).toThrow(/backups directory is not a regular directory/i);
    const command = runConfirmedPurge(fixture.appDir);
    expect(command.status).not.toBe(0);
    expect(`${command.stdout}${command.stderr}`).toMatch(/backups directory is not a regular directory/i);
    expect(rowCount(fixture.dbPath, "jobs")).toBe(1);
    expect(fs.readdirSync(externalBackups)).toEqual([]);
  });

  it("refuses a symlinked workspace authority", () => {
    const fixture = createFixture();
    const linkedAppDir = path.join(path.dirname(fixture.appDir), `${path.basename(fixture.appDir)}-link`);
    fs.symlinkSync(fixture.appDir, linkedAppDir);
    cleanups.push(() => fs.rmSync(linkedAppDir, { force: true }));

    expect(() => inspectJobDataPurge({ appDir: linkedAppDir })).toThrow(/workspace is not a regular directory/i);
    const command = runConfirmedPurge(linkedAppDir);
    expect(command.status).not.toBe(0);
    expect(`${command.stdout}${command.stderr}`).toMatch(/workspace is not a regular directory/i);
    expect(rowCount(fixture.dbPath, "jobs")).toBe(1);
    expect(fs.readdirSync(path.join(fixture.appDir, "backups"))).toEqual([]);
  });

  it("restores a generated directory when replacement creation fails before commit", () => {
    const fixture = createFixture();
    const tailoredResumes = path.join(fixture.appDir, "tailored_resumes");
    const originalMkdirSync = fs.mkdirSync.bind(fs);
    let injected = false;
    vi.spyOn(fs, "mkdirSync").mockImplementation((target, options) => {
      if (!injected && path.resolve(String(target)) === tailoredResumes) {
        injected = true;
        throw Object.assign(new Error("injected replacement-directory failure"), { code: "ENOSPC" });
      }
      return originalMkdirSync(target, options);
    });

    expect(() => executeJobDataPurge({ appDir: fixture.appDir })).toThrow(/injected replacement-directory failure/i);
    expect(rowCount(fixture.dbPath, "jobs")).toBe(1);
    expect(fs.readFileSync(path.join(tailoredResumes, "resume-approved.pdf"), "utf8"))
      .toBe("registered-tailored-resume");
    expect(fs.readFileSync(path.join(tailoredResumes, "candidates", "rejected.html"), "utf8"))
      .toBe("orphan candidate");
  });

  it("reports the recovery bundle when verification fails after the database commit", () => {
    const fixture = createFixture();
    const originalStatSync = fs.statSync.bind(fs);
    let databaseStatCalls = 0;
    vi.spyOn(fs, "statSync").mockImplementation((target) => {
      if (path.resolve(String(target)) === fixture.dbPath) {
        databaseStatCalls += 1;
        if (databaseStatCalls === 2) {
          throw Object.assign(new Error("injected post-commit verification failure"), { code: "EIO" });
        }
      }
      return originalStatSync(target);
    });

    let failure: unknown;
    try {
      executeJobDataPurge({ appDir: fixture.appDir });
    } catch (error) {
      failure = error;
    }

    expect(failure).toBeInstanceOf(JobDataPurgeCommittedError);
    expect(String(failure)).toMatch(/purge committed/i);
    expect(String(failure)).toMatch(/recovery bundle:/i);
    expect(String(failure)).toMatch(/keep JobCtrl stopped/i);
    expect(rowCount(fixture.dbPath, "jobs")).toBe(0);
    const bundles = fs.readdirSync(path.join(fixture.appDir, "backups"));
    expect(bundles).toHaveLength(1);
    expect(rowCount(path.join(fixture.appDir, "backups", bundles[0]!, "jobctrl-before.db"), "jobs")).toBe(1);
  });

  it("refuses to purge while a job stage is active", () => {
    const fixture = createFixture({ running: true });

    expect(() => executeJobDataPurge({ appDir: fixture.appDir })).toThrow(/active work/i);
    expect(rowCount(fixture.dbPath, "jobs")).toBe(1);
    expect(fs.readdirSync(path.join(fixture.appDir, "backups"))).toEqual([]);
  });

  it("treats a provisional reconciled-not-found workflow as revivable and refuses the exact command", () => {
    const fixture = createFixture({ revivableWorkflow: true });

    expect(inspectJobDataPurge({ appDir: fixture.appDir })).toMatchObject({
      activeStageCount: 0,
      activeWorkflowCount: 1,
      jobCount: 1,
    });
    const command = runConfirmedPurge(fixture.appDir);
    expect(command.status).not.toBe(0);
    expect(`${command.stdout}${command.stderr}`).toMatch(/active work \(0 active stages, 1 active workflows\)/i);
    expect(rowCount(fixture.dbPath, "jobs")).toBe(1);
    expect(fs.readdirSync(path.join(fixture.appDir, "backups"))).toEqual([]);
  });
});
