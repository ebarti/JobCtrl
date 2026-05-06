import type { TenantId } from "@jobhunter/domain-types";
import { createContext, useContext, useMemo, type ReactNode } from "react";

import { usePorts } from "./PortsProvider.js";

const TenantContext = createContext<TenantId | null>(null);

export function TenantProvider({ children }: { children: ReactNode }) {
  const ports = usePorts();
  const tenantId = useMemo(() => ports.session.getSession().tenantId, [ports.session]);
  return <TenantContext.Provider value={tenantId}>{children}</TenantContext.Provider>;
}

export function useTenantId(): TenantId {
  const tenantId = useContext(TenantContext);
  if (!tenantId) {
    throw new Error("useTenantId must be called within <TenantProvider>.");
  }
  return tenantId;
}
