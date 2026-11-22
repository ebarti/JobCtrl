import { JobCtrlApiError } from "@jobctrl/api-client";
import { z } from "zod";

const errorSchema = z.object({ error: z.object({ code: z.string(), details: z.object({ reason: z.string().optional() }).optional() }) });

/** Return only known, sanitized recovery guidance for credential-store failures. */
export function credentialRecoveryMessage(error: unknown): string | null {
  if (!(error instanceof JobCtrlApiError)) {
    return error && typeof error === "object" && "writeOutcomeUnknown" in error && error.writeOutcomeUnknown === true
      ? "The credential change may have completed. Your input remains unsaved; check credential status before retrying." : null;
  }
  const parsed = errorSchema.safeParse(error.responseBody);
  if (!parsed.success) return error.writeOutcomeUnknown ? "The credential change may have completed. Check credential status before retrying." : null;
  const body = parsed.data.error;
  if (body.code === "revision_conflict") return "Credential configuration changed elsewhere. Your input remains here; check credential status and review it before retrying.";
  if (body.code === "credential_managed_by_environment") return "This credential is managed by the launch environment and cannot be changed here.";
  if (body.code === "credential_value_unsupported") return "This value exceeds the native store's secure input limit. Your draft remains here; use the launch environment if this provider requires a larger value.";
  if (body.code !== "credential_store_unavailable") return null;
  if (body.details?.reason === "partial_failure") {
    return "Credential update recovery was incomplete. Credentials may be partially updated. Inspect the native credential store before retrying.";
  }
  if (body.details?.reason === "ownership_unverified") {
    return "Credential update ownership could not be verified. Restore process inspection or verify the previous helper has exited before clearing its coordination record.";
  }
  if (body.details?.reason === "busy") {
    return "Another credential update is in progress. Retry after it finishes.";
  }
  if (body.details?.reason === "operational_failure") return "The native credential store could not save this change. Your previous configuration and draft are retained; unlock the store and check credential status before retrying.";
  return null;
}
