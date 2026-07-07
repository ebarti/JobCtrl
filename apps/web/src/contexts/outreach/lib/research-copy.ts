import type { ResearchSourceOutcome, ResearchTaskStatus } from "@jobctl/contracts";

export const RESEARCH_TASK_STATUS_LABELS: Record<ResearchTaskStatus, string> = {
  queued: "Queued",
  running: "Researching",
  needs_review: "Needs review",
  completed: "Completed",
  failed: "Failed",
};

// Source-attempt outcomes are first-class results of the politeness gateway,
// not errors: robots-denial / rate-limit / budget-exhaustion explain why a
// source produced nothing (outreach planner plan §5.3).
export const RESEARCH_SOURCE_OUTCOME_LABELS: Record<string, string> = {
  allowed: "Fetched",
  no_candidates: "No contacts found",
  robots_disallowed: "Blocked by robots.txt",
  rate_limited: "Rate-limited",
  budget_exhausted: "Request budget reached",
  manual_capture_required: "Manual capture required",
  rejected: "Not permitted",
  extraction_failed: "Extraction failed",
};

export function researchTaskStatusLabel(status: ResearchTaskStatus | string): string {
  return (RESEARCH_TASK_STATUS_LABELS as Record<string, string>)[status] ?? status;
}

export function researchSourceOutcomeLabel(outcome: ResearchSourceOutcome | string): string {
  return RESEARCH_SOURCE_OUTCOME_LABELS[outcome] ?? outcome;
}
