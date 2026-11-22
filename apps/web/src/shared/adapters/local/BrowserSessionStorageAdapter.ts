import type { SessionStoragePort } from "../../ports/SessionStoragePort.js";

/** Keeps recovery identities separate between the local and demo workspaces. */
export class BrowserSessionStorageAdapter implements SessionStoragePort {
  constructor(private readonly scope: "local" | "demo" = "local") {}

  get(key: string): string | null {
    return this.storage().getItem(this.key(key));
  }

  set(key: string, value: string): void {
    this.storage().setItem(this.key(key), value);
  }

  remove(key: string): void {
    this.storage().removeItem(this.key(key));
  }

  private storage(): Storage {
    if (typeof window === "undefined") throw new Error("Session storage is unavailable.");
    return window.sessionStorage;
  }

  private key(key: string): string {
    if (!key) throw new Error("A session storage key is required.");
    return `jobctrl:request-recovery:${this.scope}:${encodeURIComponent(key)}`;
  }
}
