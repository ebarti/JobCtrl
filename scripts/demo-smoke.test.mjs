import assert from "node:assert/strict";
import test from "node:test";

import { assertNoCloudflareInjection, assertSyntheticHtmlAssetsAreClean } from "./demo-smoke.mjs";

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
