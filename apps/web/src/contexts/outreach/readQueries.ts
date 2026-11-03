import { replaceEqualDeep, type Query, type QueryClient } from "@tanstack/react-query";

import { retainLaterQueryPublication } from "../../shared/lib/createOptimisticMutation.js";
import type { ReadContext } from "../../shared/lib/loaderReadContext.js";
import { outreachKeys } from "./queryKeys.js";
import type { ContactsListFilters } from "./hooks/useContactsListQuery.js";

type ContactReadContext = ReadContext<"listContacts"> & {
  readonly queryClient: Pick<QueryClient, "getQueryCache">;
};
type ContactLoaderContext = ReadContext<"listContacts"> & {
  readonly queryClient: Pick<QueryClient, "getQueryCache" | "prefetchQuery">;
};

// A returned DTO is unique to its read, so its start-time fence stays paired
// with that response even if query options are replaced while it is in flight.
const listReads = new WeakMap<object, { readonly query: Query; readonly dataUpdateCount: number }>();

export function contactsListQuery(context: ContactReadContext, input: ContactsListFilters) {
  const queryKey = outreachKeys.contactList(context.tenantId, input);
  return {
    queryKey,
    queryFn: async () => {
      const query = context.queryClient.getQueryCache().find({ queryKey, exact: true });
      const dataUpdateCount = query?.state.dataUpdateCount;
      const response = { ...await context.ports.api.listContacts(input) };
      if (query && dataUpdateCount !== undefined) listReads.set(response, { query, dataUpdateCount });
      return response;
    },
    structuralSharing: (previous: unknown, next: unknown) => {
      const read = next && typeof next === "object" ? listReads.get(next) : undefined;
      if (read && next && typeof next === "object") listReads.delete(next);
      if (read && previous !== undefined &&
          context.queryClient.getQueryCache().get(read.query.queryHash) === read.query &&
          read.query.state.dataUpdateCount !== read.dataUpdateCount) {
        retainLaterQueryPublication(context.queryClient, read.query, previous);
        return previous;
      }
      return replaceEqualDeep(previous, next);
    },
  };
}
export function prefetchContactsList(context: ContactLoaderContext, input: ContactsListFilters) {
  return context.queryClient.prefetchQuery(contactsListQuery(context, input));
}
