// Owned synthetic HTTP process; resets use registered RPC handlers without workflows or sending.
import path from "node:path";
import { buildApp } from "../src/server.js";
import { createRetryFixturePythonRuntime } from "./retry-rpc-runtime.js";

const dbPath = process.argv[2]!;
const app = buildApp({ pythonRuntime: createRetryFixturePythonRuntime(), dbPath, configPath: path.join(path.dirname(dbPath), "config.json") });
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
