import type { RequestIdentityPort } from "../../ports/RequestIdentityPort.js";

export class BrowserRequestIdentityAdapter implements RequestIdentityPort {
  create(): string {
    return crypto.randomUUID();
  }
}
