import { describe, expect, it, vi } from "vitest";

import type { BrowserApi } from "./browser";
import { processNextDiscoveryBrowserTask } from "./discovery-loop";

describe("Discovery browser lease loop", () => {
  it("aborts Chrome work and skips completion after worker cancellation", async () => {
    const resultPosts: string[] = [];
    const fetchImpl = vi.fn<typeof fetch>(async (input, init) => {
      const url = String(input);
      if (url.includes("/tasks/next?")) {
        return json({
          ok: true,
          status: "task",
          taskId: "task-canceled",
          leaseId: "00000000-0000-4000-8000-000000000001",
          timeoutMs: 60_000,
          request: { mode: "rendered_page", url: "https://example.com/jobs/1" },
        });
      }
      if (url.includes("/lease?")) {
        return json({ ok: true, active: false });
      }
      if (url.endsWith("/result")) {
        resultPosts.push(String(init?.body ?? ""));
        return json({ ok: true });
      }
      return json({ ok: false }, 404);
    });
    const remove = vi.fn(async () => undefined);
    const browser = {
      declarativeNetRequest: { updateSessionRules: vi.fn(async () => undefined) },
      tabs: {
        create: vi.fn(async () => ({ id: 55 })),
        update: vi.fn(async () => ({ id: 55 })),
        remove,
        sendMessage: vi.fn(() => new Promise(() => undefined)),
      },
    } as unknown as BrowserApi;

    await expect(
      processNextDiscoveryBrowserTask(
        browser,
        "token",
        "00000000-0000-4000-8000-000000000099",
        "0.1.2",
        { fetchImpl },
      ),
    ).resolves.toBe("processed");

    expect(remove).toHaveBeenCalledWith(55);
    expect(resultPosts).toEqual([]);
  });
});

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}
