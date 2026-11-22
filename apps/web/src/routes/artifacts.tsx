import { createFileRoute, Outlet } from "@tanstack/react-router";

import { prefetchResumeArtifactCatalog } from "../contexts/resumes/index.js";
import { artifactsSearchSchema } from "./-artifacts.search.js";

export const Route = createFileRoute("/artifacts")({
  validateSearch: (search) => artifactsSearchSchema.parse(search),
  loader: ({ context }) => prefetchResumeArtifactCatalog(context),
  component: Outlet,
});
