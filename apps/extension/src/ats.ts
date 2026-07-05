export const SUPPORTED_ATS_HOST_PERMISSIONS = [
  "https://*.myworkdayjobs.com/*",
  "https://boards.greenhouse.io/*",
  "https://*.greenhouse.io/*",
  "https://jobs.lever.co/*",
  "https://*.lever.co/*",
  "https://jobs.ashbyhq.com/*",
  "https://*.ashbyhq.com/*",
] as const;

export const SUPPORTED_ATS_MATCHES = SUPPORTED_ATS_HOST_PERMISSIONS;

export type SupportedAtsKind = "ashby" | "greenhouse" | "lever" | "workday";

export function detectSupportedAts(urlText: string | undefined): SupportedAtsKind | null {
  if (!urlText) {
    return null;
  }
  try {
    const host = new URL(urlText).hostname.toLowerCase();
    if (host.endsWith("myworkdayjobs.com")) return "workday";
    if (host === "boards.greenhouse.io" || host.endsWith(".greenhouse.io")) return "greenhouse";
    if (host === "jobs.lever.co" || host.endsWith(".lever.co")) return "lever";
    if (host === "jobs.ashbyhq.com" || host.endsWith(".ashbyhq.com")) return "ashby";
    return null;
  } catch {
    return null;
  }
}
