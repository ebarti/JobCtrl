import { prefetchContactsList } from "../contexts/outreach/readQueries.js";
import { createFileRoute, Outlet } from "@tanstack/react-router";

import {
  outreachSearchSchema,
  type OutreachSearch,
} from "./-outreach.search.js";

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
  loader: ({ context, deps }) =>
    prefetchContactsList(context, contactsListInput(deps.search)),
  component: Outlet,
});
