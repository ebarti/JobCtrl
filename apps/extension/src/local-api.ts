import {
  ExtensionCaptureIngestSchema,
  type ExtensionAutofillProfileResponse,
  type ExtensionCaptureIngestRequest,
  type ExtensionCaptureIngestResponse,
} from "@jobctl/contracts";

export const LOOPBACK_API_ORIGINS = ["http://127.0.0.1:8766", "http://localhost:8766"] as const;

export type LoopbackApiOrigin = (typeof LOOPBACK_API_ORIGINS)[number];

const DEFAULT_TIMEOUT_MS = 120_000;

export class LocalApiError extends Error {
  readonly status: number | null;

  constructor(message: string, status: number | null = null) {
    super(message);
    this.name = "LocalApiError";
    this.status = status;
  }
}

export interface LocalApiOptions {
  baseUrl?: string;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}

export async function checkLocalApiReady(options: LocalApiOptions = {}): Promise<boolean> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const baseUrl = normalizeLoopbackBaseUrl(options.baseUrl);
  try {
    const response = await fetchWithTimeout(
      fetchImpl,
      `${baseUrl}/v1/health`,
      { method: "GET" },
      options.timeoutMs ?? 5_000,
    );
    return response.ok;
  } catch {
    return false;
  }
}

export async function postExtensionCapture(
  token: string,
  capture: ExtensionCaptureIngestRequest,
  options: LocalApiOptions = {},
): Promise<ExtensionCaptureIngestResponse> {
  const parsed = ExtensionCaptureIngestSchema.parse(capture);
  const bearer = token.trim();
  if (!bearer) {
    throw new LocalApiError("Missing extension capability token.");
  }
  const fetchImpl = options.fetchImpl ?? fetch;
  const baseUrl = normalizeLoopbackBaseUrl(options.baseUrl);
  const response = await fetchWithTimeout(
    fetchImpl,
    `${baseUrl}/v1/extension/captures`,
    {
      method: "POST",
      headers: {
        authorization: `Bearer ${bearer}`,
        "content-type": "application/json",
      },
      body: JSON.stringify(parsed),
    },
    options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
  );
  if (!response.ok) {
    throw new LocalApiError(`Local JobCtl API rejected capture: ${response.status}.`, response.status);
  }
  return (await response.json()) as ExtensionCaptureIngestResponse;
}

export async function getExtensionAutofillProfile(
  token: string,
  options: LocalApiOptions = {},
): Promise<ExtensionAutofillProfileResponse> {
  const bearer = token.trim();
  if (!bearer) {
    throw new LocalApiError("Missing extension capability token.");
  }
  const fetchImpl = options.fetchImpl ?? fetch;
  const baseUrl = normalizeLoopbackBaseUrl(options.baseUrl);
  const response = await fetchWithTimeout(
    fetchImpl,
    `${baseUrl}/v1/extension/autofill/profile`,
    {
      method: "GET",
      headers: {
        authorization: `Bearer ${bearer}`,
      },
    },
    options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
  );
  if (!response.ok) {
    throw new LocalApiError(`Local JobCtl API rejected autofill profile: ${response.status}.`, response.status);
  }
  return (await response.json()) as ExtensionAutofillProfileResponse;
}

export function normalizeLoopbackBaseUrl(baseUrl: string = LOOPBACK_API_ORIGINS[0]): LoopbackApiOrigin {
  const url = new URL(baseUrl);
  const normalized = url.origin;
  if (!LOOPBACK_API_ORIGINS.includes(normalized as LoopbackApiOrigin)) {
    throw new LocalApiError(`Extension API base URL must be loopback: ${normalized}`);
  }
  return normalized as LoopbackApiOrigin;
}

async function fetchWithTimeout(
  fetchImpl: typeof fetch,
  input: RequestInfo | URL,
  init: RequestInit,
  timeoutMs: number,
): Promise<Response> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetchImpl(input, { ...init, signal: controller.signal });
  } catch (error) {
    if (controller.signal.aborted) {
      throw new LocalApiError(`Local JobCtl API request timed out after ${timeoutMs}ms.`);
    }
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}
