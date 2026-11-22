import type {
  OutreachThreadDetail,
  OutreachThreadResponse,
} from "@jobctrl/contracts";
import type { DemoWorkspaceSnapshot } from "./workspace/contracts.js";

export function demoOutreachSources(snapshot: DemoWorkspaceSnapshot): string {
  const thread = snapshot.state.readModel.outreach.thread.thread;
  return JSON.stringify([
    snapshot.state.readModel.profile.config.profileVersion,
    thread
      ? snapshot.state.readModel.contacts.details[thread.contactId]?.contact
      : null,
  ]);
}

export function demoOutreachSourcesCurrent(
  snapshot: DemoWorkspaceSnapshot,
): boolean {
  return (
    snapshot.state.features?.outreachSourceBinding ===
    demoOutreachSources(snapshot)
  );
}

export async function demoThreadFingerprint(
  thread: OutreachThreadDetail,
  snapshot: DemoWorkspaceSnapshot,
): Promise<string> {
  const bytes = new TextEncoder().encode(
    JSON.stringify(["demo-outreach-v1", thread, demoOutreachSources(snapshot)]),
  );
  const hash = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(hash), (value) =>
    value.toString(16).padStart(2, "0"),
  ).join("");
}

export async function withDemoThreadFingerprint(
  response: OutreachThreadResponse,
  snapshot: DemoWorkspaceSnapshot,
): Promise<OutreachThreadResponse> {
  if (response.thread === null) return response;
  const thread = {
    ...response.thread,
    drafts: response.thread.drafts.map((draft) => ({
      ...draft,
      sourcesCurrent: demoOutreachSourcesCurrent(snapshot),
      reviewAuthorityVerified: false,
    })),
    fingerprint: await demoThreadFingerprint(response.thread, snapshot),
  };
  return { ...response, thread };
}
