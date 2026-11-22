import type { RequestIdentityPort } from "../../ports/RequestIdentityPort.js";

export class BrowserRequestIdentityAdapter implements RequestIdentityPort {
  create(): string {
    return crypto.randomUUID();
  }

  async fingerprint(value: string): Promise<string> {
    const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
    return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
  }
}
