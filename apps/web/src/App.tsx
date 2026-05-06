import { type QueryClient } from "@tanstack/react-query";
import { RouterProvider } from "@tanstack/react-router";
import type { JSX } from "react";

import { router } from "./router.js";
import { usePorts } from "./shared/providers/PortsProvider.js";
import { useTenantId } from "./shared/providers/TenantProvider.js";

export interface AppProps {
  queryClient: QueryClient;
}

export function App({ queryClient }: AppProps): JSX.Element {
  const ports = usePorts();
  const tenantId = useTenantId();
  return <RouterProvider router={router} context={{ ports, tenantId, queryClient }} />;
}
