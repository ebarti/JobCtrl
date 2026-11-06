import { useMutation, useQuery, useQueryClient, type QueryClient } from "@tanstack/react-query";
import { z } from "zod";

import { usePorts } from "../../../shared/providers/PortsProvider.js";
import { useTenantId } from "../../../shared/providers/TenantProvider.js";
import type { DomainEventEnvelope } from "../../../shared/ports/EventStreamPort.js";
import { invalidateQueriesWithOptimisticOwnership } from "../../../shared/lib/createOptimisticMutation.js";
import { profileKeys } from "../queryKeys.js";

const sourceRefSchema = z.object({ source_id: z.string(), revision: z.number() }).passthrough();
const variantSchema = z.object({
  variant_id: z.string(), revision: z.number(), achievement_id: z.string(),
  text: z.string(), status: z.string(), approval_id: z.string().nullable(),
  source_refs: z.array(sourceRefSchema), origin_key: z.string().nullable().optional(),
}).passthrough();
const wordingSchema = z.object({
  ok: z.literal(true), profileVersion: z.number().nullable(), wordingRevision: z.number(),
  roles: z.array(z.object({ role_id: z.string(), achievements: z.array(z.object({
    achievement_id: z.string(), baseline_variant_id: z.string(), source_refs: z.array(sourceRefSchema),
  }).passthrough()) }).passthrough()),
  variants: z.array(variantSchema),
  proposals: z.array(z.object({ proposal_id: z.string(), origin_key: z.string(), status: z.string(),
    variant_id: z.string().nullable(), failure_code: z.string().nullable() }).passthrough()),
}).passthrough();

export type WordingVariant = z.infer<typeof variantSchema>;
export type WordingLibrary = z.infer<typeof wordingSchema>;
export type WordingDecision = "approve" | "reject" | "defer";

export const wordingKeys = {
  all: (tenantId: string) => ["tenant", tenantId, "profile", "wording"] as const,
};

function parseLibrary(value: unknown): WordingLibrary {
  const result = wordingSchema.safeParse(value);
  if (!result.success) throw new Error("The saved wording library response is invalid. Your accepted wording has not been changed.");
  return result.data;
}

export function useWordingLibrary() {
  const tenantId = useTenantId();
  const { http } = usePorts();
  return useQuery({
    queryKey: wordingKeys.all(tenantId),
    queryFn: async () => parseLibrary(await http.json<unknown>("GET", "/v1/profile/wording")),
    meta: { suppressGlobalErrorToast: true },
  });
}

export function useWordingActions() {
  const tenantId = useTenantId();
  const { http } = usePorts();
  const queryClient = useQueryClient();
  const refresh = () => Promise.all([
    queryClient.invalidateQueries({ queryKey: wordingKeys.all(tenantId) }),
    queryClient.invalidateQueries({ queryKey: profileKeys.profile(tenantId) }),
  ]);
  const decide = useMutation({
    mutationFn: ({ variant, decision, profileVersion }: {
      variant: WordingVariant; decision: WordingDecision; profileVersion: number;
    }) => http.json<unknown>("POST", `/v1/profile/wording/${encodeURIComponent(variant.variant_id)}/decision`, {
      body: { decision, expectedProfileVersion: profileVersion, expectedVariantRevision: variant.revision, exactText: variant.text },
    }),
    onSuccess: refresh,
  });
  const draft = useMutation({
    mutationFn: ({ variant, text, profileVersion }: { variant: WordingVariant; text: string; profileVersion: number }) =>
      http.json<unknown>("POST", "/v1/profile/wording", {
        body: { expectedProfileVersion: profileVersion, achievementId: variant.achievement_id, text, sourceRefs: variant.source_refs },
      }),
    onSuccess: refresh,
  });
  return { decide, draft };
}

export const wordingInvalidation = {
  eventTypes: ["ProfileUpdated", "ProfileWordingUpdated", "ProfileSourceUpdated", "ResumeTemplateUpdated"] as const,
  handle(event: DomainEventEnvelope, client: QueryClient) {
    if (event.eventType === "ResumeTemplateUpdated") {
      void invalidateQueriesWithOptimisticOwnership(client, profileKeys.resumeTemplates(event.tenantId));
      return;
    }
    void invalidateQueriesWithOptimisticOwnership(client, wordingKeys.all(event.tenantId));
    // Wording and source decisions advance the same Profile revision used by
    // later saves and composition, even when factual fields are unchanged.
    void invalidateQueriesWithOptimisticOwnership(client, profileKeys.profile(event.tenantId));
  },
};
