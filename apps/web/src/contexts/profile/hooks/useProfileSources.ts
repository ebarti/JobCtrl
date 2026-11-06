import { useMutation, useQuery, useQueryClient, type QueryClient } from "@tanstack/react-query";
import { z } from "zod";

import { invalidateQueriesWithOptimisticOwnership } from "../../../shared/lib/createOptimisticMutation.js";
import { createUnconfirmedWriteError } from "../../../shared/lib/unconfirmed-write.js";
import type { DomainEventEnvelope } from "../../../shared/ports/EventStreamPort.js";
import type { HttpPort } from "../../../shared/ports/HttpPort.js";
import { usePorts } from "../../../shared/providers/PortsProvider.js";
import { useTenantId } from "../../../shared/providers/TenantProvider.js";
import { profileKeys } from "../queryKeys.js";
import { wordingKeys } from "./useWordingLibrary.js";

const sourceSchema = z.object({ source_id: z.string(), revision: z.number(), text: z.string(), kind: z.string(), confirmation: z.string(), origin: z.string().optional() }).passthrough();
const sourcesSchema = z.object({ ok: z.literal(true), profileVersion: z.number().nullable(), sources: z.array(sourceSchema) }).passthrough();
export type ProfileSource = z.infer<typeof sourceSchema>;
export const profileSourceKeys = { all: (tenantId: string) => ["tenant", tenantId, "profile", "sources"] as const };
function parseSources(value: unknown) {
  const result = sourcesSchema.safeParse(value);
  if (!result.success) throw new Error("The Profile sources response is invalid. Refresh to verify saved evidence.");
  return result.data;
}
async function writeSources(http: HttpPort, path: string, body: unknown) {
  const value = await http.json<unknown>("POST", path, { body });
  try { return parseSources(value); }
  catch (error) { throw createUnconfirmedWriteError("POST", path, error); }
}
export function useProfileSources() {
  const tenantId = useTenantId(); const { http } = usePorts();
  return useQuery({ queryKey: profileSourceKeys.all(tenantId), queryFn: async () => {
    return parseSources(await http.json<unknown>("GET", "/v1/profile/sources"));
  }, meta: { suppressGlobalErrorToast: true } });
}
export function useProfileSourceActions() {
  const tenantId = useTenantId(); const { http } = usePorts(); const client = useQueryClient();
  const save = (result: z.infer<typeof sourcesSchema>) => {
    client.setQueryData<z.infer<typeof sourcesSchema> | null>(profileSourceKeys.all(tenantId), (current) => current && (current.profileVersion ?? 0) > (result.profileVersion ?? 0) ? current : result);
    void client.invalidateQueries({ queryKey: profileKeys.profile(tenantId) });
    void client.invalidateQueries({ queryKey: wordingKeys.all(tenantId) });
  };
  const add = useMutation({ mutationFn: async (body: { expectedProfileVersion: number; source: { text: string; kind: string } }) =>
    writeSources(http, "/v1/profile/sources", body), onSuccess: save });
  const decide = useMutation({ mutationFn: async ({ source, profileVersion, decision }: {
    source: ProfileSource; profileVersion: number; decision: "confirm" | "reject" | "defer";
  }) => writeSources(http, `/v1/profile/sources/${encodeURIComponent(source.source_id)}/confirmation`, {
    expectedProfileVersion: profileVersion, expectedSourceRevision: source.revision, exactText: source.text, decision,
  }), onSuccess: save });
  return { add, decide };
}
export const profileSourcesInvalidation = {
  eventTypes: ["ProfileUpdated", "ProfileSourceUpdated"] as const,
  handle(event: DomainEventEnvelope, client: QueryClient) { void invalidateQueriesWithOptimisticOwnership(client, profileSourceKeys.all(event.tenantId)); },
};
