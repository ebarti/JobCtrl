// Test-only process entry point. Assert ownership before importing/building the
// API: buildApp normalizes its database immediately, before listen hooks run.
import { createRequire } from "node:module";
import { BrowserCapabilityIds } from "@jobctrl/contracts";
import type { CredentialStore } from "../src/credentials.js";
import type { JsonRpcDispatcher } from "../src/json-rpc-adapter.js";

const { assertIsolatedE2eWorkspace, assertExpectedWorkspace } = createRequire(import.meta.url)(
  "../../web/e2e/fixtures/isolated-workspace.cjs",
) as { assertIsolatedE2eWorkspace(): Promise<string>; assertExpectedWorkspace(workspace: unknown): void };
await assertIsolatedE2eWorkspace();
const { resolveApiConfig } = await import("../src/config.js");
const { buildApp } = await import("../src/server.js");
const { e2eStubActionDispatcher, e2eStubProfileImporter } =
  await import("../src/e2e-dispatch.js");
const { e2eProfilePreviewRenderer } = await import("./fixtures/e2e-profile-preview.js");
const config = resolveApiConfig();
const unavailable = async () => {
  throw new Error("Operation is outside the isolated E2E fixture");
};
const providerDispatcher: JsonRpcDispatcher = {
  call: async (method) =>
    method === "browser_capabilities_list"
      ? {
          jsonrpc: "2.0",
          id: 1,
          result: {
            capabilities: BrowserCapabilityIds.map((id) => ({
              id,
              status: "disabled",
              detail: "Synthetic E2E capability",
              mutable: false,
              enabled: false,
              profileCopyReady: false,
            })),
            detectedBrowsers: [],
          },
        }
      : {
          jsonrpc: "2.0",
          id: 1,
          error: {
            code: -32601,
            message: "Method is outside the isolated E2E fixture",
          },
        },
  close: async () => {},
};
const credentialStore: CredentialStore = {
  list: async () => ({
    ok: true,
    store: {
      kind: "config_and_macos_keychain",
      available: false,
      unavailableReason: "unsupported_platform",
      requiresWorkerRestart: true,
    },
    credentials: [],
  }),
  set: unavailable,
  delete: unavailable,
  applyBatch: unavailable,
};
const app = buildApp({
  ...config,
  providerDispatcher,
  credentialStore,
  pythonRuntime: {
    id: "isolated-e2e-deny-subprocess",
    resolve: () => {
      throw new Error("Subprocess is outside the isolated E2E fixture");
    },
  },
  actionDispatcher: e2eStubActionDispatcher,
  profileImporter: e2eStubProfileImporter,
  profilePreviewRenderer: async (input, context) => {
    await assertIsolatedE2eWorkspace();
    assertExpectedWorkspace(context);
    return e2eProfilePreviewRenderer(input, context);
  },
  artifactOpener: unavailable,
  jobUrlValidator: unavailable,
  placeValidator: unavailable,
  requireHealthyWorkerForActions: true,
});
await assertIsolatedE2eWorkspace();
await app.listen({ host: config.host, port: config.port });
for (const signal of ["SIGTERM", "SIGINT"] as const)
  process.once(signal, () => {
    void app.close();
  });
