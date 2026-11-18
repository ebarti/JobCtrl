export interface StoragePort {
  get<T = unknown>(key: string): T | null;
  /** Strict legacy-record inspection. Recovery callers must never render bytes. */
  readRaw?(key: string): string | null;
  set<T = unknown>(key: string, value: T): void;
  remove(key: string): void;
  /** Compare and update one durable record in a cross-tab transaction.
   * The callback must be synchronous; the result is returned after commit.
   */
  transact<T>(
    key: string,
    operation: (current: string | null) => { result: T; write?: string },
    signal?: AbortSignal,
  ): Promise<T>;
}
