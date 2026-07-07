import type { TenantId } from "@jobctrl/domain-types";

export interface Session {
  tenantId: TenantId;
  userId: string | null;
}

export interface SessionPort {
  getSession(): Session;
}
