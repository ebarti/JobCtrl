import assert from "node:assert/strict";
import test from "node:test";

import {
  assertNoCloudflareInjection,
  assertSyntheticHtmlAssetsAreClean,
  waitForDemoShell,
} from "./demo-smoke.mjs";

test("demo smoke waits for the production custom domain to become ready", async () => {
  const statuses = [403, 403, 200];
  const delays = [];

  const response = await waitForDemoShell(
    async () => {
      const status = statuses.shift();
      return { ok: status >= 200 && status < 300, status };
    },
    {
      attempts: 3,
      delayMs: 25,
      sleep: async (delayMs) => delays.push(delayMs),
      log: () => {},
    },
  );

  assert.equal(response.status, 200);
  assert.deepEqual(delays, [25, 25]);
});

test("demo smoke still fails after the bounded readiness window", async () => {
  let requests = 0;

  await assert.rejects(
    waitForDemoShell(
      async () => {
        requests += 1;
        return { ok: false, status: 403 };
      },
      {
        attempts: 3,
        delayMs: 0,
        sleep: async () => {},
        log: () => {},
      },
    ),
    /demo shell was not ready after 3 attempts: \/ returned 403/,
  );
  assert.equal(requests, 3);
});

test("demo smoke rejects known Cloudflare HTML injection markers", () => {
  for (const marker of ["challenge-platform", "https://static.cloudflareinsights.com/beacon.min.js", "/cdn-cgi/rum"]) {
    assert.throws(
      () => assertNoCloudflareInjection("/demo/tailored-resume.html", `<script src="${marker}">${marker}</script>`),
      /Cloudflare-injected markup/,
    );
  }
});

test("demo smoke accepts the bundled synthetic resume markup", () => {
  assert.doesNotThrow(() =>
    assertNoCloudflareInjection(
      "/demo/tailored-resume.html",
      "<main><h1>Platform systems lead</h1><p>Bundled synthetic resume.</p></main>",
    ),
  );
});

test("demo smoke follows Pages pretty-URL redirects for every synthetic HTML asset", async () => {
  const requests = [];

  await assertSyntheticHtmlAssetsAreClean(async (path, init) => {
    requests.push({ path, init });
    return {
      text: async () => "<main>Bundled synthetic HTML.</main>",
    };
  });

  assert.deepEqual(
    requests.map(({ path }) => path),
    [
      "/demo/application-preview.html",
      "/demo/profile-resume.html",
      "/demo/source-preview.html",
      "/demo/tailored-resume.html",
    ],
  );
  assert.ok(requests.every(({ init }) => init.redirect === "follow"));
});
