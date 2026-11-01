export interface StoragePort {
  get<T = unknown>(key: string): T | null;
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
