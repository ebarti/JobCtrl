import { createFileRoute } from "@tanstack/react-router";

import { ApplicationsDashboardPanel, OutcomeSuggestionsDashboard } from "../contexts/apply/index.js";
import { DigestPanel } from "../contexts/digest/index.js";
import { DiscoverySourceHealthPanel } from "../contexts/discovery/index.js";
import { JobsDashboardPanel } from "../contexts/jobs/index.js";
import { DueFollowUpsPanel } from "../contexts/outreach/index.js";
import { ActionRunsDashboard } from "../contexts/runs/index.js";
import { RecentActivityPanel } from "../contexts/activity/index.js";
import { useMountedFeatures } from "../contexts/runtime/index.js";
import { DashboardView } from "../views/dashboard/DashboardView.js";

export const Route = createFileRoute("/dashboard")({
  component: DashboardComposition,
});

function DashboardComposition() {
  const features = useMountedFeatures();
  return <DashboardView panels={[
    { id: "jobs", content: <JobsDashboardPanel /> },
    ...(features.has("digest") ? [{ id: "digest", content: <DigestPanel /> }] : []),
    ...(features.has("discovery") ? [{ id: "discovery", content: <DiscoverySourceHealthPanel /> }] : []),
    ...(features.has("applications") ? [
      { id: "outcomes", content: <OutcomeSuggestionsDashboard /> },
      { id: "applications", content: <ApplicationsDashboardPanel /> },
    ] : []),
    ...(features.has("outreach") ? [{ id: "follow-ups", content: <DueFollowUpsPanel /> }] : []),
    { id: "active-work", content: <ActionRunsDashboard /> },
    { id: "recent-activity", content: <RecentActivityPanel /> },
  ]} />;
}
