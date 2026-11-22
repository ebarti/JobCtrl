import { JobCtrlApiError, JobCtrlApiTimeoutError, JobCtrlApiUnconfirmedWriteError } from "@jobctrl/api-client";

import type { HttpMethod, HttpPort, HttpRequestOptions } from "../../ports/HttpPort.js";

const DEFAULT_TIMEOUT_MS = 120_000;
const RELATIVE_ORIGIN = "http://jobctrl.local";

/** Sends the Python application's REST requests without owning feature DTOs. */
export class BrowserHttpAdapter implements HttpPort {
  constructor(
    private readonly baseUrl = "",
    private readonly timeoutMs = DEFAULT_TIMEOUT_MS,
  ) {}

  json<T>(method: HttpMethod, path: string, options: HttpRequestOptions = {}): Promise<T> {
    return this.request(method, path, options, async (response) => {
      if (response.status === 204) return undefined as T;
      return await response.json() as T;
    });
  }

  blob(method: "GET", path: string, options: Pick<HttpRequestOptions, "query"> = {}): Promise<Blob> {
    return this.request(method, path, options, (response) => response.blob());
  }

  text(method: "GET", path: string, options: Pick<HttpRequestOptions, "query"> = {}): Promise<string> {
    return this.request(method, path, options, (response) => response.text());
  }

  private async request<T>(
    method: HttpMethod,
    path: string,
    options: HttpRequestOptions,
    read: (response: Response) => Promise<T>,
  ): Promise<T> {
    const href = this.url(path, options.query);
    const controller = new AbortController();
    let requestStarted = false;
    const timeoutError = new JobCtrlApiTimeoutError(method, path, this.timeoutMs);
    let timeout: ReturnType<typeof setTimeout> | undefined;
    const deadline = new Promise<never>((_resolve, reject) => {
      timeout = setTimeout(() => {
        controller.abort();
        reject(timeoutError);
      }, this.timeoutMs);
    });

    const operation = async (): Promise<T> => {
      const init: RequestInit = { method, signal: controller.signal, cache: "no-store" };
      const headers = new Headers();
      if (method !== "GET" && options.body !== undefined) {
        init.body = JSON.stringify(options.body);
        headers.set("content-type", "application/json");
      }
      if (options.idempotencyKey !== undefined) {
        if (!options.idempotencyKey.trim()) {
          throw new Error("An idempotency key must not be empty.");
        }
        headers.set("Idempotency-Key", options.idempotencyKey);
      }
      if (options.expectedDatabaseInstanceId !== undefined) {
        if (!/^[a-f0-9]{64}$/.test(options.expectedDatabaseInstanceId)) {
          throw new Error("A valid database incarnation identity is required.");
        }
        headers.set("Expected-Database-Instance-Id", options.expectedDatabaseInstanceId);
      }
      init.headers = headers;
      requestStarted = true;
      const response = await fetch(href, init);
      if (controller.signal.aborted) {
        void response.body?.cancel().catch(() => undefined);
        throw timeoutError;
      }
      if (!response.ok) {
        let body: unknown;
        try {
          body = await response.json();
        } catch (error) {
          if (controller.signal.aborted) throw error;
          if (method !== "GET" && !(error instanceof SyntaxError)) throw error;
        }
        throw new JobCtrlApiError(
          response.status,
          response.statusText,
          errorMessage(body),
          body,
          method !== "GET" && response.status >= 500,
        );
      }
      return read(response);
    };

    try {
      return await Promise.race([operation(), deadline]);
    } catch (error) {
      if (controller.signal.aborted) throw timeoutError;
      if (requestStarted && method !== "GET" && !(error instanceof JobCtrlApiError)) {
        throw new JobCtrlApiUnconfirmedWriteError(method, path, error);
      }
      throw error;
    } finally {
      if (timeout !== undefined) clearTimeout(timeout);
    }
  }

  private url(path: string, query: HttpRequestOptions["query"]): string {
    if (!path.startsWith("/v1/") || path.startsWith("//")) {
      throw new Error("Feature requests must use a /v1/ path.");
    }
    const base = this.baseUrl || RELATIVE_ORIGIN;
    const url = new URL(path, base);
    if (url.origin !== new URL(base).origin || !url.pathname.startsWith("/v1/")) {
      throw new Error("Feature requests must stay on the configured API origin.");
    }
    for (const [key, value] of Object.entries(query ?? {})) {
      if (value !== undefined && value !== null && value !== "") {
        url.searchParams.set(key, String(value));
      }
    }
    return this.baseUrl ? url.href : `${url.pathname}${url.search}`;
  }
}

function errorMessage(body: unknown): string | undefined {
  if (!body || typeof body !== "object" || !("error" in body)) return undefined;
  const error = body.error;
  return error && typeof error === "object" && "message" in error && typeof error.message === "string"
    ? error.message
    : undefined;
}
