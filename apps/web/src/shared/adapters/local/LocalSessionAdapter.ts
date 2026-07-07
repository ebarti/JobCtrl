import { LOCAL_TENANT } from "@jobctl/domain-types";
import type { Session, SessionPort } from "../../ports/SessionPort.js";

export class LocalSessionAdapter implements SessionPort {
  getSession(): Session {
    return { tenantId: LOCAL_TENANT, userId: null };
  }
}
