import { createFileRoute } from "@tanstack/react-router";

import { outreachKeys } from "../contexts/operations/queryKeys.js";
import { OutreachView } from "../views/outreach/OutreachView.js";
import { outreachSearchSchema, type OutreachSearch } from "./-outreach.search.js";

function contactsListInput(search: OutreachSearch) {
  const input: { jobId?: string; employer?: string } = {};
  if (search.jobId) {
    input.jobId = search.jobId;
  }
  if (search.employer) {
    input.employer = search.employer;
  }
  return input;
}

export const Route = createFileRoute("/outreach")({
  validateSearch: (search) => outreachSearchSchema.parse(search),
  loaderDeps: ({ search }) => ({ search }),
  loader: ({ deps, context }) => {
    const input = contactsListInput(deps.search);
    return context.queryClient.ensureQueryData({
      queryKey: outreachKeys.contactList(context.tenantId, input),
      queryFn: () => context.ports.api.listContacts(input),
    });
  },
  component: OutreachView,
});
