import type { ApplyRunStatus } from "@jobhunter/domain-types";

import { assertNever } from "../../../shared/lib/exhaustive.js";

export type ApplyRunResult = ApplyRunStatus;
export type ApplyRunTone = "ok" | "info" | "warn" | "danger" | "muted";

export function applyRunResultTone(result: ApplyRunResult): ApplyRunTone {
  switch (result) {
    case "succeeded":
      return "ok";
    case "starting":
    case "in_progress":
      return "info";
    case "captcha":
    case "login_issue":
    case "manual":
      return "warn";
    case "failed":
    case "expired":
      return "danger";
    case "dry_run_complete":
      return "muted";
    default:
      return assertNever(result);
  }
}
