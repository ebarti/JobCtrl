import { JobCtrlApiError } from "@jobctrl/api-client";

export type DatabaseStartupProblem = {
  kind: "migration_required" | "incompatible";
  message: string;
};

/** Only a structured response from the API can identify a schema failure. */
export function databaseStartupProblem(error: unknown): DatabaseStartupProblem | null {
  if (!(error instanceof JobCtrlApiError) || error.status !== 503) return null;
  const body = error.responseBody;
  if (!body || typeof body !== "object" || !("error" in body)) return null;
  if (body.error === "database_migration_required") {
    return {
      kind: "migration_required",
      message: "The workspace database needs an upgrade before this JobCtrl build can start.",
    };
  }
  if (body.error === "database_schema_incompatible" && "currentVersion" in body && "expectedVersion" in body) {
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
