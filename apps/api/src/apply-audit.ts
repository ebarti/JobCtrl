import type {
  ApplyAudit,
  ApplyAuditFact,
  ApplyAuditSource,
  ApplyAuditState,
  ScoreBreakdown,
  Stage,
  StageState,
} from "./contracts.js";

export interface ApplyAuditLatestRun {
  runId: string;
  status: string;
  result: string | null;
  dryRun: boolean;
  startedAt: string | null;
  finishedAt: string | null;
}

export interface BuildApplyAuditInput {
  applicationUrl: string | null;
  hasResume: boolean;
  hasCoverLetter: boolean;
  hasPdf: boolean;
  currentStage: Stage;
  currentState: StageState;
  currentErrorCode: string | null;
  currentErrorMessage: string | null;
  latestApplyRun: ApplyAuditLatestRun | null;
  scoreBreakdown: ScoreBreakdown | null;
  reviewEvidenceAvailable?: boolean;
  missingProfileData?: readonly string[];
}

const REPAIR_STATES = new Set<StageState>([
  "failed",
  "blocked",
  "stale",
  "exhausted",
  "canceled",
  "skipped",
]);

const ACTIVE_STATES = new Set<StageState>(["queued", "running"]);

const APPLICATION_ATTESTATION_LABELS: Readonly<Record<string, string>> = {
  age_18_plus: "Age 18+",
  background_check_consent: "Background check consent",
  felony_conviction: "Felony conviction",
  previously_worked_at_employer: "Previously worked at employer",
};

export function buildApplyAudit(input: BuildApplyAuditInput): ApplyAudit {
  const missingPrerequisites: ApplyAuditFact[] = [];
  const hardBlockers: ApplyAuditFact[] = [];
  const eligibilityConcerns: ApplyAuditFact[] = [];
  const sources: ApplyAuditSource[] = [
    source(
      "application_url",
      "Application target",
      input.applicationUrl ? "present" : "missing",
      input.applicationUrl ? "Application target is available." : "No application or posting URL is recorded.",
    ),
    source(
      "materials.resume",
      "Tailored resume",
      input.hasResume ? "present" : "missing",
      input.hasResume ? "Tailored resume is available." : "Tailored resume is not available yet.",
    ),
    source(
      "materials.pdf",
      "Submit-ready PDF",
      input.hasPdf ? "present" : "missing",
      input.hasPdf
        ? "Resume PDF is available for submission."
        : "Submit-ready resume PDF is not available yet.",
    ),
    source(
      "materials.cover",
      "Cover letter",
      input.hasCoverLetter ? "present" : "missing",
      input.hasCoverLetter
        ? "Cover letter material is available."
        : "No cover letter material is recorded for this job.",
    ),
    source(
      "stage_state",
      "Pipeline state",
      "present",
      `${humanize(input.currentStage)} is ${humanize(input.currentState)}.`,
    ),
    source(
      "apply_run",
      "Latest apply run",
      input.latestApplyRun ? "present" : "not_applicable",
      input.latestApplyRun ? latestRunDetail(input.latestApplyRun) : "No apply run has been recorded.",
    ),
    source(
      "score_eligibility",
      "Score eligibility",
      input.scoreBreakdown ? "present" : "unknown",
      scoreEligibilityDetail(input.scoreBreakdown),
    ),
    source(
      "profile_attestations",
      "Application attestations",
      input.missingProfileData?.length ? "missing" : "present",
      input.missingProfileData?.length
        ? missingApplicationAttestationDetail(input.missingProfileData)
        : "Typed application attestations are complete.",
    ),
  ];

  if (!input.applicationUrl) {
    hardBlockers.push(
      fact(
        "missing_application_url",
        "Missing apply link",
        "No application or posting URL is recorded, so apply review cannot proceed.",
        "blocking",
        "application_url",
      ),
    );
  }

  if (!input.hasResume) {
    missingPrerequisites.push(
      fact(
        "missing_resume",
        "Tailored resume missing",
        "The tailored resume has not been generated yet.",
        "warning",
        "materials.resume",
      ),
    );
  }

  if (!input.hasPdf) {
    missingPrerequisites.push(
      fact(
        "missing_resume_pdf",
        "Submit-ready PDF missing",
        input.hasResume
          ? "Reviewable resume text may be available, but the submit-ready PDF is still missing."
          : "The submit-ready PDF cannot exist until a tailored resume is available.",
        "warning",
        "materials.pdf",
      ),
    );
  }

  const stageIssue = stageIssueFact(input);
  if (stageIssue) {
    hardBlockers.push(stageIssue);
  }

  const runIssue = applyRunIssueFact(input.latestApplyRun);
  if (runIssue) {
    hardBlockers.push(runIssue);
  }

  const eligibility = input.scoreBreakdown?.eligibility ?? null;
  if (eligibility?.status === "blocked") {
    const blockers = eligibility.hardBlockers.length
      ? eligibility.hardBlockers
      : ["Score eligibility is blocked."];
    for (const blocker of blockers) {
      hardBlockers.push(
        fact(
          "score_eligibility_blocked",
          "Eligibility blocked",
          blocker,
          "blocking",
          "score_eligibility",
        ),
      );
    }
  }

  if (eligibility?.status === "warning" || eligibility?.warnings.length) {
    const warnings = eligibility.warnings.length
      ? eligibility.warnings
      : ["Score eligibility has warnings."];
    for (const warning of warnings) {
      eligibilityConcerns.push(
        fact(
          "score_eligibility_warning",
          "Eligibility warning",
          warning,
          "warning",
          "score_eligibility",
        ),
      );
    }
  }

  if (!input.scoreBreakdown) {
    eligibilityConcerns.push(
      fact(
        "score_eligibility_unknown",
        "Eligibility not assessed",
        "No score eligibility data is recorded for this job.",
        "unknown",
        "score_eligibility",
      ),
    );
  }

  if (input.missingProfileData?.length) {
    missingPrerequisites.push(
      fact(
        "missing_profile_attestations",
        "Profile attestations incomplete",
        missingApplicationAttestationDetail(input.missingProfileData),
        "warning",
        "profile_attestations",
      ),
    );
  }

  const state = auditState(input, {
    hardBlockers,
    missingPrerequisites,
    runIssue,
    stageIssue,
  });
  const label = auditLabel(state, input, { hardBlockers, runIssue, stageIssue });
  const summary = auditSummary(state, input, {
    hardBlockers,
    missingPrerequisites,
    runIssue,
    stageIssue,
  });

  return {
    state,
    label,
    summary,
    reviewEvidenceAvailable:
      input.reviewEvidenceAvailable ??
      Boolean(input.hasResume || input.hasPdf || input.hasCoverLetter || input.scoreBreakdown),
    missingPrerequisites,
    hardBlockers,
    eligibilityConcerns,
    sources,
  };
}

function auditState(
  input: BuildApplyAuditInput,
  facts: {
    hardBlockers: readonly ApplyAuditFact[];
    missingPrerequisites: readonly ApplyAuditFact[];
    runIssue: ApplyAuditFact | null;
    stageIssue: ApplyAuditFact | null;
  },
): ApplyAuditState {
  if (facts.runIssue || facts.stageIssue) {
    return "repair";
  }
  if (facts.hardBlockers.length > 0) {
    return "blocked";
  }
  if (
    facts.missingPrerequisites.length > 0 ||
    ACTIVE_STATES.has(input.currentState) ||
    input.currentStage !== "apply"
  ) {
    return "preparing";
  }
  return "ready";
}

function auditLabel(
  state: ApplyAuditState,
  input: BuildApplyAuditInput,
  facts: {
    hardBlockers: readonly ApplyAuditFact[];
    runIssue: ApplyAuditFact | null;
    stageIssue: ApplyAuditFact | null;
  },
): string {
  if (state === "ready") {
    return "materials ready";
  }
  if (state === "preparing") {
    return "materials preparing";
  }
  if (state === "repair") {
    if (facts.runIssue && input.latestApplyRun) {
      return `${input.latestApplyRun.dryRun ? "dry run" : "submit"} failed`;
    }
    return facts.stageIssue?.label.toLowerCase() ?? "apply needs repair";
  }
  return facts.hardBlockers[0]?.label.toLowerCase() ?? "apply blocked";
}

function auditSummary(
  state: ApplyAuditState,
  input: BuildApplyAuditInput,
  facts: {
    hardBlockers: readonly ApplyAuditFact[];
    missingPrerequisites: readonly ApplyAuditFact[];
    runIssue: ApplyAuditFact | null;
    stageIssue: ApplyAuditFact | null;
  },
): string {
  if (state === "ready") {
    return "The tailored materials are ready to review before approval.";
  }
  if (state === "preparing") {
    const first = facts.missingPrerequisites[0];
    if (first?.code === "missing_resume_pdf" && input.hasResume) {
      return "Submit-ready files are being prepared automatically; reviewable text is available now.";
    }
    if (first) {
      return `${first.detail} Review evidence is still available where recorded.`;
    }
    return `${humanize(input.currentStage)} is ${humanize(input.currentState)}. Review evidence is still available where recorded.`;
  }
  if (state === "repair") {
    const issue = facts.runIssue ?? facts.stageIssue;
    const suffix = input.reviewEvidenceAvailable ? " Review evidence is still available." : "";
    return `${issue?.detail ?? "Apply review needs repair before approval can proceed."}${suffix}`;
  }
  const issue = facts.hardBlockers[0];
  return issue?.detail ?? "Apply review is blocked by missing source facts.";
}

function stageIssueFact(input: BuildApplyAuditInput): ApplyAuditFact | null {
  if (!REPAIR_STATES.has(input.currentState)) {
    return null;
  }
  const detail =
    cleanReason(input.currentErrorMessage) ||
    cleanReason(input.currentErrorCode) ||
    `${humanize(input.currentStage)} is ${humanize(input.currentState)}.`;
  return fact(
    "stage_not_ready",
    `${humanize(input.currentStage)} ${humanize(input.currentState)}`,
    detail,
    "blocking",
    "stage_state",
  );
}

function applyRunIssueFact(run: ApplyAuditLatestRun | null): ApplyAuditFact | null {
  if (!run || !isFailedApplyRun(run)) {
    return null;
  }
  const mode = run.dryRun ? "dry run" : "submit";
  const reason = cleanReason(run.result);
  return fact(
    "apply_run_failed",
    `${mode} failed`,
    failedRunDetail(mode, reason),
    "blocking",
    "apply_run",
  );
}

function latestRunDetail(run: ApplyAuditLatestRun): string {
  const mode = run.dryRun ? "Dry run" : "Submit";
  const status = `${run.status} ${run.result ?? ""}`.toLowerCase();
  if (isFailedApplyRun(run)) {
    const reason = cleanReason(run.result);
    return failedRunDetail(mode, reason);
  }
  if (status.includes("running") || status.includes("progress") || status.includes("starting")) {
    return `${mode} is in progress.`;
  }
  if (status.includes("succeeded") || status.includes("complete")) {
    return `${mode} completed.`;
  }
  return `${mode} recorded as ${humanize(run.status)}.`;
}

function failedRunDetail(mode: string, reason: string | null): string {
  return `Last ${mode} failed${reason ? `: ${reason}` : ""}.`;
}

function scoreEligibilityDetail(scoreBreakdown: ScoreBreakdown | null): string {
  if (!scoreBreakdown) {
    return "No score eligibility data is recorded.";
  }
  const { eligibility } = scoreBreakdown;
  if (eligibility.status === "blocked") {
    return eligibility.hardBlockers[0] ?? "Eligibility is blocked.";
  }
  if (eligibility.status === "warning") {
    return eligibility.warnings[0] ?? "Eligibility has warnings.";
  }
  if (eligibility.status === "eligible") {
    return "Eligibility is recorded as eligible.";
  }
  return "Eligibility status is unknown.";
}

function isFailedApplyRun(run: ApplyAuditLatestRun): boolean {
  const status = `${run.status} ${run.result ?? ""}`.toLowerCase();
  return (
    status.includes("failed") ||
    status.includes("skipped") ||
    status.includes("canceled") ||
    status.includes("terminated") ||
    status.includes("timed_out") ||
    status.includes("captcha") ||
    status.includes("login_issue") ||
    status.includes("expired")
  );
}

function fact(
  code: string,
  label: string,
  detail: string | null,
  severity: ApplyAuditFact["severity"],
  sourceName: string,
): ApplyAuditFact {
  return {
    code,
    label,
    detail,
    severity,
    source: sourceName,
  };
}

function source(
  kind: string,
  label: string,
  status: ApplyAuditSource["status"],
  detail: string | null,
): ApplyAuditSource {
  return { kind, label, status, detail };
}

function cleanReason(value: string | null | undefined): string | null {
  const raw = String(value ?? "").trim();
  const missingProfileData = raw.match(/^missing_profile_data\s*:\s*(.+)$/i);
  if (missingProfileData?.[1]) {
    const fields = missingProfileData[1]
      .split(",")
      .map((field) => field.trim())
      .filter(Boolean);
    return fields.length
      ? `required profile answers missing: ${fields.map(applicationAttestationLabel).join(", ")}`
      : "required profile answers are missing";
  }
  const text = raw
    .replace(/_/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/^(blocked|failed|skipped|error)\s*:\s*/i, "");
  if (!text || /^(blocked|failed|stale|error)$/i.test(text)) {
    return null;
  }
  return text.charAt(0).toLowerCase() + text.slice(1);
}

function humanize(value: string): string {
  return value.replace(/_/g, " ");
}

function applicationAttestationLabel(field: string): string {
  const normalized = field.trim();
  const known = APPLICATION_ATTESTATION_LABELS[normalized];
  if (known) {
    return known;
  }
  const readable = humanize(normalized).trim();
  return readable ? `${readable.charAt(0).toUpperCase()}${readable.slice(1)}` : "Required answer";
}

function missingApplicationAttestationDetail(fields: readonly string[]): string {
  return `Application attestations missing: ${fields.map(applicationAttestationLabel).join(", ")}.`;
}
