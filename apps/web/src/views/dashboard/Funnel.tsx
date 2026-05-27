import { useNavigate } from "@tanstack/react-router";

import type { DashboardSummary, Stage } from "../../contexts/operations/types.js";
import { CardHeader } from "../../shared/ui/card-header.js";
import { SegmentBar } from "../../shared/ui/segment-bar.js";
import { kpiSearchFor } from "./KpiGrid.js";

export interface FunnelProps {
  summary: DashboardSummary;
}

type FunnelStage = DashboardSummary["funnel"][number];

interface ProductFunnelStage extends FunnelStage {
  label: "discover" | "apply";
  diagnostic: string | null;
}

const PREPARATION_STAGES: ReadonlySet<Stage> = new Set([
  "discover",
  "enrich",
  "score",
  "tailor",
  "cover",
]);

function sumStages(
  stages: readonly FunnelStage[],
  key: keyof Omit<FunnelStage, "stage">,
): number {
  return stages.reduce((total, stage) => total + stage[key], 0);
}

function describeMaintenance(summary: DashboardSummary): string | null {
  const scoreCount = summary.preparation?.outdatedScoreCount ?? 0;
  const materialCount = summary.preparation?.outdatedTailoredArtifactCount ?? 0;
  const parts = [
    scoreCount ? `${scoreCount} score update${scoreCount === 1 ? "" : "s"}` : null,
    materialCount ? `${materialCount} material update${materialCount === 1 ? "" : "s"}` : null,
  ].filter((part): part is string => Boolean(part));
  return parts.length ? parts.join(", ") : null;
}

function buildDiscoverStage(summary: DashboardSummary): ProductFunnelStage | null {
  const preparationStages = summary.funnel.filter((stage) =>
    PREPARATION_STAGES.has(stage.stage),
  );
  if (!preparationStages.length && !summary.preparation) {
    return null;
  }

  const workItems = summary.preparation?.workItems;
  const failed = sumStages(preparationStages, "failed") + (workItems?.failed ?? 0);
  const running = sumStages(preparationStages, "running") + (workItems?.running ?? 0);
  const pending = sumStages(preparationStages, "pending") + (workItems?.queued ?? 0);
  const blocked = sumStages(preparationStages, "blocked");
  const succeeded = sumStages(preparationStages, "succeeded");
  const active = failed + running + pending + blocked;
  const total = Math.max(summary.totals.jobs, sumStages(preparationStages, "total"), succeeded + active);

  return {
    stage: "discover",
    label: "discover",
    total,
    succeeded: Math.max(0, total - active),
    failed,
    blocked,
    running,
    pending,
    diagnostic: describeMaintenance(summary),
  };
}

function productFunnel(summary: DashboardSummary): ProductFunnelStage[] {
  const rows: ProductFunnelStage[] = [];
  const discover = buildDiscoverStage(summary);
  if (discover) {
    rows.push(discover);
  }
  rows.push(
    ...summary.funnel
      .filter((stage) => stage.stage === "apply")
      .map((stage) => ({ ...stage, label: "apply" as const, diagnostic: null })),
  );
  return rows;
}

export function Funnel({ summary }: FunnelProps) {
  const navigate = useNavigate();
  const rows = productFunnel(summary);
  return (
    <section className="card span-2">
      <CardHeader title="Pipeline" meta={`${summary.totals.jobs} jobs`} />
      <div className="funnel">
        {rows.map((stage, index) => (
          <button
            key={stage.stage}
            type="button"
            className="funnel-row"
            onClick={() => void navigate({ to: "/jobs", search: kpiSearchFor("all") })}
          >
            <span className="funnel-stage">
              <span className="funnel-num">{String(index + 1).padStart(2, "0")}</span> {stage.label}
            </span>
            <SegmentBar
              total={stage.total}
              values={[
                ["done", stage.succeeded],
                ["failed", stage.failed],
                ["blocked", stage.blocked],
                ["running", stage.running],
                ["pending", stage.pending],
              ]}
            />
            <span className="legend">
              {stage.failed ? <span className="danger">{stage.failed} failed</span> : null}
              {stage.blocked ? <span className="warn">{stage.blocked} blocked</span> : null}
              {stage.running ? <span>{stage.running} running</span> : null}
              <span>{stage.pending} pending</span>
              {stage.diagnostic ? <span>{stage.diagnostic}</span> : null}
            </span>
          </button>
        ))}
      </div>
    </section>
  );
}
