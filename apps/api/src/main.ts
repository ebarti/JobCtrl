import { resolveApiConfig } from "./config.js";
import {
  e2eStubActionDispatcher,
  e2eStubProfileImporter,
  isE2eStubDispatchEnabled,
} from "./e2e-dispatch.js";
import { buildApp } from "./server.js";

const config = resolveApiConfig();
// INSPECT-01 E2E: when running under the Playwright harness, swap the real
// JSON-RPC subprocess dispatcher for a deterministic stub (no worker, no LLM)
// while keeping the worker-readiness gate live so the seeded heartbeat is still
// exercised. Disabled in all normal/production runs.
const stubDispatch = isE2eStubDispatchEnabled();
const app = buildApp({
  ...config,
  logger: true,
  ...(stubDispatch
    ? {
        actionDispatcher: e2eStubActionDispatcher,
        profileImporter: e2eStubProfileImporter,
        requireHealthyWorkerForActions: true,
      }
    : {}),
});

try {
  await app.listen({ host: config.host, port: config.port });
  app.log.info(`JobCtl API listening on http://${config.host}:${config.port}`);
} catch (error) {
  app.log.error(error);
  process.exitCode = 1;
}
