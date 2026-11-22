/** Per-tab, reload-persistent storage for non-private request recovery metadata.
 * Operations throw when storage is unavailable so callers can report that
 * a request identity cannot be safely recovered after a reload.
 */
export interface SessionStoragePort {
  get(key: string): string | null;
  set(key: string, value: string): void;
  remove(key: string): void;
}
