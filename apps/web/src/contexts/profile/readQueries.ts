import { profileKeys } from "./queryKeys.js";
import type { HttpReadContext, HttpLoaderReadContext } from "../../shared/lib/loaderReadContext.js";
import { readProfile } from "./client.js";

export function profileQuery(context: HttpReadContext) {
  return {
    queryKey: profileKeys.profile(context.tenantId),
    queryFn: () => readProfile(context.ports.http),
  };
}
export function prefetchProfile(context: HttpLoaderReadContext) {
  return context.queryClient.prefetchQuery(profileQuery(context));
}

export function prefetchProfileEditor(
  context: HttpLoaderReadContext,
) {
  return prefetchProfile(context);
}
