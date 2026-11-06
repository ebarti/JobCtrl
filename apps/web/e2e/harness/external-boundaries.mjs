import http from "node:http";

/** Controlled EXTERNAL HTTP boundary. Unexpected calls fail closed. The suite
 * supplies explicit model determinations per journey; this server never matches
 * source text, decides meaning, or loads recorded model output. */
export async function externalBoundaries(token) {
  const pending = [];
  const waiters = [];
  const calls = [];
  const sends = [];
  const inFlight = new Set();
  let catalog = {
    providers: [
      {
        provider: "codex",
        configured: true,
        ready: true,
        models: [
          {
            id: "gpt-6",
            displayName: "gpt-6",
            capabilities: ["structured_json"],
          },
        ],
      },
      {
        provider: "claude",
        configured: true,
        ready: true,
        models: [
          {
            id: "claude-opus-4-8",
            displayName: "claude-opus-4-8",
            capabilities: ["structured_json"],
          },
        ],
      },
      {
        provider: "google",
        configured: true,
        ready: true,
        models: [
          {
            id: "gemini-3.1-pro-preview",
            displayName: "gemini-3.1-pro-preview",
            capabilities: ["structured_json"],
          },
        ],
      },
    ],
  };
  let closed = false;
  const server = http.createServer(async (request, response) => {
    try {
      if (request.headers.authorization !== `Bearer ${token}`) {
        response.writeHead(401);
        response.end();
        return;
      }
      const parts = [];
      let bytes = 0;
      for await (const part of request) {
        bytes += part.length;
        if (bytes > 2_000_000)
          throw new Error("External request exceeds the fixture bound");
        parts.push(part);
      }
      const body = Buffer.concat(parts).toString("utf8");
      const call = {
        method: request.method,
        path: request.url,
        body: body ? JSON.parse(body) : null,
        headers: Object.fromEntries(
          Object.entries(request.headers).filter(
            ([key]) => key !== "authorization" && key !== "x-jobctrl-e2e-token",
          ),
        ),
      };
      calls.push(call);
      if (request.url === "/catalog") {
        if (call.body?.operation !== "providers.catalog")
          throw new Error("Unexpected external catalog request");
        response.writeHead(200, {
          "Content-Type": "application/json",
          "Cache-Control": "no-store",
        });
        response.end(JSON.stringify(catalog));
        return;
      }
      if (request.url?.endsWith("/messages/send")) sends.push(call);
      const item = {
        ...call,
        respond(value, status = 200) {
          response.writeHead(status, {
            "Content-Type": "application/json",
            "Cache-Control": "no-store",
          });
          response.end(JSON.stringify(value));
        },
        disconnect() {
          response.destroy();
        },
        invalidJson() {
          response.writeHead(200, { "Content-Type": "application/json" });
          response.end("{invalid");
        },
        reply(value) {
          this.respond({
            value,
            usage: { input_tokens: 20, output_tokens: 10, cost_usd: 0.0001 },
          });
        },
        raw(
          body,
          {
            status = 200,
            headers = { "Content-Type": "text/html; charset=utf-8" },
          } = {},
        ) {
          response.writeHead(status, {
            "Cache-Control": "no-store",
            ...headers,
          });
          response.end(body);
        },
      };
      inFlight.add(item);
      response.once("close", () => {
        item.closed = true;
        inFlight.delete(item);
      });
      if (waiters.length) waiters.shift().resolve(item);
      else pending.push(item);
    } catch (error) {
      response.writeHead(400, { "Content-Type": "application/json" });
      response.end(
        JSON.stringify({
          error: "invalid_synthetic_external_request",
          message: error.message,
        }),
      );
    }
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  return {
    url: `http://127.0.0.1:${address.port}`,
    calls,
    sends,
    setCatalog(value) {
      catalog = value;
    },
    async next({ timeout = 15_000 } = {}) {
      if (closed) throw new Error("External boundary is closed");
      if (pending.length) return pending.shift();
      return new Promise((resolve, reject) => {
        const waiter = {
          resolve(value) {
            clearTimeout(timer);
            resolve(value);
          },
        };
        const timer = setTimeout(() => {
          waiters.splice(waiters.indexOf(waiter), 1);
          reject(
            new Error(
              `No external request arrived within ${timeout}ms; observed ${calls.length} calls`,
            ),
          );
        }, timeout);
        waiters.push(waiter);
      });
    },
    async close() {
      closed = true;
      for (const item of pending.splice(0))
        item.respond({ error: "unhandled_external_request" }, 500);
      server.closeAllConnections();
      await new Promise((resolve) => server.close(resolve));
    },
    assertDrained() {
      const live = [...inFlight].filter((item) => !item.closed);
      if (live.length)
        throw new Error(
          `${live.length} unexpected external request(s): ${live.map((item) => item.path).join(", ")}`,
        );
    },
  };
}
