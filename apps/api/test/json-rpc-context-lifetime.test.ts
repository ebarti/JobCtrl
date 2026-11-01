import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, expect, it } from "vitest";

import { getDefaultJsonRpcDispatcher, resetDefaultJsonRpcDispatcher } from "../src/json-rpc-adapter.js";
import type { PythonRuntimeCommandResolver } from "../src/python-runtime.js";
import { providerModelsResult } from "./provider-fixture.js";

const directories: string[] = [];

afterEach(() => {
  resetDefaultJsonRpcDispatcher();
  for (const directory of directories.splice(0)) fs.rmSync(directory, { recursive: true, force: true });
});

it("keeps provider calls alive when imports select a different RPC context", async () => {
  const appDir = fs.mkdtempSync(path.join(os.tmpdir(), "jobctrl-rpc-context-"));
  directories.push(appDir);
  const pythonRuntime: PythonRuntimeCommandResolver = {
    id: "owned-context-lifetime-probe",
    resolve: () => ({
      executable: process.execPath,
      argv: ["-e", `
        const readline = require("node:readline");
        readline.createInterface({ input: process.stdin }).on("line", line => {
          const request = JSON.parse(line);
          setTimeout(() => process.stdout.write(JSON.stringify({
            jsonrpc: "2.0", id: request.id, result: ${JSON.stringify(providerModelsResult)}
          }) + "\\n"), 25);
        });
      `],
      cwd: appDir,
      env: process.env,
    }),
  };
  const providers = getDefaultJsonRpcDispatcher({ appDir, configPath: path.join(appDir, "config.json"), pythonRuntime });
  const inFlight = providers.call("provider_models", {});
  const imports = getDefaultJsonRpcDispatcher({ appDir, pythonRuntime });

  await expect(inFlight).resolves.toMatchObject({ result: providerModelsResult });
  await expect(imports.call("provider_models", {})).resolves.toMatchObject({ result: providerModelsResult });
  await expect(providers.call("provider_models", {})).resolves.toMatchObject({ result: providerModelsResult });

  resetDefaultJsonRpcDispatcher();
  await expect(imports.call("provider_models", {})).rejects.toThrow("closed");
  await expect(providers.call("provider_models", {})).rejects.toThrow("closed");
});
