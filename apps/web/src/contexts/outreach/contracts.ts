import type { OutreachDraftDto, OutreachThreadDetail, OutreachThreadResponse } from "@jobctrl/contracts";

/** The Python feature exposes an opaque revision for every saved thread. */
export type ThreadDraft = OutreachDraftDto & { readonly sourcesCurrent?: boolean; readonly reviewAuthorityVerified?: boolean; readonly reviewAuthorityFailure?: string | null };
export type ThreadDetail = Omit<OutreachThreadDetail, "drafts"> & { readonly fingerprint: string; readonly drafts: ThreadDraft[] };
export type ThreadResponse = Omit<OutreachThreadResponse, "thread"> & {
  readonly thread: ThreadDetail | null;
};

/** Reject a thread without a revision instead of permitting an unbound write. */
export function requireThreadFingerprint(response: OutreachThreadResponse): ThreadResponse {
  if (response?.ok !== true || !("thread" in response)) throw new Error("The outreach thread response is invalid.");
  if (response.thread === null) return { ...response, thread: null };
  const thread = response.thread as OutreachThreadDetail & { fingerprint?: unknown };
  if (typeof thread.fingerprint !== "string" || thread.fingerprint.length === 0) {
    throw new Error("The outreach thread has no revision. Refresh it before making changes.");
  }
  return { ...response, thread: thread as ThreadDetail };
}
