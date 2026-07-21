import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { pathToFileURL } from "node:url";

const CLOUDFLARE_INJECTION_MARKER = /challenge-platform|beacon\.min\.js|\/cdn-cgi\/rum/i;
const DEMO_SHELL_READY_ATTEMPTS = 31;
const DEMO_SHELL_READY_DELAY_MS = 3_000;
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
    delayMs = DEMO_SHELL_READY_DELAY_MS,
    sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    log = console.warn,
  } = {},
) {
  let lastStatus = "unknown";

  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    const response = await fetchShell();
    if (response.ok) {
      return response;
    }

    lastStatus = response.status;
    await response.body?.cancel?.();
    if (attempt < attempts) {
      log(`Demo shell is not ready (attempt ${attempt}/${attempts}): / returned ${lastStatus}`);
      await sleep(delayMs);
    }
  }

  assert.fail(`demo shell was not ready after ${attempts} attempts: / returned ${lastStatus}`);
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

  const shell = await waitForDemoShell(() => fetchPath("/"));
  const shellHtml = await shell.text();
  assert.match(shellHtml, /<div id="root"><\/div>/);
  assertNoCloudflareInjection("/", shellHtml);
  assert.match(shell.headers.get("content-security-policy") ?? "", /default-src 'self'/);
  assert.equal(shell.headers.get("referrer-policy"), "no-referrer");
  assert.equal(shell.headers.get("x-content-type-options"), "nosniff");

  const deepLink = await request("/jobs/job-northwind-platform");
  const deepLinkHtml = await deepLink.text();
  assert.match(deepLinkHtml, /<div id="root"><\/div>/);
  assertNoCloudflareInjection("/jobs/job-northwind-platform", deepLinkHtml);

  await assertSyntheticHtmlAssetsAreClean(request);

  const initial = await request("/api/demo-consent", {
    headers: {
      accept: "application/json",
      origin: baseUrl.origin,
      "sec-fetch-site": "same-origin",
    },
  });
  assert.deepEqual(await initial.json(), { choice: "unknown", version: "v1" });

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
  assert.deepEqual(await denied.json(), { choice: "denied", version: "v1" });
  const deniedCookies = denied.headers.get("set-cookie") ?? "";
  assert.match(deniedCookies, /__Host-jobctrl_demo_consent=v1\.denied/);
  assert.doesNotMatch(deniedCookies, /__Host-jobctrl_demo_(?:vid|session)=/);

  const granted = await choose("granted");
  assert.deepEqual(await granted.json(), { choice: "granted", version: "v1" });
  const grantedCookies = granted.headers.get("set-cookie") ?? "";
  for (const cookie of [
    "__Host-jobctrl_demo_consent=v1.granted",
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
