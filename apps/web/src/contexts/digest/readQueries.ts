import type { HttpLoaderReadContext, HttpReadContext } from "../../shared/lib/loaderReadContext.js";
import { DigestSchema } from "./contracts.js";
import { digestKeys } from "./queryKeys.js";

export function digestQuery(context: HttpReadContext) {
  return { queryKey: digestKeys.summary(context.tenantId),
    queryFn: async () => DigestSchema.parse(await context.ports.http.json<unknown>("GET", "/v1/digest")) };
}
export function prefetchDigest(context: HttpLoaderReadContext) {
  return context.queryClient.prefetchQuery(digestQuery(context));
}
