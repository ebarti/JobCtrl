import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { openDatabase, openReadOnlyDatabase, type SqliteDatabase } from "./db.js";
import { permanentlyDeleteJobs } from "./write-model.js";

export const JOB_DATA_PURGE_CONFIRMATION = "DELETE-ALL-JOB-DATA";

const LOCAL_TENANT = "local";
const GENERATED_DIRECTORY_NAMES = ["tailored_resumes", "cover_letters"] as const;
const REGISTERED_FILE_DIRECTORY_NAMES = ["tailored_resumes", "cover_letters", "logs"] as const;
const TERMINAL_WORKFLOW_STATUSES = [
  "canceled",
  "failed",
  "succeeded",
  "terminated",
  "timed_out",
] as const;
const ACTIVE_STAGE_STATES = ["queued", "running"] as const;
const JOB_DATA_WORKFLOW_TYPES = [
  "ApplyWorkflow",
  "DiscoverWorkflow",
  "InterviewPrepWorkflow",
  "JobPipelineWorkflow",
  "JobPreparationWorkflow",
  "JobUrlImportWorkflow",
  "ManualCaptureImportWorkflow",
] as const;
const WORKFLOW_LIFECYCLE_EVENT_TYPES = [
  "WorkflowStarted",
  "WorkflowCancellationRequested",
  "WorkflowCompleted",
  "WorkflowFailed",
  "WorkflowCanceled",
  "WorkflowTimedOut",
  "WorkflowTerminated",
] as const;
const DISCOVERY_EXECUTION_EVENT_TYPES = [
  "DiscoveryRunStarted",
  "DiscoveryRunCompleted",
  "DiscoveryRunFailed",
  "PipelineStepQueued",
  "PipelineStepStarted",
  "PipelineStepCompleted",
  "PipelineStepFailed",
  "EnrichmentLeaseClaimed",
] as const;
const JOB_STAGE_EVENT_TYPES = [
  "StageQueued",
  "StageStarted",
  "StageProgress",
  "StageCompleted",
  "StageFailed",
  "StageBlocked",
  "StageCanceled",
  "StageExhausted",
  "StageReset",
  "StageSkipped",
  "StageStale",
] as const;
const JOB_STAGES = ["discover", "enrich", "score", "tailor", "cover", "apply"] as const;
const JOB_OPERATION_TABLES = [
  "apply_run_projections",
  "discovery_execution_jobs",
  "discovery_execution_recoveries",
  "discovery_runs",
  "discovery_search_unit_filtered_events",
  "discovery_search_unit_jobs",
  "discovery_search_units",
  "pipeline_step_projections",
  "source_quality_stats",
] as const;

/**
 * These are the user-owned authorities the purge promises not to change.
 * Job-scoped template assignments and refresh attempts are intentionally not
 * here: they belong to generated Materials and cascade with their Job.
 */
const PRESERVED_TABLES = [
  "candidate_profiles",
  "candidate_profile_achievement_evidence",
  "candidate_profile_education_entries",
  "candidate_profile_experience_bullets",
  "candidate_profile_experience_entries",
  "candidate_profile_required_bullets",
  "candidate_profile_required_education_entries",
  "candidate_profile_required_experience_entries",
  "candidate_profile_required_skill_categories",
  "candidate_profile_required_skills",
  "candidate_profile_resume_constraint_metrics",
  "candidate_profile_skill_categories",
  "candidate_profile_skill_items",
  "discovery_settings",
  "resume_template_defaults",
  "resume_template_versions",
  "resume_templates",
  "scoring_policies",
  "source_registry_entries",
  "tailoring_policies",
] as const;

type PreservedTableName = (typeof PRESERVED_TABLES)[number];

type FileTreeStats = {
  bytes: number;
  entries: number;
  files: number;
  symlinks: number;
};

type TableFingerprint = {
  digest: string;
  rows: number;
};

type PreservationSnapshot = {
  configDigest: string;
  tables: Record<PreservedTableName, TableFingerprint>;
};

type RegisteredFile = {
  absolutePath: string;
  directoryName: (typeof REGISTERED_FILE_DIRECTORY_NAMES)[number];
  exists: boolean;
};

type StagedPath = {
  destination: string;
  source: string;
  sourceMode: number | null;
  type: "directory" | "file";
};

type AuthorityIdentity = {
  device: number;
  inode: number;
  realPath: string;
};

type WorkspaceAuthorities = {
  appDir: string;
  backups: AuthorityIdentity | null;
  database: AuthorityIdentity;
  databasePath: string;
  workspace: AuthorityIdentity;
};

export type JobDataPurgePlan = {
  activeStageCount: number;
  activeWorkflowCount: number;
  appDir: string;
  databaseBytes: number;
  databasePath: string;
  generatedBytes: number;
  generatedEntries: number;
  generatedFiles: number;
  generatedSymlinks: number;
  jobCount: number;
  jobOperationRows: number;
  materialArtifactRows: number;
  registeredArtifactRows: number;
  registeredFileCount: number;
  registeredLogFileCount: number;
  registeredMissingFileCount: number;
};

export type JobDataPurgeResult = JobDataPurgePlan & {
  backupDirectory: string | null;
  databaseBackupPath: string | null;
  jobOperationRowsDeleted: number;
  jobsDeleted: number;
  logicalDatabaseBytesAfter: number;
  movedGeneratedFiles: number;
  noOp: boolean;
};

export type JobDataPurgeOptions = {
  appDir?: string;
};

export class JobDataPurgeCommittedError extends Error {
  readonly backupDirectory: string;
  readonly databaseBackupPath: string;

  constructor(cause: unknown, backupDirectory: string, databaseBackupPath: string) {
    const causeMessage = cause instanceof Error ? cause.message : String(cause);
    super(
      `Job-data purge committed, but post-commit compaction or verification failed. `
      + `Live job data may already be purged. Recovery bundle: ${backupDirectory}. `
      + `Keep JobCtrl stopped and restore ${databaseBackupPath} plus the bundle's files/ tree before retrying. `
      + `Cause: ${causeMessage}`,
    );
    this.name = "JobDataPurgeCommittedError";
    this.backupDirectory = backupDirectory;
    this.databaseBackupPath = databaseBackupPath;
  }
}

function defaultAppDir(): string {
  return path.resolve(process.env.JOBCTRL_DIR || path.join(os.homedir(), ".jobctrl"));
}

function resolvedAppDir(input?: string): string {
  return path.resolve(input || defaultAppDir());
}

function lstatIfPresent(authorityPath: string): fs.Stats | null {
  try {
    return fs.lstatSync(authorityPath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

function authorityIdentity(authorityPath: string, stat: fs.Stats): AuthorityIdentity {
  return {
    device: stat.dev,
    inode: stat.ino,
    realPath: fs.realpathSync(authorityPath),
  };
}

function requireRegularAuthorityDirectory(directoryPath: string, label: string): AuthorityIdentity {
  const stat = lstatIfPresent(directoryPath);
  if (!stat) throw new Error(`Refusing to purge: ${label} does not exist.`);
  if (stat.isSymbolicLink() || !stat.isDirectory()) {
    throw new Error(`Refusing to purge: ${label} is not a regular directory.`);
  }
  return authorityIdentity(directoryPath, stat);
}

function requireRegularAuthorityFile(filePath: string, label: string): AuthorityIdentity {
  const stat = lstatIfPresent(filePath);
  if (!stat) throw new Error(`Refusing to purge: ${label} does not exist.`);
  if (stat.isSymbolicLink() || !stat.isFile()) {
    throw new Error(`Refusing to purge: ${label} is not a regular file.`);
  }
  return authorityIdentity(filePath, stat);
}

function requireWorkspaceAuthorities(appDir: string): WorkspaceAuthorities {
  const workspace = requireRegularAuthorityDirectory(appDir, "the JobCtrl workspace");
  const databasePath = path.join(appDir, "jobctrl.db");
  const database = requireRegularAuthorityFile(databasePath, "jobctrl.db");
  if (!isPathInside(database.realPath, workspace.realPath) || database.realPath === workspace.realPath) {
    throw new Error("Refusing to purge: jobctrl.db resolves outside the JobCtrl workspace.");
  }
  const backupsDirectory = path.join(appDir, "backups");
  const backupsStat = lstatIfPresent(backupsDirectory);
  const backups = backupsStat
    ? requireRegularAuthorityDirectory(backupsDirectory, "the backups directory")
    : null;
  if (backups && (!isPathInside(backups.realPath, workspace.realPath) || backups.realPath === workspace.realPath)) {
    throw new Error("Refusing to purge: the backups directory resolves outside the JobCtrl workspace.");
  }
  return { appDir, backups, database, databasePath, workspace };
}

function sameIdentity(left: AuthorityIdentity, right: AuthorityIdentity): boolean {
  return left.device === right.device && left.inode === right.inode && left.realPath === right.realPath;
}

function assertWorkspaceAuthorities(
  expected: WorkspaceAuthorities,
  options: { allowBackupCreation?: boolean } = {},
): WorkspaceAuthorities {
  const current = requireWorkspaceAuthorities(expected.appDir);
  const backupIdentityMatches = expected.backups
    ? Boolean(current.backups && sameIdentity(expected.backups, current.backups))
    : options.allowBackupCreation || current.backups === null;
  if (
    !sameIdentity(expected.workspace, current.workspace)
    || !sameIdentity(expected.database, current.database)
    || !backupIdentityMatches
  ) {
    throw new Error("Refusing to purge: a workspace, database, or backup authority changed during execution.");
  }
  return current;
}

function countRows(db: SqliteDatabase, sql: string, params: readonly string[] = []): number {
  const row = db.prepare(sql).get(...params) as { count: number | bigint } | undefined;
  return Number(row?.count ?? 0);
}

function placeholders(values: readonly string[]): string {
  return values.map(() => "?").join(", ");
}

function jobOperationEventPredicate(): { params: string[]; sql: string } {
  const params = [
    LOCAL_TENANT,
    ...DISCOVERY_EXECUTION_EVENT_TYPES,
    ...JOB_STAGE_EVENT_TYPES,
    ...JOB_STAGES,
    ...WORKFLOW_LIFECYCLE_EVENT_TYPES,
    ...JOB_DATA_WORKFLOW_TYPES,
    ...JOB_DATA_WORKFLOW_TYPES,
  ];
  return {
    params,
    sql: `job_events.tenant_id = ?
      AND (
        job_events.event_type IN (${placeholders(DISCOVERY_EXECUTION_EVENT_TYPES)})
        OR (
          job_events.event_type IN (${placeholders(JOB_STAGE_EVENT_TYPES)})
          AND LOWER(COALESCE(job_events.stage, '')) IN (${placeholders(JOB_STAGES)})
        )
        OR (
          job_events.event_type IN (${placeholders(WORKFLOW_LIFECYCLE_EVENT_TYPES)})
          AND job_events.payload_json IS NOT NULL
          AND json_valid(job_events.payload_json)
          AND (
            COALESCE(
              json_extract(job_events.payload_json, '$.workflowType'),
              json_extract(job_events.payload_json, '$.workflow_type')
            ) IN (${placeholders(JOB_DATA_WORKFLOW_TYPES)})
            OR EXISTS (
              SELECT 1
                FROM workflow_run_projections AS workflows
               WHERE workflows.tenant_id = job_events.tenant_id
                 AND workflows.workflow_id = COALESCE(
                   json_extract(job_events.payload_json, '$.workflowId'),
                   json_extract(job_events.payload_json, '$.workflow_id')
                 )
                 AND workflows.workflow_type IN (${placeholders(JOB_DATA_WORKFLOW_TYPES)})
            )
          )
        )
      )`,
  };
}

function jobOperationalAttemptMetricPredicate(): { params: string[]; sql: string } {
  return {
    params: [LOCAL_TENANT, ...JOB_STAGES],
    sql: `tenant_id = ?
      AND LOWER(COALESCE(stage, '')) IN (${placeholders(JOB_STAGES)})`,
  };
}

function jobOperationRowCount(db: SqliteDatabase): number {
  const tableRows = JOB_OPERATION_TABLES.reduce(
    (total, tableName) => total + countRows(
      db,
      `SELECT COUNT(*) AS count FROM ${tableName} WHERE tenant_id = ?`,
      [LOCAL_TENANT],
    ),
    0,
  );
  const workflowRows = countRows(
    db,
    `SELECT COUNT(*) AS count
       FROM workflow_run_projections
      WHERE tenant_id = ?
        AND workflow_type IN (${placeholders(JOB_DATA_WORKFLOW_TYPES)})`,
    [LOCAL_TENANT, ...JOB_DATA_WORKFLOW_TYPES],
  );
  const eventPredicate = jobOperationEventPredicate();
  const eventRows = countRows(
    db,
    `SELECT COUNT(*) AS count FROM job_events WHERE ${eventPredicate.sql}`,
    eventPredicate.params,
  );
  const attemptMetricPredicate = jobOperationalAttemptMetricPredicate();
  const attemptMetricRows = countRows(
    db,
    `SELECT COUNT(*) AS count FROM operational_attempt_metrics WHERE ${attemptMetricPredicate.sql}`,
    attemptMetricPredicate.params,
  );
  return tableRows + workflowRows + eventRows + attemptMetricRows;
}

function purgeJobOperationRows(db: SqliteDatabase): void {
  const eventPredicate = jobOperationEventPredicate();
  db.prepare(`DELETE FROM job_events WHERE ${eventPredicate.sql}`).run(...eventPredicate.params);

  // Delete children explicitly so the removed-row inventory is independent of
  // whether a caller opened SQLite with foreign-key cascades enabled.
  for (const tableName of JOB_OPERATION_TABLES) {
    db.prepare(`DELETE FROM ${tableName} WHERE tenant_id = ?`).run(LOCAL_TENANT);
  }
  const attemptMetricPredicate = jobOperationalAttemptMetricPredicate();
  db.prepare(
    `DELETE FROM operational_attempt_metrics WHERE ${attemptMetricPredicate.sql}`,
  ).run(...attemptMetricPredicate.params);
  db.prepare(
    `DELETE FROM workflow_run_projections
      WHERE tenant_id = ?
        AND workflow_type IN (${placeholders(JOB_DATA_WORKFLOW_TYPES)})`,
  ).run(LOCAL_TENANT, ...JOB_DATA_WORKFLOW_TYPES);
}

function isPathInside(candidate: string, parent: string): boolean {
  const relative = path.relative(parent, candidate);
  return relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative));
}

function requireOwnedDirectory(appDir: string, directoryName: string): string {
  const directoryPath = path.join(appDir, directoryName);
  if (!fs.existsSync(directoryPath)) return directoryPath;
  const stat = fs.lstatSync(directoryPath);
  if (stat.isSymbolicLink() || !stat.isDirectory()) {
    throw new Error(`Refusing to purge: ${directoryName} is not a regular JobCtrl-owned directory.`);
  }
  return directoryPath;
}

function fileTreeStats(root: string): FileTreeStats {
  if (!fs.existsSync(root)) return { bytes: 0, entries: 0, files: 0, symlinks: 0 };
  const totals: FileTreeStats = { bytes: 0, entries: 0, files: 0, symlinks: 0 };
  const pending = [root];
  while (pending.length) {
    const directory = pending.pop();
    if (!directory) continue;
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      totals.entries += 1;
      const entryPath = path.join(directory, entry.name);
      if (entry.isSymbolicLink()) {
        totals.symlinks += 1;
      } else if (entry.isDirectory()) {
        pending.push(entryPath);
      } else if (entry.isFile()) {
        totals.files += 1;
        totals.bytes += fs.statSync(entryPath).size;
      }
    }
  }
  return totals;
}

function registeredArtifactPaths(db: SqliteDatabase): string[] {
  const rows = db.prepare(
    `SELECT DISTINCT artifacts.path AS path
       FROM job_artifacts AS artifacts
       INNER JOIN jobs
         ON jobs.tenant_id = artifacts.tenant_id
        AND jobs.job_id = artifacts.job_id
      WHERE jobs.tenant_id = ?
        AND TRIM(artifacts.path) != ''
      UNION
     SELECT DISTINCT artifacts.path AS path
       FROM job_materials_artifacts AS artifacts
       INNER JOIN jobs
         ON jobs.tenant_id = artifacts.tenant_id
        AND jobs.job_id = artifacts.job_id
      WHERE jobs.tenant_id = ?
        AND TRIM(artifacts.path) != ''`,
  ).all(LOCAL_TENANT, LOCAL_TENANT) as Array<{ path: string }>;
  return rows.map((row) => String(row.path)).filter(Boolean);
}

function classifyRegisteredFiles(appDir: string, rawPaths: readonly string[]): RegisteredFile[] {
  const ownedRoots = new Map(
    REGISTERED_FILE_DIRECTORY_NAMES.map((name) => [name, requireOwnedDirectory(appDir, name)] as const),
  );
  const classified: RegisteredFile[] = [];
  let unsafeCount = 0;

  for (const rawPath of new Set(rawPaths)) {
    const lexicalPath = path.resolve(appDir, rawPath);
    const existing = fs.existsSync(lexicalPath);
    const effectivePath = existing ? fs.realpathSync(lexicalPath) : lexicalPath;
    const directoryName = REGISTERED_FILE_DIRECTORY_NAMES.find((name) => {
      const root = ownedRoots.get(name);
      if (!root) return false;
      const effectiveRoot = fs.existsSync(root) ? fs.realpathSync(root) : root;
      return isPathInside(effectivePath, effectiveRoot);
    });
    if (!directoryName) {
      unsafeCount += 1;
      continue;
    }
    if (existing) {
      const stat = fs.lstatSync(lexicalPath);
      if (stat.isSymbolicLink() || !stat.isFile()) {
        unsafeCount += 1;
        continue;
      }
    }
    classified.push({ absolutePath: lexicalPath, directoryName, exists: existing });
  }

  if (unsafeCount > 0) {
    throw new Error(
      `Refusing to purge: ${unsafeCount} registered artifact path(s) are outside the owned generated-data boundary or are not regular files.`,
    );
  }
  return classified;
}

function canonicalRow(row: Record<string, unknown>): string {
  return JSON.stringify(
    Object.entries(row).map(([key, value]) => {
      if (Buffer.isBuffer(value)) return [key, { bufferBase64: value.toString("base64") }];
      if (typeof value === "bigint") return [key, { bigint: value.toString() }];
      return [key, value];
    }),
  );
}

function tableFingerprint(db: SqliteDatabase, tableName: PreservedTableName): TableFingerprint {
  const rows = (db.prepare(`SELECT * FROM ${tableName}`).all() as Array<Record<string, unknown>>)
    .map(canonicalRow)
    .sort();
  return {
    digest: createHash("sha256").update(rows.join("\n")).digest("hex"),
    rows: rows.length,
  };
}

function fileDigest(filePath: string): string {
  if (!fs.existsSync(filePath)) return "missing";
  const stat = fs.lstatSync(filePath);
  if (stat.isSymbolicLink() || !stat.isFile()) {
    throw new Error("Refusing to purge: config.json is not a regular file.");
  }
  return createHash("sha256").update(fs.readFileSync(filePath)).digest("hex");
}

function preservationSnapshot(db: SqliteDatabase, appDir: string): PreservationSnapshot {
  const tables = Object.fromEntries(
    PRESERVED_TABLES.map((tableName) => [tableName, tableFingerprint(db, tableName)]),
  ) as Record<PreservedTableName, TableFingerprint>;
  return {
    configDigest: fileDigest(path.join(appDir, "config.json")),
    tables,
  };
}

function assertPreserved(before: PreservationSnapshot, after: PreservationSnapshot): void {
  if (JSON.stringify(before) !== JSON.stringify(after)) {
    throw new Error("Purge invariant failed: profile, template, search, or settings data changed.");
  }
}

function activeWorkCounts(db: SqliteDatabase): { activeStageCount: number; activeWorkflowCount: number } {
  const stagePlaceholders = ACTIVE_STAGE_STATES.map(() => "?").join(", ");
  const workflowPlaceholders = TERMINAL_WORKFLOW_STATUSES.map(() => "?").join(", ");
  return {
    activeStageCount: countRows(
      db,
      `SELECT COUNT(*) AS count
         FROM job_stage_states
        WHERE tenant_id = ? AND LOWER(state) IN (${stagePlaceholders})`,
      [LOCAL_TENANT, ...ACTIVE_STAGE_STATES],
    ),
    activeWorkflowCount: countRows(
      db,
      `SELECT COUNT(*) AS count
         FROM workflow_run_projections
        WHERE tenant_id = ?
          AND (
            LOWER(status) NOT IN (${workflowPlaceholders})
            OR (
              LOWER(status) = 'terminated'
              AND LOWER(COALESCE(error_code, '')) = 'reconciled_not_found'
            )
          )`,
      [LOCAL_TENANT, ...TERMINAL_WORKFLOW_STATUSES],
    ),
  };
}

function assertNoActiveWork(db: SqliteDatabase): void {
  const active = activeWorkCounts(db);
  if (active.activeStageCount > 0 || active.activeWorkflowCount > 0) {
    throw new Error(
      `Refusing to purge while JobCtrl reports active work (${active.activeStageCount} active stages, ${active.activeWorkflowCount} active workflows). Stop or cancel it first.`,
    );
  }
}

function buildPlan(db: SqliteDatabase, appDir: string): JobDataPurgePlan {
  const databasePath = path.join(appDir, "jobctrl.db");
  const otherTenantJobs = countRows(
    db,
    "SELECT COUNT(*) AS count FROM jobs WHERE tenant_id != ?",
    [LOCAL_TENANT],
  );
  if (otherTenantJobs > 0) {
    throw new Error(`Refusing to perform a partial purge: ${otherTenantJobs} non-local Job row(s) exist.`);
  }

  const registeredRows = countRows(
    db,
    `SELECT
       (SELECT COUNT(*) FROM job_artifacts WHERE tenant_id = ?) +
       (SELECT COUNT(*) FROM job_materials_artifacts WHERE tenant_id = ?) AS count`,
    [LOCAL_TENANT, LOCAL_TENANT],
  );
  const materialArtifactRows = countRows(
    db,
    "SELECT COUNT(*) AS count FROM job_materials_artifacts WHERE tenant_id = ?",
    [LOCAL_TENANT],
  );
  const registeredFiles = classifyRegisteredFiles(appDir, registeredArtifactPaths(db));
  const generatedStats = GENERATED_DIRECTORY_NAMES
    .map((name) => fileTreeStats(requireOwnedDirectory(appDir, name)))
    .reduce<FileTreeStats>(
      (total, item) => ({
        bytes: total.bytes + item.bytes,
        entries: total.entries + item.entries,
        files: total.files + item.files,
        symlinks: total.symlinks + item.symlinks,
      }),
      { bytes: 0, entries: 0, files: 0, symlinks: 0 },
    );
  const active = activeWorkCounts(db);
  return {
    ...active,
    appDir,
    databaseBytes: fs.statSync(databasePath).size,
    databasePath,
    generatedBytes: generatedStats.bytes,
    generatedEntries: generatedStats.entries,
    generatedFiles: generatedStats.files,
    generatedSymlinks: generatedStats.symlinks,
    jobCount: countRows(db, "SELECT COUNT(*) AS count FROM jobs WHERE tenant_id = ?", [LOCAL_TENANT]),
    jobOperationRows: jobOperationRowCount(db),
    materialArtifactRows,
    registeredArtifactRows: registeredRows,
    registeredFileCount: registeredFiles.filter((item) => item.exists).length,
    registeredLogFileCount: registeredFiles.filter((item) => item.exists && item.directoryName === "logs").length,
    registeredMissingFileCount: registeredFiles.filter((item) => !item.exists).length,
  };
}

export function inspectJobDataPurge(options: JobDataPurgeOptions = {}): JobDataPurgePlan {
  const appDir = resolvedAppDir(options.appDir);
  const authorities = requireWorkspaceAuthorities(appDir);
  const db = openReadOnlyDatabase(authorities.databasePath);
  try {
    const plan = buildPlan(db, appDir);
    assertWorkspaceAuthorities(authorities);
    return plan;
  } finally {
    db.close();
  }
}

function backupTimestamp(): string {
  return new Date().toISOString().replaceAll(":", "").replaceAll("-", "").replace(".", "-");
}

function createBackupDirectory(appDir: string): string {
  const backupsDir = path.join(appDir, "backups");
  fs.mkdirSync(backupsDir, { mode: 0o700, recursive: true });
  requireRegularAuthorityDirectory(backupsDir, "the backups directory");
  const directory = fs.mkdtempSync(path.join(backupsDir, `job-data-purge-${backupTimestamp()}-`));
  fs.chmodSync(directory, 0o700);
  return directory;
}

function backupDatabase(db: SqliteDatabase, destination: string): void {
  db.prepare("VACUUM INTO ?").run(destination);
  fs.chmodSync(destination, 0o600);
}

function stageGeneratedDirectory(
  appDir: string,
  backupDirectory: string,
  directoryName: (typeof GENERATED_DIRECTORY_NAMES)[number],
  staged: StagedPath[],
): void {
  const source = requireOwnedDirectory(appDir, directoryName);
  if (!fs.existsSync(source) || fs.readdirSync(source).length === 0) return;
  const sourceMode = fs.statSync(source).mode & 0o777;
  const destination = path.join(backupDirectory, "files", directoryName);
  fs.mkdirSync(path.dirname(destination), { mode: 0o700, recursive: true });
  fs.renameSync(source, destination);
  staged.push({ destination, source, sourceMode, type: "directory" });
  fs.mkdirSync(source, { mode: sourceMode });
}

function stageRegisteredLogFiles(
  appDir: string,
  backupDirectory: string,
  registeredFiles: readonly RegisteredFile[],
  staged: StagedPath[],
): void {
  const logsRoot = requireOwnedDirectory(appDir, "logs");
  for (const file of registeredFiles) {
    if (file.directoryName !== "logs" || !file.exists) continue;
    const relative = path.relative(logsRoot, file.absolutePath);
    if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) {
      throw new Error("Refusing to purge: a registered log path escaped the owned logs directory.");
    }
    const destination = path.join(backupDirectory, "files", "logs", relative);
    fs.mkdirSync(path.dirname(destination), { mode: 0o700, recursive: true });
    fs.renameSync(file.absolutePath, destination);
    staged.push({ destination, source: file.absolutePath, sourceMode: null, type: "file" });
  }
}

function restoreStagedPaths(staged: readonly StagedPath[]): void {
  const failures: string[] = [];
  for (const item of [...staged].reverse()) {
    try {
      if (!fs.existsSync(item.destination)) continue;
      if (item.type === "directory") {
        if (fs.existsSync(item.source)) {
          if (fs.readdirSync(item.source).length > 0) {
            throw new Error("replacement directory received new files");
          }
          fs.rmdirSync(item.source);
        }
        fs.renameSync(item.destination, item.source);
        if (item.sourceMode !== null) fs.chmodSync(item.source, item.sourceMode);
      } else {
        fs.mkdirSync(path.dirname(item.source), { recursive: true });
        fs.renameSync(item.destination, item.source);
      }
    } catch (error) {
      failures.push(error instanceof Error ? error.message : String(error));
    }
  }
  if (failures.length > 0) {
    throw new Error(`Database purge rolled back, but ${failures.length} staged path(s) could not be restored.`);
  }
}

function assertLogicalPurge(db: SqliteDatabase): void {
  const remainingJobs = countRows(db, "SELECT COUNT(*) AS count FROM jobs WHERE tenant_id = ?", [LOCAL_TENANT]);
  const remainingJobOperationRows = jobOperationRowCount(db);
  const remainingMaterialArtifacts = countRows(
    db,
    "SELECT COUNT(*) AS count FROM job_materials_artifacts WHERE tenant_id = ?",
    [LOCAL_TENANT],
  );
  const remainingArtifacts = countRows(
    db,
    "SELECT COUNT(*) AS count FROM job_artifacts WHERE tenant_id = ?",
    [LOCAL_TENANT],
  );
  if (remainingJobs || remainingMaterialArtifacts || remainingArtifacts || remainingJobOperationRows) {
    throw new Error(
      `Purge invariant failed: ${remainingJobs} jobs, ${remainingMaterialArtifacts + remainingArtifacts} artifact row(s), and ${remainingJobOperationRows} job execution/history row(s) remain.`,
    );
  }
  const foreignKeyViolations = db.prepare("PRAGMA foreign_key_check").all();
  if (foreignKeyViolations.length > 0) {
    throw new Error(`Purge invariant failed: ${foreignKeyViolations.length} foreign-key violation(s) remain.`);
  }
}

function assertDatabaseIntegrity(db: SqliteDatabase): void {
  const rows = db.prepare("PRAGMA integrity_check").all() as Array<{ integrity_check: string }>;
  if (rows.length !== 1 || rows[0]?.integrity_check !== "ok") {
    throw new Error("Purge invariant failed: SQLite integrity_check did not return ok.");
  }
}

export function executeJobDataPurge(options: JobDataPurgeOptions = {}): JobDataPurgeResult {
  const appDir = resolvedAppDir(options.appDir);
  let authorities = requireWorkspaceAuthorities(appDir);
  const databasePath = authorities.databasePath;
  const db = openDatabase(databasePath);
  let staged: StagedPath[] = [];
  let backupDirectory: string | null = null;
  let databaseBackupPath: string | null = null;
  try {
    const plan = buildPlan(db, appDir);
    const hasGeneratedEntries = plan.generatedEntries > 0;
    const hasRegisteredLogFiles = plan.registeredLogFileCount > 0;
    if (
      plan.jobCount === 0
      && plan.jobOperationRows === 0
      && !hasGeneratedEntries
      && !hasRegisteredLogFiles
    ) {
      assertWorkspaceAuthorities(authorities);
      assertDatabaseIntegrity(db);
      return {
        ...plan,
        backupDirectory: null,
        databaseBackupPath: null,
        jobOperationRowsDeleted: 0,
        jobsDeleted: 0,
        logicalDatabaseBytesAfter: plan.databaseBytes,
        movedGeneratedFiles: 0,
        noOp: true,
      };
    }

    assertNoActiveWork(db);
    const registeredFiles = classifyRegisteredFiles(appDir, registeredArtifactPaths(db));
    const preservedBefore = preservationSnapshot(db, appDir);
    assertWorkspaceAuthorities(authorities);
    backupDirectory = createBackupDirectory(appDir);
    authorities = assertWorkspaceAuthorities(authorities, { allowBackupCreation: true });
    databaseBackupPath = path.join(backupDirectory, "jobctrl-before.db");
    backupDatabase(db, databaseBackupPath);
    assertWorkspaceAuthorities(authorities);

    let jobOperationRowsDeleted = 0;
    let jobsDeleted = 0;
    const transaction = db.transaction(() => {
      assertWorkspaceAuthorities(authorities);
      assertNoActiveWork(db);
      assertPreserved(preservedBefore, preservationSnapshot(db, appDir));
      for (const directoryName of GENERATED_DIRECTORY_NAMES) {
        stageGeneratedDirectory(appDir, backupDirectory!, directoryName, staged);
      }
      stageRegisteredLogFiles(appDir, backupDirectory!, registeredFiles, staged);

      const jobOperationRowsBefore = jobOperationRowCount(db);
      const jobKeys = (db.prepare("SELECT job_id FROM jobs WHERE tenant_id = ? ORDER BY job_id").all(LOCAL_TENANT) as Array<{ job_id: string }>)
        .map((row) => row.job_id);
      const result = permanentlyDeleteJobs(db, { allMatching: false, jobKeys });
      jobsDeleted = result.count;
      if (jobsDeleted !== jobKeys.length) {
        throw new Error(`Purge invariant failed: expected to delete ${jobKeys.length} jobs, deleted ${jobsDeleted}.`);
      }
      purgeJobOperationRows(db);
      jobOperationRowsDeleted = jobOperationRowsBefore;
      assertLogicalPurge(db);
      assertPreserved(preservedBefore, preservationSnapshot(db, appDir));
      assertWorkspaceAuthorities(authorities);
    });

    try {
      transaction.immediate();
    } catch (error) {
      try {
        restoreStagedPaths(staged);
        staged = [];
      } catch (restoreError) {
        throw new AggregateError([error, restoreError], "Job-data purge failed and filesystem rollback was incomplete.");
      }
      throw error;
    }

    try {
      assertWorkspaceAuthorities(authorities);
      db.pragma("wal_checkpoint(TRUNCATE)");
      db.exec("VACUUM");
      db.pragma("wal_checkpoint(TRUNCATE)");
      assertLogicalPurge(db);
      assertPreserved(preservedBefore, preservationSnapshot(db, appDir));
      assertDatabaseIntegrity(db);
      assertWorkspaceAuthorities(authorities);
      for (const directoryName of GENERATED_DIRECTORY_NAMES) {
        const stats = fileTreeStats(requireOwnedDirectory(appDir, directoryName));
        if (stats.entries > 0) {
          throw new Error(`Purge invariant failed: ${directoryName} is not empty after the purge.`);
        }
      }

      return {
        ...plan,
        backupDirectory,
        databaseBackupPath,
        jobOperationRowsDeleted,
        jobsDeleted,
        logicalDatabaseBytesAfter: fs.statSync(databasePath).size,
        movedGeneratedFiles: plan.generatedFiles + plan.registeredLogFileCount,
        noOp: false,
      };
    } catch (error) {
      throw new JobDataPurgeCommittedError(error, backupDirectory, databaseBackupPath);
    }
  } finally {
    db.close();
  }
}
