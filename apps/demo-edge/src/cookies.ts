import {
  CONSENT_CONTRACT_VERSION,
  PERSISTENT_COOKIE_MAX_AGE_SECONDS,
  type ConsentChoice,
} from "./contracts.js";

export const CONSENT_COOKIE = "__Host-jobctrl_demo_consent";
export const VISITOR_COOKIE = "__Host-jobctrl_demo_vid";
export const SESSION_COOKIE = "__Host-jobctrl_demo_session";

export interface DemoCookies {
  consent?: ConsentChoice;
  visitorId?: string;
  sessionId?: string;
  consentContractStale: boolean;
  visitorCookiePresent: boolean;
  sessionCookiePresent: boolean;
}

function cookieValue(name: string, cookieHeader: string | null): string | undefined {
  if (cookieHeader === null) return undefined;
  for (const entry of cookieHeader.split(";")) {
    const [key, ...parts] = entry.trim().split("=");
    if (key === name && parts.length > 0) return parts.join("=");
  }
  return undefined;
}

function validId(value: string | undefined): value is string {
  return value !== undefined && /^[A-Za-z0-9_-]{32,128}$/.test(value);
}

export function readDemoCookies(request: Request): DemoCookies {
  const header = request.headers.get("cookie");
  const consentValue = cookieValue(CONSENT_COOKIE, header);
  const consent = consentValue === `${CONSENT_CONTRACT_VERSION}.granted`
    ? "granted"
    : consentValue === `${CONSENT_CONTRACT_VERSION}.denied`
      ? "denied"
      : undefined;
  const visitorId = cookieValue(VISITOR_COOKIE, header);
  const sessionId = cookieValue(SESSION_COOKIE, header);
  return {
    ...(consent === undefined ? {} : { consent }),
    ...(validId(visitorId) ? { visitorId } : {}),
    ...(validId(sessionId) ? { sessionId } : {}),
    consentContractStale: consentValue !== undefined && consent === undefined,
    visitorCookiePresent: visitorId !== undefined,
    sessionCookiePresent: sessionId !== undefined,
  };
}

function baseCookie(name: string, value: string): string {
  return `${name}=${value}; Max-Age=${PERSISTENT_COOKIE_MAX_AGE_SECONDS}; Path=/; Secure; SameSite=Lax`;
}

export function consentCookie(choice: ConsentChoice): string {
  return baseCookie(CONSENT_COOKIE, `${CONSENT_CONTRACT_VERSION}.${choice}`);
}

export function visitorCookie(visitorId: string): string {
  return `${baseCookie(VISITOR_COOKIE, visitorId)}; HttpOnly`;
}

export function sessionCookie(sessionId: string): string {
  return `${SESSION_COOKIE}=${sessionId}; Path=/; Secure; SameSite=Lax; HttpOnly`;
}

export function expireCookie(name: string): string {
  return `${name}=; Max-Age=0; Expires=Thu, 01 Jan 1970 00:00:00 GMT; Path=/; Secure; SameSite=Lax; HttpOnly`;
}

export function expireConsentCookie(): string {
  return `${CONSENT_COOKIE}=; Max-Age=0; Expires=Thu, 01 Jan 1970 00:00:00 GMT; Path=/; Secure; SameSite=Lax`;
}

export function appendCookies(response: Response, cookies: readonly string[]): Response {
  for (const cookie of cookies) response.headers.append("set-cookie", cookie);
  return response;
}
