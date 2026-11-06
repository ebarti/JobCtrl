import type { Stage } from "@jobctrl/contracts";

export type StageTone = "neutral" | "info" | "ok";

export function stageTone(stage: Stage): StageTone {
  switch (stage) {
    case "discover":
    case "enrich":
      return "neutral";
    case "score":
    case "tailor":
      return "info";
    case "apply":
      return "ok";
    default:
      return "neutral";
  }
}
