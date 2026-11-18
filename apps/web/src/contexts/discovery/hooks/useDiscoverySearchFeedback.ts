import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { z } from "zod";
import { SOURCE_KIND_VALUES, SOURCE_STATE_VALUES } from "@jobctrl/contracts";

import { usePorts } from "../../../shared/providers/PortsProvider.js";
import { useTenantId } from "../../../shared/providers/TenantProvider.js";
import { DiscoverySettingsPythonSchema } from "../contracts.js";
import { discoveryKeys } from "../queryKeys.js";
import type { DiscoverySearchController } from "./useDiscoverySearchController.js";

const DismissalSchema = z.object({ version: z.literal(1), fingerprint: z.string().regex(/^[a-f0-9]{64}$/) }).strict();
const SourcesSchema = z.object({ ok: z.literal(true), sources: z.array(z.object({
  sourceId: z.string(), kind: z.enum(SOURCE_KIND_VALUES), state: z.enum(SOURCE_STATE_VALUES),
  adapterConfig: z.object({ board: z.string().optional() }).passthrough().optional(),
}).passthrough()) });
export type CurrentSearchSourceState = "enabled" | "disabled" | "unknown";

/** Acknowledgement is browser presentation state; canonical search history is untouched. */
export function useDiscoverySearchFeedback(controller: DiscoverySearchController) {
  const { storage, requestIdentity, http } = usePorts();
  const tenant = useTenantId(); const client = useQueryClient();
  const [error, setError] = useState<string | null>(null);
  const { workspace, action } = controller;
  const terminal = Boolean(action && ["succeeded", "failed", "cancelled"].includes(action.status)
    && ["completed", "partial", "failed", "cancelled"].includes(controller.status));
  const eligible = terminal && Boolean(workspace) && !controller.isPending && !controller.statusUnavailable
    && !controller.historyError && !controller.hasUnconfirmedRequest && controller.recovery.ready
    && !controller.recovery.error && !controller.recovery.record;
  const storageKey = JSON.stringify(["discovery-search-dismissal", 1, tenant, workspace?.workspaceId, workspace?.databaseInstanceId, action?.runId]);
  // The full outcome is compared in memory. Only its opaque digest is persisted.
  const outcome = JSON.stringify({ status: action?.status, updatedAt: action?.updatedAt, result: action?.result,
    errorCode: action?.errorCode, counts: controller.counts, failures: controller.sourceFailures });
  const queryKey = [...discoveryKeys.all(tenant), "search-feedback", workspace?.workspaceId ?? "", workspace?.databaseInstanceId ?? "", action?.runId ?? "", outcome] as const;
  const dismissal = useQuery({ queryKey, enabled: eligible, retry: false, staleTime: 0,
    queryFn: async () => {
      const fingerprint = await requestIdentity.fingerprint(outcome);
      const recorded = DismissalSchema.safeParse(storage.get(storageKey));
      return { fingerprint, dismissed: recorded.success && recorded.data.fingerprint === fingerprint };
    }, meta: { suppressGlobalErrorToast: true } });
  const hasFailures = controller.sourceFailures.length > 0;
  const settings = useQuery({ queryKey: [...discoveryKeys.settings(tenant), "workspace", workspace?.databaseInstanceId ?? ""], enabled: Boolean(workspace && hasFailures), retry: false,
    queryFn: async () => DiscoverySettingsPythonSchema.parse(await http.json<unknown>("GET", "/v1/discovery/settings", { expectedDatabaseInstanceId: workspace!.databaseInstanceId })),
    meta: { suppressGlobalErrorToast: true } });
  const registry = useQuery({ queryKey: [...discoveryKeys.sourceRegistry(tenant), "workspace", workspace?.databaseInstanceId ?? ""], enabled: Boolean(workspace && hasFailures), retry: false,
    queryFn: async () => SourcesSchema.parse(await http.json<unknown>("GET", "/v1/discovery/sources", { expectedDatabaseInstanceId: workspace!.databaseInstanceId })),
    meta: { suppressGlobalErrorToast: true } });

  const boardState = (board: string): CurrentSearchSourceState => {
    if (!settings.isSuccess) return "unknown";
    if (!settings.data.settings.boards.includes(board)) return "disabled";
    if (!registry.isSuccess) return "unknown";
    const records = registry.data.sources.filter((source) => source.kind === "broad_board" && source.adapterConfig?.board === board);
    return !records.length || records.some((source) => ["active", "experimental"].includes(source.state)) ? "enabled" : "disabled";
  };
  const sourceState = (failure: DiscoverySearchController["sourceFailures"][number]): CurrentSearchSourceState => {
    if (failure.boards?.length) {
      const states = failure.boards.map(boardState);
      return states.includes("enabled") ? "enabled" : states.includes("unknown") ? "unknown" : "disabled";
    }
    if (!failure.sourceId || !registry.isSuccess) return "unknown";
    const source = registry.data.sources.find((item) => item.sourceId === failure.sourceId);
    if (source?.kind === "broad_board") return source.adapterConfig?.board ? boardState(source.adapterConfig.board) : "unknown";
    return source && ["active", "experimental"].includes(source.state) ? "enabled" : "disabled";
  };

  return {
    terminal, sourceState, loading: eligible && dismissal.isPending,
    dismissed: eligible && dismissal.data?.dismissed === true,
    canDismiss: eligible && dismissal.isSuccess,
    error: error ?? (eligible && dismissal.isError ? "Saved search feedback could not be read. The result remains visible." : null),
    dismiss() {
      if (!eligible || !dismissal.data) return;
      try {
        storage.set(storageKey, { version: 1, fingerprint: dismissal.data.fingerprint });
        const saved = DismissalSchema.safeParse(storage.get(storageKey));
        if (!saved.success || saved.data.fingerprint !== dismissal.data.fingerprint) throw new Error("unconfirmed");
        client.setQueryData(queryKey, { ...dismissal.data, dismissed: true }); setError(null);
      } catch { setError("Dismissal could not be saved. The last search result remains visible."); }
    },
    show() {
      if (!dismissal.data) return;
      try {
        const saved = DismissalSchema.safeParse(storage.get(storageKey));
        if (saved.success && saved.data.fingerprint === dismissal.data.fingerprint) storage.remove(storageKey);
        client.setQueryData(queryKey, { ...dismissal.data, dismissed: false }); setError(null);
      } catch { setError("The saved dismissal could not be changed. Search details remain available."); }
    },
  };
}
