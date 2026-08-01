import { describe, expect, it, vi } from "vitest";

import { DemoTelemetryAdapter, classifyDemoRoute } from "./DemoTelemetryAdapter.js";

describe("DemoTelemetryAdapter", () => {
  it("sends only closed event names, attributes, and values", async () => {
    const fetcher = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) =>
      new Response(null, { status: 204 }));
    const adapter = new DemoTelemetryAdapter({ fetcher: fetcher as typeof fetch });

    adapter.event("demo_action_completed", {
      feature: "pipeline",
      action: "run_stage",
      scenario: "success",
      result: "succeeded",
      durationBucket: "under_100ms",
    });
    adapter.event("arbitrary_event", { route: "dashboard" });
    adapter.event("demo_route_viewed", { route: "dashboard", search: "private value" });
    adapter.event("demo_route_viewed", { route: "private/company/name" });
    await Promise.resolve();

    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(JSON.parse(String(fetcher.mock.calls[0]?.[1]?.body))).toEqual({
      name: "demo_action_completed",
      attributes: {
        feature: "pipeline",
        action: "run_stage",
        scenario: "success",
        result: "succeeded",
        durationBucket: "under_100ms",
      },
    });
  });

  it("never serializes raw errors and remains fail-open", async () => {
    const fetcher = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) =>
      Promise.reject(new TypeError("network secret")));
    const adapter = new DemoTelemetryAdapter({ fetcher: fetcher as typeof fetch });

    expect(() => adapter.error(new Error("resume text"), { errorCode: "raw stack" })).not.toThrow();
    await Promise.resolve();
    const body = String(fetcher.mock.calls[0]?.[1]?.body);
    expect(body).toContain("client_unexpected");
    expect(body).not.toMatch(/resume text|raw stack|network secret/);
  });

  it("classifies route, viewport, and referrer without sending raw URLs", async () => {
    const fetcher = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) =>
      new Response(null, { status: 204 }));
    const adapter = new DemoTelemetryAdapter({
      fetcher: fetcher as typeof fetch,
      viewportWidth: () => 640,
      referrer: () => "https://jobctrl.dev/private?query=value",
    });

    adapter.sessionStarted(
      "/jobs/6e2f4a10-20be-4d5f-98a4-a4bb9a877a35?secret=value",
    );
    adapter.routeViewed("/artifacts/artifact-tailored-resume");
    await Promise.resolve();
    const bodies = fetcher.mock.calls.map((call) => String(call[1]?.body));
    expect(bodies.map((body) => JSON.parse(body))).toEqual([
      {
        name: "demo_session_started",
        attributes: { route: "job_detail", viewportBucket: "compact", referrerClass: "jobctrl_docs" },
      },
      {
        name: "demo_route_viewed",
        attributes: { route: "artifact_detail", viewportBucket: "compact", referrerClass: "jobctrl_docs" },
      },
    ]);
    expect(bodies.join(" ")).not.toMatch(/northwind|secret|private|query/);
    expect(classifyDemoRoute("/discovery")).toBe("discovery");
  });
});
