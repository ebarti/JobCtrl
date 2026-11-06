import type { ReactNode } from "react";

import { PageHead } from "../../shared/ui/page-head.js";

export interface DashboardPanel {
  readonly id: string;
  readonly content: ReactNode;
}

/** Layout only: each public feature panel owns its own read and error state. */
export function DashboardView({ panels = [] }: { readonly panels?: readonly DashboardPanel[] }) {
  return (
    <div className="dashboard-view">
      <PageHead
        eyebrow="Overview"
        title="Dashboard"
        subtitle="Pipeline health, outcomes, active work, and the decisions that need attention."
      />
      <div className="dashboard-stack">
        <div className="dashboard-tail">
          {panels.map((panel) => <div className="col-span-full" key={panel.id}>{panel.content}</div>)}
        </div>
      </div>
    </div>
  );
}
