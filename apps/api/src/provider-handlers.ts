import {
  CodexVerifyResultSchema,
  ProviderModelCatalogResultSchema,
  ProviderStatusResultSchema,
  type ProviderModelCatalogItem,
} from "./contracts.js";
import { callRpc, RpcContractError, type JsonRpcDispatcher } from "./json-rpc-adapter.js";
import type { DirectEndpointHandlers } from "./endpoint-routes.js";

/** Provider operations share the checked RPC boundary with Settings catalog validation. */
export function createProviderHandlers(providerDispatcher: JsonRpcDispatcher): Pick<
  DirectEndpointHandlers, "providerStatus" | "providerModels" | "verifyCodexProvider"
> {
  return {
    providerStatus: async (_input, reply) => {
      try {
        const response = await callRpc(providerDispatcher, "provider_status", {});
        if (response.error) {
          void reply.code(502);
          return providerOperationError(
            "provider_status_failed",
            "Provider status is temporarily unavailable.",
          );
        }
        const parsed = ProviderStatusResultSchema.safeParse(response.result);
        if (!parsed.success) {
          void reply.code(502);
          return providerOperationError(
            "provider_status_failed",
            "Provider status returned an invalid response.",
          );
        }
        return { ok: true as const, providers: parsed.data.providers };
      } catch (error) {
        if (error instanceof RpcContractError && error.phase === "result") {
          void reply.code(502);
          return providerOperationError("provider_status_failed", "Provider status returned an invalid response.");
        }
        void reply.code(503);
        return providerOperationError(
          "provider_status_failed",
          "Provider status is temporarily unavailable.",
        );
      }
    },

    providerModels: async (_input, reply) => {
      try {
        const catalog = await dispatchProviderModelCatalog(providerDispatcher);
        return { ok: true as const, providers: catalog.providers };
      } catch {
        void reply.code(503);
        return providerOperationError(
          "provider_models_failed",
          "Provider models are temporarily unavailable.",
        );
      }
    },

    verifyCodexProvider: async (_input, reply) => {
      try {
        const response = await callRpc(providerDispatcher, "provider_verify", {
          provider: "codex",
        });
        if (response.error) {
          void reply.code(502);
          return providerOperationError(
            "provider_verification_failed",
            "Codex verification could not be completed.",
          );
        }
        const parsed = CodexVerifyResultSchema.safeParse(response.result);
        if (!parsed.success) {
          void reply.code(502);
          return providerOperationError(
            "provider_verification_failed",
            "Codex verification returned an invalid response.",
          );
        }
        return { ok: true as const, verification: parsed.data };
      } catch (error) {
        if (error instanceof RpcContractError && error.phase === "result") {
          void reply.code(502);
          return providerOperationError("provider_verification_failed", "Codex verification returned an invalid response.");
        }
        void reply.code(503);
        return providerOperationError(
          "provider_verification_failed",
          "Codex verification is temporarily unavailable.",
        );
      }
    },
  };
}

export function providerOperationError(
  error: "provider_status_failed" | "provider_verification_failed" | "provider_models_failed",
  message: string,
) {
  return { ok: false as const, error, message };
}

export async function dispatchProviderModelCatalog(
  dispatcher: JsonRpcDispatcher,
): Promise<{ providers: ProviderModelCatalogItem[] }> {
  const response = await callRpc(dispatcher, "provider_models", {});
  if (response.error) {
    throw new Error("provider model catalog RPC failed");
  }
  const parsed = ProviderModelCatalogResultSchema.safeParse(response.result);
  if (!parsed.success) {
    throw new Error("provider model catalog RPC returned an invalid response");
  }
  return parsed.data;
}
