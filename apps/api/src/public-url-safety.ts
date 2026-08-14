import { lookup } from "node:dns/promises";

import ipaddr from "ipaddr.js";

export interface PublicUrlDecision {
  allowed: boolean;
  reason?: string;
}

export type PublicHostnameResolver = (
  hostname: string,
) => Promise<readonly string[]>;
export type PublicUrlValidator = (url: string) => Promise<PublicUrlDecision>;

export async function validatePublicHttpUrl(
  url: string,
  resolver: PublicHostnameResolver = resolveHostname,
): Promise<PublicUrlDecision> {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return { allowed: false, reason: "URL must be a valid HTTP(S) URL." };
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    return { allowed: false, reason: "URL must use HTTP or HTTPS." };
  }
  if (parsed.username !== "" || parsed.password !== "") {
    return {
      allowed: false,
      reason: "URL must not contain embedded credentials.",
    };
  }
  const hostname = parsed.hostname.replace(/^\[|\]$/g, "").replace(/\.$/, "");
  if (!hostname) {
    return { allowed: false, reason: "URL host is required." };
  }
  const normalizedHostname = hostname.toLowerCase();
  if (
    normalizedHostname === "localhost" ||
    [".localhost", ".local", ".internal", ".lan", ".home", ".localdomain"].some(
      (suffix) => normalizedHostname.endsWith(suffix),
    )
  ) {
    return { allowed: false, reason: "URL host is a local network name." };
  }
  if (ipaddr.isValid(hostname)) {
    return publicAddressDecision(hostname);
  }

  let addresses: readonly string[];
  try {
    addresses = await resolver(hostname);
  } catch {
    return { allowed: false, reason: "URL host could not be resolved." };
  }
  if (addresses.length === 0) {
    return {
      allowed: false,
      reason: "URL host did not resolve to an IP address.",
    };
  }
  for (const address of addresses) {
    const decision = publicAddressDecision(address);
    if (!decision.allowed) return decision;
  }
  return { allowed: true };
}

async function resolveHostname(hostname: string): Promise<readonly string[]> {
  const results = await lookup(hostname, { all: true, verbatim: true });
  return results.map((result) => result.address);
}

function publicAddressDecision(value: string): PublicUrlDecision {
  if (!ipaddr.isValid(value)) {
    return {
      allowed: false,
      reason: "URL host resolved to an invalid IP address.",
    };
  }
  const address = ipaddr.parse(value);
  if (address instanceof ipaddr.IPv6 && address.isIPv4MappedAddress()) {
    return publicAddressDecision(address.toIPv4Address().toString());
  }
  if (address.range() !== "unicast") {
    return {
      allowed: false,
      reason: "URL host resolves to a non-public address.",
    };
  }
  return { allowed: true };
}
