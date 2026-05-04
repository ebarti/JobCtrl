import { resolveApiConfig } from "./config.js";
import { buildApp } from "./server.js";

const config = resolveApiConfig();
const app = buildApp({ ...config, logger: true });

try {
  await app.listen({ host: config.host, port: config.port });
  app.log.info(`JobHunter API listening on http://${config.host}:${config.port}`);
} catch (error) {
  app.log.error(error);
  process.exitCode = 1;
}
