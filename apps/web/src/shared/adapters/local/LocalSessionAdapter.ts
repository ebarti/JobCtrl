import { LOCAL_TENANT } from "@jobctrl/domain-types";
import type { Session, SessionPort } from "../../ports/SessionPort.js";

export class LocalSessionAdapter implements SessionPort {
  newRequestId(): string {
    return crypto.randomUUID();
  }
  getSession(): Session {
    return { tenantId: LOCAL_TENANT, userId: null };
  }
}
