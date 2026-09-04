import { describe, expect, it, vi } from "vitest";

import {
  claimDiscoveryBrowserInstallation,
  getExtensionAutofillProfile,
  getNextDiscoveryBrowserTask,
  isDiscoveryBrowserLeaseActive,
  normalizeLoopbackBaseUrl,
  postDiscoveryBrowserTaskResult,
  postExtensionCapture,
} from "./local-api";

describe("extension local API client", () => {
  it("posts captures only to the loopback extension endpoint with the bearer token", async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({ ok: true, itemId: "item-1", jobKey: null, importedAt: "now", provenance: { sourceKind: "user_mediated_capture", originatingUrl: "https://example.com/job", captureMode: "current_page", futureManualActionRequired: false } }), { status: 200 }));

    await postExtensionCapture(
      "token-1",
      {
        captureId: "capture-1",
        originatingUrl: "https://example.com/job",
        captureMode: "current_page",
        capturedUrl: "https://example.com/job",
        contentText: "Role description",
        futureManualActionRequired: false,
        captureClient: "browser_extension",
        extensionVersion: "0.3.0",
      },
      { fetchImpl },
    );

    expect(fetchImpl).toHaveBeenCalledWith(
      "http://127.0.0.1:8766/v1/extension/captures",
      expect.objectContaining({
        method: "POST",
        headers: expect.objectContaining({
          authorization: "Bearer token-1",
          "content-type": "application/json",
        }),
      }),
    );
    const [, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(JSON.parse(String(init.body))).toMatchObject({
      captureId: "capture-1",
      captureClient: "browser_extension",
    });
  });

  it("rejects non-loopback API origins", () => {
    expect(() => normalizeLoopbackBaseUrl("https://api.example.com")).toThrow(/loopback/);
  });

  it("reads the whitelisted autofill profile with the bearer token", async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({ ok: true, profileVersion: 3, fields: [] }), { status: 200 }));

    await getExtensionAutofillProfile("token-2", { fetchImpl });

    expect(fetchImpl).toHaveBeenCalledWith(
      "http://127.0.0.1:8766/v1/extension/autofill/profile",
      expect.objectContaining({
        method: "GET",
        headers: expect.objectContaining({
          authorization: "Bearer token-2",
        }),
      }),
    );
  });

  it("polls and completes Discovery browser tasks only through loopback", async () => {
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            ok: true,
            status: "task",
            taskId: "task-1",
            leaseId: "00000000-0000-4000-8000-000000000001",
            timeoutMs: 60_000,
            request: {
              mode: "rendered_page",
              url: "https://example.com/jobs/1",
            },
          }),
          { status: 200 },
        ),
      )
      .mockResolvedValueOnce(new Response(JSON.stringify({ ok: true, active: true }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ ok: true }), { status: 200 }));

    const installationId = "00000000-0000-4000-8000-000000000099";
    const lease = await getNextDiscoveryBrowserTask("token-3", installationId, "0.1.2", { fetchImpl });
    expect(lease).toMatchObject({ status: "task", taskId: "task-1" });
    expect(
      await isDiscoveryBrowserLeaseActive(
        "token-3",
        installationId,
        "0.1.2",
        "task-1",
        "00000000-0000-4000-8000-000000000001",
        { fetchImpl },
      ),
    ).toBe(true);
    await postDiscoveryBrowserTaskResult(
      "token-3",
      installationId,
      "0.1.2",
      "task-1",
      {
        leaseId: "00000000-0000-4000-8000-000000000001",
        result: {
          status: "succeeded",
          finalUrl: "https://example.com/jobs/1",
          statusCode: 200,
          contentType: "text/html",
          title: "Fixture",
          bodyText: "Fixture role",
          bodyHtml: "<main>Fixture role</main>",
        },
      },
      { fetchImpl },
    );

    expect(fetchImpl.mock.calls[0]?.[0]).toBe(
      "http://127.0.0.1:8766/v1/extension/discovery/tasks/next?extensionVersion=0.1.2",
    );
    expect(fetchImpl.mock.calls[1]?.[0]).toContain(
      "http://127.0.0.1:8766/v1/extension/discovery/tasks/task-1/lease?",
    );
    expect(fetchImpl.mock.calls[2]?.[0]).toBe(
      "http://127.0.0.1:8766/v1/extension/discovery/tasks/task-1/result",
    );
    expect(fetchImpl.mock.calls.every(([url]) => String(url).startsWith("http://127.0.0.1:8766/"))).toBe(true);
    for (const [, init] of fetchImpl.mock.calls) {
      expect(init?.headers).toEqual(expect.objectContaining({
        "x-jobctrl-extension-installation": installationId,
        "x-jobctrl-extension-version": "0.1.2",
      }));
    }
  });

  it("claims the exact extension installation selected by the current Chrome profile", async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({ ok: true }), { status: 200 }));

    await claimDiscoveryBrowserInstallation(
      "token-4",
      {
        installationId: "00000000-0000-4000-8000-000000000088",
        extensionVersion: "0.1.2",
        replace: true,
      },
      { fetchImpl },
    );

    expect(fetchImpl).toHaveBeenCalledWith(
      "http://127.0.0.1:8766/v1/extension/discovery/claim",
      expect.objectContaining({ method: "POST" }),
    );
  });
});
