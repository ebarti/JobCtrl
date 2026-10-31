// Test-only server for the owned pipeline occupancy E2E workspace.
import { createRequire } from "node:module";

const { assertIsolatedE2eWorkspace } = createRequire(import.meta.url)(
  "../../web/e2e/fixtures/isolated-workspace.cjs",
) as { assertIsolatedE2eWorkspace(): string };
assertIsolatedE2eWorkspace();

const { resolveApiConfig } = await import("../src/config.js");
const { buildApp } = await import("../src/server.js");
const unavailable = async (): Promise<never> => { throw new Error("Unavailable in synthetic occupancy QA"); };
const config = resolveApiConfig();
const app = buildApp({
  ...config,
  credentialStore: { list: unavailable, set: unavailable, delete: unavailable, applyBatch: unavailable },
  providerDispatcher: { call: unavailable, close: async () => {} },
  actionDispatcher: unavailable,
  artifactOpener: unavailable,
  jobUrlValidator: unavailable,
  placeValidator: unavailable,
  pythonRuntime: { id: "synthetic-occupancy-deny-subprocess", resolve: () => { throw new Error("Subprocess denied"); } },
});
assertIsolatedE2eWorkspace();
const address = await app.listen({ host: "127.0.0.1", port: 0 });
process.stdout.write(`${JSON.stringify({ address, dbPath: config.dbPath })}\n`);
process.stdin.resume();
for (const signal of ["SIGTERM", "SIGINT"] as const) {
  process.once(signal, () => {
    void app.close().catch(() => { process.exitCode = 1; }).finally(() => process.stdin.pause());
  });
}
