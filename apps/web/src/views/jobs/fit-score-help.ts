import type { JobDetail } from "../../contexts/operations/types.js";

export function fitScoreHelp(job: JobDetail["job"]): string {
  if (job.scoreCorrection) {
    const reason = job.scoreCorrection.rationale.trim();
    return `The displayed fit score is the latest saved manual correction, not a newly calculated policy result.${reason ? ` Correction reason: ${reason}.` : ""} The earlier score remains in the stored correction history. Band, confidence, and eligibility still describe the retained scoring breakdown; this correction does not recompute them.`;
  }
  return "The latest stored candidate-to-job score calculated by the scoring policy, on a 0–10 scale. It may be absent before scoring or stale after a policy change; inspect the evidence before relying on it.";
}
