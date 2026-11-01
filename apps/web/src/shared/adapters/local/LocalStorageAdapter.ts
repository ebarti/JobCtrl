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

  async transact<T>(
    key: string,
    operation: (current: string | null) => { result: T; write?: string },
    signal?: AbortSignal,
  ): Promise<T> {
    const database = await new Promise<IDBDatabase>((resolve, reject) => {
      let abandoned = false;
      const cleanup = () => {
        clearTimeout(timer);
        signal?.removeEventListener("abort", cancel);
      };
      const cancel = () => {
        abandoned = true;
        cleanup();
        reject(new DOMException("Cancelled", "AbortError"));
      };
      const timer = setTimeout(() => {
        abandoned = true;
        cleanup();
        reject(new Error("Browser storage did not open"));
      }, 5000);
      if (signal?.aborted) {
        cancel();
        return;
      }
      signal?.addEventListener("abort", cancel, { once: true });
      try {
        const request = indexedDB.open("jobctrl-profile-import", 1);
        request.onupgradeneeded = () => {
          if (abandoned) request.transaction?.abort();
          else request.result.createObjectStore("records");
        };
        request.onerror = () => {
          cleanup();
          reject(request.error);
        };
        request.onblocked = () => {
          abandoned = true;
          cleanup();
          reject(new Error("Browser storage upgrade is blocked"));
        };
        request.onsuccess = () => {
          cleanup();
          if (abandoned) request.result.close();
          else resolve(request.result);
        };
      } catch (error) {
        cleanup();
        reject(error);
      }
    });
    try {
      if (signal?.aborted) throw new DOMException("Cancelled", "AbortError");
      return await new Promise<T>((resolve, reject) => {
        const transaction = database.transaction("records", "readwrite");
        const abort = () => {
          try {
            transaction.abort();
          } catch {
            /* Already finished. */
          }
        };
        const timer = setTimeout(abort, 5000);
        signal?.addEventListener("abort", abort, { once: true });
        let result: T;
        let failure: unknown;
        transaction.oncomplete = () => {
          clearTimeout(timer);
          signal?.removeEventListener("abort", abort);
          resolve(result!);
        };
        transaction.onabort = () => {
          clearTimeout(timer);
          signal?.removeEventListener("abort", abort);
          reject(
            failure ??
              transaction.error ??
              new Error("Browser storage transaction failed"),
          );
        };
        transaction.onerror = () => undefined;
        const records = transaction.objectStore("records");
        let request: IDBRequest;
        try {
          request = records.get(key);
        } catch (error) {
          failure = error;
          abort();
          return;
        }
        request.onsuccess = () => {
          try {
            const change = operation(
              (request.result as string | undefined) ?? null,
            );
            result = change.result;
            if (change.write !== undefined) records.put(change.write, key);
          } catch (error) {
            failure = error;
            abort();
          }
        };
        request.onerror = () => {
          failure = request.error;
          abort();
        };
      });
    } finally {
      database.close();
    }
  }
}
