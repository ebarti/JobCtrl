import type { JobDetail } from "@jobctrl/contracts";

export function requirementFitScoreContext(detail: JobDetail): string | null {
  const { job, requirementFitReport: report } = detail;
  if (
    !report || job.scoreCorrection ||
    report.jobId !== job.jobKey || report.scoreVersion !== job.scoreVersion ||
    report.resolvedFitScore !== job.fitScore
  ) {
    return null;
  }
  const coverage = new Intl.NumberFormat("en", {
    style: "percent",
    maximumFractionDigits: 2,
  }).format(report.summary.weightedFit);
  const blockers = report.assessments.flatMap(({ fit }) =>
    fit.kind === "blocked" ? [fit.blocker] : [],
  );
  const blockingContext = blockers.length
    ? ` Blocking requirement${blockers.length === 1 ? "" : "s"}: ${blockers.join("; ")}${report.formulaVersion === "requirement-fit-v1" ? " The recorded policy caps scores with blocked requirements at 4/10." : ""}`
    : "";
  return `${coverage} weighted requirement coverage.${blockingContext}`;
}

export function fitScoreHelp(job: JobDetail["job"], requirementContext?: string | null): string {
  if (job.scoreCorrection) {
    const reason = job.scoreCorrection.rationale.trim();
    return `The displayed fit score is the latest saved manual correction, not a newly calculated policy result.${reason ? ` Correction reason: ${reason}.` : ""} The earlier score remains in the stored correction history. Band, confidence, and eligibility still describe the retained scoring breakdown; this correction does not recompute them.`;
  }
  return `The latest stored candidate-to-job score calculated by the scoring policy, on a 1–10 scale. It may be absent before scoring or stale after a policy change; inspect the evidence before relying on it.${requirementContext ? ` ${requirementContext}` : ""}`;
}
