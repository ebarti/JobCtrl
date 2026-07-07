import type { TenantId } from "@jobctl/domain-types";

export interface Session {
  tenantId: TenantId;
  userId: string | null;
}

export interface SessionPort {
  getSession(): Session;
}
