import { MaterialLocaleHistorySchema, MaterialLocaleParamsSchema, RpcMethods, type MaterialLocaleRequest } from "./contracts.js";
import type { JsonRpcDispatcher } from "./json-rpc-adapter.js";

export class LocaleVariantError extends Error {
  constructor(readonly code: string, readonly status: number) { super(code); }
}

export async function materialLocaleVariants(
  dispatcher: JsonRpcDispatcher,
  context: { tenantId: string; expectedAppDir: string; expectedDbPath: string; jobId: string },
  request: MaterialLocaleRequest,
) {
  const params = MaterialLocaleParamsSchema.parse({ ...context, request });
  let response;
  try { response = await dispatcher.call(RpcMethods.MaterialLocaleVariants, params); }
  catch { throw new LocaleVariantError("locale_worker_unavailable", 503); }
  if (response.error) {
    const code = response.error.message;
    const status = code.startsWith("stale_") ? 409 : code === "job_not_found" ? 404
      : code === "provider_unavailable" ? 503 : code === "budget_denied" ? 429
      : response.error.code === -32602 ? 400 : 503;
    throw new LocaleVariantError(code, status);
  }
  const result = MaterialLocaleHistorySchema.safeParse(response.result);
  if (!result.success) throw new LocaleVariantError("invalid_locale_worker_result", 503);
  if (result.data.variants.some(row => row.jobId !== context.jobId || row.tenantId !== context.tenantId)) {
    throw new LocaleVariantError("invalid_locale_worker_binding", 503);
  }
  if (request.operation === "generate" && !result.data.variants.some(row =>
    row.source.artifactId === request.sourceArtifactId && row.source.generation === request.expectedGeneration && row.profileVersion === request.expectedProfileVersion && row.sourceLocale === request.sourceLocale && row.targetLocale === request.targetLocale)) {
    throw new LocaleVariantError("invalid_locale_worker_binding", 503);
  }
  if (request.operation !== "history" && request.operation !== "generate" && !result.data.variants.some(row => row.revisionId === request.revisionId && row.version === request.expectedVersion + 1)) {
    throw new LocaleVariantError("invalid_locale_worker_binding", 503);
  }
  return result.data;
}
