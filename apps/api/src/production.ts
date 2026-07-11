import { resolveProductionApiConfig } from "./config.js";
import { createBundledPythonRuntime } from "./python-runtime.js";
import { buildApp } from "./server.js";

const config = resolveProductionApiConfig();
// In bundled mode the first-party web origin is the API origin itself. Keep the
// existing mutation-origin guard authoritative by registering that port before
// requests are handled.
process.env.JOBCTRL_WEB_PORT = String(config.port);
const pythonRuntime = createBundledPythonRuntime({
  executable: config.pythonExecutable,
  environment: process.env,
  payloadDir: config.payloadDir,
});
const app = buildApp({
  ...config,
  logger: true,
  pythonRuntime,
  webAssetsDir: config.webAssetsDir,
});

try {
  await app.listen({ host: config.host, port: config.port });
  app.log.info(`JobCtrl listening on http://${config.host}:${config.port}`);
} catch (error) {
  app.log.error(error);
  process.exitCode = 1;
}
