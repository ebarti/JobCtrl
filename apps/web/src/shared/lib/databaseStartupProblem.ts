import { JobCtrlApiError } from "@jobctrl/api-client";

export type DatabaseStartupProblem = {
  kind: "migration_required" | "incompatible";
  message: string;
};

/** Only a structured response from the API can identify a schema failure. */
export function databaseStartupProblem(error: unknown): DatabaseStartupProblem | null {
  if (!(error instanceof JobCtrlApiError) || (error.status !== 503 && error.status !== 409)) return null;
  const body = error.responseBody;
  if (!body || typeof body !== "object" || !("error" in body)) return null;
  const nested = body.error;
  const code = typeof nested === "string" ? nested
    : nested && typeof nested === "object" && "code" in nested && typeof nested.code === "string" ? nested.code : null;
  if (code === "profile_transfer_required") {
    return {
      kind: "migration_required",
      message: "This workspace requires the deliberate Profile transfer before the Python application can start.",
    };
  }
  if (code === "database_migration_required") {
    return {
      kind: "migration_required",
      message: "The workspace database needs an upgrade before this JobCtrl build can start.",
    };
  }
  if (code === "unsupported_database_version" || code === "invalid_database_identity" || code === "feature_schema_mismatch") {
    return {
      kind: "incompatible",
      message: "The workspace database is not compatible with this JobCtrl build. Stop JobCtrl and inspect the workspace before retrying.",
    };
  }
  if (code === "database_schema_incompatible" && "currentVersion" in body && "expectedVersion" in body) {
    const newer = typeof body.currentVersion === "number" && typeof body.expectedVersion === "number"
      && body.currentVersion > body.expectedVersion;
    return {
      kind: "incompatible",
      message: newer
        ? "This workspace was created by a newer JobCtrl version. Use a compatible newer build."
        : "The workspace database schema is not compatible with this build. Stop JobCtrl and inspect the workspace before retrying.",
    };
  }
  return null;
}
