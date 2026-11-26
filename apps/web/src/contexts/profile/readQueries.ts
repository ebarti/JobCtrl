import { profileKeys } from "./queryKeys.js";
import type { HttpReadContext, HttpLoaderReadContext } from "../../shared/lib/loaderReadContext.js";
import { readProfile } from "./client.js";
import { requestWorkspace } from "../../shared/lib/useSessionRequestIdentity.js";

export function profileQuery(context: HttpReadContext) {
  return {
    queryKey: profileKeys.profile(context.tenantId),
    queryFn: async () => {
      const { databaseInstanceId } = await requestWorkspace(context.ports.http);
      return readProfile(context.ports.http, databaseInstanceId);
    },
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
