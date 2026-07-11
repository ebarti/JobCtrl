import { describe, expect, it, vi } from "vitest";

import {
  DemoConsentClient,
  DemoConsentUnavailableError,
} from "./DemoConsentClient.js";

const KEY = "k".repeat(32);

describe("DemoConsentClient", () => {
  it("reads the versioned same-origin consent choice", async () => {
    const fetcher = vi.fn(async () => json({ choice: "denied", version: "v1" }));
    const client = new DemoConsentClient({ fetcher: fetcher as typeof fetch });

    await expect(client.getChoice()).resolves.toEqual({ choice: "denied", version: "v1" });
    expect(fetcher).toHaveBeenCalledWith("/api/demo-consent", expect.objectContaining({
      method: "GET",
      credentials: "same-origin",
    }));
  });

  it("retains one operation key across a failed grant retry", async () => {
    const fetcher = vi.fn()
      .mockResolvedValueOnce(new Response(null, { status: 503 }))
      .mockResolvedValueOnce(json({ choice: "granted", version: "v1" }));
    const client = new DemoConsentClient({
      fetcher: fetcher as typeof fetch,
      createOperationKey: () => KEY,
    });

    await expect(client.submitChoice("granted")).rejects.toBeInstanceOf(DemoConsentUnavailableError);
    await expect(client.submitChoice("granted")).resolves.toMatchObject({ choice: "granted" });
    const bodies = fetcher.mock.calls.map((call) => JSON.parse(String(call[1]?.body)) as unknown);
    expect(bodies).toEqual([
      { choice: "granted", operationKey: KEY },
      { choice: "granted", operationKey: KEY },
    ]);
  });

  it("uses a stable health key and rejects malformed consent responses", async () => {
    const fetcher = vi.fn()
      .mockResolvedValueOnce(new Response(null, { status: 503 }))
      .mockResolvedValueOnce(new Response(null, { status: 204 }))
      .mockResolvedValueOnce(json({ choice: "granted", version: "v2" }));
    const client = new DemoConsentClient({
      fetcher: fetcher as typeof fetch,
      createOperationKey: () => KEY,
    });

    await expect(client.recordHealth("success", "persistent")).rejects.toBeInstanceOf(DemoConsentUnavailableError);
    await expect(client.recordHealth("success", "persistent")).resolves.toBeUndefined();
    expect(JSON.parse(String(fetcher.mock.calls[0]?.[1]?.body))).toEqual(
      JSON.parse(String(fetcher.mock.calls[1]?.[1]?.body)),
    );
    await expect(client.getChoice()).rejects.toBeInstanceOf(DemoConsentUnavailableError);
  });
});

function json(value: unknown): Response {
  return new Response(JSON.stringify(value), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}
