import { getRow, type SqliteDatabase } from "./db.js";

const APPLICATION_ATTESTATION_PROFILE_COLUMNS = [
  ["age_18_plus", "application_attestation_age_18_plus"],
  ["background_check_consent", "application_attestation_background_check_consent"],
  ["felony_conviction", "application_attestation_felony_conviction"],
  ["previously_worked_at_employer", "application_attestation_previously_worked_at_employer"],
] as const;

export function missingApplicationAttestationFields(db: SqliteDatabase): string[] {
  const row = getRow<Record<string, unknown>>(
    db,
    `SELECT ${APPLICATION_ATTESTATION_PROFILE_COLUMNS.map(([, column]) => column).join(", ")}
       FROM candidate_profiles
      WHERE tenant_id = ? AND profile_id = ?`,
    ["local", "default"],
  );
  if (!row) return [];
  return APPLICATION_ATTESTATION_PROFILE_COLUMNS
    .filter(([, column]) => row[column] === undefined || row[column] === null || row[column] === "")
    .map(([field]) => field);
}
