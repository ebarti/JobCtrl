import type { TenantId } from "@jobctrl/domain-types";
import type { QueryClient } from "@tanstack/react-query";
import type { HttpPort } from "../ports/HttpPort.js";

/** Narrow transport authority for feature-owned reads and their route loaders. */
export interface HttpReadContext {
  readonly tenantId: TenantId;
  readonly ports: { readonly http: HttpPort };
}

export interface HttpLoaderReadContext extends HttpReadContext {
  readonly queryClient: Pick<QueryClient, "prefetchQuery" | "ensureQueryData">;
}
