import { createHash } from "node:crypto";

import { allRows, tableExists, type SqliteDatabase } from "./db.js";

export const CURRENT_DISCOVERY_EXECUTION_DECODER_VERSION = 3;

interface ReadyNativeRecoveryRow {
  [key: string]: unknown;
  discover_workflow_id: string;
  discover_run_id: string;
}

interface RecoveryMembershipRow {
  job_id: string;
}

interface RecoveryStepRow {
  step_kind: string;
  item_key: string;
}

export function recoveryKeyDigest(
  membershipKeys: readonly string[],
  stepKeys: ReadonlyArray<readonly [string, string]>,
): string {
  const memberships = [...new Set(membershipKeys)].map(utf8Hex).sort();
  const steps = [...new Set(stepKeys.map((stepKey) => JSON.stringify(stepKey)))]
    .map(utf8Hex)
    .sort();
  return createHash("sha256")
    .update(JSON.stringify({ memberships, steps }))
    .digest("hex");
}

export function advanceReadyNativeRecoveryManifests(
  db: SqliteDatabase,
  tenantId: string,
  updatedAt = new Date().toISOString(),
): number {
  if (!tableExists(db, "discovery_execution_recoveries")) return 0;

  const manifests = allRows<ReadyNativeRecoveryRow>(
    db,
    `SELECT discover_workflow_id, discover_run_id
       FROM discovery_execution_recoveries
      WHERE tenant_id = ? AND state = 'ready' AND mode = 'native'
        AND decoder_version = ?`,
    [tenantId, CURRENT_DISCOVERY_EXECUTION_DECODER_VERSION],
  );
  const memberships = db.prepare(
    `SELECT job_id FROM discovery_execution_jobs
      WHERE tenant_id = ? AND discover_workflow_id = ? AND discover_run_id = ?`,
  );
  const steps = db.prepare(
    `SELECT step_kind, item_key FROM pipeline_step_projections
      WHERE tenant_id = ? AND discover_workflow_id = ? AND discover_run_id = ?`,
  );
  const update = db.prepare(
    `UPDATE discovery_execution_recoveries
        SET expected_membership_count = ?, persisted_membership_count = ?,
            expected_step_count = ?, persisted_step_count = ?,
            key_digest = ?, last_error_code = NULL, updated_at = ?
      WHERE tenant_id = ? AND discover_workflow_id = ? AND discover_run_id = ?
        AND state = 'ready' AND mode = 'native' AND decoder_version = ?`,
  );

  let changed = 0;
  for (const manifest of manifests) {
    const membershipKeys = (memberships.all(
      tenantId,
      manifest.discover_workflow_id,
      manifest.discover_run_id,
    ) as RecoveryMembershipRow[]).map((row) => row.job_id);
    const stepKeys = (steps.all(
      tenantId,
      manifest.discover_workflow_id,
      manifest.discover_run_id,
    ) as RecoveryStepRow[]).map(
      (row): [string, string] => [row.step_kind, row.item_key],
    );
    const result = update.run(
      membershipKeys.length,
      membershipKeys.length,
      stepKeys.length,
      stepKeys.length,
      recoveryKeyDigest(membershipKeys, stepKeys),
      updatedAt,
      tenantId,
      manifest.discover_workflow_id,
      manifest.discover_run_id,
      CURRENT_DISCOVERY_EXECUTION_DECODER_VERSION,
    );
    changed += result.changes;
  }
  return changed;
}

function utf8Hex(value: string): string {
  return Buffer.from(value, "utf8").toString("hex");
}
