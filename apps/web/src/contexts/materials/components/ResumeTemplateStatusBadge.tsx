import type { ResumeTemplateState, ResumeTemplateStaleState } from "@jobhunter/contracts";
import type { JSX } from "react";

export interface ResumeTemplateStatusBadgeProps {
  readonly state?: ResumeTemplateState | null | undefined;
}

const STATUS_LABELS: Record<ResumeTemplateStaleState, string> = {
  template_current: "template current",
  template_stale: "template stale",
  refresh_queued: "template refresh queued",
  refresh_failed: "template refresh failed",
  refresh_unavailable: "template refresh unavailable",
};

export function ResumeTemplateStatusBadge({ state }: ResumeTemplateStatusBadgeProps): JSX.Element | null {
  if (!state) return null;
  return (
    <span className={`tag ${toneForState(state.state)}`} title={templateTitle(state)}>
      {STATUS_LABELS[state.state]}
    </span>
  );
}

function toneForState(state: ResumeTemplateStaleState): "muted" | "info" | "ok" | "warn" {
  if (state === "template_current") return "ok";
  if (state === "refresh_queued") return "info";
  if (state === "template_stale") return "warn";
  return "warn";
}

function templateTitle(state: ResumeTemplateState): string {
  const source =
    state.effective.assignmentSource === "job_override"
      ? "job override"
      : state.effective.assignmentSource === "profile_default"
        ? "default template"
        : "built-in template";
  const refresh = state.lastRefreshAttempt?.errorMessage ? ` Last refresh: ${state.lastRefreshAttempt.errorMessage}` : "";
  return `${state.effective.templateName} from ${source}.${refresh}`;
}
