import { prefetchArtifactsList } from "../contexts/operations/readQueries.js";
import { createFileRoute, Outlet } from "@tanstack/react-router";

import {
  artifactsSearchSchema,
  type ArtifactsSearch,
} from "./-artifacts.search.js";

function artifactsListInput(search: ArtifactsSearch) {
  return {
    page: search.page,
    pageSize: search.pageSize,
    q: search.q,
    sort: search.sort,
    dir: search.dir,
    status: search.status === "all" ? "" : search.status,
  };
}

export const Route = createFileRoute("/artifacts")({
  validateSearch: (search) => artifactsSearchSchema.parse(search),
  loaderDeps: ({ search }) => ({ search }),
  loader: ({ context, deps }) =>
    prefetchArtifactsList(context, artifactsListInput(deps.search)),
  component: Outlet,
});
