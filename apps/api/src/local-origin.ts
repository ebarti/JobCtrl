export const LOCAL_ORIGIN_PATTERNS = [
  /^https?:\/\/localhost(?::\d+)?$/,
  /^https?:\/\/127\.0\.0\.1(?::\d+)?$/,
  /^https?:\/\/\[::1\](?::\d+)?$/,
];

export const LOCAL_CORS_METHODS = ["DELETE", "GET", "HEAD", "POST", "PATCH"];

export const LOOPBACK_HOST_PATTERNS = [
  /^localhost(?::\d+)?$/i,
  /^127(?:\.\d{1,3}){3}(?::\d+)?$/,
  /^\[::1\](?::\d+)?$/,
];

export function isLoopbackHostHeader(hostHeader: string | string[] | undefined): boolean {
  const values = headerValues(hostHeader);
  return (
    values.length === 1 &&
    values.every((value) => LOOPBACK_HOST_PATTERNS.some((pattern) => pattern.test(value.trim())))
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
    return true;
  }
  return origins.every((origin) => origin !== null && isLoopbackOrigin(origin));
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

export function isLoopbackOrigin(origin: string): boolean {
  return LOCAL_ORIGIN_PATTERNS.some((pattern) => pattern.test(origin));
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
