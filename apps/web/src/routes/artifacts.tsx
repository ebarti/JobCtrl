import { createFileRoute } from "@tanstack/react-router";

import { artifactsKeys } from "../contexts/operations/artifactsKeys.js";
import { ArtifactsView } from "../views/artifacts/ArtifactsView.js";
import { artifactsSearchSchema, type ArtifactsSearch } from "./-artifacts.search.js";

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
  loader: ({ deps, context }) => {
    const input = artifactsListInput(deps.search);
    return context.queryClient.ensureQueryData({
      queryKey: artifactsKeys.list(context.tenantId, input),
      queryFn: () => context.ports.api.artifacts(input),
    });
  },
  component: ArtifactsView,
});
