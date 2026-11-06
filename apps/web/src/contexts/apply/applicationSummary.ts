import { useQuery } from "@tanstack/react-query";

import { usePorts } from "../../shared/providers/PortsProvider.js";
import { useTenantId } from "../../shared/providers/TenantProvider.js";
import { applyKeys } from "./queryKeys.js";

export interface ApplicationsSummary {
  readonly pendingApprovalCount: number;
  readonly queuedCount: number | null;
  readonly queueCountComplete: boolean;
  readonly runningCount: number;
  readonly needsVerificationCount: number;
  readonly failedCount: number;
  readonly appliedCount: number;
  readonly followUpsDueCount: number;
  readonly followUpJobIds: string[];
}

export function useApplicationsSummaryQuery() {
  const tenantId = useTenantId();
  const { http } = usePorts();
  return useQuery({
    queryKey: [...applyKeys.all(tenantId), "summary"],
    queryFn: async () => {
      const summary = await http.json<ApplicationsSummary>("GET", "/v1/applications/summary");
      const counts = [summary?.pendingApprovalCount, summary?.runningCount, summary?.needsVerificationCount,
        summary?.failedCount, summary?.appliedCount, summary?.followUpsDueCount];
      if (counts.some((count) => !Number.isInteger(count) || count! < 0) || typeof summary.queueCountComplete !== "boolean" ||
          (summary.queuedCount !== null && (!Number.isInteger(summary.queuedCount) || summary.queuedCount < 0)) ||
          !Array.isArray(summary.followUpJobIds) || !summary.followUpJobIds.every((job) => typeof job === "string")) {
        throw new Error("The application summary response is invalid.");
      }
      return summary;
    },
    staleTime: 0,
    refetchOnMount: "always",
  });
}
