import type { StoragePort } from "../../ports/StoragePort.js";

export class LocalStorageAdapter implements StoragePort {
  constructor(private readonly prefix = "jh:") {}

  private key(key: string): string {
    return `${this.prefix}${key}`;
  }

  get<T = unknown>(key: string): T | null {
    if (typeof window === "undefined") {
      return null;
    }
    const raw = window.localStorage.getItem(this.key(key));
    if (raw === null) {
      return null;
    }
    try {
      return JSON.parse(raw) as T;
    } catch {
      return null;
    }
  }

  set<T = unknown>(key: string, value: T): void {
    if (typeof window === "undefined") {
      return;
    }
    window.localStorage.setItem(this.key(key), JSON.stringify(value));
  }

  remove(key: string): void {
    if (typeof window === "undefined") {
      return;
    }
    window.localStorage.removeItem(this.key(key));
  }
}
