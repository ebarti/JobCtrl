import { afterEach, describe, expect, it, vi } from "vitest";

import type { BrowserApi, BrowserDeclarativeNetRequestRule, BrowserTab } from "./browser";
import { executeDiscoveryBrowserTask } from "./discovery-executor";

const JOB_URL = "https://www.linkedin.com/jobs/view/123";
const task = (url = JOB_URL) => ({
  ok: true as const, status: "task" as const, taskId: "window-task", leaseId: "window-lease",
  timeoutMs: 1_000, request: { mode: "rendered_page" as const, url },
});

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

/** Models the measured active-tab/unfocused-window contract; not native browser proof. */
function fixture() {
  const tabs = new Set([99]); // An unrelated user tab must survive every cleanup.
  const rules = new Set<number>();
  const operations: string[] = [];
  let visible = false;
  let url = JOB_URL;
  const create = vi.fn(async () => { operations.push("create-blank"); tabs.add(42); return { id: 42 }; });
  const createWindow = vi.fn(async () => { operations.push("unfocused-window"); visible = true; return { id: 7 }; });
  const removeWindow = vi.fn();
  const update = vi.fn(async (_id: number, properties: { active?: boolean; url?: string }) => {
    operations.push("navigate");
    expect(rules.size).toBe(2);
    url = properties.url ?? url;
    if (properties.active === false) visible = false;
    return { id: 42 };
  });
  const remove = vi.fn(async (id: number) => { operations.push("close-tab"); tabs.delete(id); });
  const updateSessionRules = vi.fn(async (options: { removeRuleIds: number[]; addRules?: BrowserDeclarativeNetRequestRule[] }) => {
    operations.push(options.addRules ? "install-guard" : "remove-guard");
    for (const id of options.removeRuleIds) rules.delete(id);
    for (const rule of options.addRules ?? []) rules.add(rule.id);
  });
  const sendMessage = vi.fn(async (_id: number, message: { type: string }) => {
    if (message.type === "jobctrl.discovery.probe") return { ok: true, status: "discovery_ready" };
    operations.push("snapshot");
    if (url === JOB_URL && !visible) return { status: "failed", errorCode: "navigation_failed", retryable: true, message: "Hidden fixture did not hydrate" };
    return { status: "succeeded", finalUrl: url, statusCode: 200, contentType: "text/html", title: "Role", bodyText: "Visible fixture detail" };
  });
  const browser = {
    tabs: { create, update, remove, sendMessage },
    windows: { create: createWindow, remove: removeWindow },
    declarativeNetRequest: { updateSessionRules },
    webNavigation: { onErrorOccurred: { addListener: vi.fn(), removeListener: vi.fn() } },
  } as unknown as BrowserApi;
  return { browser, tabs, rules, operations, create, createWindow, removeWindow, update, remove, updateSessionRules, sendMessage };
}

afterEach(() => vi.useRealTimers());

describe("LinkedIn unfocused rendering window lifecycle", () => {
  it("hydrates in an active tab without focusing the window and closes only its owned tab", async () => {
    const f = fixture();
    expect(await executeDiscoveryBrowserTask(f.browser, task())).toMatchObject({ status: "succeeded", bodyText: "Visible fixture detail" });
    expect(f.create).toHaveBeenCalledWith({ active: false, url: "about:blank" });
    expect(f.createWindow).toHaveBeenCalledWith({ focused: false, tabId: 42 });
    expect(f.update).toHaveBeenCalledWith(42, { url: JOB_URL });
    expect(f.operations).toEqual(["create-blank", "install-guard", "unfocused-window", "navigate", "snapshot", "close-tab", "remove-guard"]);
    expect(f.tabs).toEqual(new Set([99]));
    expect(f.rules.size).toBe(0);
    expect(f.removeWindow).not.toHaveBeenCalled();
  });

  it.each(["https://careers.example/jobs/1", "https://linkedin.com.example/jobs/1", "https://example.com/linkedin.com/jobs/1", "https://www.linkedin.com/in/profile"])(
    "keeps the inactive-tab path for %s", async (url) => {
      const f = fixture();
      expect(await executeDiscoveryBrowserTask(f.browser, task(url))).toMatchObject({ status: "succeeded" });
      expect(f.createWindow).not.toHaveBeenCalled();
      expect(f.update).toHaveBeenCalledWith(42, { active: false, url });
      expect(f.tabs).toEqual(new Set([99]));
    },
  );

  it("fails window creation without navigation or a transport fallback", async () => {
    const f = fixture();
    f.createWindow.mockRejectedValue(new Error("Chrome refused the window"));
    expect(await executeDiscoveryBrowserTask(f.browser, task())).toMatchObject({ status: "failed", errorCode: "navigation_failed", message: "Chrome refused the window" });
    expect(f.update).not.toHaveBeenCalled();
    expect(f.sendMessage).not.toHaveBeenCalled();
    expect(f.tabs).toEqual(new Set([99]));
    expect(f.rules.size).toBe(0);
  });

  it("does not allocate anything for an already canceled task", async () => {
    const f = fixture();
    const controller = new AbortController(); controller.abort();
    expect(await executeDiscoveryBrowserTask(f.browser, task(), { signal: controller.signal })).toMatchObject({ status: "failed", retryable: true });
    expect(f.create).not.toHaveBeenCalled();
    expect(f.createWindow).not.toHaveBeenCalled();
    expect(f.updateSessionRules).not.toHaveBeenCalled();
  });

  it("closes a tab created after cancellation and never navigates it", async () => {
    const f = fixture(); const controller = new AbortController(); const creating = deferred<BrowserTab>();
    f.create.mockImplementation(() => creating.promise as Promise<{ id: number }>);
    const execution = executeDiscoveryBrowserTask(f.browser, task(), { signal: controller.signal });
    controller.abort();
    expect(await execution).toMatchObject({ status: "failed" });
    expect(f.remove).not.toHaveBeenCalled();
    f.tabs.add(42); creating.resolve({ id: 42 });
    await vi.waitFor(() => expect(f.tabs).toEqual(new Set([99])));
    expect(f.update).not.toHaveBeenCalled();
    expect(f.createWindow).not.toHaveBeenCalled();
  });

  it.each(["cancel", "timeout"])("cleans a late window move after %s without closing user-added tabs", async (ending) => {
    vi.useFakeTimers();
    const f = fixture(); const controller = new AbortController(); const moving = deferred<{ id: number }>();
    f.createWindow.mockImplementation(() => moving.promise);
    const execution = executeDiscoveryBrowserTask(f.browser, task(), { signal: controller.signal });
    await vi.waitFor(() => expect(f.createWindow).toHaveBeenCalledOnce());
    if (ending === "cancel") controller.abort(); else await vi.advanceTimersByTimeAsync(1_000);
    expect(await execution).toMatchObject({ status: "failed", retryable: true });
    expect(f.tabs).toEqual(new Set([99]));
    // Simulate the delayed operation becoming observable after first cleanup.
    f.tabs.add(42); f.tabs.add(100); moving.resolve({ id: 7 });
    await vi.waitFor(() => expect(f.tabs).toEqual(new Set([99, 100])));
    expect(f.update).not.toHaveBeenCalled();
    expect(f.removeWindow).not.toHaveBeenCalled();
    expect(f.rules.size).toBe(0);
  });

  it("removes guard rules installed after cancellation rather than leaving a stale rule pair", async () => {
    const f = fixture(); const controller = new AbortController(); const installing = deferred<void>();
    const updateRules = f.updateSessionRules.getMockImplementation()!;
    f.updateSessionRules.mockImplementation(async (options) => {
      if (options.addRules) await installing.promise;
      await updateRules(options);
    });
    const execution = executeDiscoveryBrowserTask(f.browser, task(), { signal: controller.signal });
    await vi.waitFor(() => expect(f.updateSessionRules).toHaveBeenCalledOnce());
    controller.abort(); expect(await execution).toMatchObject({ status: "failed" });
    installing.resolve();
    await vi.waitFor(() => expect(f.updateSessionRules).toHaveBeenCalledTimes(3));
    expect(f.rules.size).toBe(0);
    expect(f.createWindow).not.toHaveBeenCalled();
    expect(f.update).not.toHaveBeenCalled();
  });

  it("closes the owned tab and guard when a visible capture is canceled", async () => {
    const f = fixture(); const controller = new AbortController();
    f.sendMessage.mockImplementation(() => new Promise(() => undefined));
    const execution = executeDiscoveryBrowserTask(f.browser, task(), { signal: controller.signal });
    await vi.waitFor(() => expect(f.sendMessage).toHaveBeenCalled());
    controller.abort(); expect(await execution).toMatchObject({ status: "failed" });
    expect(f.tabs).toEqual(new Set([99]));
    expect(f.rules.size).toBe(0);
  });
});
