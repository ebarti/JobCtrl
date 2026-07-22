import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { pathToFileURL } from "node:url";

const CLOUDFLARE_INJECTION_MARKER = /challenge-platform|beacon\.min\.js|\/cdn-cgi\/rum/i;
// Cloudflare Pages can finish publishing before its custom domain serves the
// new deployment. Keep the canonical-domain probe bounded, but allow for that
// propagation rather than treating the previous 90-second window as a deploy
// failure.
export const DEMO_SHELL_READY_WINDOW_MS = 5 * 60_000;
export const DEMO_SHELL_READY_DELAY_MS = 3_000;
export const DEMO_SHELL_READY_ATTEMPTS = DEMO_SHELL_READY_WINDOW_MS / DEMO_SHELL_READY_DELAY_MS + 1;
export const DEMO_SHELL_REQUEST_TIMEOUT_MS = 15_000;
export const DEMO_CONSENT_READY_WINDOW_MS = 60_000;
export const DEMO_CONSENT_READY_DELAY_MS = 3_000;
export const DEMO_CONSENT_READY_ATTEMPTS = DEMO_CONSENT_READY_WINDOW_MS / DEMO_CONSENT_READY_DELAY_MS + 1;
const GOOGLE_ANALYTICS_CSP = {
  connect: "connect-src 'self' https://*.google-analytics.com",
  image: "img-src 'self' data: blob: https://*.google-analytics.com",
  script: "script-src 'self' https://www.googletagmanager.com",
};
const SYNTHETIC_HTML_ASSETS = [
  "/demo/application-preview.html",
  "/demo/profile-resume.html",
  "/demo/source-preview.html",
  "/demo/tailored-resume.html",
];

export function assertNoCloudflareInjection(path, html) {
  assert.doesNotMatch(
    html,
    CLOUDFLARE_INJECTION_MARKER,
    `${path} contains Cloudflare-injected markup`,
  );
}

export async function assertSyntheticHtmlAssetsAreClean(request) {
  for (const path of SYNTHETIC_HTML_ASSETS) {
    const response = await request(path, { redirect: "follow" });
    assertNoCloudflareInjection(path, await response.text());
  }
}

export async function waitForDemoShell(
  fetchShell,
  {
    attempts = DEMO_SHELL_READY_ATTEMPTS,
    timeoutMs = DEMO_SHELL_READY_WINDOW_MS,
    delayMs = DEMO_SHELL_READY_DELAY_MS,
    requestTimeoutMs = DEMO_SHELL_REQUEST_TIMEOUT_MS,
    sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    now = Date.now,
    createAbortSignal = (timeout) => AbortSignal.timeout(timeout),
    isReady = (response) => response.ok,
    log = console.warn,
  } = {},
) {
  const startedAt = now();
  const deadlineAt = startedAt + timeoutMs;
  let lastStatus = "unknown";
  const observedStatuses = new Map();

  for (let attempt = 1; attempt <= attempts && now() < deadlineAt; attempt += 1) {
    const remainingBeforeRequestMs = deadlineAt - now();
    const signal = createAbortSignal(Math.min(requestTimeoutMs, remainingBeforeRequestMs));

    try {
      const response = await fetchShell({ signal });
      if (response.ok && isReady(response)) {
        return response;
      }

      lastStatus = response.ok ? `${response.status} (deployment marker pending)` : response.status;
      observedStatuses.set(lastStatus, (observedStatuses.get(lastStatus) ?? 0) + 1);
      await response.body?.cancel?.();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      lastStatus = `request error: ${message}`;
      observedStatuses.set(lastStatus, (observedStatuses.get(lastStatus) ?? 0) + 1);
    }

    const remainingBeforeRetryMs = deadlineAt - now();
    if (attempt < attempts && remainingBeforeRetryMs > 0) {
      log(
        `Demo shell is not ready (attempt ${attempt}/${attempts}; ${Math.ceil(remainingBeforeRetryMs / 1_000)}s remaining): / ${lastStatus}`,
      );
      await sleep(Math.min(delayMs, remainingBeforeRetryMs));
    }
  }

  const observedSummary = [...observedStatuses]
    .map(([status, count]) => `${status} x ${count}`)
    .join(", ");
  const elapsedMs = Math.max(0, now() - startedAt);
  assert.fail(
    `demo shell was not ready within ${timeoutMs}ms after ${elapsedMs}ms: / last observation ${lastStatus}; observed statuses: ${observedSummary || "none"}`,
  );
}

export function hasGoogleAnalyticsCsp(response) {
  const policy = response.headers.get("content-security-policy") ?? "";
  return Object.values(GOOGLE_ANALYTICS_CSP).every((directive) => policy.includes(directive));
}

export async function waitForDemoConsentContract(
  fetchConsent,
  {
    expectedVersion = "v2",
    attempts = DEMO_CONSENT_READY_ATTEMPTS,
    timeoutMs = DEMO_CONSENT_READY_WINDOW_MS,
    delayMs = DEMO_CONSENT_READY_DELAY_MS,
    requestTimeoutMs = DEMO_SHELL_REQUEST_TIMEOUT_MS,
    sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    now = Date.now,
    createAbortSignal = (timeout) => AbortSignal.timeout(timeout),
    log = console.warn,
  } = {},
) {
  const startedAt = now();
  const deadlineAt = startedAt + timeoutMs;
  let lastObservation = "unknown";

  for (let attempt = 1; attempt <= attempts && now() < deadlineAt; attempt += 1) {
    const remainingBeforeRequestMs = deadlineAt - now();
    const signal = createAbortSignal(Math.min(requestTimeoutMs, remainingBeforeRequestMs));

    try {
      const response = await fetchConsent({ signal });
      if (response.ok) {
        const state = await response.json();
        if (state?.choice === "unknown" && state?.version === expectedVersion) return state;
        lastObservation = `choice=${state?.choice ?? "invalid"}, version=${state?.version ?? "invalid"}`;
      } else {
        lastObservation = `status=${response.status}`;
        await response.body?.cancel?.();
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      lastObservation = `request error: ${message}`;
    }

    const remainingBeforeRetryMs = deadlineAt - now();
    if (attempt < attempts && remainingBeforeRetryMs > 0) {
      log(
        `Demo consent contract is not ready (attempt ${attempt}/${attempts}; ${Math.ceil(remainingBeforeRetryMs / 1_000)}s remaining): ${lastObservation}`,
      );
      await sleep(Math.min(delayMs, remainingBeforeRetryMs));
    }
  }

  const elapsedMs = Math.max(0, now() - startedAt);
  assert.fail(
    `demo consent contract ${expectedVersion} was not ready within ${timeoutMs}ms after ${elapsedMs}ms: ${lastObservation}`,
  );
}

async function runDemoSmoke() {
  const baseUrl = new URL(process.env.DEMO_BASE_URL ?? process.argv[2] ?? "");
  assert.equal(baseUrl.protocol, "https:", "DEMO_BASE_URL must use HTTPS");

  const fetchPath = (path, init) =>
    fetch(new URL(path, baseUrl), {
      redirect: "manual",
      ...init,
    });

  const request = async (path, init) => {
    const response = await fetchPath(path, init);
    assert.ok(response.ok, `${path} returned ${response.status}`);
    return response;
  };

  const shell = await waitForDemoShell(
    ({ signal }) => fetchPath("/", { signal }),
    { isReady: hasGoogleAnalyticsCsp },
  );
  const shellHtml = await shell.text();
  assert.match(shellHtml, /<div id="root"><\/div>/);
  assertNoCloudflareInjection("/", shellHtml);
  const contentSecurityPolicy = shell.headers.get("content-security-policy") ?? "";
  assert.match(contentSecurityPolicy, /default-src 'self'/);
  for (const directive of Object.values(GOOGLE_ANALYTICS_CSP)) {
    assert.ok(contentSecurityPolicy.includes(directive), `CSP is missing ${directive}`);
  }
  assert.equal(shell.headers.get("referrer-policy"), "no-referrer");
  assert.equal(shell.headers.get("x-content-type-options"), "nosniff");

  const deepLink = await request("/jobs/job-northwind-platform");
  const deepLinkHtml = await deepLink.text();
  assert.match(deepLinkHtml, /<div id="root"><\/div>/);
  assertNoCloudflareInjection("/jobs/job-northwind-platform", deepLinkHtml);

  await assertSyntheticHtmlAssetsAreClean(request);

  const initialState = await waitForDemoConsentContract(({ signal }) =>
    fetchPath("/api/demo-consent", {
      signal,
      headers: {
        accept: "application/json",
        origin: baseUrl.origin,
        "sec-fetch-site": "same-origin",
      },
    }));
  assert.deepEqual(initialState, { choice: "unknown", version: "v2" });

  const operationKey = () => randomBytes(24).toString("base64url");
  const choose = (choice) => request("/api/demo-consent", {
    method: "POST",
    headers: {
      accept: "application/json",
      "content-type": "application/json",
      origin: baseUrl.origin,
      "sec-fetch-site": "same-origin",
    },
    body: JSON.stringify({ choice, operationKey: operationKey() }),
  });

  const denied = await choose("denied");
  assert.deepEqual(await denied.json(), { choice: "denied", version: "v2" });
  const deniedCookies = denied.headers.get("set-cookie") ?? "";
  assert.match(deniedCookies, /__Host-jobctrl_demo_consent=v2\.denied/);
  assert.doesNotMatch(deniedCookies, /__Host-jobctrl_demo_(?:vid|session)=/);

  const granted = await choose("granted");
  assert.deepEqual(await granted.json(), { choice: "granted", version: "v2" });
  const grantedCookies = granted.headers.get("set-cookie") ?? "";
  for (const cookie of [
    "__Host-jobctrl_demo_consent=v2.granted",
    "__Host-jobctrl_demo_vid=",
    "__Host-jobctrl_demo_session=",
  ]) {
    assert.ok(grantedCookies.includes(cookie), `grant response is missing ${cookie}`);
  }
  assert.match(grantedCookies, /Path=\/; Secure; SameSite=Lax/);
  assert.match(grantedCookies, /HttpOnly/);

  console.log(`Demo smoke passed: ${baseUrl.origin}`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await runDemoSmoke();
}
