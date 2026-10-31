import { JobCtrlApiError } from "@jobctrl/api-client";

/** Return only known, sanitized recovery guidance for credential-store failures. */
export function credentialRecoveryMessage(error: unknown): string | null {
  if (!(error instanceof JobCtrlApiError) || error.status !== 503) return null;
  const body = error.responseBody;
  if (!body || typeof body !== "object" || !("error" in body) || body.error !== "credential_store_unavailable" || !("reason" in body)) return null;
  if (body.reason === "partial_failure") {
    return "Credential update recovery was incomplete. Credentials may be partially updated. Inspect the native credential store before retrying.";
  }
  if (body.reason === "ownership_unverified") {
    return "Credential update ownership could not be verified. Restore process inspection or verify the previous helper has exited before clearing its coordination record.";
  }
  if (body.reason === "busy") {
    return "Another credential update is in progress. Retry after it finishes.";
  }
  return null;
}
