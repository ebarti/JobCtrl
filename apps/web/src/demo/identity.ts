import type { DemoWorkspaceSnapshot } from "./workspace/contracts.js";

/** Browser-only identities contain no path, account or real local-workspace data. */
export async function demoWorkspaceIdentity(snapshot: DemoWorkspaceSnapshot) {
  const digest = async (value: unknown) => {
    const hash = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(JSON.stringify(value)));
    return Array.from(new Uint8Array(hash), (byte) => byte.toString(16).padStart(2, "0")).join("");
  };
  return { workspaceId: await digest(["demo-workspace", snapshot.workspaceId]),
    databaseInstanceId: await digest(["demo-database", snapshot.workspaceId, snapshot.resetEpoch]) };
}
