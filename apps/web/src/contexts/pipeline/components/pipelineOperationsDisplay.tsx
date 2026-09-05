import type { PipelineEta } from "@jobctrl/contracts";

export function sentenceCase(value: string): string {
  return value.replaceAll("_", " ").replace(/^./, (character) => character.toUpperCase());
}

export function safeOperationalIdentifier(value: string): string {
  return /(?:https?:\/\/|www\.)/i.test(value) ? "Sensitive identifier withheld" : value;
}

export function formatSeconds(value: number): string {
  if (value < 60) return `${Math.round(value)} sec`;
  if (value < 3_600) return `${Math.round(value / 60)} min`;
  return `${(value / 3_600).toFixed(value < 36_000 ? 1 : 0)} hr`;
}

function pausedEtaReasonLabel(
  reason: Extract<PipelineEta, { status: "paused" }>["reason"],
): string {
  switch (reason) {
    case "no_dispatch":
      return "No recent dispatch activity";
    case "budget_exceeded":
      return "Budget limit reached";
    case "blocked":
      return "Work is blocked";
    case "worker_unavailable":
      return "Worker unavailable";
  }
}

export function etaStatusLabel(eta: PipelineEta): string {
  return eta.status === "paused" ? "No ETA" : sentenceCase(eta.status);
}

export function etaReasonLabel(
  eta: Extract<PipelineEta, { status: "paused" | "stale" | "unavailable" }>,
): string {
  return eta.status === "paused"
    ? pausedEtaReasonLabel(eta.reason)
    : sentenceCase(eta.reason);
}

export function etaLabel(eta: PipelineEta): string {
  switch (eta.status) {
    case "available":
      return `${formatSeconds(eta.lowSeconds)}–${formatSeconds(eta.highSeconds)}`;
    case "calibrating":
      return `Calibrating · ${eta.completedSamples}/${eta.minimumSamples}`;
    case "paused":
      return `No ETA · ${pausedEtaReasonLabel(eta.reason)}`;
    case "stale":
      return `Stale · ${sentenceCase(eta.reason)}`;
    case "unavailable":
      return eta.reason === "no_work" ? "No work remaining" : `Unavailable · ${sentenceCase(eta.reason)}`;
  }
}
