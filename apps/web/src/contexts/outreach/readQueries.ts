import { outreachKeys } from "./queryKeys.js";
import type { ContactsListFilters } from "./hooks/useContactsListQuery.js";
import type {
  ReadContext,
  LoaderReadContext,
} from "../../shared/lib/loaderReadContext.js";

export function contactsListQuery(
  context: ReadContext<"listContacts">,
  input: ContactsListFilters,
) {
  return {
    queryKey: outreachKeys.contactList(context.tenantId, input),
    queryFn: () => context.ports.api.listContacts(input),
  };
}
export function prefetchContactsList(
  context: LoaderReadContext<"listContacts">,
  input: ContactsListFilters,
) {
  return context.queryClient.prefetchQuery(contactsListQuery(context, input));
}
