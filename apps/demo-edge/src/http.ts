import { MAX_REQUEST_BYTES } from "./contracts.js";

export const JSON_HEADERS = {
  "cache-control": "no-store",
  "content-type": "application/json; charset=utf-8",
  "x-content-type-options": "nosniff",
} as const;

export function jsonResponse(status: number, payload: Record<string, unknown>): Response {
  return new Response(JSON.stringify(payload), { status, headers: JSON_HEADERS });
}

export function emptyResponse(status = 204): Response {
  return new Response(null, { status, headers: { "cache-control": "no-store", "x-content-type-options": "nosniff" } });
}

export function rejectedResponse(status = 400): Response {
  return jsonResponse(status, { error: "request_rejected" });
}

export function temporarilyUnavailableResponse(): Response {
  return jsonResponse(503, { error: "temporarily_unavailable" });
}

export function methodNotAllowed(allowed: string): Response {
  const response = rejectedResponse(405);
  response.headers.set("allow", allowed);
  return response;
}

export function hasSameOriginMetadata(request: Request, allowMissingOrigin = false): boolean {
  const requestUrl = new URL(request.url);
  const origin = request.headers.get("origin");
  return request.headers.get("sec-fetch-site") === "same-origin"
    && (origin === requestUrl.origin || (allowMissingOrigin && origin === null));
}

export async function readStrictJson(request: Request): Promise<unknown | undefined> {
  const contentType = request.headers.get("content-type");
  if (contentType === null || !/^application\/json(?:\s*;\s*charset=utf-8)?$/i.test(contentType)) {
    return undefined;
  }

  const contentLength = request.headers.get("content-length");
  if (contentLength !== null && (!/^\d+$/.test(contentLength) || Number(contentLength) > MAX_REQUEST_BYTES)) {
    return undefined;
  }

  const reader = request.body?.getReader();
  if (reader === undefined) return undefined;

  const chunks: Uint8Array[] = [];
  let totalBytes = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      totalBytes += value.byteLength;
      if (totalBytes > MAX_REQUEST_BYTES) {
        await reader.cancel();
        return undefined;
      }
      chunks.push(value);
    }
  } catch {
    try {
      await reader.cancel();
    } catch {
      // The stream is already closed or errored; the body is still rejected.
    }
    return undefined;
  } finally {
    reader.releaseLock();
  }

  const bytes = new Uint8Array(totalBytes);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }

  try {
    return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)) as unknown;
  } catch {
    return undefined;
  }
}

export function logEdgeEvent(event: string, fields: Record<string, string | number | boolean>): void {
  // Wrangler deliberately disables automatic traces and invocation logs because they can
  // persist raw request metadata. These typed custom fields contain no request object,
  // body, cookies, IP, URL, user agent, or referrer.
  console.log(JSON.stringify({ component: "jobctrl-demo-edge", event, ...fields }));
}
