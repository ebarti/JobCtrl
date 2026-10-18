import { profileKeys } from "./queryKeys.js";
import type {
  ReadContext,
  LoaderReadContext,
} from "../../shared/lib/loaderReadContext.js";

export function profileQuery(context: ReadContext<"profile">) {
  return {
    queryKey: profileKeys.profile(context.tenantId),
    queryFn: () => context.ports.api.profile(),
  };
}
export function prefetchProfile(context: LoaderReadContext<"profile">) {
  return context.queryClient.prefetchQuery(profileQuery(context));
}

export function settingsQuery(context: ReadContext<"settings">) {
  return {
    queryKey: profileKeys.settings(context.tenantId),
    queryFn: () => context.ports.api.settings(),
  };
}
export function prefetchSettings(context: LoaderReadContext<"settings">) {
  return context.queryClient.prefetchQuery(settingsQuery(context));
}

export function prefetchProfileEditor(
  context: LoaderReadContext<"profile" | "settings">,
) {
  return Promise.all([prefetchProfile(context), prefetchSettings(context)]);
}
