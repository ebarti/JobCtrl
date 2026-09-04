import { afterEach, describe, expect, it, vi } from "vitest";

import type { BrowserApi } from "./browser";
import { executeDiscoveryBrowserTask } from "./discovery-executor";

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("Discovery browser executor", () => {
  it("uses an inactive tab in the current Chrome profile and closes it after a rendered snapshot", async () => {
    const create = vi.fn(async () => ({ id: 42 }));
    const update = vi.fn(async () => ({ id: 42 }));
    const remove = vi.fn(async () => undefined);
    const updateSessionRules = vi.fn(async () => undefined);
    const sendMessage = vi
      .fn()
      .mockResolvedValueOnce({ ok: true, status: "discovery_ready" })
      .mockResolvedValueOnce({
        status: "succeeded",
        finalUrl: "https://example.com/jobs/1",
        statusCode: null,
        contentType: "text/html",
        title: "Fixture role",
        bodyText: "Fixture role",
        bodyHtml: "<main>Fixture role</main>",
      });
    const browser = {
      declarativeNetRequest: { updateSessionRules },
      tabs: { create, update, remove, sendMessage },
    } as unknown as BrowserApi;

    const result = await executeDiscoveryBrowserTask(browser, {
      ok: true,
      status: "task",
      taskId: "task-1",
      leaseId: "00000000-0000-4000-8000-000000000001",
      timeoutMs: 60_000,
      request: { mode: "rendered_page", url: "https://example.com/jobs/1" },
    });

    expect(create).toHaveBeenCalledWith({ active: false, url: "about:blank" });
    expect(update).toHaveBeenCalledWith(42, { active: false, url: "https://example.com/jobs/1" });
    expect(updateSessionRules).toHaveBeenNthCalledWith(1, expect.objectContaining({
      addRules: expect.arrayContaining([
        expect.objectContaining({
          priority: 10,
          action: { type: "allow" },
          condition: expect.objectContaining({ tabIds: [42] }),
        }),
        expect.objectContaining({
          priority: 1,
          action: { type: "block" },
          condition: expect.objectContaining({ tabIds: [42] }),
        }),
      ]),
    }));
    expect(sendMessage).toHaveBeenLastCalledWith(42, { type: "jobctrl.discovery.snapshot" });
    expect(result).toMatchObject({ status: "succeeded", title: "Fixture role" });
    expect(remove).toHaveBeenCalledWith(42);
  });

  it("cleans up the inactive tab and redirect guard after a retryable hydration failure", async () => {
    const remove = vi.fn(async () => undefined);
    const updateSessionRules = vi.fn(async () => undefined);
    const browser = {
      declarativeNetRequest: { updateSessionRules },
      tabs: {
        create: vi.fn(async () => ({ id: 46 })),
        update: vi.fn(async () => ({ id: 46 })),
        remove,
        sendMessage: vi
          .fn()
          .mockResolvedValueOnce({ ok: true, status: "discovery_ready" })
          .mockResolvedValueOnce({
            status: "failed",
            errorCode: "navigation_failed",
            message: "LinkedIn job detail did not become ready before the bounded Discovery wait.",
            retryable: true,
          }),
      },
    } as unknown as BrowserApi;

    const result = await executeDiscoveryBrowserTask(browser, {
      ok: true,
      status: "task",
      taskId: "task-hydration-timeout",
      leaseId: "00000000-0000-4000-8000-000000000008",
      timeoutMs: 60_000,
      request: { mode: "rendered_page", url: "https://www.linkedin.com/jobs/view/123" },
    });

    expect(result).toMatchObject({
      status: "failed",
      errorCode: "navigation_failed",
      retryable: true,
    });
    expect(remove).toHaveBeenCalledWith(46);
    expect(updateSessionRules).toHaveBeenLastCalledWith({ removeRuleIds: expect.any(Array) });
  });

  it("executes an authenticated JSON API request without requiring an injectable origin page", async () => {
    const create = vi.fn(async () => ({ id: 43 }));
    const update = vi.fn(async () => ({ id: 43 }));
    const remove = vi.fn(async () => undefined);
    const updateSessionRules = vi.fn(async () => undefined);
    const sendMessage = vi.fn();
    const fetchRequest = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) =>
      new Response('{"jobs":[]}', {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );
    vi.stubGlobal("fetch", fetchRequest);
    const browser = {
      declarativeNetRequest: { updateSessionRules },
      tabs: { create, update, remove, sendMessage },
    } as unknown as BrowserApi;

    const result = await executeDiscoveryBrowserTask(browser, {
      ok: true,
      status: "task",
      taskId: "task-2",
      leaseId: "00000000-0000-4000-8000-000000000002",
      timeoutMs: 60_000,
      request: {
        mode: "http_request",
        url: "https://api.example.com/jobs?q=platform",
        method: "GET",
        headers: {},
      },
    });

    expect(fetchRequest).toHaveBeenCalledWith(
      "https://api.example.com/jobs?q=platform",
      expect.objectContaining({
        method: "GET",
        credentials: "include",
        redirect: "manual",
        signal: expect.any(AbortSignal),
      }),
    );
    expect(result).toMatchObject({ status: "succeeded", bodyText: '{"jobs":[]}' });
    expect(create).not.toHaveBeenCalled();
    expect(update).not.toHaveBeenCalled();
    expect(sendMessage).not.toHaveBeenCalled();
    expect(remove).not.toHaveBeenCalled();
    expect(updateSessionRules).not.toHaveBeenCalled();
  });

  it("preserves an API POST while stripping browser-owned and proxy headers", async () => {
    const fetchRequest = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) =>
      new Response('{"jobs":[]}', {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );
    vi.stubGlobal("fetch", fetchRequest);
    const browser = {
      declarativeNetRequest: { updateSessionRules: vi.fn() },
      tabs: {
        create: vi.fn(),
        update: vi.fn(),
        remove: vi.fn(),
        sendMessage: vi.fn(),
      },
    } as unknown as BrowserApi;

    const result = await executeDiscoveryBrowserTask(browser, {
      ok: true,
      status: "task",
      taskId: "task-post",
      leaseId: "00000000-0000-4000-8000-000000000006",
      timeoutMs: 60_000,
      request: {
        mode: "http_request",
        url: "https://api.example.com/jobs/search",
        method: "POST",
        body: '{"query":"platform"}',
        headers: {
          "Content-Type": "application/json",
          "X-Workday-Csrf": "allowed",
          Cookie: "must-not-be-forwarded",
          Origin: "https://attacker.example",
          Referer: "https://attacker.example/",
          "User-Agent": "spoofed",
          Connection: "keep-alive",
          Host: "attacker.example",
          "Content-Length": "999",
          "Sec-Fetch-Site": "cross-site",
          "Sec-Ch-Ua": "spoofed",
          "Proxy-Authorization": "secret",
        },
      },
    });

    expect(fetchRequest).toHaveBeenCalledTimes(1);
    const [, init] = fetchRequest.mock.calls[0] ?? [];
    expect(init).toMatchObject({
      method: "POST",
      body: '{"query":"platform"}',
      credentials: "include",
      redirect: "manual",
    });
    expect(init?.headers).toEqual({
      "Content-Type": "application/json",
      "X-Workday-Csrf": "allowed",
    });
    expect(result).toMatchObject({ status: "succeeded", bodyText: '{"jobs":[]}' });
  });

  it("enforces the response limit in UTF-8 bytes and cancels an oversized stream", async () => {
    const cancel = vi.fn();
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode("é".repeat(2_000_001)));
      },
      cancel,
    });
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        new Response(body, {
          status: 200,
          headers: { "content-type": "text/plain; charset=utf-8" },
        }),
      ),
    );
    const browser = {
      declarativeNetRequest: { updateSessionRules: vi.fn() },
      tabs: {
        create: vi.fn(),
        update: vi.fn(),
        remove: vi.fn(),
        sendMessage: vi.fn(),
      },
    } as unknown as BrowserApi;

    const result = await executeDiscoveryBrowserTask(browser, {
      ok: true,
      status: "task",
      taskId: "task-oversized",
      leaseId: "00000000-0000-4000-8000-000000000007",
      timeoutMs: 60_000,
      request: {
        mode: "http_request",
        url: "https://api.example.com/oversized",
        method: "GET",
        headers: {},
      },
    });

    expect(result).toMatchObject({
      status: "failed",
      errorCode: "response_too_large",
      retryable: false,
    });
    expect(cancel).toHaveBeenCalledTimes(1);
    expect(cancel).toHaveBeenCalledWith("Discovery response exceeded its byte limit.");
  });

  it("hard-aborts a hanging extension HTTP request at the lease timeout", async () => {
    const create = vi.fn(async () => ({ id: 44 }));
    const update = vi.fn(async () => ({ id: 44 }));
    const remove = vi.fn(async () => undefined);
    const updateSessionRules = vi.fn(async () => undefined);
    const sendMessage = vi.fn();
    vi.stubGlobal(
      "fetch",
      vi.fn((_input: RequestInfo | URL, init?: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => reject(init.signal?.reason), { once: true });
        }),
      ),
    );
    const browser = {
      declarativeNetRequest: { updateSessionRules },
      tabs: { create, update, remove, sendMessage },
    } as unknown as BrowserApi;

    const startedAt = Date.now();
    const result = await executeDiscoveryBrowserTask(browser, {
      ok: true,
      status: "task",
      taskId: "task-timeout",
      leaseId: "00000000-0000-4000-8000-000000000003",
      timeoutMs: 1_000,
      request: {
        mode: "http_request",
        url: "https://api.example.com/hangs",
        method: "GET",
        headers: {},
      },
    });

    expect(Date.now() - startedAt).toBeLessThan(1_500);
    expect(result).toMatchObject({ status: "failed", errorCode: "request_failed", retryable: true });
    expect(result.status === "failed" ? result.message : "").toContain("1000 ms timeout");
    expect(create).not.toHaveBeenCalled();
    expect(sendMessage).not.toHaveBeenCalled();
    expect(remove).not.toHaveBeenCalled();
    expect(updateSessionRules).not.toHaveBeenCalled();
  });

  it("does not follow a brokered HTTP redirect", async () => {
    const fetchRequest = vi.fn(async () =>
      new Response(null, {
        status: 302,
        headers: { location: "http://127.0.0.1/private" },
      }),
    );
    vi.stubGlobal("fetch", fetchRequest);
    const browser = {
      declarativeNetRequest: { updateSessionRules: vi.fn() },
      tabs: {
        create: vi.fn(),
        update: vi.fn(),
        remove: vi.fn(),
        sendMessage: vi.fn(),
      },
    } as unknown as BrowserApi;

    const result = await executeDiscoveryBrowserTask(browser, {
      ok: true,
      status: "task",
      taskId: "task-redirect",
      leaseId: "00000000-0000-4000-8000-000000000005",
      timeoutMs: 60_000,
      request: {
        mode: "http_request",
        url: "https://api.example.com/redirect",
        method: "GET",
        headers: {},
      },
    });

    expect(fetchRequest).toHaveBeenCalledTimes(1);
    expect(result).toMatchObject({
      status: "failed",
      errorCode: "unsafe_redirect",
      retryable: false,
    });
  });

  it("closes the tab promptly when the broker cancels an active lease", async () => {
    const controller = new AbortController();
    const remove = vi.fn(async () => undefined);
    const browser = {
      declarativeNetRequest: { updateSessionRules: vi.fn(async () => undefined) },
      tabs: {
        create: vi.fn(async () => ({ id: 45 })),
        update: vi.fn(async () => ({ id: 45 })),
        remove,
        sendMessage: vi
          .fn()
          .mockResolvedValueOnce({ ok: true, status: "discovery_ready" })
          .mockImplementationOnce(() => new Promise(() => undefined)),
      },
    } as unknown as BrowserApi;

    const execution = executeDiscoveryBrowserTask(
      browser,
      {
        ok: true,
        status: "task",
        taskId: "task-cancel",
        leaseId: "00000000-0000-4000-8000-000000000004",
        timeoutMs: 60_000,
        request: { mode: "rendered_page", url: "https://example.com/jobs/2" },
      },
      { signal: controller.signal },
    );
    await vi.waitFor(() => expect(browser.tabs.sendMessage).toHaveBeenCalledTimes(2));
    controller.abort();

    await expect(execution).resolves.toMatchObject({ status: "failed", retryable: true });
    expect(remove).toHaveBeenCalledWith(45);
  });
});
