import { useQuery, useQueryClient } from "@tanstack/react-query";
import { z } from "zod";

import type { HttpPort, SessionStoragePort } from "../ports/index.js";
import { usePorts } from "../providers/PortsProvider.js";
import { useTenantId } from "../providers/TenantProvider.js";

// Only opaque identities and source fences belong here. Never persist request
// bodies, profile text, credentials or generated output in browser storage.
const IdentitySchema = z.object({
  version: z.literal(1),
  requestId: z.string().min(1).max(200),
  operation: z.string().min(1).max(160),
  fingerprint: z.string().regex(/^[a-f0-9]{64}$/),
  workspaceId: z.string().min(1),
  databaseInstanceId: z.string().min(1),
  sourceRevision: z.number().int().positive().optional(),
  requestKind: z.enum(["preview", "compare", "choose", "update"]).optional(),
  sourceFingerprint: z.string().regex(/^[a-f0-9]{64}$/).optional(),
}).strict();
export type SessionRequestIdentity = z.infer<typeof IdentitySchema>;

function read(storage: SessionStoragePort, key: string, operation: string): SessionRequestIdentity | null {
  const raw = storage.get(key);
  if (raw === null) return null;
  let parsed: SessionRequestIdentity;
  try {
    parsed = IdentitySchema.parse(JSON.parse(raw));
  } catch {
    throw new Error("The saved request identity cannot be read. Restore session storage before starting another request.");
  }
  if (parsed.operation !== operation) throw new Error("The saved request identity belongs to a different operation.");
  return parsed;
}

/** Read the current database incarnation immediately before admission or reconciliation. */
export async function requestWorkspace(http: HttpPort): Promise<{ workspaceId: string; databaseInstanceId: string }> {
  try {
    const { workspaceId, databaseInstanceId } = z.object({ ok: z.literal(true), workspaceId: z.string().min(1), databaseInstanceId: z.string().min(1) })
      .parse(await http.json<unknown>("GET", "/v1/health"));
    return { workspaceId, databaseInstanceId };
  } catch {
    throw new Error("The current workspace identity is unavailable. Restore the connection before continuing.");
  }
}

export async function requireRequestWorkspace(http: HttpPort, identity: SessionRequestIdentity): Promise<void> {
  const current = await requestWorkspace(http);
  if (current.workspaceId !== identity.workspaceId || current.databaseInstanceId !== identity.databaseInstanceId) {
    throw new Error("This request belongs to a different workspace or database. Return to that workspace to reconcile it.");
  }
}

const ActionStatusSchema = z.object({
  runId: z.string().min(1), action: z.string().min(1),
  status: z.enum(["pending", "queued", "running", "succeeded", "failed", "cancelled", "start_failed"]),
  errorCode: z.string().nullable().optional(), cancellationRequested: z.boolean(),
}).passthrough();

/** Resolve an exact durable-action identity without storing or returning its input. */
export async function lookupSessionAction(http: HttpPort, identity: SessionRequestIdentity) {
  await requireRequestWorkspace(http, identity);
  const result = ActionStatusSchema.parse(await http.json<unknown>("GET", "/v1/action-runs/by-idempotency-key", {
    query: { action: identity.operation }, idempotencyKey: identity.requestId, expectedDatabaseInstanceId: identity.databaseInstanceId,
  }));
  if (result.action !== identity.operation) throw new Error("The recorded action does not match the earlier request.");
  return result;
}

/** Per-tab persistence of request identity only; feature code owns status and retry semantics. */
export function useSessionRequestIdentity(scope: string, operation: string) {
  const tenant = useTenantId();
  const { sessionStorage } = usePorts();
  const client = useQueryClient();
  const storageKey = JSON.stringify([tenant, operation, scope]);
  const queryKey = ["tenant", tenant, "session-request-identity", operation, scope] as const;
  const query = useQuery({
    queryKey,
    queryFn: () => read(sessionStorage, storageKey, operation),
    staleTime: Infinity,
    retry: false,
    meta: { suppressGlobalErrorToast: true },
  });
  return {
    record: query.data ?? null,
    ready: query.isSuccess,
    error: query.error,
    current() { return read(sessionStorage, storageKey, operation); },
    save(identity: SessionRequestIdentity) {
      const parsed = IdentitySchema.parse(identity);
      if (parsed.operation !== operation) throw new Error("The request identity belongs to a different operation.");
      const existing = read(sessionStorage, storageKey, operation);
      if (existing && existing.requestId !== parsed.requestId) throw new Error("An earlier request is still awaiting reconciliation.");
      sessionStorage.set(storageKey, JSON.stringify(parsed));
      client.setQueryData(queryKey, parsed);
    },
    clear(requestId: string) {
      const existing = read(sessionStorage, storageKey, operation);
      if (existing && existing.requestId !== requestId) throw new Error("A newer request identity must be reconciled first.");
      sessionStorage.remove(storageKey);
      client.setQueryData(queryKey, null);
    },
  };
}
