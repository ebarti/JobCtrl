import { describe, expect, it, vi } from "vitest";

import { normalizeLoopbackBaseUrl, postExtensionCapture } from "./local-api";

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
});
