const TRUSTED_LIVE_BROWSER_HOSTS = [
  "ashbyhq.com",
  "example.com",
  "example.test",
  "glassdoor.com",
  "google.com",
  "greenhouse.io",
  "icims.com",
  "indeed.com",
  "jobvite.com",
  "lever.co",
  "linkedin.com",
  "myworkdayjobs.com",
  "smartrecruiters.com",
  "workday.com",
] as const;

/**
 * Chrome cannot bind a hostname to the address approved by the API's DNS
 * check. Limit its privileged, authenticated transport to provider-owned DNS
 * zones; arbitrary posting hosts continue through the address-pinned worker
 * transport instead.
 */
export function isTrustedLiveBrowserUrl(value: string): boolean {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return false;
  }
  const hostname = url.hostname.toLowerCase().replace(/\.$/, "");
  return TRUSTED_LIVE_BROWSER_HOSTS.some(
    (trustedHost) => hostname === trustedHost || hostname.endsWith(`.${trustedHost}`),
  );
}
