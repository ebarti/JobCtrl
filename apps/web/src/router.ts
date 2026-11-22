import type { TenantId } from "@jobctrl/domain-types";
import type { QueryClient } from "@tanstack/react-query";
import { createRouter } from "@tanstack/react-router";

import type { ResolvedPorts } from "./shared/providers/PortsProvider.js";
import { routeTree } from "./routeTree.gen.js";

export interface RouterContext {
  ports: ResolvedPorts;
  tenantId: TenantId;
  queryClient: QueryClient;
}

export const router = createRouter({
  routeTree,
  defaultPreload: "intent",
  context: { ports: undefined!, tenantId: undefined!, queryClient: undefined! },
});

declare module "@tanstack/react-router" {
  interface Register {
    router: typeof router;
  }
}
