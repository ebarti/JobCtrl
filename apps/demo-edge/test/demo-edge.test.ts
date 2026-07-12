import { applyD1Migrations, env } from "cloudflare:test";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { migrations } from "virtual:demo-edge-migrations";

import { classifyDemoApiRoute, dispatchDemoApi, ingressRateLimitKey } from "../workers/api.js";
import {
  CONSENT_MAX_AGE_SECONDS,
  CONSENT_CONTRACT_VERSION,
  MAX_REQUEST_BYTES,
  OPERATION_DIGEST_MAX_AGE_SECONDS,
  OPERATIONAL_RATE_LIMIT_PER_MINUTE,
  PERSISTENT_COOKIE_MAX_AGE_SECONDS,
  PRODUCT_DATA_MAX_AGE_SECONDS,
  RETENTION_SAFETY_MARGIN_SECONDS,
  TELEMETRY_GLOBAL_RATE_LIMIT_PER_MINUTE,
  TELEMETRY_RATE_LIMIT_PER_MINUTE,
  actionNames,
  routeNames,
  timingMetrics,
} from "../src/contracts.js";
import {
  activateTelemetryIdentity,
  hashTelemetryIds,
  insertTelemetryEvent,
  isTelemetryRequestAllowed,
  recordOperationalCounter,
} from "../src/database.js";
import {
  handleConsentGet,
  handleConsentPost,
  handleHealthPost,
  handleTelemetryPost,
} from "../src/handlers.js";
import { readStrictJson } from "../src/http.js";
import { parseTelemetryEvent } from "../src/schema.js";
import type { DemoRequestContext } from "../src/context.js";
import { runRetention } from "../workers/retention.js";

const origin = "https://demo.jobctrl.dev";
const visitorId = "v".repeat(32);
const sessionId = "s".repeat(32);
const fixedNow = new Date("2026-07-11T12:00:00.000Z");
const testEnv = env as unknown as DemoEdgeEnv;
const migrationTestDb = (env as unknown as { MIGRATION_TEST_DB: D1Database }).MIGRATION_TEST_DB;

function cookieHeader(choice: "granted" | "denied", visitor = visitorId, session = sessionId): string {
  return [
    `__Host-jobctrl_demo_consent=${CONSENT_CONTRACT_VERSION}.${choice}`,
    `__Host-jobctrl_demo_vid=${visitor}`,
    `__Host-jobctrl_demo_session=${session}`,
  ].join("; ");
}

function context(
  path: string,
  init: RequestInit = {},
  targetEnv = testEnv,
  includeOrigin = true,
): DemoRequestContext {
  const headers = new Headers(init.headers);
  if (includeOrigin && !headers.has("origin")) headers.set("origin", origin);
  headers.set("sec-fetch-site", "same-origin");
  if (!headers.has("cf-connecting-ip")) headers.set("cf-connecting-ip", "192.0.2.10");
  return {
    request: new Request(`${origin}${path}`, { ...init, headers }),
    env: targetEnv,
    ingressAllowed: true,
  };
}

function jsonContext(
  path: string,
  body: unknown,
  cookies?: string,
  method = "POST",
  targetEnv = testEnv,
  includeOrigin = true,
): DemoRequestContext {
  const headers = new Headers({ "content-type": "application/json; charset=utf-8" });
  if (cookies !== undefined) headers.set("cookie", cookies);
  return context(path, { method, headers, body: JSON.stringify(body) }, targetEnv, includeOrigin);
}

function operationKey(seed: string): string {
  return seed.padEnd(32, "x").slice(0, 32);
}

function setCookies(response: Response): string[] {
  const headersWithCookies = response.headers as Headers & { getSetCookie?: () => string[] };
  return headersWithCookies.getSetCookie?.() ?? [response.headers.get("set-cookie") ?? ""];
}

function envWithLimiters(
  telemetryLimit: (options: { key: string }) => Promise<{ success: boolean }>,
  ingressLimit: (options: { key: string }) => Promise<{ success: boolean }> = async () => ({ success: true }),
): DemoEdgeEnv {
  return {
    DEMO_TELEMETRY_DB: testEnv.DEMO_TELEMETRY_DB,
    DEMO_RELEASE: testEnv.DEMO_RELEASE,
    PUBLIC_INGRESS_LIMITER: { limit: ingressLimit },
    TELEMETRY_EDGE_LIMITER: { limit: telemetryLimit },
  } as unknown as DemoEdgeEnv;
}

async function eventCount(): Promise<number> {
  const row = await testEnv.DEMO_TELEMETRY_DB.prepare(
    "SELECT COUNT(*) AS count FROM consented_product_events",
  ).first<{ count: number }>();
  return row?.count ?? 0;
}

async function sessionRateCount(): Promise<number> {
  const row = await testEnv.DEMO_TELEMETRY_DB.prepare(
    "SELECT COUNT(*) AS count FROM telemetry_rate_windows",
  ).first<{ count: number }>();
  return row?.count ?? 0;
}

async function globalRateCount(): Promise<number> {
  const row = await testEnv.DEMO_TELEMETRY_DB.prepare(
    "SELECT COALESCE(SUM(count), 0) AS count FROM telemetry_global_rate_windows",
  ).first<{ count: number }>();
  return row?.count ?? 0;
}

async function activeIdentityCount(): Promise<number> {
  const row = await testEnv.DEMO_TELEMETRY_DB.prepare(
    "SELECT COUNT(*) AS count FROM active_demo_identities",
  ).first<{ count: number }>();
  return row?.count ?? 0;
}

async function operationalStateCounts(): Promise<{ counters: number; retries: number; rates: number }> {
  const [counters, retries, rates] = await Promise.all([
    testEnv.DEMO_TELEMETRY_DB.prepare("SELECT COUNT(*) AS count FROM daily_operational_counters").first<{ count: number }>(),
    testEnv.DEMO_TELEMETRY_DB.prepare("SELECT COUNT(*) AS count FROM operational_retry_digests").first<{ count: number }>(),
    testEnv.DEMO_TELEMETRY_DB.prepare("SELECT COUNT(*) AS count FROM operational_rate_windows").first<{ count: number }>(),
  ]);
  return {
    counters: counters?.count ?? 0,
    retries: retries?.count ?? 0,
    rates: rates?.count ?? 0,
  };
}

async function seedCookieDerivedState(visitor = visitorId, session = sessionId): Promise<{ visitorHash: string; sessionHash: string }> {
  await activateTelemetryIdentity(testEnv, visitor, session, fixedNow);
  const ids = await hashTelemetryIds(visitor, session);
  await insertTelemetryEvent(testEnv, ids.visitorHash, ids.sessionHash, {
    name: "demo_timing",
    attributes: { route: "dashboard", timingMetric: "lcp", metricBucket: "good", viewportBucket: "standard" },
  }, fixedNow);
  await testEnv.DEMO_TELEMETRY_DB.prepare(
    "INSERT INTO telemetry_rate_windows (session_hash, window_utc, count, expires_at) VALUES (?, ?, 1, ?)",
  ).bind(ids.sessionHash, "2026-07-11T12:00", "2026-07-12T12:00:00.000Z").run();
  return ids;
}

beforeAll(async () => {
  await applyD1Migrations(testEnv.DEMO_TELEMETRY_DB, migrations);
});

beforeEach(async () => {
  await testEnv.DEMO_TELEMETRY_DB.batch([
    testEnv.DEMO_TELEMETRY_DB.prepare("DELETE FROM daily_operational_counters"),
    testEnv.DEMO_TELEMETRY_DB.prepare("DELETE FROM operational_retry_digests"),
    testEnv.DEMO_TELEMETRY_DB.prepare("DELETE FROM consented_product_events"),
    testEnv.DEMO_TELEMETRY_DB.prepare("DELETE FROM telemetry_rate_windows"),
    testEnv.DEMO_TELEMETRY_DB.prepare("DELETE FROM telemetry_global_rate_windows"),
    testEnv.DEMO_TELEMETRY_DB.prepare("DELETE FROM operational_rate_windows"),
    testEnv.DEMO_TELEMETRY_DB.prepare("DELETE FROM active_demo_identities"),
  ]);
});

describe("API Worker consent and telemetry boundaries", () => {
  it("accepts every closed browser route and action dimension", () => {
    for (const route of routeNames) {
      expect(parseTelemetryEvent({
        name: "demo_route_viewed",
        attributes: { route },
      }), route).toBeDefined();
    }
    for (const action of actionNames) {
      expect(parseTelemetryEvent({
        name: "demo_action_started",
        attributes: { action },
      }), action).toBeDefined();
    }
  });

  it("exercises every routed endpoint and permits browser-equivalent safe GETs without Origin", async () => {
    expect((await dispatchDemoApi(context("/api/demo-consent", { method: "GET" }, testEnv, false).request, testEnv)).status).toBe(200);
    expect((await dispatchDemoApi(context("/api/demo-consent", {
      method: "GET",
      headers: { origin: "https://not-demo.example" },
    }).request, testEnv)).status).toBe(403);
    expect((await dispatchDemoApi(jsonContext("/api/demo-consent", {
      choice: "denied",
      operationKey: operationKey("missing-origin"),
    }, undefined, "POST", testEnv, false).request, testEnv)).status).toBe(403);

    await activateTelemetryIdentity(testEnv, visitorId, sessionId, fixedNow);
    expect((await dispatchDemoApi(jsonContext("/api/demo-health", {
      choice: "granted", result: "success", storageMode: "memory", operationKey: operationKey("route-health"),
    }, cookieHeader("granted")).request, testEnv)).status).toBe(204);
    expect((await dispatchDemoApi(jsonContext("/api/demo-telemetry", {
      name: "demo_route_viewed", attributes: { route: "jobs" },
    }, cookieHeader("denied")).request, testEnv)).status).toBe(204);
    expect((await dispatchDemoApi(context("/api/demo-telemetry/me", {
      method: "DELETE", headers: { cookie: cookieHeader("denied") },
    }).request, testEnv)).status).toBe(404);
  });

  it("cancels an over-limit chunked body without consuming later chunks", async () => {
    let pulls = 0;
    let cancelled = false;
    let releasePull: (() => void) | undefined;
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        pulls += 1;
        controller.enqueue(new Uint8Array(MAX_REQUEST_BYTES + 1));
        return new Promise<void>((resolve) => { releasePull = resolve; });
      },
      cancel() {
        cancelled = true;
        releasePull?.();
      },
    });
    const request = new Request(`${origin}/api/demo-health`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body,
    });

    await expect(readStrictJson(request)).resolves.toBeUndefined();
    expect(pulls).toBe(1);
    expect(cancelled).toBe(true);
  });

  it("sets exact host-only cookies only after a confirmed grant", async () => {
    const grantedContext = jsonContext("/api/demo-consent", {
      choice: "granted", operationKey: operationKey("grant"),
    });
    const granted = await dispatchDemoApi(grantedContext.request, testEnv);
    expect(granted.status).toBe(200);
    const cookies = setCookies(granted);
    expect(cookies).toContain("__Host-jobctrl_demo_consent=v1.granted; Max-Age=15544800; Path=/; Secure; SameSite=Lax");
    expect(cookies).toEqual(expect.arrayContaining([
      expect.stringMatching(/^__Host-jobctrl_demo_vid=[A-Za-z0-9_-]{32,128}; Max-Age=15544800; Path=\/; Secure; SameSite=Lax; HttpOnly$/),
      expect.stringMatching(/^__Host-jobctrl_demo_session=[A-Za-z0-9_-]{32,128}; Path=\/; Secure; SameSite=Lax; HttpOnly$/),
    ]));
    expect(cookies.join(";")).not.toContain("Domain=");
    expect(await activeIdentityCount()).toBe(1);
  });

  it("keeps a repeated granted POST idempotent and preserves IDs and telemetry history", async () => {
    await activateTelemetryIdentity(testEnv, visitorId, sessionId, fixedNow);
    const ids = await hashTelemetryIds(visitorId, sessionId);
    await insertTelemetryEvent(testEnv, ids.visitorHash, ids.sessionHash, {
      name: "demo_session_started",
      attributes: { route: "dashboard", viewportBucket: "standard", referrerClass: "direct" },
    }, fixedNow);
    await testEnv.DEMO_TELEMETRY_DB.prepare(
      "INSERT INTO telemetry_rate_windows (session_hash, window_utc, count, expires_at) VALUES (?, ?, 1, ?)",
    ).bind(ids.sessionHash, "2026-07-11T12:00", "2026-07-12T12:00:00.000Z").run();
    await testEnv.DEMO_TELEMETRY_DB.prepare(
      "CREATE TRIGGER block_repeat_grant_delete BEFORE DELETE ON consented_product_events BEGIN SELECT RAISE(ABORT, 'must not delete'); END",
    ).run();

    const repeatedAt = new Date(
      fixedNow.getTime() + (PERSISTENT_COOKIE_MAX_AGE_SECONDS - 60) * 1_000,
    );
    const response = await handleConsentPost(jsonContext("/api/demo-consent", {
      choice: "granted", operationKey: operationKey("repeat-granted"),
    }, cookieHeader("granted")), repeatedAt);
    expect(response.status).toBe(200);
    expect(setCookies(response)).toEqual([
      "__Host-jobctrl_demo_consent=v1.granted; Max-Age=15544800; Path=/; Secure; SameSite=Lax",
      `__Host-jobctrl_demo_vid=${visitorId}; Max-Age=15544800; Path=/; Secure; SameSite=Lax; HttpOnly`,
    ]);
    expect(await eventCount()).toBe(1);
    expect(await sessionRateCount()).toBe(1);
    const refreshedIdentity = await testEnv.DEMO_TELEMETRY_DB.prepare(
      "SELECT expires_at FROM active_demo_identities WHERE visitor_hash = ? AND session_hash = ?",
    ).bind(ids.visitorHash, ids.sessionHash).first<{ expires_at: string }>();
    expect(Date.parse(refreshedIdentity!.expires_at) - repeatedAt.getTime()).toBe(
      PERSISTENT_COOKIE_MAX_AGE_SECONDS * 1_000,
    );

    await testEnv.DEMO_TELEMETRY_DB.prepare("DROP TRIGGER block_repeat_grant_delete").run();
    await runRetention(
      testEnv,
      new Date(repeatedAt.getTime() + CONSENT_MAX_AGE_SECONDS * 1_000),
    );
    expect(await activeIdentityCount()).toBe(0);
  });

  it("preserves a returning visitor and history while activating a new browser session", async () => {
    await seedCookieDerivedState();
    const visitorOnlyCookies = [
      `__Host-jobctrl_demo_consent=${CONSENT_CONTRACT_VERSION}.granted`,
      `__Host-jobctrl_demo_vid=${visitorId}`,
    ].join("; ");

    const visitorRotated = await handleConsentPost(jsonContext("/api/demo-consent", {
      choice: "granted", operationKey: operationKey("partial-visitor"),
    }, visitorOnlyCookies), fixedNow);
    expect(visitorRotated.status).toBe(200);
    expect(setCookies(visitorRotated).join(";")).toContain(`__Host-jobctrl_demo_vid=${visitorId};`);
    expect(setCookies(visitorRotated)).toEqual(expect.arrayContaining([
      expect.stringMatching(/^__Host-jobctrl_demo_session=[A-Za-z0-9_-]{32,128};/),
    ]));
    expect(setCookies(visitorRotated).join(";")).not.toContain(`__Host-jobctrl_demo_session=${sessionId};`);
    expect(await eventCount()).toBe(1);
    expect(await sessionRateCount()).toBe(1);
    expect(await activeIdentityCount()).toBe(2);

    const returnedCookies = setCookies(visitorRotated).map((cookie) => cookie.split(";", 1)[0]).join("; ");
    const telemetry = await handleTelemetryPost(jsonContext("/api/demo-telemetry", {
      name: "demo_route_viewed", attributes: { route: "jobs" },
    }, returnedCookies), fixedNow);
    expect(telemetry.status).toBe(204);
    expect(await eventCount()).toBe(2);
    const audience = await testEnv.DEMO_TELEMETRY_DB.prepare(
      "SELECT COUNT(DISTINCT visitor_hash) AS visitors, COUNT(DISTINCT session_hash) AS sessions FROM consented_product_events",
    ).first<{ visitors: number; sessions: number }>();
    expect(audience).toEqual({ visitors: 1, sessions: 2 });
  });

  it("rotates a corrupt session-only grant without deleting retained telemetry", async () => {
    await seedCookieDerivedState();
    const sessionOnlyCookies = [
      `__Host-jobctrl_demo_consent=${CONSENT_CONTRACT_VERSION}.granted`,
      `__Host-jobctrl_demo_session=${sessionId}`,
    ].join("; ");
    const rotated = await handleConsentPost(jsonContext("/api/demo-consent", {
      choice: "granted", operationKey: operationKey("partial-session"),
    }, sessionOnlyCookies), fixedNow);
    expect(rotated.status).toBe(200);
    expect(await rotated.json()).toEqual({ choice: "granted", version: CONSENT_CONTRACT_VERSION });
    expect(setCookies(rotated).join(";")).not.toContain(`__Host-jobctrl_demo_session=${sessionId};`);
    expect(await eventCount()).toBe(1);
    expect(await sessionRateCount()).toBe(1);
    expect(await activeIdentityCount()).toBe(2);
  });

  it("keeps an initial decline identity-free when aggregate counter persistence fails", async () => {
    const failingEnv = {
      DEMO_RELEASE: testEnv.DEMO_RELEASE,
      PUBLIC_INGRESS_LIMITER: { limit: async () => ({ success: true }) },
      TELEMETRY_EDGE_LIMITER: { limit: async () => ({ success: true }) },
      DEMO_TELEMETRY_DB: { prepare: () => { throw new Error("unavailable"); } },
    } as unknown as DemoEdgeEnv;
    const response = await handleConsentPost(jsonContext("/api/demo-consent", {
      choice: "denied", operationKey: operationKey("denied-counter-failure"),
    }, undefined, "POST", failingEnv), fixedNow);

    expect(response.status).toBe(200);
    expect(setCookies(response)).toEqual([
      "__Host-jobctrl_demo_consent=v1.denied; Max-Age=15544800; Path=/; Secure; SameSite=Lax",
    ]);
    expect(await activeIdentityCount()).toBe(0);
  });

  it("deduplicates a committed operation when the response is lost", async () => {
    const payload = { choice: "denied", operationKey: operationKey("lost-response") };
    await handleConsentPost(jsonContext("/api/demo-consent", payload), fixedNow);
    await handleConsentPost(jsonContext("/api/demo-consent", payload), fixedNow);
    const row = await testEnv.DEMO_TELEMETRY_DB.prepare(
      "SELECT count FROM daily_operational_counters WHERE metric = 'consent_choice' AND consent_choice = 'denied'",
    ).first<{ count: number }>();
    expect(row?.count).toBe(1);
  });

  it("classifies ingress into a closed route-key space", async () => {
    expect([
      classifyDemoApiRoute("/api/demo-consent"),
      classifyDemoApiRoute("/api/demo-health"),
      classifyDemoApiRoute("/api/demo-telemetry"),
      classifyDemoApiRoute("/api/demo-telemetry/me"),
      classifyDemoApiRoute("/api/not-a-route"),
    ]).toEqual(["consent", "health", "telemetry", "unknown", "unknown"]);

    const firstUnknown = await ingressRateLimitKey("192.0.2.10", "/api/random-one");
    const secondUnknown = await ingressRateLimitKey("192.0.2.10", "/api/random-two");
    const otherClient = await ingressRateLimitKey("198.51.100.20", "/api/random-one");
    const known = await ingressRateLimitKey("192.0.2.10", "/api/demo-consent");
    expect(firstUnknown).toBe(secondUnknown);
    expect(firstUnknown).not.toBe(otherClient);
    expect(firstUnknown).not.toBe(known);
    expect(firstUnknown).toMatch(/^[a-f0-9]{64}$/);
  });

  it("invokes bounded ingress protection for every public path without overriding denial", async () => {
    const ingressKeys: string[] = [];
    const limitedIngressEnv = envWithLimiters(
      async () => ({ success: true }),
      async ({ key }) => {
        ingressKeys.push(key);
        return { success: false };
      },
    );

    expect((await dispatchDemoApi(
      context("/api/demo-consent", { method: "GET" }, limitedIngressEnv, false).request,
      limitedIngressEnv,
    )).status).toBe(429);
    expect((await dispatchDemoApi(jsonContext("/api/demo-consent", {
      choice: "granted", operationKey: operationKey("ingress-repeat-grant"),
    }, cookieHeader("granted"), "POST", limitedIngressEnv).request, limitedIngressEnv)).status).toBe(429);
    expect((await dispatchDemoApi(jsonContext("/api/demo-consent", {
      choice: "denied", operationKey: operationKey("ingress-denial"),
    }, undefined, "POST", limitedIngressEnv).request, limitedIngressEnv)).status).toBe(200);
    expect((await dispatchDemoApi(jsonContext("/api/demo-health", {
      choice: "granted", result: "success", storageMode: "memory", operationKey: operationKey("ingress-health"),
    }, cookieHeader("granted"), "POST", limitedIngressEnv).request, limitedIngressEnv)).status).toBe(429);
    expect((await dispatchDemoApi(jsonContext("/api/demo-telemetry", {
      name: "demo_route_viewed", attributes: { route: "jobs" },
    }, cookieHeader("denied"), "POST", limitedIngressEnv).request, limitedIngressEnv)).status).toBe(204);
    expect((await dispatchDemoApi(context("/api/demo-telemetry/me", {
      method: "DELETE",
      headers: { cookie: `__Host-jobctrl_demo_consent=${CONSENT_CONTRACT_VERSION}.denied` },
    }, limitedIngressEnv).request, limitedIngressEnv)).status).toBe(404);
    expect((await dispatchDemoApi(
      context("/api/arbitrary-one", { method: "GET" }, limitedIngressEnv, false).request,
      limitedIngressEnv,
    )).status).toBe(404);
    expect((await dispatchDemoApi(
      context("/api/arbitrary-two", { method: "GET" }, limitedIngressEnv, false).request,
      limitedIngressEnv,
    )).status).toBe(404);

    expect(ingressKeys).toHaveLength(8);
    expect(ingressKeys.every((key) => /^[a-f0-9]{64}$/.test(key))).toBe(true);
    expect(ingressKeys.join("")).not.toContain("192.0.2.10");
    expect(ingressKeys[0]).toBe(ingressKeys[1]);
    expect(ingressKeys[1]).toBe(ingressKeys[2]);
    expect(ingressKeys[5]).toBe(ingressKeys[6]);
    expect(ingressKeys[6]).toBe(ingressKeys[7]);
    expect(new Set([ingressKeys[0], ingressKeys[3], ingressKeys[4], ingressKeys[5]]).size).toBe(4);
  });

  it("returns unknown and immediately expires identifiers for a stale consent contract", async () => {
    const staleCookies = [
      "__Host-jobctrl_demo_consent=v0.granted",
      `__Host-jobctrl_demo_vid=${visitorId}`,
      `__Host-jobctrl_demo_session=${sessionId}`,
    ].join("; ");
    const response = await handleConsentGet(context("/api/demo-consent", {
      method: "GET", headers: { cookie: staleCookies },
    }, testEnv, false), fixedNow);
    expect(await response.json()).toEqual({ choice: "unknown", version: CONSENT_CONTRACT_VERSION });
    const cookies = setCookies(response).join(";");
    expect(cookies).toContain("__Host-jobctrl_demo_consent=; Max-Age=0");
    expect(cookies).toContain("__Host-jobctrl_demo_vid=; Max-Age=0");
    expect(cookies).toContain("__Host-jobctrl_demo_session=; Max-Age=0");
  });

  it("treats forged, partial, and inactive granted cookie tuples as unknown", async () => {
    const cases = [
      {
        name: "forged consent only",
        cookie: `__Host-jobctrl_demo_consent=${CONSENT_CONTRACT_VERSION}.granted`,
        expired: ["__Host-jobctrl_demo_consent"],
      },
      {
        name: "missing session",
        cookie: [
          `__Host-jobctrl_demo_consent=${CONSENT_CONTRACT_VERSION}.granted`,
          `__Host-jobctrl_demo_vid=${visitorId}`,
        ].join("; "),
        expired: ["__Host-jobctrl_demo_consent", "__Host-jobctrl_demo_vid"],
      },
      {
        name: "missing visitor",
        cookie: [
          `__Host-jobctrl_demo_consent=${CONSENT_CONTRACT_VERSION}.granted`,
          `__Host-jobctrl_demo_session=${sessionId}`,
        ].join("; "),
        expired: ["__Host-jobctrl_demo_consent", "__Host-jobctrl_demo_session"],
      },
      {
        name: "inactive pair",
        cookie: cookieHeader("granted"),
        expired: [
          "__Host-jobctrl_demo_consent",
          "__Host-jobctrl_demo_vid",
          "__Host-jobctrl_demo_session",
        ],
      },
      {
        name: "malformed identifier",
        cookie: [
          `__Host-jobctrl_demo_consent=${CONSENT_CONTRACT_VERSION}.granted`,
          "__Host-jobctrl_demo_vid=too-short",
          `__Host-jobctrl_demo_session=${sessionId}`,
        ].join("; "),
        expired: [
          "__Host-jobctrl_demo_consent",
          "__Host-jobctrl_demo_vid",
          "__Host-jobctrl_demo_session",
        ],
      },
    ];

    for (const testCase of cases) {
      const response = await handleConsentGet(context("/api/demo-consent", {
        method: "GET", headers: { cookie: testCase.cookie },
      }, testEnv, false), fixedNow);
      expect(response.status, testCase.name).toBe(200);
      expect(await response.json(), testCase.name).toEqual({
        choice: "unknown",
        version: CONSENT_CONTRACT_VERSION,
      });
      const expiredCookies = setCookies(response).join(";");
      for (const name of testCase.expired) {
        expect(expiredCookies, testCase.name).toContain(`${name}=; Max-Age=0`);
      }
    }

    await activateTelemetryIdentity(
      testEnv,
      visitorId,
      sessionId,
      new Date(fixedNow.getTime() - (PERSISTENT_COOKIE_MAX_AGE_SECONDS + 1) * 1_000),
    );
    const expiredPair = await handleConsentGet(context("/api/demo-consent", {
      method: "GET", headers: { cookie: cookieHeader("granted") },
    }, testEnv, false), fixedNow);
    expect(await expiredPair.json()).toEqual({ choice: "unknown", version: CONSENT_CONTRACT_VERSION });
    expect(setCookies(expiredPair).join(";")).toContain("__Host-jobctrl_demo_session=; Max-Age=0");
    expect(await operationalStateCounts()).toEqual({ counters: 0, retries: 0, rates: 0 });
  });

  it("returns granted only for the exact active pair without extending identity expiry", async () => {
    await activateTelemetryIdentity(testEnv, visitorId, sessionId, fixedNow);
    const ids = await hashTelemetryIds(visitorId, sessionId);
    const before = await testEnv.DEMO_TELEMETRY_DB.prepare(
      "SELECT expires_at FROM active_demo_identities WHERE visitor_hash = ? AND session_hash = ?",
    ).bind(ids.visitorHash, ids.sessionHash).first<{ expires_at: string }>();

    const response = await handleConsentGet(context("/api/demo-consent", {
      method: "GET", headers: { cookie: cookieHeader("granted") },
    }, testEnv, false), new Date(fixedNow.getTime() + 60_000));
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ choice: "granted", version: CONSENT_CONTRACT_VERSION });
    expect(response.headers.get("set-cookie")).toBeNull();

    const after = await testEnv.DEMO_TELEMETRY_DB.prepare(
      "SELECT expires_at FROM active_demo_identities WHERE visitor_hash = ? AND session_hash = ?",
    ).bind(ids.visitorHash, ids.sessionHash).first<{ expires_at: string }>();
    expect(after).toEqual(before);
  });

  it("fails closed without rewriting cookies when consent identity validation is unavailable", async () => {
    const failingEnv = {
      ...testEnv,
      DEMO_TELEMETRY_DB: { prepare: () => { throw new Error("unavailable"); } },
    } as unknown as DemoEdgeEnv;
    const response = await handleConsentGet(context("/api/demo-consent", {
      method: "GET", headers: { cookie: cookieHeader("granted") },
    }, failingEnv, false), fixedNow);
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ error: "temporarily_unavailable" });
    expect(response.headers.get("set-cookie")).toBeNull();
  });

  it("rotates stale-contract identifiers without deleting retained telemetry", async () => {
    await seedCookieDerivedState();
    const staleCookies = [
      "__Host-jobctrl_demo_consent=v0.granted",
      `__Host-jobctrl_demo_vid=${visitorId}`,
      `__Host-jobctrl_demo_session=${sessionId}`,
    ].join("; ");
    const rotated = await handleConsentPost(jsonContext("/api/demo-consent", {
      choice: "granted", operationKey: operationKey("stale-rotation"),
    }, staleCookies), fixedNow);
    expect(rotated.status).toBe(200);
    expect(await rotated.json()).toEqual({ choice: "granted", version: CONSENT_CONTRACT_VERSION });
    const rotatedCookies = setCookies(rotated).join(";");
    expect(rotatedCookies).not.toContain(visitorId);
    expect(rotatedCookies).not.toContain(sessionId);
    expect(await eventCount()).toBe(1);
    expect(await sessionRateCount()).toBe(1);
    expect(await activeIdentityCount()).toBe(2);
  });

  it("rejects identity-bearing denial without changing accepted state", async () => {
    await seedCookieDerivedState();
    const response = await handleConsentPost(jsonContext("/api/demo-consent", {
      choice: "denied", operationKey: operationKey("post-accept-denial"),
    }, cookieHeader("granted")), fixedNow);
    expect(response.status).toBe(409);
    expect(response.headers.get("set-cookie")).toBeNull();
    expect(await eventCount()).toBe(1);
    expect(await sessionRateCount()).toBe(1);
    expect(await activeIdentityCount()).toBe(1);
    const counters = await testEnv.DEMO_TELEMETRY_DB.prepare(
      "SELECT COUNT(*) AS count FROM daily_operational_counters",
    ).first<{ count: number }>();
    expect(counters?.count).toBe(0);
  });

  it("rejects ingress-limited identity-bearing denial without logging or touching D1", async () => {
    let ingressCalls = 0;
    const limitedEnv = envWithLimiters(
      async () => ({ success: true }),
      async () => {
        ingressCalls += 1;
        return { success: false };
      },
    );
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);
    try {
      const response = await dispatchDemoApi(jsonContext("/api/demo-consent", {
        choice: "denied", operationKey: operationKey("limited-identity-denial"),
      }, cookieHeader("granted"), "POST", limitedEnv).request, limitedEnv);
      expect(response.status).toBe(409);
      expect(response.headers.get("set-cookie")).toBeNull();
      expect(ingressCalls).toBe(1);
      expect(logSpy).not.toHaveBeenCalled();
      expect(await operationalStateCounts()).toEqual({ counters: 0, retries: 0, rates: 0 });
    } finally {
      logSpy.mockRestore();
    }
  });

  it("re-prompts a clean declined entry and later grants", async () => {
    const declined = await handleConsentPost(jsonContext("/api/demo-consent", {
      choice: "denied", operationKey: operationKey("entry-decline"),
    }), fixedNow);
    expect(declined.status).toBe(200);
    expect(await activeIdentityCount()).toBe(0);

    const returned = await handleConsentGet(context("/api/demo-consent", {
      method: "GET",
      headers: { cookie: `__Host-jobctrl_demo_consent=${CONSENT_CONTRACT_VERSION}.denied` },
    }, testEnv, false), fixedNow);
    expect(await returned.json()).toEqual({ choice: "denied", version: CONSENT_CONTRACT_VERSION });

    const granted = await handleConsentPost(jsonContext("/api/demo-consent", {
      choice: "granted", operationKey: operationKey("entry-return-grant"),
    }, `__Host-jobctrl_demo_consent=${CONSENT_CONTRACT_VERSION}.denied`), fixedNow);
    expect(granted.status).toBe(200);
    expect(await granted.json()).toEqual({ choice: "granted", version: CONSENT_CONTRACT_VERSION });
    expect(await activeIdentityCount()).toBe(1);
  });

  it("enforces session, global D1, and per-edge telemetry limits in that order", async () => {
    await activateTelemetryIdentity(testEnv, visitorId, sessionId, fixedNow);
    const ids = await hashTelemetryIds(visitorId, sessionId);
    await testEnv.DEMO_TELEMETRY_DB.prepare(
      "INSERT INTO telemetry_rate_windows (session_hash, window_utc, count, expires_at) VALUES (?, ?, ?, ?)",
    ).bind(ids.sessionHash, "2026-07-11T12:00", TELEMETRY_RATE_LIMIT_PER_MINUTE, "2026-07-12T12:00:00.000Z").run();
    let edgeCalls = 0;
    const acceptedEnv = envWithLimiters(async () => {
      edgeCalls += 1;
      return { success: true };
    });
    const limited = await isTelemetryRequestAllowed(acceptedEnv, ids.visitorHash, ids.sessionHash, fixedNow);
    expect(limited).toBe(false);
    expect(await globalRateCount()).toBe(0);
    expect(edgeCalls).toBe(0);

    await testEnv.DEMO_TELEMETRY_DB.prepare("DELETE FROM telemetry_rate_windows").run();
    expect(await isTelemetryRequestAllowed(acceptedEnv, ids.visitorHash, ids.sessionHash, fixedNow)).toBe(true);
    expect(await globalRateCount()).toBe(1);
    expect(edgeCalls).toBe(1);

    await testEnv.DEMO_TELEMETRY_DB.prepare(
      "UPDATE telemetry_global_rate_windows SET count = ?",
    ).bind(TELEMETRY_GLOBAL_RATE_LIMIT_PER_MINUTE).run();
    await activateTelemetryIdentity(testEnv, visitorId, "t".repeat(32), fixedNow);
    const otherIds = await hashTelemetryIds(visitorId, "t".repeat(32));
    expect(await isTelemetryRequestAllowed(acceptedEnv, otherIds.visitorHash, otherIds.sessionHash, fixedNow)).toBe(false);
    expect(await globalRateCount()).toBe(TELEMETRY_GLOBAL_RATE_LIMIT_PER_MINUTE);
    expect(edgeCalls).toBe(1);

    const rejected = await handleTelemetryPost(jsonContext("/api/demo-telemetry", {
      name: "demo_route_viewed", attributes: { route: "jobs", email: "not-allowed@example.invalid" },
    }, cookieHeader("granted"), "POST", acceptedEnv), fixedNow);
    expect(rejected.status).toBe(400);
    expect(await eventCount()).toBe(0);

    await testEnv.DEMO_TELEMETRY_DB.prepare("DELETE FROM telemetry_rate_windows").run();
    await testEnv.DEMO_TELEMETRY_DB.prepare("DELETE FROM telemetry_global_rate_windows").run();
    const response = await handleTelemetryPost(jsonContext("/api/demo-telemetry", {
      name: "demo_timing",
      attributes: { route: "dashboard", timingMetric: "lcp", metricBucket: "good", viewportBucket: "standard" },
    }, cookieHeader("granted"), "POST", acceptedEnv), fixedNow);
    expect(response.status).toBe(204);
    const row = await testEnv.DEMO_TELEMETRY_DB.prepare(
      "SELECT visitor_hash, session_hash FROM consented_product_events",
    ).first<{ visitor_hash: string; session_hash: string }>();
    expect(row?.visitor_hash).not.toContain(visitorId);
    expect(row?.session_hash).not.toContain(sessionId);
  });

  it("accepts only closed timing metrics and non-duration metric buckets", async () => {
    await activateTelemetryIdentity(testEnv, visitorId, sessionId, fixedNow);
    const buckets = ["good", "needs_improvement", "poor"] as const;
    for (const [index, timingMetric] of timingMetrics.entries()) {
      const response = await handleTelemetryPost(jsonContext("/api/demo-telemetry", {
        name: "demo_timing",
        attributes: {
          route: "dashboard",
          timingMetric,
          metricBucket: buckets[index % buckets.length],
          viewportBucket: "standard",
        },
      }, cookieHeader("granted")), fixedNow);
      expect(response.status).toBe(204);
    }
    const stored = await testEnv.DEMO_TELEMETRY_DB.prepare(
      "SELECT timing_metric, metric_bucket FROM consented_product_events ORDER BY timing_metric",
    ).all<{ timing_metric: string; metric_bucket: string }>();
    expect(new Set(stored.results.map(({ timing_metric }) => timing_metric))).toEqual(new Set(timingMetrics));
    expect(stored.results.every(({ metric_bucket }) => buckets.includes(metric_bucket as typeof buckets[number]))).toBe(true);

    expect((await handleTelemetryPost(jsonContext("/api/demo-telemetry", {
      name: "demo_timing",
      attributes: { route: "dashboard", timingMetric: "lcp" },
    }, cookieHeader("granted")), fixedNow)).status).toBe(400);
    expect((await handleTelemetryPost(jsonContext("/api/demo-telemetry", {
      name: "demo_timing",
      attributes: { route: "dashboard", timingMetric: "raw_custom_metric", metricBucket: "good" },
    }, cookieHeader("granted")), fixedNow)).status).toBe(400);
  });

  it("enforces mutation origin, bounded body, and operational health rate guards", async () => {
    expect((await handleHealthPost(jsonContext("/api/demo-health", {
      choice: "granted", result: "success", storageMode: "memory", operationKey: operationKey("origin"),
    }, cookieHeader("granted"), "POST", testEnv, false), fixedNow)).status).toBe(403);
    expect((await handleHealthPost(jsonContext("/api/demo-health", {
      choice: "granted", result: "success", storageMode: "memory", operationKey: operationKey("oversized"), padding: "x".repeat(2_100),
    }, cookieHeader("granted")), fixedNow)).status).toBe(400);
    await activateTelemetryIdentity(testEnv, visitorId, sessionId, fixedNow);
    await testEnv.DEMO_TELEMETRY_DB.prepare(
      "INSERT INTO operational_rate_windows (endpoint, window_utc, count, expires_at) VALUES (?, ?, ?, ?)",
    ).bind("health", "2026-07-11T12:00", OPERATIONAL_RATE_LIMIT_PER_MINUTE, "2026-07-12T12:00:00.000Z").run();
    expect((await handleHealthPost(jsonContext("/api/demo-health", {
      choice: "granted", result: "success", storageMode: "memory", operationKey: operationKey("rate-limit"),
    }, cookieHeader("granted")), fixedNow)).status).toBe(429);
    expect((await handleHealthPost(jsonContext("/api/demo-health", {
      choice: "denied", result: "success", storageMode: "memory", operationKey: operationKey("denied-no-init"),
    }, cookieHeader("denied")), fixedNow)).status).toBe(400);
  });

  it("writes initialization health only for the exact active granted pair", async () => {
    const payload = {
      choice: "granted" as const,
      result: "success" as const,
      storageMode: "memory" as const,
      operationKey: operationKey("health-active-pair"),
    };
    const invalidCookies = [
      `__Host-jobctrl_demo_consent=${CONSENT_CONTRACT_VERSION}.granted`,
      [
        `__Host-jobctrl_demo_consent=${CONSENT_CONTRACT_VERSION}.granted`,
        `__Host-jobctrl_demo_vid=${visitorId}`,
      ].join("; "),
      [
        `__Host-jobctrl_demo_consent=${CONSENT_CONTRACT_VERSION}.granted`,
        `__Host-jobctrl_demo_session=${sessionId}`,
      ].join("; "),
      cookieHeader("granted"),
    ];
    for (const cookies of invalidCookies) {
      expect((await handleHealthPost(
        jsonContext("/api/demo-health", payload, cookies),
        fixedNow,
      )).status).toBe(400);
    }

    await activateTelemetryIdentity(
      testEnv,
      visitorId,
      sessionId,
      new Date(fixedNow.getTime() - (PERSISTENT_COOKIE_MAX_AGE_SECONDS + 1) * 1_000),
    );
    expect((await handleHealthPost(
      jsonContext("/api/demo-health", payload, cookieHeader("granted")),
      fixedNow,
    )).status).toBe(400);
    expect(await operationalStateCounts()).toEqual({ counters: 0, retries: 0, rates: 0 });

    await activateTelemetryIdentity(testEnv, visitorId, sessionId, fixedNow);
    const active = await handleHealthPost(
      jsonContext("/api/demo-health", payload, cookieHeader("granted")),
      fixedNow,
    );
    expect(active.status).toBe(204);
    expect(await operationalStateCounts()).toEqual({ counters: 1, retries: 1, rates: 1 });
  });

  it("fails health closed before rate or counter writes when identity validation is unavailable", async () => {
    const failingEnv = {
      ...testEnv,
      DEMO_TELEMETRY_DB: { prepare: () => { throw new Error("unavailable"); } },
    } as unknown as DemoEdgeEnv;
    const response = await handleHealthPost(jsonContext("/api/demo-health", {
      choice: "granted",
      result: "success",
      storageMode: "memory",
      operationKey: operationKey("health-d1-outage"),
    }, cookieHeader("granted"), "POST", failingEnv), fixedNow);
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ error: "temporarily_unavailable" });
    expect(await operationalStateCounts()).toEqual({ counters: 0, retries: 0, rates: 0 });
  });

  it("runs duplicate UTC retention safely", async () => {
    await testEnv.DEMO_TELEMETRY_DB.batch([
      testEnv.DEMO_TELEMETRY_DB.prepare(
        "INSERT INTO daily_operational_counters VALUES ('2026-04-01', 'test-release', 'v1', 'consent_choice', 'denied', 'not_applicable', 'not_applicable', 1, '2026-07-10T12:00:00.000Z')",
      ),
      testEnv.DEMO_TELEMETRY_DB.prepare(
        "INSERT INTO operational_retry_digests VALUES ('expired-digest', '2026-07-10T12:00:00.000Z')",
      ),
      testEnv.DEMO_TELEMETRY_DB.prepare(
        "INSERT INTO consented_product_events (id, occurred_at, expires_at, visitor_hash, session_hash, release, consent_contract_version, event_name) VALUES ('expired-event', '2026-04-01T00:00:00.000Z', '2026-07-10T12:00:00.000Z', 'a', 'b', 'test-release', 'v1', 'demo_timing')",
      ),
      testEnv.DEMO_TELEMETRY_DB.prepare(
        "INSERT INTO telemetry_global_rate_windows VALUES ('2026-07-10T12:00', 1, '2026-07-10T12:00:00.000Z')",
      ),
      testEnv.DEMO_TELEMETRY_DB.prepare(
        "INSERT INTO active_demo_identities VALUES ('expired-visitor', 'expired-session', '2026-07-11T12:00:00.000Z')",
      ),
    ]);
    await runRetention(testEnv, fixedNow);
    await runRetention(testEnv, fixedNow);
    expect(await eventCount()).toBe(0);
    expect(await globalRateCount()).toBe(0);
    expect(await activeIdentityCount()).toBe(0);
  });

  it("assigns conservative exact expiries below every physical retention maximum", async () => {
    await recordOperationalCounter(testEnv, operationKey("expiry-counter"), {
      metric: "consent_choice",
      consentChoice: "granted",
      initializationResult: "not_applicable",
      storageMode: "not_applicable",
    }, fixedNow);
    await activateTelemetryIdentity(testEnv, visitorId, sessionId, fixedNow);
    const ids = await hashTelemetryIds(visitorId, sessionId);
    await insertTelemetryEvent(testEnv, ids.visitorHash, ids.sessionHash, {
      name: "demo_route_viewed",
      attributes: { route: "jobs" },
    }, fixedNow);

    const retry = await testEnv.DEMO_TELEMETRY_DB.prepare(
      "SELECT expires_at FROM operational_retry_digests",
    ).first<{ expires_at: string }>();
    const counter = await testEnv.DEMO_TELEMETRY_DB.prepare(
      "SELECT expires_at FROM daily_operational_counters",
    ).first<{ expires_at: string }>();
    const productEvent = await testEnv.DEMO_TELEMETRY_DB.prepare(
      "SELECT expires_at FROM consented_product_events",
    ).first<{ expires_at: string }>();
    const identity = await testEnv.DEMO_TELEMETRY_DB.prepare(
      "SELECT expires_at FROM active_demo_identities",
    ).first<{ expires_at: string }>();

    expect(Date.parse(retry!.expires_at) - fixedNow.getTime()).toBe(
      (OPERATION_DIGEST_MAX_AGE_SECONDS - RETENTION_SAFETY_MARGIN_SECONDS) * 1_000,
    );
    expect(Date.parse(productEvent!.expires_at) - fixedNow.getTime()).toBe(
      (PRODUCT_DATA_MAX_AGE_SECONDS - RETENTION_SAFETY_MARGIN_SECONDS) * 1_000,
    );
    expect(Date.parse(identity!.expires_at) - fixedNow.getTime()).toBe(
      PERSISTENT_COOKIE_MAX_AGE_SECONDS * 1_000,
    );
    const dayStart = new Date("2026-07-11T00:00:00.000Z");
    expect(Date.parse(counter!.expires_at) - dayStart.getTime()).toBe(
      (PRODUCT_DATA_MAX_AGE_SECONDS - RETENTION_SAFETY_MARGIN_SECONDS) * 1_000,
    );
  });

  it("upgrades an applied original 0001 and fresh-installs the complete schema", async () => {
    expect(migrations.map((migration) => migration.name)).toEqual([
      "0001_demo_telemetry.sql",
      "0002_active_identity_and_retention.sql",
    ]);
    await applyD1Migrations(migrationTestDb, [migrations[0]!]);
    await migrationTestDb.batch([
      migrationTestDb.prepare(
        "INSERT INTO daily_operational_counters VALUES ('2026-07-11', 'old-release', 'v1', 'consent_choice', 'granted', 'not_applicable', 'not_applicable', 1)",
      ),
      migrationTestDb.prepare(
        "INSERT INTO consented_product_events (id, occurred_at, expires_at, visitor_hash, session_hash, release, consent_contract_version, event_name) VALUES ('old-event', '2026-07-11T00:00:00.000Z', '2026-08-01T00:00:00.000Z', 'old-visitor', 'old-session', 'old-release', 'v1', 'demo_route_viewed')",
      ),
      migrationTestDb.prepare(
        "INSERT INTO telemetry_rate_windows VALUES ('orphan-session', '2026-07-11T12:00', 1, '2026-07-12T12:00:00.000Z')",
      ),
    ]);
    expect(await migrationTestDb.prepare(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'active_demo_identities'",
    ).first()).toBeNull();

    await applyD1Migrations(migrationTestDb, [migrations[1]!]);
    const counterColumns = await migrationTestDb.prepare("PRAGMA table_info(daily_operational_counters)").all<{ name: string }>();
    const eventColumns = await migrationTestDb.prepare("PRAGMA table_info(consented_product_events)").all<{ name: string }>();
    expect(counterColumns.results.map(({ name }) => name)).toContain("expires_at");
    expect(eventColumns.results.map(({ name }) => name)).toEqual(expect.arrayContaining(["timing_metric", "metric_bucket"]));
    expect(await migrationTestDb.prepare("SELECT count FROM daily_operational_counters").first()).toMatchObject({ count: 1 });
    expect(await migrationTestDb.prepare("SELECT COUNT(*) AS count FROM active_demo_identities").first()).toMatchObject({ count: 1 });
    expect(await migrationTestDb.prepare("SELECT COUNT(*) AS count FROM telemetry_rate_windows").first()).toMatchObject({ count: 0 });
    expect(await migrationTestDb.prepare(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'telemetry_global_rate_windows'",
    ).first()).toMatchObject({ name: "telemetry_global_rate_windows" });

    const freshTables = await testEnv.DEMO_TELEMETRY_DB.prepare(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name IN ('active_demo_identities', 'telemetry_global_rate_windows') ORDER BY name",
    ).all<{ name: string }>();
    expect(freshTables.results.map(({ name }) => name)).toEqual([
      "active_demo_identities",
      "telemetry_global_rate_windows",
    ]);
  });
});
