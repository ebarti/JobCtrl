import type { Browser } from "@playwright/test";

export async function sharedEventStreamTargets(browser: Browser, origin: string) {
  const session = await browser.newBrowserCDPSession();
  try {
    const { targetInfos } = await session.send("Target.getTargets");
    return targetInfos.filter((target) => target.type === "shared_worker"
      && target.url.startsWith(`${origin}/`) && target.url.includes("SseEventStreamWorker"));
  } finally { await session.detach(); }
}

async function sharedWorkerInspector(browser: Browser, targetId: string) {
  const session = await browser.newBrowserCDPSession();
  let sessionId: string;
  try { sessionId = (await session.send("Target.attachToTarget", { targetId, flatten: false })).sessionId; }
  catch (error) { await session.detach(); throw error; }
  let sequence = 0;
  const command = (method: string, params: Record<string, unknown> = {}): Promise<Record<string, unknown>> => new Promise((resolve, reject) => {
    const id = ++sequence;
    const finish = (error: Error | null, result: Record<string, unknown> = {}) => {
      clearTimeout(timeout);
      session.off("Target.receivedMessageFromTarget", receive);
      if (error) reject(error); else resolve(result);
    };
    const receive = (event: { sessionId: string; message: string }) => {
      if (event.sessionId !== sessionId) return;
      const response = JSON.parse(event.message) as { id?: number; error?: { message?: string }; result?: Record<string, unknown> };
      if (response.id !== id) return;
      finish(response.error ? new Error(response.error.message ?? "Worker inspection failed.") : null, response.result);
    };
    const timeout = setTimeout(() => finish(new Error(`Worker inspection timed out: ${method}.`)), 5_000);
    session.on("Target.receivedMessageFromTarget", receive);
    void session.send("Target.sendMessageToTarget", { sessionId, message: JSON.stringify({ id, method, params }) })
      .catch((error: unknown) => finish(error instanceof Error ? error : new Error("Worker inspection failed.")));
  });
  let closed = false;
  return {
    command,
    onEvent(handler: (method: string, params: Record<string, unknown>) => void) {
      const receive = (event: { sessionId: string; message: string }) => {
        if (event.sessionId !== sessionId) return;
        const packet = JSON.parse(event.message) as { method?: string; params?: Record<string, unknown> };
        if (packet.method) handler(packet.method, packet.params ?? {});
      };
      session.on("Target.receivedMessageFromTarget", receive);
      return () => session.off("Target.receivedMessageFromTarget", receive);
    },
    async close() {
      if (closed) return;
      closed = true;
      await session.send("Target.detachFromTarget", { sessionId }).catch(() => undefined);
      await session.detach();
    },
  };
}

/** Observe the actual worker network stream without replacing EventSource or its frames. */
export async function observeSharedWorkerEventSource(browser: Browser, targetId: string, onFrame: (data: string) => void): Promise<() => Promise<void>> {
  const inspector = await sharedWorkerInspector(browser, targetId);
  const off = inspector.onEvent((method, params) => {
    if (method === "Network.eventSourceMessageReceived" && typeof params["data"] === "string") onFrame(params["data"]);
  });
  try { await inspector.command("Network.enable"); }
  catch (error) { off(); await inspector.close(); throw error; }
  return async () => { off(); await inspector.close(); };
}

/** Observe native platform objects in the real worker; no browser primitive is replaced. */
export async function sharedWorkerEventSources(browser: Browser, targetId: string): Promise<{ url: string; readyState: number }[]> {
  const inspector = await sharedWorkerInspector(browser, targetId);
  const { command } = inspector;
  try {
    const prototype = await command("Runtime.evaluate", { expression: "EventSource.prototype", objectGroup: "jobctrl-e2e-event-sources" }) as { result?: { objectId?: string } };
    if (!prototype.result?.objectId) throw new Error("The shared worker has no native EventSource prototype.");
    const objects = await command("Runtime.queryObjects", { prototypeObjectId: prototype.result.objectId, objectGroup: "jobctrl-e2e-event-sources" }) as { objects?: { objectId?: string } };
    if (!objects.objects?.objectId) throw new Error("The browser did not return EventSource objects.");
    const snapshot = await command("Runtime.callFunctionOn", {
      objectId: objects.objects.objectId,
      functionDeclaration: "function () { return this.filter(source => source.readyState !== EventSource.CLOSED).map(source => ({ url: source.url, readyState: source.readyState })); }",
      returnByValue: true,
    }) as { result?: { value?: unknown } };
    const value = snapshot.result?.value;
    if (!Array.isArray(value) || value.some((item: unknown) => !item || typeof item !== "object"
      || !("url" in item) || typeof item.url !== "string" || !("readyState" in item) || typeof item.readyState !== "number")) {
      throw new Error("The browser returned an invalid EventSource observation.");
    }
    await command("Runtime.releaseObjectGroup", { objectGroup: "jobctrl-e2e-event-sources" });
    return value as { url: string; readyState: number }[];
  } finally { await inspector.close(); }
}
