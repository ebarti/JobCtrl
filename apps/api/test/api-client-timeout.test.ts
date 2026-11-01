import { createServer, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";

import { JobCtrlApiClient, JobCtrlApiError, JobCtrlApiTimeoutError, JobCtrlApiUnconfirmedWriteError } from "@jobctrl/api-client";
import { afterEach, describe, expect, it, vi } from "vitest";

const servers: Server[] = [];

async function serve(handler: (response: ServerResponse) => void): Promise<JobCtrlApiClient> {
  const server = createServer((_request, response) => handler(response));
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return new JobCtrlApiClient(`http://127.0.0.1:${(server.address() as AddressInfo).port}`, 250);
}

afterEach(async () => {
  vi.restoreAllMocks();
  for (const server of servers.splice(0)) {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

describe("API request deadline", () => {
  it("times out when headers never arrive", async () => {
    const client = await serve(() => {});
    await expect(client.health()).rejects.toMatchObject({
      name: "JobCtrlApiTimeoutError", method: "GET", writeOutcomeUnknown: false,
    });
  });

  it.each([200, 503])("aborts a stalled response body after %s headers", async (status) => {
    let closed!: () => void;
    const closedPromise = new Promise<void>((resolve) => { closed = resolve; });
    const client = await serve((response) => {
      response.on("close", closed);
      response.writeHead(status, { "content-type": "application/json" });
      response.write('{"message":');
    });
    let headers!: () => void;
    const headersPromise = new Promise<void>((resolve) => { headers = resolve; });
    const realFetch = globalThis.fetch;
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
      const response = await realFetch(input, init);
      headers();
      return response;
    });
    const result = client.reviseOutreachDraft("synthetic-thread", { editedBodyText: "Synthetic edit" })
      .then(() => null, (error: unknown) => error);
    await headersPromise;
    expect(await result).toBeInstanceOf(JobCtrlApiTimeoutError);
    expect(await result).toMatchObject({ method: "POST", writeOutcomeUnknown: true });
    await closedPromise;
  });

  it("settles at the deadline when a synthetic body ignores abort", async () => {
    let closeBody!: () => void;
    const body = new ReadableStream<Uint8Array>({
      start(controller) { closeBody = () => controller.close(); },
    });
    let requestSignal: AbortSignal | undefined;
    vi.spyOn(globalThis, "fetch").mockImplementation(async (_input, init) => {
      requestSignal = init?.signal ?? undefined;
      return new Response(body, { status: 200 });
    });
    const client = new JobCtrlApiClient("http://synthetic.invalid", 20);
    try {
      await expect(client.health()).rejects.toBeInstanceOf(JobCtrlApiTimeoutError);
      expect(requestSignal?.aborted).toBe(true);
    } finally {
      closeBody();
    }
  });

  it("cancels a late response that arrives after the deadline", async () => {
    let reply!: (response: Response) => void;
    let canceled = 0;
    vi.spyOn(globalThis, "fetch").mockImplementation(() => new Promise<Response>((resolve) => { reply = resolve; }));
    const client = new JobCtrlApiClient("http://synthetic.invalid", 20);
    await expect(client.health()).rejects.toBeInstanceOf(JobCtrlApiTimeoutError);
    reply(new Response(new ReadableStream({ cancel() { canceled += 1; } }), { status: 200 }));
    await vi.waitFor(() => expect(canceled).toBe(1));
  });

  it.each([200, 503])("reports an unconfirmed write when a %s response body is truncated", async (status) => {
    const client = await serve((response) => {
      response.writeHead(status, { "content-type": "application/json" });
      response.write('{"message":');
      setTimeout(() => response.destroy(), 40);
    });
    let headers!: () => void;
    const headersPromise = new Promise<void>((resolve) => { headers = resolve; });
    const realFetch = globalThis.fetch;
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
      const response = await realFetch(input, init);
      headers();
      return response;
    });
    const result = client.reviseOutreachDraft("synthetic-thread", { editedBodyText: "Synthetic edit" })
      .then(() => null, (error: unknown) => error);
    await headersPromise;
    expect(await result).toBeInstanceOf(JobCtrlApiUnconfirmedWriteError);
    expect(await result).toMatchObject({ method: "POST", writeOutcomeUnknown: true });
  });

  it("preserves completed HTTP errors and classifies malformed success acknowledgements as unconfirmed", async () => {
    let count = 0;
    const client = await serve((response) => {
      count += 1;
      response.writeHead(count === 1 ? 200 : 409, { "content-type": "application/json" });
      response.end(count === 1 ? "invalid acknowledgement" : count === 2 ? JSON.stringify({ message: "Synthetic conflict" }) : "null");
    });
    const write = () => client.reviseOutreachDraft("synthetic-thread", { editedBodyText: "Synthetic edit" });
    await expect(write()).rejects.toBeInstanceOf(JobCtrlApiUnconfirmedWriteError);
    await expect(write()).rejects.toMatchObject({ name: "JobCtrlApiError", status: 409, message: "Synthetic conflict" });
    await expect(write()).rejects.toMatchObject({ name: "JobCtrlApiError", status: 409, responseBody: null });
  });

  it.each([400, 409, 500, 502, 503])("keeps status %s typed and marks only server errors on writes unconfirmed", async (status) => {
    const client = await serve((response) => {
      response.writeHead(status, { "content-type": "application/json" });
      response.end(JSON.stringify({ error: "synthetic_error", message: "Synthetic failure" }));
    });
    const writeError = await client.reviseOutreachDraft("synthetic-thread", { editedBodyText: "Synthetic edit" })
      .then(() => null, (reason: unknown) => reason);
    expect(writeError).toBeInstanceOf(JobCtrlApiError);
    expect(writeError).toMatchObject({ status, responseBody: { error: "synthetic_error" }, writeOutcomeUnknown: status >= 500 });
    const readError = await client.health().then(() => null, (reason: unknown) => reason);
    expect(readError).toMatchObject({ status, writeOutcomeUnknown: false });
  });

  it("preserves read network errors while marking a dropped write unconfirmed", async () => {
    const failure = new TypeError("Synthetic disconnected transport");
    vi.spyOn(globalThis, "fetch").mockRejectedValue(failure);
    const client = new JobCtrlApiClient("http://synthetic.invalid", 250);
    await expect(client.health()).rejects.toBe(failure);
    const error = await client.reviseOutreachDraft("synthetic-thread", { editedBodyText: "Synthetic edit" })
      .then(() => null, (reason: unknown) => reason);
    expect(error).toBeInstanceOf(JobCtrlApiUnconfirmedWriteError);
    expect(error).toMatchObject({ cause: failure, method: "POST", writeOutcomeUnknown: true });
  });

  it("retains ordinary success and structured or non-JSON error responses", async () => {
    let count = 0;
    const client = await serve((response) => {
      count += 1;
      if (count === 1) {
        response.writeHead(200, { "content-type": "application/json" });
        response.end(JSON.stringify({ ok: true, marker: "synthetic" }));
      } else if (count === 2) {
        response.writeHead(409, { "content-type": "application/json" });
        response.end(JSON.stringify({ message: "Synthetic conflict", current: 2 }));
      } else {
        response.writeHead(503, "Unavailable");
        response.end("not json");
      }
    });
    await expect(client.health()).resolves.toMatchObject({ ok: true, marker: "synthetic" });
    await expect(client.health()).rejects.toMatchObject({
      name: "JobCtrlApiError", status: 409, message: "Synthetic conflict", responseBody: { current: 2 },
    });
    const error = await client.health().then(() => null, (reason: unknown) => reason);
    expect(error).toBeInstanceOf(JobCtrlApiError);
    expect(error).toMatchObject({ status: 503, message: "JobCtrl API request failed: 503 Unavailable" });
  });

  it("cleans up the deadline after success and a completed error body", async () => {
    vi.useFakeTimers();
    const startTimer = vi.spyOn(globalThis, "setTimeout");
    const clearTimer = vi.spyOn(globalThis, "clearTimeout");
    const signals: AbortSignal[] = [];
    let calls = 0;
    vi.spyOn(globalThis, "fetch").mockImplementation(async (_input, init) => {
      signals.push(init!.signal as AbortSignal);
      calls += 1;
      return new Response(JSON.stringify(calls === 1 ? { ok: true } : { message: "Synthetic error" }),
        { status: calls === 1 ? 200 : 400 });
    });
    try {
      const client = new JobCtrlApiClient("http://synthetic.invalid", 50);
      await client.health();
      await expect(client.health()).rejects.toBeInstanceOf(JobCtrlApiError);
      await vi.advanceTimersByTimeAsync(100);
      expect(signals.map((signal) => signal.aborted)).toEqual([false, false]);
      const deadlines = startTimer.mock.calls.flatMap((args, index) =>
        args[1] === 50 ? [startTimer.mock.results[index]?.value] : [],
      );
      expect(deadlines).toHaveLength(2);
      expect(deadlines.every((deadline) => clearTimer.mock.calls.some(([handle]) => handle === deadline))).toBe(true);
    } finally {
      startTimer.mockRestore();
      clearTimer.mockRestore();
      vi.useRealTimers();
    }
  });
});
