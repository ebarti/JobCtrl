import type { ApplyAuditFact, ApplyAuditSource } from "@jobhunter/contracts";
import { Link } from "@tanstack/react-router";

import type { JobDetail } from "../../contexts/operations/types.js";
import { ResetStaleScoresButton } from "../../contexts/scoring/components/ResetStaleScoresButton.js";
import { ScoreCorrectionControl } from "../../contexts/scoring/components/ScoreCorrectionControl.js";
import { ScoreStalenessBadge } from "../../contexts/scoring/components/ScoreStalenessBadge.js";

export interface JobAuditTriageProps {
  detail: JobDetail;
}

export function JobAuditTriage({ detail }: JobAuditTriageProps) {
  const { job, applyAudit } = detail;
  const score = job.scoreBreakdown;
  const reasoning = score?.reasoning || job.scoreReasoning;
  const factGroups = auditFactGroups(detail);

  return (
    <section className="section job-audit-triage" aria-labelledby="job-audit-triage-title">
      <div className="job-audit-triage-head">
        <div>
          <span className="eyebrow">Audit triage</span>
          <h3 id="job-audit-triage-title">Why this job is here</h3>
        </div>
        <Link
          aria-label={`Open Apply Review for ${job.title}`}
          className="tab"
          search={{ jobKey: job.jobKey }}
          to="/apply-review"
        >
          Open Apply Review
        </Link>
      </div>

      <div className="job-audit-triage-grid">
        <div className="job-audit-triage-column">
          <div className="job-audit-triage-kicker">Ranking</div>
          <div className="job-audit-metrics" aria-label="Ranking summary">
            <Metric label="Fit score" value={`${job.fitScore ?? "-"}/10`} />
            <Metric label="Band" value={score?.fitBand ?? "not recorded"} />
            <Metric label="Confidence" value={score?.confidence ?? "not recorded"} />
            <Metric label="Eligibility" value={score?.eligibility.status ?? "unknown"} />
          </div>
          {reasoning ? (
            <p>{reasoning}</p>
          ) : (
            <p className="muted">No score rationale was stored for this job.</p>
          )}
          <TagGroup label="Matched signals" values={score?.matchedSignals} />
          <TagGroup label="Missing signals" values={score?.missingSignals} tone="warn" />
          <TagGroup label="Transferable signals" values={score?.transferableSignals} />
          <TagGroup label="Keywords" values={job.scoreKeywords} />
          <ScoreMetadata detail={detail} />
          {job.scoreStaleness.isStale ? (
            <div className="score-policy-row">
              <ScoreStalenessBadge staleness={job.scoreStaleness} />
              <span className="muted">scoring policy updated; reset this score before rescoring</span>
              <ResetStaleScoresButton
                className="tab on"
                jobKeys={[job.jobKey]}
                label="reset for rescore"
                staleCount={1}
              />
            </div>
          ) : null}
          <ScoreCorrectionControl jobId={job.jobKey} currentScore={job.fitScore} />
          {factGroups.length ? (
            <div className="job-audit-concerns">
              <div className="job-audit-triage-kicker">Apply concerns</div>
              <dl className="job-audit-fact-list">
                {factGroups.map((group) => (
                  <div key={group.label}>
                    <dt>{group.label}</dt>
                    <dd>
                      {group.facts.map((fact) => (
                        <span
                          className={`tag ${factTone(fact)}`}
                          key={`${group.label}:${fact.code}:${fact.detail ?? ""}`}
                        >
                          {fact.detail ? `${fact.label}: ${fact.detail}` : fact.label}
                        </span>
                      ))}
                    </dd>
                  </div>
                ))}
              </dl>
            </div>
          ) : null}
          {applyAudit.state !== "ready" && !factGroups.length ? (
            <p className="muted">{applyAudit.summary}</p>
          ) : null}
        </div>
      </div>
    </section>
  );
}

function Metric({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <span>{label}</span>
      <b>{value}</b>
    </div>
  );
}

function TagGroup({
  label,
  values,
  tone = "info",
}: {
  label: string;
  values: readonly string[] | undefined;
  tone?: "info" | "warn";
}) {
  if (!values?.length) {
    return null;
  }
  return (
    <div className="job-audit-tag-group">
      <span>{label}</span>
      <div>
        {values.map((value) => (
          <span className={`tag ${tone}`} key={value}>
            {value}
          </span>
        ))}
      </div>
    </div>
  );
}

function ScoreMetadata({ detail }: { detail: JobDetail }) {
  const { job } = detail;
  const metadata = [
    job.scoreCriteria ? `minimum ${job.scoreCriteria.minFitScore}/10` : null,
    job.scoreTrace?.scoringPolicyVersion ? `policy v${job.scoreTrace.scoringPolicyVersion}` : null,
    job.scoreTrace?.rubricVersion ?? null,
    job.scoreTrace?.policyAnchorCount ? `${job.scoreTrace.policyAnchorCount} anchors` : null,
    job.scoredAt ? `scored ${job.scoredAt}` : null,
  ].filter(Boolean);

  if (!metadata.length) {
    return null;
  }

  return <p className="muted">{metadata.join(" | ")}</p>;
}

function auditFactGroups(detail: JobDetail): Array<{ label: string; facts: ApplyAuditFact[] }> {
  const { applyAudit } = detail;
  return [
    { label: "Missing", facts: applyAudit.missingPrerequisites },
    { label: "Blockers", facts: applyAudit.hardBlockers },
    { label: "Eligibility", facts: applyAudit.eligibilityConcerns },
    { label: "Sources", facts: sourceFacts(applyAudit.sources) },
  ].filter((group) => group.facts.length > 0);
}

function sourceFacts(sources: readonly ApplyAuditSource[]): ApplyAuditFact[] {
  return sources
    .filter(isInspectableSource)
    .map((source) => ({
      code: `source_${source.kind}`,
      label: source.label,
      detail: sourceDetail(source),
      severity: source.status === "unknown" ? "unknown" : "warning",
      source: source.kind,
    }));
}

function isInspectableSource(source: ApplyAuditSource): boolean {
  if (source.status === "unknown") {
    return true;
  }
  return (
    source.status === "missing" &&
    (source.kind === "application_url" ||
      source.kind === "materials.resume" ||
      source.kind === "materials.pdf")
  );
}

function sourceDetail(source: ApplyAuditSource): string {
  const status = source.status.replace(/_/g, " ");
  return source.detail ? `${status}: ${source.detail}` : status;
}

function factTone(fact: ApplyAuditFact): "muted" | "info" | "ok" | "warn" {
  if (fact.severity === "unknown") {
    return "muted";
  }
  if (fact.severity === "success") {
    return "ok";
  }
  if (fact.severity === "info") {
    return "info";
  }
  return "warn";
}
