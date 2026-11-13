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
  if (report.formulaVersion === "requirement-fit-v3-equal") {
    return `${coverage} qualification coverage. Every distinct requirement or job-local education/language demand counts once; alternatives count as one demand. No demands means no score.`;
  }
  const scoped = report.formulaVersion === "requirement-fit-v2-scoped";
  if (scoped && report.assessments.some(({ contribution }) => !contribution.scope || !contribution.scopeSourceId)) {
    return "No recorded source for requirement classification. Review the saved assessment.";
  }
  const excluded = scoped ? report.assessments.filter(({ contribution }) => contribution.scope !== "resume").length : 0;
  const blockers = report.assessments.flatMap(({ fit, contribution }) =>
    fit.kind === "blocked" && (!scoped || contribution.scope === "resume") ? [fit.blocker] : [],
  );
  const blockingContext = blockers.length
    ? ` Blocking requirement${blockers.length === 1 ? "" : "s"}: ${blockers.join("; ")}${report.formulaVersion === "requirement-fit-v1" || scoped ? " The recorded policy caps scores with blocked requirements at 4/10." : ""}`
    : "";
  const separateContext = excluded
    ? ` ${excluded} eligibility, logistics or employer condition${excluded === 1 ? " is" : "s are"} assessed separately.`
    : "";
  return `Historical scoring policy: ${coverage} weighted ${scoped ? "capability" : "requirement"} coverage.${separateContext}${blockingContext} Refresh requirements and manually update affected matches before relying on this result as current.`;
}

export function fitScoreHelp(job: JobDetail["job"], requirementContext?: string | null): string {
  if (job.scoreCorrection) {
    const reason = job.scoreCorrection.rationale.trim();
    return `The displayed fit score is the latest saved manual correction, not a newly calculated policy result.${reason ? ` Correction reason: ${reason}.` : ""} The earlier score remains in the stored correction history. Band and confidence still describe the retained qualification breakdown; this correction does not recompute them.`;
  }
  return `The latest stored candidate-to-job score calculated by the scoring policy, on a 1–10 scale. It may be absent before scoring or stale after a policy change; inspect the evidence before relying on it.${requirementContext ? ` ${requirementContext}` : ""}`;
}
