import {
  ExtensionCaptureIngestSchema,
  type ExtensionAutofillProfileResponse,
  type ExtensionCaptureIngestRequest,
  type ExtensionCaptureIngestResponse,
  type DiscoveryBrowserTaskCompletionRequest,
  type DiscoveryBrowserExtensionClaimRequest,
  type DiscoveryBrowserTaskLeaseResponse,
} from "@jobctrl/contracts";

export const LOOPBACK_API_ORIGINS = ["http://127.0.0.1:8766", "http://localhost:8766"] as const;

export type LoopbackApiOrigin = (typeof LOOPBACK_API_ORIGINS)[number];

const DEFAULT_TIMEOUT_MS = 120_000;
const INSTALLATION_HEADER = "x-jobctrl-extension-installation";
const EXTENSION_VERSION_HEADER = "x-jobctrl-extension-version";

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
    throw new LocalApiError(`Local JobCtrl API rejected capture: ${response.status}.`, response.status);
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
    throw new LocalApiError(`Local JobCtrl API rejected autofill profile: ${response.status}.`, response.status);
  }
  return (await response.json()) as ExtensionAutofillProfileResponse;
}

export async function getNextDiscoveryBrowserTask(
  token: string,
  installationId: string,
  extensionVersion: string,
  options: LocalApiOptions = {},
): Promise<DiscoveryBrowserTaskLeaseResponse> {
  const bearer = requireBearerToken(token);
  const fetchImpl = options.fetchImpl ?? fetch;
  const baseUrl = normalizeLoopbackBaseUrl(options.baseUrl);
  const query = new URLSearchParams({ extensionVersion: extensionVersion.trim() || "unknown" });
  const response = await fetchWithTimeout(
    fetchImpl,
    `${baseUrl}/v1/extension/discovery/tasks/next?${query.toString()}`,
    {
      method: "GET",
      headers: discoveryExtensionHeaders(bearer, installationId, extensionVersion),
      cache: "no-store",
    },
    options.timeoutMs ?? 10_000,
  );
  if (!response.ok) {
    throw new LocalApiError(`Local JobCtrl API rejected the Discovery task poll: ${response.status}.`, response.status);
  }
  return (await response.json()) as DiscoveryBrowserTaskLeaseResponse;
}

export async function postDiscoveryBrowserTaskResult(
  token: string,
  installationId: string,
  extensionVersion: string,
  taskId: string,
  completion: DiscoveryBrowserTaskCompletionRequest,
  options: LocalApiOptions = {},
): Promise<void> {
  const bearer = requireBearerToken(token);
  const fetchImpl = options.fetchImpl ?? fetch;
  const baseUrl = normalizeLoopbackBaseUrl(options.baseUrl);
  const response = await fetchWithTimeout(
    fetchImpl,
    `${baseUrl}/v1/extension/discovery/tasks/${encodeURIComponent(taskId)}/result`,
    {
      method: "POST",
      headers: {
        ...discoveryExtensionHeaders(bearer, installationId, extensionVersion),
        "content-type": "application/json",
      },
      body: JSON.stringify(completion),
    },
    options.timeoutMs ?? 15_000,
  );
  if (!response.ok && response.status !== 404 && response.status !== 409) {
    throw new LocalApiError(`Local JobCtrl API rejected the Discovery task result: ${response.status}.`, response.status);
  }
}

export async function claimDiscoveryBrowserInstallation(
  token: string,
  claim: DiscoveryBrowserExtensionClaimRequest,
  options: LocalApiOptions = {},
): Promise<void> {
  const bearer = requireBearerToken(token);
  const fetchImpl = options.fetchImpl ?? fetch;
  const baseUrl = normalizeLoopbackBaseUrl(options.baseUrl);
  const response = await fetchWithTimeout(
    fetchImpl,
    `${baseUrl}/v1/extension/discovery/claim`,
    {
      method: "POST",
      headers: {
        authorization: `Bearer ${bearer}`,
        "content-type": "application/json",
      },
      body: JSON.stringify(claim),
    },
    options.timeoutMs ?? 10_000,
  );
  if (!response.ok) {
    throw new LocalApiError(
      response.status === 409
        ? "Another Chrome profile is selected for Discovery. Pair again in this profile to replace it."
        : `Local JobCtrl API rejected the Discovery profile claim: ${response.status}.`,
      response.status,
    );
  }
}

export async function isDiscoveryBrowserLeaseActive(
  token: string,
  installationId: string,
  extensionVersion: string,
  taskId: string,
  leaseId: string,
  options: LocalApiOptions = {},
): Promise<boolean> {
  const bearer = requireBearerToken(token);
  const fetchImpl = options.fetchImpl ?? fetch;
  const baseUrl = normalizeLoopbackBaseUrl(options.baseUrl);
  const query = new URLSearchParams({ leaseId });
  const response = await fetchWithTimeout(
    fetchImpl,
    `${baseUrl}/v1/extension/discovery/tasks/${encodeURIComponent(taskId)}/lease?${query.toString()}`,
    {
      method: "GET",
      headers: discoveryExtensionHeaders(bearer, installationId, extensionVersion),
      cache: "no-store",
    },
    options.timeoutMs ?? 5_000,
  );
  if (response.status === 404 || response.status === 409) return false;
  if (!response.ok) {
    throw new LocalApiError(`Local JobCtrl API rejected the Discovery lease heartbeat: ${response.status}.`, response.status);
  }
  const body = (await response.json()) as { active?: unknown };
  return body.active === true;
}

export function normalizeLoopbackBaseUrl(baseUrl: string = LOOPBACK_API_ORIGINS[0]): LoopbackApiOrigin {
  const url = new URL(baseUrl);
  const normalized = url.origin;
  if (!LOOPBACK_API_ORIGINS.includes(normalized as LoopbackApiOrigin)) {
    throw new LocalApiError(`Extension API base URL must be loopback: ${normalized}`);
  }
  return normalized as LoopbackApiOrigin;
}

function requireBearerToken(token: string): string {
  const bearer = token.trim();
  if (!bearer) {
    throw new LocalApiError("Missing extension capability token.");
  }
  return bearer;
}

function discoveryExtensionHeaders(
  bearer: string,
  installationId: string,
  extensionVersion: string,
): Record<string, string> {
  const normalizedInstallationId = installationId.trim();
  if (!normalizedInstallationId) {
    throw new LocalApiError("Missing Discovery extension installation identity.");
  }
  return {
    authorization: `Bearer ${bearer}`,
    [INSTALLATION_HEADER]: normalizedInstallationId,
    [EXTENSION_VERSION_HEADER]: extensionVersion.trim().slice(0, 80) || "unknown",
  };
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
      throw new LocalApiError(`Local JobCtrl API request timed out after ${timeoutMs}ms.`);
    }
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}
