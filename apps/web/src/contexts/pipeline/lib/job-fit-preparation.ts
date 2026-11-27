import type { PreparationRun } from "../client.js";

type Step = PreparationRun["steps"][number];
type SearchAssessment = NonNullable<PreparationRun["pendingSearchAssessments"]>[number];
type RunForJob = { run: PreparationRun; steps: Map<string, Step>; searchAssessment?: SearchAssessment | undefined };
type Posting = { job_id: string; revision: number; source_hash: string };
export interface FitPreparationInput {
  job: Posting;
  currentRequirements?: { status: string; revision: number } | null | undefined;
  latestRunId?: string | null | undefined;
}
export interface FitPreparationReason { label: string; detail: string; runId: string | null }

const stages = new Map([
  ["enrich", "Posting check"], ["role_analysis", "Role analysis"], ["requirements_extract", "Requirements extraction"],
  ["requirements", "Requirements check"], ["fit", "Fit assessment"],
]);
const fitRecipes = new Set(["run", "discover", "search", "assess", "score", "tailor", "prepare"]);
const active = (run: PreparationRun) => ["pending", "queued", "running"].includes(run.status);

function explain(input: FitPreparationInput, candidates: RunForJob[]): FitPreparationReason | null {
  const { job, currentRequirements } = input;
  const ongoing = candidates.filter(({ run }) => active(run));
  // A bounded history is insufficient to choose between unrelated attempts.
  // Prefer an explicit active owner or the job projection's recorded run ID.
  const selected = ongoing.length ? (ongoing.length === 1 ? ongoing[0] : undefined)
    : input.latestRunId ? candidates.find(({ run }) => run.runId === input.latestRunId)
    : candidates.length === 1 ? candidates[0] : undefined;
  const steps = selected?.steps;
  const requirements = steps?.get("requirements");
  const recorded = requirements?.status === "succeeded" ? requirements.result : null;
  const matchesPosting = recorded?.postingRevision === job.revision && recorded?.postingHash === job.source_hash;
  const languageFromRun = matchesPosting && recorded?.status === "unsupported_language" &&
    typeof recorded.revision === "number" && Number.isSafeInteger(recorded.revision) && recorded.revision > 0;
  const fit = steps?.get("fit");
  if (currentRequirements?.status === "unsupported_language") {
    const linked = languageFromRun && currentRequirements.revision === recorded?.revision;
    return { label: "Skipped · non-English posting", detail: "The accepted posting-language check identified a non-English posting.",
      runId: linked ? selected!.run.runId : null };
  }
  if (!selected || !steps) return null;
  const { run } = selected;
  // Older Jobs grids omit the current Requirements binding. Describe only what
  // this run recorded for this exact posting, even if it is later reassessed.
  if (currentRequirements === undefined && languageFromRun) {
    if (!fit) return { label: "Non-English in this run", detail: "This run’s requirements check marked this posting revision as non-English.", runId: run.runId };
    if (fit.status === "skipped" && fit.result?.skip === "unsupported_posting_language" && fit.result.requirements_revision === recorded.revision &&
      (fit.postingRevision === undefined || fit.postingRevision === job.revision))
      return { label: "Skipped in this run · non-English", detail: "This run skipped Fit after its requirements check marked this posting revision as non-English.", runId: run.runId };
  }
  const enrich = steps.get("enrich");
  const role = steps.get("role_analysis");
  const upstreamRevision = role?.status === "succeeded" ? role.result?.postingRevision
    : enrich && ["succeeded", "skipped"].includes(enrich.status) ? enrich.result?.revision : undefined;
  for (const [stage, label] of stages) {
    const step = steps.get(stage);
    if (step?.status !== "failed") continue;
    const revision = step.postingRevision ?? recorded?.postingRevision ?? upstreamRevision;
    if (revision !== job.revision || (recorded?.postingHash && !matchesPosting)) return null;
    return { label: label + " failed", detail: `${label} failed${step.errorCode ? ` (${step.errorCode})` : ""}.`, runId: run.runId };
  }
  if (languageFromRun || !active(run) || run.recipe !== "search") return null;
  const searchAssessment = selected.searchAssessment;
  if (run.executionPolicy?.version === "search-jobs-v1" && run.pendingSearchAssessments) {
    if (!searchAssessment) return null;
    const sameHandoff = searchAssessment.postingRevision === job.revision && searchAssessment.sourceHash === job.source_hash;
    const acceptedByRun = enrich?.status === "succeeded" && enrich.result?.revision === job.revision;
    if (!sameHandoff && !acceptedByRun) return null;
    if (searchAssessment.status === "queued") {
      return { label: "Fit queued", detail: "This job is in the assessment queue.", runId: run.runId };
    }
    if (!fit) {
      return { label: "Checking the job", detail: "The search is checking the posting and requirements for this job.", runId: run.runId };
    }
  } else if (!run.cohortFrozen || !["per_job", "cohort"].includes(run.targetRoute ?? "")) return null;
  if (recorded && !matchesPosting || upstreamRevision !== undefined && upstreamRevision !== job.revision) return null;
  for (const step of steps.values()) {
    if (["pending", "running"].includes(step.status) && step.postingRevision !== undefined && step.postingRevision !== job.revision) return null;
  }
  if (fit && !["pending", "running"].includes(fit.status)) return null;
  if (fit) return fit.status === "running"
    ? { label: "Assessing fit", detail: "The search is assessing fit for this job.", runId: run.runId }
    : { label: "Fit queued", detail: "This search has queued the job’s Fit assessment.", runId: run.runId };
  if (run.executionPolicy?.version === "search-jobs-v1") {
    return { label: "Waiting for job checks", detail: "Fit can start once this job’s posting and requirements checks finish.", runId: run.runId };
  }
  return { label: "Waiting for search checks", detail: "This job is in the active search. Fit scoring waits for posting and requirements checks across the search.", runId: run.runId };
}

/** Only jobs on this page participate. Group the bulk run steps once for all rows. */
export function jobFitPreparation(inputs: readonly FitPreparationInput[], runs: readonly PreparationRun[]) {
  const histories = new Map(inputs.map(({ job }) => [job.job_id, [] as RunForJob[]]));
  for (const run of runs) {
    if (!fitRecipes.has(run.recipe)) continue;
    const members = new Map<string, Map<string, Step>>();
    const pending = new Map(run.pendingSearchAssessments?.map((item) => [item.jobId, item]));
    for (const id of run.jobIds) {
      const history = histories.get(id);
      if (!history) continue;
      const steps = new Map<string, Step>();
      members.set(id, steps);
      history.push({ run, steps, searchAssessment: pending.get(id) });
    }
    if (members.size) for (const step of run.steps) {
      if (step.jobId) members.get(step.jobId)?.set(step.stage, step);
    }
  }
  return new Map(inputs.map((input) => [input.job.job_id, explain(input, histories.get(input.job.job_id)!)]));
}
