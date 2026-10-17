import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { ApiClientPort } from "../../../shared/ports/ApiClientPort.js";
import { usePorts } from "../../../shared/providers/PortsProvider.js";
import { useTenantId } from "../../../shared/providers/TenantProvider.js";
import { artifactsKeys } from "../../operations/artifactsKeys.js";
import { jobsKeys } from "../../operations/jobsKeys.js";
import { materialsKeys } from "../queryKeys.js";

export type MaterialExportHistory = Awaited<
  ReturnType<ApiClientPort["acceptedMaterialExports"]>
>;
export type MaterialExportRequest = Extract<
  Parameters<ApiClientPort["acceptedMaterialExports"]>[1],
  { operation: "export" }
>;
export type MaterialExportReceipt = MaterialExportHistory["exports"][number];

export function useAcceptedMaterialExports(jobId: string) {
  const tenantId = useTenantId();
  const { api, artifactDownload, featureFlags } = usePorts();
  const queryClient = useQueryClient();
  const isDemo = featureFlags.get("demoMode", false);
  const key = materialsKeys.exports(tenantId, jobId);
  const history = useQuery({
    queryKey: key,
    queryFn: () => api.acceptedMaterialExports(jobId, { operation: "history" }),
    enabled: !isDemo,
    retry: false,
    refetchInterval: 15_000,
    meta: { suppressGlobalErrorToast: true },
  });
  const mutation = useMutation({
    meta: { suppressGlobalErrorToast: true },
    mutationFn: (request: MaterialExportRequest) =>
      api.acceptedMaterialExports(jobId, request),
    onMutate: () => queryClient.cancelQueries({ queryKey: key }),
    // Exports are append-only. Keep the accepted snapshot visible until success;
    // there is no optimistic approval or artifact to roll back after a failure.
    onSuccess: (result) => queryClient.setQueryData(key, result),
    onSettled: () =>
      Promise.all([
        queryClient.invalidateQueries({ queryKey: key }),
        queryClient.invalidateQueries({
          queryKey: jobsKeys.detail(tenantId, jobId),
        }),
        queryClient.invalidateQueries({
          queryKey: artifactsKeys.lists(tenantId),
        }),
      ]),
  });
  const download = useMutation({
    meta: { suppressGlobalErrorToast: true },
    mutationFn: (receipt: MaterialExportReceipt) =>
      artifactDownload.downloadDocx(
        receipt.artifactId,
        `${receipt.kind === "tailored_resume" ? "resume" : "cover-letter"}-g${receipt.generation}-${receipt.settings.paper}.docx`,
      ),
  });
  const exportAndDownload = async (request: MaterialExportRequest) => {
    download.reset();
    const result = await mutation.mutateAsync(request);
    const receipt = result.exports.find(
      (row) => row.artifactId === result.exportedArtifactId,
    );
    if (receipt) await download.mutateAsync(receipt);
  };
  return { history, mutation, download, exportAndDownload, isDemo };
}
