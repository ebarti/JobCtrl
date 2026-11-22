export type HttpMethod = "GET" | "POST" | "PATCH" | "PUT" | "DELETE";
export type HttpQueryValue = string | number | boolean | readonly string[] | null | undefined;

export interface HttpRequestOptions {
  readonly body?: unknown;
  readonly query?: Readonly<Record<string, HttpQueryValue>>;
  /** Stable identity for a durable action retry, supplied by its feature. */
  readonly idempotencyKey?: string;
  /** Fence an admission or reconciliation to the observed database incarnation. */
  readonly expectedDatabaseInstanceId?: string;
}

/** Shared transport only. Feature modules own paths, DTOs and validation. */
export interface HttpPort {
  json<T>(method: HttpMethod, path: string, options?: HttpRequestOptions): Promise<T>;
  blob(method: "GET", path: string, options?: Pick<HttpRequestOptions, "query">): Promise<Blob>;
  text(method: "GET", path: string, options?: Pick<HttpRequestOptions, "query">): Promise<string>;
}
