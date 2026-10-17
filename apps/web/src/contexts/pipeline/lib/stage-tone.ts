import { assertNever } from "../../../shared/lib/exhaustive.js";
import type { Stage } from "@jobctrl/contracts";

export type StageTone = "neutral" | "info" | "ok";

export function stageTone(stage: Stage): StageTone {
  switch (stage) {
    case "discover":
    case "enrich":
      return "neutral";
    case "score":
    case "tailor":
    case "cover":
      return "info";
    case "apply":
      return "ok";
    default:
      return assertNever(stage);
  }
}
