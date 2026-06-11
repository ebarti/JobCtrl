import type { ApplyAuditFact, ApplyAuditSource } from "@jobhunter/contracts";
import { Link } from "@tanstack/react-router";

import type { JobDetail } from "../../contexts/operations/types.js";

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
        </div>

        <div className="job-audit-triage-column">
          <div className="job-audit-triage-kicker">Apply readiness</div>
          <div className="job-audit-readiness-line">
            <span className={`tag ${auditTone(applyAudit.state)}`}>{applyAudit.label}</span>
            <span>{applyAudit.summary}</span>
          </div>
          {factGroups.length ? (
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
          ) : (
            <p className="muted">No missing prerequisites, blockers, or eligibility concerns recorded.</p>
          )}
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

function auditTone(state: JobDetail["applyAudit"]["state"]): "ok" | "info" | "warn" {
  if (state === "ready") return "ok";
  if (state === "preparing") return "info";
  return "warn";
}

function factTone(fact: ApplyAuditFact): "muted" | "info" | "warn" {
  if (fact.severity === "unknown") {
    return "muted";
  }
  if (fact.severity === "info" || fact.severity === "success") {
    return "info";
  }
  return "warn";
}
