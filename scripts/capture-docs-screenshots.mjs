import { spawn } from "node:child_process";
import net from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";
import docsScreenshotWorkspace from "../apps/web/e2e/fixtures/docs-screenshot-workspace.cjs";
import { createDocsScreenshotEnvironment } from "./docs-screenshot-environment.mjs";

const repoRoot = path.resolve(fileURLToPath(new URL("../", import.meta.url)));
const { createOwnedDocsScreenshotDirectory } = docsScreenshotWorkspace;

function parsePort(name, value) {
  if (value === undefined) return null;
  const port = Number(value);
  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    throw new Error(`${name} must be an integer from 1 to 65535.`);
  }
  return port;
}

async function findAvailablePort() {
  return await new Promise((resolve, reject) => {
    const server = net.createServer();
    server.unref();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") {
        server.close();
        reject(new Error("Unable to allocate an isolated documentation port."));
        return;
      }
      const port = address.port;
      server.close((error) => (error ? reject(error) : resolve(port)));
    });
  });
}

async function run() {
  const suppliedAppDir = process.env.JOBCTRL_E2E_APP_DIR;
  const appDir = await createOwnedDocsScreenshotDirectory(suppliedAppDir);
  const apiPort =
    parsePort("JOBCTRL_E2E_API_PORT", process.env.JOBCTRL_E2E_API_PORT) ??
    (await findAvailablePort());
  const webPort =
    parsePort("JOBCTRL_E2E_WEB_PORT", process.env.JOBCTRL_E2E_WEB_PORT) ??
    (await findAvailablePort());
  if (apiPort === webPort) {
    throw new Error("Documentation API and web ports must be different.");
  }

  const child = spawn(
    "corepack",
    [
      "pnpm",
      "--filter",
      "@jobctrl/web",
      "e2e",
      "--",
      "tests/docs-screenshots.spec.ts",
    ],
    {
      cwd: repoRoot,
      env: createDocsScreenshotEnvironment({ appDir, apiPort, webPort }),
      stdio: "inherit",
    },
  );

  const exitCode = await new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", (code, signal) => {
      if (signal) {
        reject(
          new Error(`Documentation screenshot runner exited on ${signal}.`),
        );
        return;
      }
      resolve(code ?? 1);
    });
  });
  if (exitCode !== 0) process.exitCode = exitCode;
}

await run();
