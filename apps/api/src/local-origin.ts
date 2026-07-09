export const LOCAL_ORIGIN_PATTERNS = [
  /^https?:\/\/localhost(?::\d+)?$/,
  /^https?:\/\/127\.0\.0\.1(?::\d+)?$/,
  /^https?:\/\/\[::1\](?::\d+)?$/,
];

export const LOCAL_CORS_METHODS = ["DELETE", "GET", "HEAD", "POST", "PATCH"];
export const LOCAL_CORS_ALLOWED_HEADERS = ["authorization", "content-type"];
const DEFAULT_FIRST_PARTY_WEB_PORTS = ["5173", "5174"];

export const LOOPBACK_HOST_PATTERNS = [
  /^localhost(?::\d+)?$/i,
  /^127(?:\.\d{1,3}){3}(?::\d+)?$/,
  /^\[::1\](?::\d+)?$/,
];

const CHROME_EXTENSION_ID_PATTERN = /^[a-p]{32}$/;

export function isLoopbackHostHeader(hostHeader: string | string[] | undefined): boolean {
  const values = headerValues(hostHeader);
  return (
    values.length === 1 &&
    values.every((value) => LOOPBACK_HOST_PATTERNS.some((pattern) => pattern.test(value.trim())))
  );
}

export function isLoopbackPeerAddress(peerAddress: string | undefined): boolean {
  const normalized = peerAddress?.trim().toLowerCase();
  if (!normalized) {
    return false;
  }
  if (normalized === "::1" || normalized === "0:0:0:0:0:0:0:1") {
    return true;
  }
  if (normalized.startsWith("::ffff:")) {
    return isLoopbackPeerAddress(normalized.slice("::ffff:".length));
  }
  const octets = normalized.split(".");
  return (
    octets.length === 4 &&
    octets.every((octet) => /^\d{1,3}$/.test(octet) && Number.parseInt(octet, 10) <= 255) &&
    Number.parseInt(octets[0] ?? "", 10) === 127
  );
}

export function isTrustedMutationSource(
  originHeader: string | string[] | undefined,
  refererHeader: string | string[] | undefined,
): boolean {
  const origins = [
    ...headerValues(originHeader).map(parseOriginHeader),
    ...headerValues(refererHeader).map(parseRefererOrigin),
  ];
  if (origins.length === 0) {
    return false;
  }
  return origins.every((origin) => origin !== null && isFirstPartyWebOrigin(origin));
}

export function resolveLoopbackCorsOrigin(originHeader: string | string[] | undefined): string | undefined {
  for (const raw of headerValues(originHeader)) {
    const origin = parseOriginHeader(raw);
    if (origin && isLoopbackOrigin(origin)) {
      return origin;
    }
  }
  return undefined;
}

export function resolveExtensionCorsOrigin(originHeader: string | string[] | undefined): string | undefined {
  for (const raw of headerValues(originHeader)) {
    const origin = parseExtensionOrigin(raw);
    if (origin) {
      return origin;
    }
  }
  return undefined;
}

export function isLoopbackOrigin(origin: string): boolean {
  return LOCAL_ORIGIN_PATTERNS.some((pattern) => pattern.test(origin));
}

function isFirstPartyWebOrigin(origin: string): boolean {
  if (!isLoopbackOrigin(origin)) {
    return false;
  }
  try {
    const url = new URL(origin);
    const port = url.port || (url.protocol === "https:" ? "443" : "80");
    return trustedFirstPartyWebPorts().has(port);
  } catch {
    return false;
  }
}

function trustedFirstPartyWebPorts(): Set<string> {
  const ports = new Set(DEFAULT_FIRST_PARTY_WEB_PORTS);
  for (const value of [process.env["JOBCTRL_WEB_PORT"], process.env["JOBCTRL_E2E_WEB_PORT"]]) {
    const port = normalizePort(value);
    if (port) {
      ports.add(port);
    }
  }
  return ports;
}

function normalizePort(value: string | undefined): string | null {
  if (!value || !/^\d+$/.test(value)) {
    return null;
  }
  const port = Number.parseInt(value, 10);
  return port >= 1 && port <= 65535 ? String(port) : null;
}

function headerValues(value: string | string[] | undefined): string[] {
  if (Array.isArray(value)) {
    return value;
  }
  return value ? [value] : [];
}

function parseOriginHeader(value: string): string | null {
  if (!value || value === "null") {
    return null;
  }
  try {
    return new URL(value).origin;
  } catch {
    return null;
  }
}

function parseRefererOrigin(value: string): string | null {
  try {
    return new URL(value).origin;
  } catch {
    return null;
  }
}

function parseExtensionOrigin(value: string): string | null {
  if (!value || value === "null") {
    return null;
  }
  try {
    const url = new URL(value);
    if (url.protocol !== "chrome-extension:" || !CHROME_EXTENSION_ID_PATTERN.test(url.host)) {
      return null;
    }
    return `${url.protocol}//${url.host}`;
  } catch {
    return null;
  }
}
