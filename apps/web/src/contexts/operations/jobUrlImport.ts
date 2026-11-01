import type { JobUrlImportCompletedResponse } from "@jobctrl/contracts";
import type { TenantId } from "@jobctrl/domain-types";
import type { QueryClient } from "@tanstack/react-query";

import { dashboardKeys } from "./dashboardKeys.js";
import { jobsKeys } from "./jobsKeys.js";
import { discoveryKeys } from "./queryKeys.js";

export async function invalidateCompletedJobUrlImport(
  queryClient: Pick<QueryClient, "invalidateQueries">,
  tenantId: TenantId,
  result: JobUrlImportCompletedResponse,
): Promise<void> {
  if (result.status === "imported") {
    await Promise.all([
      queryClient.invalidateQueries({ queryKey: jobsKeys.lists(tenantId) }),
      queryClient.invalidateQueries({ queryKey: jobsKeys.details(tenantId) }),
      queryClient.invalidateQueries({ queryKey: dashboardKeys.summary(tenantId) }),
    ]);
  } else {
    await queryClient.invalidateQueries({ queryKey: discoveryKeys.manualCapture(tenantId) });
  }
}
