import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";

import { requirementTableReturnState, requirementsLibrarySearchSchema } from "../contexts/requirements/index.js";
import { useRuntimeHealth } from "../contexts/runtime/index.js";
import { Empty } from "../shared/ui/empty.js";
import { RequirementsLibraryView } from "../views/requirements/RequirementsLibraryView.js";

export const Route = createFileRoute("/requirements")({
  validateSearch: (search) => requirementsLibrarySearchSchema.parse(search),
  component: RequirementsRoute,
});

function RequirementsRoute() {
  const search = Route.useSearch();
  const navigate = useNavigate();
  const health = useRuntimeHealth();
  const { requirement: _selection, ...tableState } = search;
  if (!health.data) return <Empty title={health.error ? "Requirements unavailable" : "Loading requirements"}
    description={health.error ? "The application status could not be checked. Try again when the connection is available." : "Checking the available workspace."}
    {...(health.error ? { action: <button type="button" onClick={() => void health.refetch()}>Retry</button> } : {})} />;
  if (!health.data.features.includes("requirements") || !health.data.features.includes("fit")) {
    return <Empty title="Requirements unavailable" description="The requirements workspace is not enabled in this application."
      action={<Link to="/jobs">Back to jobs</Link>} />;
  }
  return <RequirementsLibraryView selectedRequirementId={search.requirement ?? null} tableState={tableState}
    onTableStateChange={(next) => { void navigate({ to: "/requirements", search: (previous) => ({ ...previous, ...next }), replace: true }); }}
    onSelectRequirement={(requirement) => { void navigate({ to: "/requirements", search: (previous) => ({ ...previous, requirement: requirement ?? undefined }) }); }}
    onOpenAchievement={(roleId, achievementId) => { void navigate({ to: "/profile", search: {
      section: "experience", roleId, achievementId,
      ...(search.requirement ? { returnRequirement: search.requirement } : {}),
      returnRequirementsFilter: search.q,
      returnRequirementsTable: requirementTableReturnState(tableState),
    } }); }} />;
}
