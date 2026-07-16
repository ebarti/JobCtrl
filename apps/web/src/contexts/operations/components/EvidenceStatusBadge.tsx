import type { JSX } from "react";

import { StatusBadge } from "../../../shared/ui/status-badge.js";
import type { StatusTagTone } from "../../../shared/ui/status-tokens.js";
import type { EvidenceGap, EvidenceMapEntry, EvidenceUsageRef } from "../types.js";

type EvidenceStrength = EvidenceMapEntry["freshness"]["evidenceStrength"];
type EvidenceFit = EvidenceUsageRef["requirementFitKind"];
type EvidenceCoverage =
  | EvidenceUsageRef["artifactCoverageState"]
  | EvidenceUsageRef["coverageState"];

export type EvidenceStatusBadgeProps =
  | { readonly type: "confirmation"; readonly value: boolean }
  | { readonly type: "coverage"; readonly value: EvidenceCoverage }
  | { readonly type: "fit"; readonly value: EvidenceFit }
  | { readonly type: "gap"; readonly value: EvidenceGap["kind"] }
  | { readonly type: "strength"; readonly value: EvidenceStrength };

interface EvidenceStatusDescriptor {
  readonly label: string;
  readonly tone: StatusTagTone;
}

function strengthDescriptor(value: EvidenceStrength): EvidenceStatusDescriptor {
  switch (value) {
    case "verified":
      return { label: value, tone: "ok" };
    case "supported":
    case "declared":
      return { label: value, tone: "info" };
    case "inferred":
      return { label: value, tone: "warn" };
    case "draft":
    case null:
      return { label: value ?? "unrated", tone: "muted" };
    default:
      return { label: value, tone: "muted" };
  }
}

function fitDescriptor(value: EvidenceFit): EvidenceStatusDescriptor {
  switch (value) {
    case "matched":
      return { label: value, tone: "ok" };
    case "transferable":
      return { label: value, tone: "info" };
    case "missing":
    case "blocked":
      return { label: value, tone: "danger" };
    case "not_assessed":
    case null:
      return { label: value?.replaceAll("_", " ") ?? "not assessed", tone: "muted" };
  }
}

function coverageDescriptor(value: EvidenceCoverage): EvidenceStatusDescriptor {
  switch (value) {
    case "covered":
      return { label: value, tone: "ok" };
    case "declared":
      return { label: value, tone: "info" };
    case "missing":
    case "missing_from_resume":
    case "missing_from_profile":
    case "not_covered":
      return { label: value.replaceAll("_", " "), tone: "danger" };
    case "not_recorded":
    case null:
      return { label: value?.replaceAll("_", " ") ?? "not assessed", tone: "muted" };
  }
}

function gapDescriptor(value: EvidenceGap["kind"]): EvidenceStatusDescriptor {
  switch (value) {
    case "blocked_requirement":
      return { label: "Blocked requirement", tone: "danger" };
    case "transferable_requirement":
      return { label: "Transferable requirement", tone: "info" };
    case "missing_skill":
      return { label: "Missing skill", tone: "danger" };
    case "missing_requirement":
      return { label: "Missing requirement", tone: "danger" };
  }
}

function statusDescriptor(status: EvidenceStatusBadgeProps): EvidenceStatusDescriptor {
  switch (status.type) {
    case "confirmation":
      return status.value
        ? { label: "confirmed", tone: "ok" }
        : { label: "unconfirmed", tone: "warn" };
    case "coverage":
      return coverageDescriptor(status.value);
    case "fit":
      return fitDescriptor(status.value);
    case "gap":
      return gapDescriptor(status.value);
    case "strength":
      return strengthDescriptor(status.value);
  }
}

export function EvidenceStatusBadge(status: EvidenceStatusBadgeProps): JSX.Element {
  const descriptor = statusDescriptor(status);
  return <StatusBadge tone={descriptor.tone}>{descriptor.label}</StatusBadge>;
}
