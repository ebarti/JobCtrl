import { FormSnapshotSchema, FormMappingResponseSchema, type FormSnapshot, type FormMappingResponse } from "@jobctrl/contracts";
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

export class ExtensionCaptureSupersededError extends LocalApiError {
  constructor() {
    super("A superseded capture remains saved locally.", 409);
    this.name = "ExtensionCaptureSupersededError";
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
  if (!parsed.captureId) {
    throw new LocalApiError("Capture requires a stable ID before sending.");
  }
  const bearer = token.trim();
  if (!bearer) {
    throw new LocalApiError("Missing extension capability token.");
  }
  const fetchImpl = options.fetchImpl ?? fetch;
  const baseUrl = normalizeLoopbackBaseUrl(options.baseUrl);
  const body = await fetchCaptureBodyWithTimeout(
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
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(parsed.captureId));
  const expectedItemId = `extension:${Array.from(new Uint8Array(digest).slice(0, 16), (byte) => byte.toString(16).padStart(2, "0")).join("")}`;
  if (!isCaptureAcknowledgement(body, expectedItemId, parsed)) {
    throw new LocalApiError("Local JobCtrl API did not acknowledge this capture.");
  }
  return body;
}

function isCaptureAcknowledgement(
  value: unknown,
  expectedItemId: string,
  capture: ExtensionCaptureIngestRequest,
): value is ExtensionCaptureIngestResponse {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const result = value as Record<string, unknown>;
  if (result.ok !== true || result.itemId !== expectedItemId || !(typeof result.jobKey === "string" || result.jobKey === null)) return false;
  if (result.status === "dismissed") {
    return result.jobKey === null && (typeof result.dismissedAt === "string" || result.dismissedAt === null) && typeof result.message === "string";
  }
  // The documented completed-import response is untagged. Any other status
  // must not be mistaken for an import just because import fields are present.
  if (result.status !== undefined) return false;
  const provenance = result.provenance;
  if (!provenance || typeof provenance !== "object" || Array.isArray(provenance)) return false;
  const source = provenance as Record<string, unknown>;
  return typeof result.importedAt === "string" && result.importedAt.length > 0 &&
    source.sourceKind === "user_mediated_capture" && source.originatingUrl === capture.originatingUrl &&
    source.captureMode === capture.captureMode && source.futureManualActionRequired === capture.futureManualActionRequired;
}

async function fetchCaptureBodyWithTimeout(
  fetchImpl: typeof fetch,
  input: RequestInfo | URL,
  init: RequestInit,
  timeoutMs: number,
): Promise<unknown> {
  const controller = new AbortController();
  const timeoutError = new LocalApiError(`Local JobCtrl API request timed out after ${timeoutMs}ms.`);
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      reject(timeoutError);
      controller.abort();
    }, timeoutMs);
  });
  const request = (async () => {
    const response = await fetchImpl(input, { ...init, signal: controller.signal });
    if (controller.signal.aborted) {
      void response.body?.cancel().catch(() => undefined);
      throw timeoutError;
    }
    if (!response.ok) {
      if (response.status === 409) {
        let body: unknown;
        try { body = await response.json(); } catch { /* Preserve the generic conflict. */ }
        if (body && typeof body === "object" && !Array.isArray(body)
            && "ok" in body && body.ok === false && "error" in body && body.error === "extension_capture_superseded") {
          throw new ExtensionCaptureSupersededError();
        }
      }
      throw new LocalApiError(`Local JobCtrl API rejected capture: ${response.status}.`, response.status);
    }
    try {
      return await response.json() as unknown;
    } catch {
      throw new LocalApiError("Local JobCtrl API returned an invalid capture acknowledgement.");
    }
  })();
  try {
    // Abort stops a real fetch; the race also bounds callers if a body reader
    // or injected fetch implementation does not promptly honor the signal.
    return await Promise.race([request, deadline]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
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

export async function getExtensionFormMapping(token:string,snapshot:FormSnapshot,options:LocalApiOptions={}):Promise<FormMappingResponse>{
  const response=await fetchWithTimeout(options.fetchImpl??fetch,`${normalizeLoopbackBaseUrl(options.baseUrl)}/v1/extension/autofill/mapping`,{method:"POST",headers:{authorization:`Bearer ${requireBearerToken(token)}`,"content-type":"application/json"},body:JSON.stringify(FormSnapshotSchema.parse(snapshot))},options.timeoutMs??DEFAULT_TIMEOUT_MS);
  if(!response.ok)throw new LocalApiError(`Form mapping unavailable: ${response.status}.`,response.status);
  return FormMappingResponseSchema.parse(await response.json());
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
