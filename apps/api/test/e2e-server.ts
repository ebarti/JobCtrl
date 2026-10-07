// Test-only process entry point. Assert ownership before importing/building the
// API: buildApp normalizes its database immediately, before listen hooks run.
import { createRequire } from "node:module";
import { BrowserCapabilityIds, RpcMethods } from "@jobctrl/contracts";
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
const modelProfileSuggestions = process.env["JOBCTRL_E2E_PROFILE_SUGGESTIONS"] === "1";
const { default: Database } = await import("better-sqlite3");
const { recordCandidateProposal, recordModelDecision, bindDecision } = await import("./semantic-fixtures.js");
const unavailable = async () => {
  throw new Error("Operation is outside the isolated E2E fixture");
};
const providerDispatcher: JsonRpcDispatcher = {
  call: async (method, params) =>
    method === RpcMethods.ProfileRequiredBulletSuggestions
      ? (() => {
          // Chosen model findings exercise the same persisted authority contract
          // as the worker, without judging the fixture's language.
          const source = (params.sources as Array<{ reference: string; originalText: string }>)[0]!;
          const citations = [{source_id: source.reference, quote: source.originalText, exact_values: []}];
          const result = {suggestions: [
            {reference: source.reference, kind: "grammar", guidance: "Review the repeated spacing in the incident response bullet.", proposedText: "Helped with incident response", citations},
            {reference: source.reference, kind: "missing_evidence", guidance: "Which saved incident report supports the incident response claim?", proposedText: null, citations},
          ], citations, rationale: "Chosen model findings"};
          const db = new Database(config.dbPath);
          try {
            const id = recordModelDecision(db, "required_bullet_coaching", "profile:required_bullets", result);
            bindDecision(db, "profile_coaching", "profile:required_bullets", String(params.expectedProfileVersion), "required_bullet_coaching", id);
            const row = db.prepare("SELECT envelope_json FROM semantic_determinations WHERE tenant_id='local' AND determination_id=?").get(id) as {envelope_json: string};
            return {jsonrpc: "2.0", id: 1, result: {...result, profileVersion: params.expectedProfileVersion, determination: JSON.parse(row.envelope_json)}};
          } finally {db.close();}
        })()
      : method === RpcMethods.ProfileTargetRoleSuggestions && modelProfileSuggestions
      ? (() => {
          const db = new Database(config.dbPath);
          try {
            return {jsonrpc:"2.0",id:1,result:recordCandidateProposal(db,params,[
              {title:"Model proposal A",classification:"direct",track:"management",seniority:"manager"},
              {title:"Model proposal B",classification:"adjacent",track:"ic",seniority:"staff"},
              {title:"Model proposal C",classification:"adjacent",track:"executive",seniority:"c_level"},
            ])};
          } finally { db.close(); }
        })()
      : method === "browser_capabilities_list"
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
      kind: "config_and_native_credential_store",
      nativeStore: "macos_keychain" as const,
      maxSecretBytes: 128,
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
  placeValidator: modelProfileSuggestions
    ? async (place) => ["Barcelona", "London"].includes(place)
    : unavailable,
  requireHealthyWorkerForActions: true,
});
await assertIsolatedE2eWorkspace();
await app.listen({ host: config.host, port: config.port });
for (const signal of ["SIGTERM", "SIGINT"] as const)
  process.once(signal, () => {
    void app.close();
  });
