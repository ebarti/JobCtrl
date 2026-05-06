import { assertNever } from "../../../shared/lib/exhaustive.js";
import type { StageState } from "../../operations/types.js";

export type StageStateTone = "ok" | "warn" | "danger" | "muted" | "info";

export function stageStateTone(state: StageState): StageStateTone {
  switch (state) {
    case "succeeded":
      return "ok";
    case "running":
    case "queued":
      return "info";
    case "blocked":
      return "warn";
    case "failed":
    case "exhausted":
      return "danger";
    case "pending":
    case "skipped":
    case "stale":
    case "canceled":
      return "muted";
    default:
      return assertNever(state);
  }
}
