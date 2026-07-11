import {
  appendCookies,
  consentCookie,
  expireConsentCookie,
  expireCookie,
  readDemoCookies,
  sessionCookie,
  SESSION_COOKIE,
  visitorCookie,
  VISITOR_COOKIE,
} from "./cookies.js";
import { CONSENT_CONTRACT_VERSION } from "./contracts.js";
import {
  activateTelemetryIdentity,
  hasActiveTelemetryIdentity,
  hasActiveTelemetryVisitor,
  hashTelemetryIds,
  insertTelemetryEvent,
  isOperationalRequestAllowed,
  isTelemetryRequestAllowed,
  recordOperationalCounter,
  refreshTelemetryIdentity,
} from "./database.js";
import { randomId } from "./crypto.js";
import {
  emptyResponse,
  hasSameOriginMetadata,
  jsonResponse,
  logEdgeEvent,
  methodNotAllowed,
  readStrictJson,
  rejectedResponse,
  temporarilyUnavailableResponse,
} from "./http.js";
import { parseConsentRequest, parseHealthRequest, parseTelemetryEvent } from "./schema.js";
import type { DemoRequestContext } from "./context.js";

function sameOriginOrRejected(context: DemoRequestContext, allowMissingOrigin = false): Response | undefined {
  return hasSameOriginMetadata(context.request, allowMissingOrigin) ? undefined : rejectedResponse(403);
}

function consentPayload(choice: "granted" | "denied" | "unknown"): Record<string, string> {
  return {
    choice,
    version: CONSENT_CONTRACT_VERSION,
  };
}

type GrantIdentityPreparation =
  | { mode: "reuse"; visitorId: string }
  | { mode: "new_session"; visitorId: string }
  | { mode: "rotate" }
  | { mode: "blocked"; response: Response };

async function prepareIdentifiersForGrant(
  context: DemoRequestContext,
  now: Date,
): Promise<GrantIdentityPreparation> {
  const cookies = readDemoCookies(context.request);
  if (cookies.visitorId === undefined && cookies.sessionId === undefined) return { mode: "rotate" };

  try {
    if (cookies.consent === "granted" && cookies.visitorId !== undefined) {
      if (cookies.sessionId !== undefined
        && await refreshTelemetryIdentity(context.env, cookies.visitorId, cookies.sessionId, now)) {
        return { mode: "reuse", visitorId: cookies.visitorId };
      }
      if (cookies.sessionId === undefined
        && await hasActiveTelemetryVisitor(context.env, cookies.visitorId, now)) {
        return { mode: "new_session", visitorId: cookies.visitorId };
      }
    }
  } catch {
    return { mode: "blocked", response: temporarilyUnavailableResponse() };
  }

  // Stale, inactive, or corrupt identifiers are rotated without deleting
  // retained rows. The ordinary expiry worker remains their only lifecycle in
  // this acceptance-only phase.
  return { mode: "rotate" };
}

function expiredStaleCookies(context: DemoRequestContext): string[] {
  const cookies = readDemoCookies(context.request);
  return [
    expireConsentCookie(),
    ...(cookies.visitorCookiePresent ? [expireCookie(VISITOR_COOKIE)] : []),
    ...(cookies.sessionCookiePresent ? [expireCookie(SESSION_COOKIE)] : []),
  ];
}

export async function handleConsentGet(context: DemoRequestContext, now = new Date()): Promise<Response> {
  if (context.request.method !== "GET") return methodNotAllowed("GET, POST");
  const rejected = sameOriginOrRejected(context, true);
  if (rejected !== undefined) return rejected;

  const cookies = readDemoCookies(context.request);
  if (cookies.consentContractStale) {
    return appendCookies(
      jsonResponse(200, consentPayload("unknown")),
      expiredStaleCookies(context),
    );
  }
  if (cookies.consent === "denied") {
    return jsonResponse(200, consentPayload("denied"));
  }
  if (!context.ingressAllowed) return rejectedResponse(429);
  if (cookies.consent !== "granted") return jsonResponse(200, consentPayload("unknown"));
  if (cookies.visitorId === undefined || cookies.sessionId === undefined) {
    return appendCookies(
      jsonResponse(200, consentPayload("unknown")),
      expiredStaleCookies(context),
    );
  }

  try {
    if (!await hasActiveTelemetryIdentity(context.env, cookies.visitorId, cookies.sessionId, now)) {
      return appendCookies(
        jsonResponse(200, consentPayload("unknown")),
        expiredStaleCookies(context),
      );
    }
  } catch {
    return temporarilyUnavailableResponse();
  }
  return jsonResponse(200, consentPayload("granted"));
}

export async function handleConsentPost(context: DemoRequestContext, now = new Date()): Promise<Response> {
  if (context.request.method !== "POST") return methodNotAllowed("GET, POST");
  const rejected = sameOriginOrRejected(context);
  if (rejected !== undefined) return rejected;

  const body = await readStrictJson(context.request);
  const request = parseConsentRequest(body);
  if (request === undefined) return rejectedResponse();

  if (request.choice === "denied") {
    const cookies = readDemoCookies(context.request);
    if (cookies.consent === "granted" || cookies.visitorCookiePresent || cookies.sessionCookiePresent) {
      if (context.ingressAllowed) {
        logEdgeEvent("consent_write", { endpoint: "consent", outcome: "identity_bearing_denial_rejected" });
      }
      return rejectedResponse(409);
    }
    try {
      if (await isOperationalRequestAllowed(context.env, "consent", now)) {
        await recordOperationalCounter(context.env, request.operationKey, {
          metric: "consent_choice",
          consentChoice: "denied",
          initializationResult: "not_applicable",
          storageMode: "not_applicable",
        }, now);
      }
    } catch {
      // Anonymous entry-choice measurement is best-effort and never changes decline.
    }
    return appendCookies(
      jsonResponse(200, consentPayload("denied")),
      [consentCookie("denied")],
    );
  }

  if (!context.ingressAllowed) return rejectedResponse(429);

  const identityPreparation = await prepareIdentifiersForGrant(context, now);
  if (identityPreparation.mode === "blocked") return identityPreparation.response;
  if (identityPreparation.mode === "reuse") {
    logEdgeEvent("consent_write", { endpoint: "consent", outcome: "granted_idempotent" });
    return appendCookies(
      jsonResponse(200, consentPayload("granted")),
      [consentCookie("granted"), visitorCookie(identityPreparation.visitorId)],
    );
  }
  if (identityPreparation.mode === "new_session") {
    const sessionId = randomId();
    try {
      await activateTelemetryIdentity(context.env, identityPreparation.visitorId, sessionId, now);
    } catch {
      return temporarilyUnavailableResponse();
    }
    logEdgeEvent("consent_write", { endpoint: "consent", outcome: "new_session" });
    return appendCookies(
      jsonResponse(200, consentPayload("granted")),
      [
        consentCookie("granted"),
        visitorCookie(identityPreparation.visitorId),
        sessionCookie(sessionId),
      ],
    );
  }

  try {
    if (!await isOperationalRequestAllowed(context.env, "consent", now)) return rejectedResponse(429);
    await recordOperationalCounter(context.env, request.operationKey, {
      metric: "consent_choice",
      consentChoice: "granted",
      initializationResult: "not_applicable",
      storageMode: "not_applicable",
    }, now);
  } catch {
    logEdgeEvent("consent_write", { endpoint: "consent", outcome: "database_unavailable" });
    return temporarilyUnavailableResponse();
  }

  // Fresh and rotated grants create a new active pair. Any superseded pair is
  // retained only until its ordinary expiry.
  const visitorId = randomId();
  const sessionId = randomId();
  try {
    await activateTelemetryIdentity(context.env, visitorId, sessionId, now);
  } catch {
    return temporarilyUnavailableResponse();
  }
  logEdgeEvent("consent_write", { endpoint: "consent", outcome: "granted" });
  return appendCookies(
    jsonResponse(200, consentPayload("granted")),
    [consentCookie("granted"), visitorCookie(visitorId), sessionCookie(sessionId)],
  );
}

export async function handleHealthPost(context: DemoRequestContext, now = new Date()): Promise<Response> {
  if (context.request.method !== "POST") return methodNotAllowed("POST");
  const rejected = sameOriginOrRejected(context);
  if (rejected !== undefined) return rejected;
  if (!context.ingressAllowed) return rejectedResponse(429);

  const body = await readStrictJson(context.request);
  const request = parseHealthRequest(body);
  const cookies = readDemoCookies(context.request);
  if (request === undefined
    || request.choice !== "granted"
    || request.choice !== cookies.consent
    || cookies.visitorId === undefined
    || cookies.sessionId === undefined) {
    return rejectedResponse();
  }

  try {
    if (!await hasActiveTelemetryIdentity(context.env, cookies.visitorId, cookies.sessionId, now)) {
      return rejectedResponse();
    }
    if (!await isOperationalRequestAllowed(context.env, "health", now)) return rejectedResponse(429);
    await recordOperationalCounter(context.env, request.operationKey, {
      metric: "initialization_result",
      consentChoice: request.choice,
      initializationResult: request.result,
      storageMode: request.storageMode,
    }, now);
  } catch {
    logEdgeEvent("health_write", { endpoint: "health", outcome: "database_unavailable" });
    return temporarilyUnavailableResponse();
  }

  logEdgeEvent("health_write", { endpoint: "health", outcome: "recorded" });
  return emptyResponse();
}

export async function handleTelemetryPost(context: DemoRequestContext, now = new Date()): Promise<Response> {
  if (context.request.method !== "POST") return methodNotAllowed("POST");
  const rejected = sameOriginOrRejected(context);
  if (rejected !== undefined) return rejected;
  if (!context.ingressAllowed) return emptyResponse();

  const body = await readStrictJson(context.request);
  const event = parseTelemetryEvent(body);
  if (event === undefined) return rejectedResponse();

  const cookies = readDemoCookies(context.request);
  if (cookies.consent !== "granted" || cookies.visitorId === undefined || cookies.sessionId === undefined) {
    return emptyResponse();
  }

  try {
    const ids = await hashTelemetryIds(cookies.visitorId, cookies.sessionId);
    if (!await isTelemetryRequestAllowed(context.env, ids.visitorHash, ids.sessionHash, now)) {
      logEdgeEvent("telemetry_write", { endpoint: "telemetry", outcome: "rate_dropped" });
      return emptyResponse();
    }
    if (!await insertTelemetryEvent(context.env, ids.visitorHash, ids.sessionHash, event, now)) {
      logEdgeEvent("telemetry_write", { endpoint: "telemetry", outcome: "inactive_dropped" });
      return emptyResponse();
    }
  } catch {
    // Optional analytics must never disclose database state or disrupt the demo.
    logEdgeEvent("telemetry_write", { endpoint: "telemetry", outcome: "dropped" });
    return emptyResponse();
  }

  logEdgeEvent("telemetry_write", { endpoint: "telemetry", outcome: "recorded" });
  return emptyResponse();
}
