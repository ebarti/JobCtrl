import { CredentialBatchUpdateRequestSchema, CredentialKeys, CredentialUpdateRequestSchema } from "@jobctrl/contracts";
import { useMutation, useQuery, useQueryClient, type QueryClient } from "@tanstack/react-query";
import { z } from "zod";
import { useState } from "react";

import { invalidateQueriesWithOptimisticOwnership, retainLaterQueryPublication } from "../../shared/lib/createOptimisticMutation.js";
import { createUnconfirmedWriteError } from "../../shared/lib/unconfirmed-write.js";
import type { FeatureEventHandler } from "../../shared/ports/FeatureEvents.js";
import { usePorts } from "../../shared/providers/PortsProvider.js";
import { useTenantId } from "../../shared/providers/TenantProvider.js";

export type { CredentialKey, CredentialUpdateRequest, CredentialBatchUpdateRequest, ProviderId, ProviderStatusItem } from "@jobctrl/contracts";
export { CredentialUpdateRequestSchema };

const credentialSchema = z.object({
  key: z.enum(CredentialKeys), label: z.string(), configured: z.boolean().nullable(),
  storage: z.enum(["config", "native_store"]),
  effectiveSource: z.enum(["environment", "native_store", "config", "absent", "inspection_unknown"]), editable: z.boolean(),
});
const credentialsSchema = z.object({
  ok: z.literal(true), revision: z.number().int().positive(),
  store: z.object({
    kind: z.literal("config_and_native_credential_store"),
    nativeStore: z.enum(["macos_keychain", "windows_credential_manager", "linux_secret_service"]).nullable(),
    maxSecretBytes: z.number().int().positive().nullable(), available: z.boolean(),
    unavailableReason: z.enum(["inspection_failed", "unsupported_platform"]).nullable(), requiresWorkerRestart: z.literal(false),
  }),
  credentials: z.array(credentialSchema).length(CredentialKeys.length),
}).refine((value) => new Set(value.credentials.map((item) => item.key)).size === CredentialKeys.length);
export type CredentialsResponse = z.infer<typeof credentialsSchema>;
const statusSchema = z.object({ ok: z.literal(true), providers: z.array(z.object({
  provider: z.enum(["codex", "claude", "google"]), configured: z.boolean(), ready: z.boolean(),
  mode: z.string().nullable(), message: z.string().optional(),
})).max(3) });
const verificationSchema = z.object({ provider: z.literal("codex"), ok: z.boolean(),
  status: z.enum(["connected", "not_configured", "failed"]), message: z.string() });
const catalogSchema = z.object({ ok: z.literal(true), providers: z.array(z.object({
  provider: z.enum(["codex", "claude", "google"]), configured: z.boolean(), ready: z.boolean(),
  source: z.literal("live"), message: z.string().optional(), models: z.array(z.object({
    id: z.string(), displayName: z.string(), capabilities: z.array(z.string()), isDefault: z.boolean().optional(),
    supportedReasoningEfforts: z.array(z.object({ reasoningEffort: z.string(), description: z.string().optional() })).optional(),
    defaultReasoningEffort: z.string().optional(),
  })).max(512),
})).length(3) });

export const credentialKeys = {
  all: (tenant: string) => ["tenant", tenant, "settings", "credentials"] as const,
  current: (tenant: string) => [...credentialKeys.all(tenant), "metadata"] as const,
  status: (tenant: string) => [...credentialKeys.all(tenant), "providers"] as const,
  models: (tenant: string) => [...credentialKeys.all(tenant), "models"] as const,
  batch: (tenant: string) => [...credentialKeys.all(tenant), "batch"] as const,
};

function parsed<T>(schema: z.ZodType<T>, value: unknown, message: string): T {
  const result = schema.safeParse(value);
  if (!result.success) throw new Error(message);
  return result.data;
}

function publish(client: QueryClient, tenant: string, saved: CredentialsResponse): void {
  client.setQueryData<CredentialsResponse>(credentialKeys.current(tenant), (previous) =>
    previous && previous.revision > saved.revision ? previous : saved);
}

function revision(client: QueryClient, tenant: string): number {
  const key = credentialKeys.current(tenant);
  const saved = credentialsSchema.safeParse(client.getQueryData(key));
  if (!saved.success || client.getQueryState(key)?.status === "error") {
    throw new Error("Check credential status before making another change. Your input remains unsaved.");
  }
  return saved.data.revision;
}

async function refresh(client: QueryClient, tenant: string): Promise<void> {
  await invalidateQueriesWithOptimisticOwnership(client, ["tenant", tenant, "settings"]);
}

export function useCredentialMetadata() {
  const tenant = useTenantId();
  const { http } = usePorts();
  const client = useQueryClient();
  const key = credentialKeys.current(tenant);
  return useQuery({ queryKey: key,
    queryFn: async () => parsed(credentialsSchema, await http.json<unknown>("GET", "/v1/credentials"), "Credential status returned an invalid response."),
    structuralSharing: (previous, next) => {
      const old = credentialsSchema.safeParse(previous);
      const incoming = credentialsSchema.safeParse(next);
      if (old.success && incoming.success && old.data.revision > incoming.data.revision) {
        const query = client.getQueryCache().find({ queryKey: key, exact: true });
        if (query) retainLaterQueryPublication(client, query, previous);
        return previous;
      }
      return next;
    }, meta: { suppressGlobalErrorToast: true },
  });
}

export function useCredentialBatchMutation() {
  const tenant = useTenantId();
  const { http } = usePorts();
  const client = useQueryClient();
  return useMutation({ mutationKey: credentialKeys.batch(tenant),
    mutationFn: async (body: z.infer<typeof CredentialBatchUpdateRequestSchema> & { expectedRevision?: number }) => {
      const request = parsed(CredentialBatchUpdateRequestSchema, { operations: body.operations }, "Credential changes are invalid.");
      const saved = parsed(credentialsSchema, await http.json<unknown>("PATCH", "/v1/credentials/batch", {
        body: { ...request, expectedRevision: body.expectedRevision ?? revision(client, tenant) },
      }), "The credential write could not be confirmed. Check credential status before retrying.");
      const confirmed = request.operations.every((operation) => saved.credentials.find((item) => item.key === operation.key)?.configured === (operation.operation === "set"));
      if (saved.store.unavailableReason === "inspection_failed" || !confirmed) {
        throw createUnconfirmedWriteError("PATCH", "/v1/credentials/batch", new Error("Native inspection is unavailable."));
      }
      return saved;
    }, onSuccess: (saved) => publish(client, tenant, saved),
    onSettled: () => refresh(client, tenant), meta: { suppressGlobalErrorToast: true },
  });
}

/** A draft keeps the revision it began from until explicit review or success. */
export function useCredentialEditFence() {
  const saved = useCredentialMetadata();
  const [baseline, setBaseline] = useState<number | null>(null);
  const current = saved.data?.revision;
  return {
    capture: () => { if (baseline === null && current !== undefined) setBaseline(current); },
    request: <T extends object>(body: T): T & { expectedRevision?: number } => {
      const expectedRevision = baseline ?? current;
      return expectedRevision === undefined ? body : { ...body, expectedRevision };
    },
    accept: (revision: number, hasNewerDraft = false) => setBaseline(hasNewerDraft ? revision : null),
    review: () => { if (current !== undefined) setBaseline(current); },
    stale: baseline !== null && current !== undefined && baseline !== current,
  };
}

export function useProviderStatusQuery() {
  const tenant = useTenantId();
  const { http } = usePorts();
  return useQuery({ queryKey: credentialKeys.status(tenant),
    queryFn: async () => parsed(statusSchema, await http.json<unknown>("GET", "/v1/providers/status"), "Provider readiness returned an invalid response."),
    meta: { suppressGlobalErrorToast: true },
  });
}

export function useProviderCatalog({ enabled = true }: { enabled?: boolean } = {}) {
  const tenant = useTenantId();
  const { http } = usePorts();
  return useQuery({ queryKey: credentialKeys.models(tenant), enabled,
    queryFn: async () => parsed(catalogSchema, await http.json<unknown>("GET", "/v1/providers/models"), "The live model catalog returned an invalid response."),
    meta: { suppressGlobalErrorToast: true },
  });
}

export function useVerifyCodexProviderMutation() {
  const tenant = useTenantId();
  const { http } = usePorts();
  const client = useQueryClient();
  return useMutation({ mutationKey: [...credentialKeys.all(tenant), "verify"],
    mutationFn: async () => ({ verification: parsed(verificationSchema,
      await http.json<unknown>("POST", "/v1/providers/codex/verify", { body: {} }), "Codex verification could not be confirmed.") }),
    onSettled: () => refresh(client, tenant), meta: { suppressGlobalErrorToast: true },
  });
}

export const credentialEvents: FeatureEventHandler = {
  eventTypes: ["CredentialsUpdated", "SettingsUpdated"],
  handle(event, client) { void refresh(client, event.tenantId); },
};
