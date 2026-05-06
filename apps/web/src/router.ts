import type { TenantId } from "@jobhunter/domain-types";
import { createRouter } from "@tanstack/react-router";

import type { Ports } from "./shared/providers/PortsProvider.js";
import { routeTree } from "./routeTree.gen.js";

export interface RouterContext {
  ports: Ports;
  tenantId: TenantId;
}

export const router = createRouter({
  routeTree,
  defaultPreload: "intent",
  context: { ports: undefined!, tenantId: undefined! },
});

declare module "@tanstack/react-router" {
  interface Register {
    router: typeof router;
  }
}
