// Owned synthetic HTTP process used by action-retry.test.ts; no worker or send transport.
import path from "node:path";
import { buildApp } from "../src/server.js";

const dbPath = process.argv[2]!;
const app = buildApp({ dbPath, configPath: path.join(path.dirname(dbPath), "config.json") });
app.addHook("preHandler", async (request) => {
  if (request.method === "POST" && (request.url.endsWith("/outcomes") || request.url.endsWith("/send-logs"))) {
    process.send?.({ stage: "mutation-entered", requestId: (request.body as { requestId?: string })?.requestId });
  }
});
await app.listen({ host: "127.0.0.1", port: 0 });
const address = app.server.address();
if (!address || typeof address === "string") throw new Error("Owned TCP address missing");
process.send?.({ url: `http://127.0.0.1:${address.port}` });
process.on("SIGTERM", () => { app.server.closeAllConnections(); void app.close().then(() => process.exit(0)); });
