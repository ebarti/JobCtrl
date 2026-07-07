import type { JSX } from "react";
import type { StageSummary } from "@jobctrl/contracts";

import { StatusDot } from "../../../shared/ui/status-dot.js";
import { TailorJobButton } from "../../materials/components/RetailorCurrentPolicyButton.js";
import { StageBadge } from "./StageBadge.js";

export interface StageTimelineProps {
  stages: readonly StageSummary[];
  jobId?: string;
}

export function StageTimeline({ stages, jobId }: StageTimelineProps): JSX.Element {
  return (
    <ol className="timeline">
      {stages.map((stage) => {
        const diagnostics = stageDiagnostics(stage);
        return (
          <li key={stage.stage} className="timeline-row">
            <span className="timeline-row-head">
              <StatusDot state={stage.state} />
              <StageBadge stage={stage.stage} />
            </span>
            <StageBadge state={stage.state} />
            {diagnostics.length ? (
              <dl className="timeline-diagnostics" aria-label={`${stage.stage} diagnostics`}>
                {diagnostics.map(([label, value]) => (
                  <div key={label}>
                    <dt>{label}</dt>
                    <dd>{value}</dd>
                  </div>
                ))}
              </dl>
            ) : null}
            {jobId && canTailorFromStage(stage) ? (
              <TailorJobButton className="tab timeline-action" jobId={jobId} />
            ) : null}
          </li>
        );
      })}
    </ol>
  );
}

function canTailorFromStage(stage: StageSummary): boolean {
  return (
    stage.stage === "tailor" &&
    !["queued", "running", "succeeded", "exhausted"].includes(stage.state)
  );
}

function stageDiagnostics(stage: StageSummary): Array<[string, string]> {
  if (!["failed", "exhausted", "blocked"].includes(stage.state)) return [];
  const diagnostics: Array<[string, string]> = [];
  if (stage.errorCode) diagnostics.push(["code", stage.errorCode]);
  if (stage.errorMessage) diagnostics.push(["message", stage.errorMessage]);
  if (stage.attemptCount || stage.maxAttempts) {
    diagnostics.push(["attempts", `${stage.attemptCount}/${stage.maxAttempts}`]);
  }
  if (stage.durationMs !== null) {
    diagnostics.push(["duration", formatDuration(stage.durationMs)]);
  }
  if (stage.blockedBy.length) {
    diagnostics.push(["blocked by", stage.blockedBy.join(", ")]);
  }
  if (["failed", "exhausted"].includes(stage.state)) {
    diagnostics.push(["retry", stage.retryable ? "available" : "not automatic"]);
  }
  return diagnostics;
}

function formatDuration(durationMs: number): string {
  if (durationMs < 1000) return `${durationMs}ms`;
  return `${Math.round(durationMs / 1000)}s`;
}
