import {
  useMutation,
  useQuery,
  useQueryClient,
  type QueryClient,
} from "@tanstack/react-query";
import { useCallback } from "react";
import { z } from "zod";

import { usePorts } from "../../../shared/providers/PortsProvider.js";
import { useTenantId } from "../../../shared/providers/TenantProvider.js";
import type { DomainEventEnvelope } from "../../../shared/ports/EventStreamPort.js";
import { invalidateQueriesWithOptimisticOwnership } from "../../../shared/lib/createOptimisticMutation.js";
import { createUnconfirmedWriteError } from "../../../shared/lib/unconfirmed-write.js";
import type { HttpPort } from "../../../shared/ports/HttpPort.js";
import type { SessionPort } from "../../../shared/ports/SessionPort.js";
import { profileKeys } from "../queryKeys.js";
import { profileDraftGeneration } from "../lib/profile-draft-state.js";

// A native unload can occur before an asynchronous recovery transaction commits.
// The shell installs its blocker once and reads this registry at unload time.
const pendingWordingRecovery = new WeakMap<
  SessionPort,
  Map<string, Map<number, Set<string>>>
>();

export function setWordingRecoveryPending(
  session: SessionPort,
  tenant: string,
  generation: number,
  owner: string,
  pending: boolean,
) {
  if (generation !== profileDraftGeneration(session)) return;
  let tenants = pendingWordingRecovery.get(session);
  if (!tenants) {
    tenants = new Map();
    pendingWordingRecovery.set(session, tenants);
  }
  let generations = tenants.get(tenant);
  if (!generations) {
    generations = new Map();
    tenants.set(tenant, generations);
  }
  let owners = generations.get(generation);
  if (!owners) {
    owners = new Set();
    generations.set(generation, owners);
  }
  if (pending) owners.add(owner);
  else owners.delete(owner);
  if (!owners.size) generations.delete(generation);
  if (!generations.size) tenants.delete(tenant);
}

export function clearWordingRecoveryForSession(
  session: SessionPort,
  tenant: string,
) {
  pendingWordingRecovery.get(session)?.delete(tenant);
}

export function useWordingRecoveryGuard() {
  const { session } = usePorts();
  const tenant = useTenantId();
  return useCallback(
    () =>
      Boolean(
        pendingWordingRecovery
          .get(session)
          ?.get(tenant)
          ?.get(profileDraftGeneration(session))?.size,
      ),
    [session, tenant],
  );
}

const sourceRefSchema = z
  .object({ source_id: z.string(), revision: z.number() })
  .passthrough();
export const wordingVariantSchema = z
  .object({
    variant_id: z.string(),
    revision: z.number(),
    achievement_id: z.string(),
    text: z.string(),
    status: z.string(),
    approval_id: z.string().nullable(),
    source_refs: z.array(sourceRefSchema),
    origin_key: z.string().nullable().optional(),
    provenance: z.record(z.string(), z.unknown()).optional(),
  })
  .passthrough();
const wordingSchema = z
  .object({
    ok: z.literal(true),
    profileVersion: z.number().nullable(),
    wordingRevision: z.number(),
    roles: z.array(
      z
        .object({
          role_id: z.string(),
          achievements: z.array(
            z
              .object({
                achievement_id: z.string(),
                baseline_variant_id: z.string(),
                source_refs: z.array(sourceRefSchema),
              })
              .passthrough(),
          ),
        })
        .passthrough(),
    ),
    variants: z.array(wordingVariantSchema),
    proposals: z.array(
      z
        .object({
          proposal_id: z.string(),
          origin_key: z.string(),
          status: z.string(),
          variant_id: z.string().nullable(),
          failure_code: z.string().nullable(),
        })
        .passthrough(),
    ),
  })
  .passthrough();

export type WordingVariant = z.infer<typeof wordingVariantSchema>;
export type WordingLibrary = z.infer<typeof wordingSchema>;
export type WordingDecision = "approve" | "reject" | "defer";

export const wordingKeys = {
  all: (tenantId: string) =>
    ["tenant", tenantId, "profile", "wording"] as const,
};

function parseLibrary(value: unknown): WordingLibrary {
  const result = wordingSchema.safeParse(value);
  if (!result.success)
    throw new Error(
      "The saved wording library response is invalid. Your accepted wording has not been changed.",
    );
  return result.data;
}

async function writeLibrary(
  http: HttpPort,
  method: "POST" | "PATCH",
  path: string,
  body: unknown,
): Promise<WordingLibrary> {
  const response = await http.json<unknown>(method, path, { body });
  try {
    return parseLibrary(response);
  } catch (error) {
    throw createUnconfirmedWriteError(method, path, error);
  }
}

export function useWordingLibrary() {
  const tenantId = useTenantId();
  const { http } = usePorts();
  return useQuery({
    queryKey: wordingKeys.all(tenantId),
    queryFn: async () =>
      parseLibrary(await http.json<unknown>("GET", "/v1/profile/wording")),
    meta: { suppressGlobalErrorToast: true },
  });
}

export function useWordingActions() {
  const tenantId = useTenantId();
  const { http } = usePorts();
  const queryClient = useQueryClient();
  const refresh = (library: WordingLibrary) => {
    queryClient.setQueryData<WordingLibrary>(
      wordingKeys.all(tenantId),
      (current) => {
        if (!current) return library;
        const previous = current.profileVersion ?? -1;
        const incoming = library.profileVersion ?? -1;
        if (
          incoming < previous ||
          (incoming === previous &&
            library.wordingRevision < current.wordingRevision)
        )
          return current;
        return library;
      },
    );
    return Promise.all([
      queryClient.invalidateQueries({ queryKey: wordingKeys.all(tenantId) }),
      queryClient.invalidateQueries({
        queryKey: profileKeys.profile(tenantId),
      }),
    ]);
  };
  const refreshAfterFailure = () => {
    void queryClient.invalidateQueries({ queryKey: wordingKeys.all(tenantId) });
    void queryClient.invalidateQueries({
      queryKey: profileKeys.profile(tenantId),
    });
  };
  const decide = useMutation({
    mutationFn: ({
      variant,
      decision,
      profileVersion,
    }: {
      variant: WordingVariant;
      decision: WordingDecision;
      profileVersion: number;
    }) =>
      writeLibrary(
        http,
        "POST",
        `/v1/profile/wording/${encodeURIComponent(variant.variant_id)}/decision`,
        {
          decision,
          expectedProfileVersion: profileVersion,
          expectedVariantRevision: variant.revision,
          exactText: variant.text,
        },
      ),
    onSuccess: refresh,
    onError: refreshAfterFailure,
  });
  const edit = useMutation({
    mutationFn: ({
      variant,
      text,
      profileVersion,
    }: {
      variant: WordingVariant;
      text: string;
      profileVersion: number;
    }) =>
      writeLibrary(
        http,
        "PATCH",
        `/v1/profile/wording/${encodeURIComponent(variant.variant_id)}`,
        {
          expectedProfileVersion: profileVersion,
          expectedVariantRevision: variant.revision,
          exactText: variant.text,
          text,
        },
      ),
    onSuccess: refresh,
    onError: refreshAfterFailure,
  });
  const draft = useMutation({
    mutationFn: ({
      variant,
      text,
      profileVersion,
    }: {
      variant: WordingVariant;
      text: string;
      profileVersion: number;
    }) =>
      writeLibrary(http, "POST", "/v1/profile/wording", {
        expectedProfileVersion: profileVersion,
        achievementId: variant.achievement_id,
        text,
        sourceRefs: variant.source_refs,
        replacesVariantId: variant.variant_id,
        replacesVariantRevision: variant.revision,
      }),
    onSuccess: refresh,
    onError: refreshAfterFailure,
  });
  return { decide, draft, edit };
}

export const wordingInvalidation = {
  eventTypes: [
    "ProfileUpdated",
    "ProfileWordingUpdated",
    "ProfileSourceUpdated",
    "ResumeTemplateUpdated",
  ] as const,
  handle(event: DomainEventEnvelope, client: QueryClient) {
    if (event.eventType === "ResumeTemplateUpdated") {
      void invalidateQueriesWithOptimisticOwnership(
        client,
        profileKeys.resumeTemplates(event.tenantId),
      );
      return;
    }
    void invalidateQueriesWithOptimisticOwnership(
      client,
      wordingKeys.all(event.tenantId),
    );
    // Wording and source decisions advance the same Profile revision used by
    // later saves and composition, even when factual fields are unchanged.
    void invalidateQueriesWithOptimisticOwnership(
      client,
      profileKeys.profile(event.tenantId),
    );
  },
};

export function useWordingHistory(variantId: string, enabled: boolean) {
  const tenantId = useTenantId();
  const { http } = usePorts();
  return useQuery({
    queryKey: [...wordingKeys.all(tenantId), "history", variantId],
    enabled,
    queryFn: async () =>
      z
        .object({
          ok: z.literal(true),
          revisions: z.array(wordingVariantSchema),
        })
        .parse(
          await http.json<unknown>(
            "GET",
            `/v1/profile/wording/${encodeURIComponent(variantId)}/history`,
          ),
        ),
  });
}
