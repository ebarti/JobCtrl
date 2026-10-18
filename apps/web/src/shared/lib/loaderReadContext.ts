import type { TenantId } from "@jobctrl/domain-types";
import type { QueryClient } from "@tanstack/react-query";
import type { ApiClientPort } from "../ports/ApiClientPort.js";

// Structural dependencies: context reads never depend on the router or generated tree.
export interface ReadContext<Method extends keyof ApiClientPort> {
  readonly tenantId: TenantId;
  readonly ports: { readonly api: Pick<ApiClientPort, Method> };
}
export interface LoaderReadContext<
  Method extends keyof ApiClientPort,
> extends ReadContext<Method> {
  readonly queryClient: Pick<QueryClient, "prefetchQuery" | "ensureQueryData">;
}
