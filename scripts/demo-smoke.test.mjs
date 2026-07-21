import assert from "node:assert/strict";
import test from "node:test";

import {
  assertNoCloudflareInjection,
  assertSyntheticHtmlAssetsAreClean,
  DEMO_SHELL_READY_ATTEMPTS,
  DEMO_SHELL_READY_DELAY_MS,
  DEMO_SHELL_REQUEST_TIMEOUT_MS,
  DEMO_SHELL_READY_WINDOW_MS,
  waitForDemoShell,
} from "./demo-smoke.mjs";

test("demo smoke waits through custom-domain propagation longer than the former 90-second window", async () => {
  const statuses = [...Array.from({ length: 32 }, () => 403), 200];
  const delays = [];
  let elapsedMs = 0;

  const response = await waitForDemoShell(
    async () => {
      const status = statuses.shift();
      return { ok: status >= 200 && status < 300, status };
    },
    {
      sleep: async (delayMs) => {
        delays.push(delayMs);
        elapsedMs += delayMs;
      },
      now: () => elapsedMs,
      createAbortSignal: () => new AbortController().signal,
      log: () => {},
    },
  );

  assert.equal(response.status, 200);
  assert.deepEqual(delays, Array.from({ length: 32 }, () => DEMO_SHELL_READY_DELAY_MS));
  assert.equal(DEMO_SHELL_READY_ATTEMPTS, 101);
  assert.equal(DEMO_SHELL_READY_WINDOW_MS, 5 * 60_000);
  assert.equal(DEMO_SHELL_REQUEST_TIMEOUT_MS, 15_000);
});

test("demo smoke still fails after the bounded readiness window", async () => {
  let requests = 0;
  let elapsedMs = 0;

  await assert.rejects(
    waitForDemoShell(
      async () => {
        requests += 1;
        elapsedMs += 1;
        return { ok: false, status: 403 };
      },
      {
        attempts: 3,
        timeoutMs: 1,
        delayMs: 0,
        sleep: async () => {},
        now: () => elapsedMs,
        createAbortSignal: () => new AbortController().signal,
        log: () => {},
      },
    ),
    /demo shell was not ready within 1ms after 1ms: \/ last observation 403; observed statuses: 403 x 1/,
  );
  assert.equal(requests, 1);
});

test("demo smoke uses the remaining global deadline to cancel requests and report readiness observations", async () => {
  let elapsedMs = 0;
  const requestTimeouts = [];

  await assert.rejects(
    waitForDemoShell(
      async ({ signal }) => {
        elapsedMs += signal.timeoutMs;
        throw new Error("request deadline elapsed");
      },
      {
        attempts: 10,
        timeoutMs: 50,
        delayMs: 25,
        requestTimeoutMs: 15,
        sleep: async (delayMs) => {
          elapsedMs += delayMs;
        },
        now: () => elapsedMs,
        createAbortSignal: (timeoutMs) => {
          requestTimeouts.push(timeoutMs);
          return { timeoutMs };
        },
        log: () => {},
      },
    ),
    /within 50ms after 50ms: \/ last observation request error: request deadline elapsed; observed statuses: request error: request deadline elapsed x 2/,
  );
  assert.deepEqual(requestTimeouts, [15, 10]);
});

test("demo smoke retries a transient network error before the canonical domain becomes ready", async () => {
  let elapsedMs = 0;
  const observations = [new Error("socket reset"), { ok: true, status: 200 }];

  const response = await waitForDemoShell(
    async () => {
      const observation = observations.shift();
      if (observation instanceof Error) {
        throw observation;
      }
      return observation;
    },
    {
      timeoutMs: 50,
      delayMs: 25,
      sleep: async (delayMs) => {
        elapsedMs += delayMs;
      },
      now: () => elapsedMs,
      createAbortSignal: () => new AbortController().signal,
      log: () => {},
    },
  );

  assert.equal(response.status, 200);
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
