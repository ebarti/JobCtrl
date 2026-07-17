import type {
  ResumeTemplateState,
  ResumeTemplateStaleState,
} from "@jobctrl/contracts";
import { IconBan, IconClock, type TablerIcon } from "@tabler/icons-react";
import type { JSX } from "react";

import { StatusBadge } from "../../../shared/ui/status-badge.js";

export interface ResumeTemplateStatusBadgeProps {
  readonly state?: ResumeTemplateState | null | undefined;
}

const STATUS_LABELS: Record<ResumeTemplateStaleState, string> = {
  template_current: "current",
  template_stale: "stale",
  refresh_queued: "refresh queued",
  refresh_failed: "refresh failed",
  refresh_unavailable: "refresh unavailable",
};

export function ResumeTemplateStatusBadge({
  state,
}: ResumeTemplateStatusBadgeProps): JSX.Element | null {
  if (!state) return null;
  return (
    <StatusBadge
      icon={iconForState(state.state)}
      tone={toneForState(state.state)}
      title={templateTitle(state)}
    >
      {STATUS_LABELS[state.state]}
    </StatusBadge>
  );
}

function iconForState(state: ResumeTemplateStaleState): TablerIcon | undefined {
  if (state === "refresh_queued") return IconClock;
  if (state === "refresh_unavailable") return IconBan;
  return undefined;
}

function toneForState(
  state: ResumeTemplateStaleState,
): "muted" | "info" | "ok" | "warn" {
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
  const refresh = state.lastRefreshAttempt?.errorMessage
    ? ` Last refresh: ${state.lastRefreshAttempt.errorMessage}`
    : "";
  return `${state.effective.templateName} from ${source}.${refresh}`;
}
