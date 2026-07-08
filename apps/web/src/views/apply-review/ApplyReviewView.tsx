import type {
  ApplyAuditFact,
  ApplyAuditSource,
  ApplyReviewRequirementLedAudit,
  ApplyReviewQueueItem,
  ResumeCommentThread,
  ResumeReviewDraft,
  ResumeReviewDraftRenderResponse,
} from "@jobctrl/contracts";
import { IconExternalLink } from "@tabler/icons-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { ACTIVE_APPLY_RUN_STATUSES, CancelApplyButton } from "../../contexts/apply/components/CancelApplyButton.js";
import { ApplyReviewDecisionControls } from "../../contexts/apply/components/ApplyReviewDecisionControls.js";
import {
  useCreateResumeReviewDraftMutation,
  useRenderResumeReviewDraftMutation,
  useReplyToResumeReviewCommentMutation,
  useSaveResumeReviewDraftRevisionMutation,
  useSeedResumeReviewCommentThreadsMutation,
} from "../../contexts/apply/hooks/useApplyReviewMutations.js";
import { CompensationSummaryStrip } from "../../contexts/enrichment/components/CompensationEvidence.js";
import { ArtifactComparison } from "../../contexts/materials/components/ArtifactComparison.js";
import {
  ArtifactGroundingRiskPanel,
  ResumePlateEditor,
  type ResumeDraftGateState,
} from "../../contexts/materials/components/ResumeAuditPins.js";
import { JobResumeTemplateSelect } from "../../contexts/materials/components/JobResumeTemplateSelect.js";
import {
  useEnsureCurrentResumeMaterialsMutation,
  useSetJobResumeTemplateMutation,
} from "../../contexts/materials/hooks/useResumeTemplateMaterialMutations.js";
import { useApplyReviewQueueQuery } from "../../contexts/operations/hooks/useApplyReviewQueueQuery.js";
import { useResumeReviewDraftQuery } from "../../contexts/operations/hooks/useResumeReviewDraftQuery.js";
import { useResumeTemplatesQuery } from "../../contexts/profile/hooks/useResumeTemplatesQuery.js";
import { formatDateTime } from "../../shared/lib/formatters.js";
import { usePorts } from "../../shared/providers/PortsProvider.js";
import { Empty } from "../../shared/ui/empty.js";
import { MarkdownDocument } from "../../shared/ui/MarkdownDocument.js";
import { PageHead } from "../../shared/ui/page-head.js";
import type { PdfAuditLineSelection, PdfAuditLineTarget } from "../../shared/ui/PdfPreviewViewer.js";
import { JobDetailDrawer } from "../jobs/JobDetailDrawer.js";

type MaterialStatus = {
  readonly kind: ApplyReviewQueueItem["applyAudit"]["state"];
  readonly label: string;
  readonly tone: "ok" | "info" | "warn";
};

type ApplyRun = NonNullable<ApplyReviewQueueItem["latestApplyRun"]>;
type ApplyReviewRequirement = ApplyReviewQueueItem["position"]["idealRequirements"][number];
type ScoreDimensionKey = "technicalFit" | "experienceFit" | "roleFit";
type ArtifactComparisonDraftTarget = {
  readonly acceptedArtifactId: string | null;
  readonly artifactId: string;
  readonly riskLabels: readonly string[];
};

const SCORE_DIMENSIONS: ReadonlyArray<[ScoreDimensionKey, string]> = [
  ["technicalFit", "Technical fit"],
  ["experienceFit", "Experience fit"],
  ["roleFit", "Role fit"],
];

function materialStatus(item: ApplyReviewQueueItem): MaterialStatus {
  return {
    kind: item.applyAudit.state,
    label: item.applyAudit.label,
    tone: auditTone(item.applyAudit.state),
  };
}

function auditTone(state: ApplyReviewQueueItem["applyAudit"]["state"]): MaterialStatus["tone"] {
  if (state === "ready") return "ok";
  if (state === "preparing") return "info";
  return "warn";
}

function selectedItem(items: readonly ApplyReviewQueueItem[], selectedJobKey: string | null) {
  return items.find((item) => item.jobKey === selectedJobKey) ?? items[0] ?? null;
}

function reviewStateLabel(item: ApplyReviewQueueItem): string | null {
  if (item.review.state === "pending") {
    return null;
  }
  const decidedAt = item.review.decidedAt ? ` · ${formatDateTime(item.review.decidedAt)}` : "";
  switch (item.review.state) {
    case "approved_submit":
      return `Approved for submit${decidedAt}`;
    case "approved_dry_run":
      return `Approved for dry run${decidedAt}`;
    case "deferred":
      return `Deferred${decidedAt}`;
    case "declined":
      return `Declined${decidedAt}`;
    default:
      return null;
  }
}

function activeApplyRun(item: ApplyReviewQueueItem): ApplyRun | null {
  const run = item.latestApplyRun;
  if (!run || !ACTIVE_APPLY_RUN_STATUSES.has(run.status)) {
    return null;
  }
  return run;
}

function evidenceValues(item: ApplyReviewQueueItem): Array<{ label: string; values: readonly string[] }> {
  return [
    { label: "Profile evidence matched by scorer", values: item.position.matched },
    { label: "Transferable profile evidence", values: item.position.transferable },
    { label: "Job keywords used by scorer", values: item.position.keywords },
  ].filter((group) => group.values.length > 0);
}

function formatRequirementTier(tier: string | null): string | null {
  const text = tier?.replace(/[_-]+/g, " ").trim();
  return text || null;
}

function formatRequirementWeight(weight: number | null): string | null {
  if (weight === null || !Number.isFinite(weight)) {
    return null;
  }
  const percent = weight <= 1 ? weight * 100 : weight;
  return `importance ${Math.round(percent)}%`;
}

function formatRequirementCoverage(
  coverage: ApplyReviewRequirement["coverage"],
): {
  readonly label: string;
  readonly tone: "muted" | "ok" | "warn";
  readonly title: string;
} {
  if (coverage.state === "covered") {
    return {
      label: "covered in tailored resume",
      tone: "ok",
      title: "This requirement is linked to generated resume bullet provenance.",
    };
  }
  if (coverage.state === "not_covered") {
    return {
      label: "not covered in tailored resume",
      tone: "warn",
      title: "Tailored resume bullet provenance was recorded, but no bullet is linked to this requirement.",
    };
  }
  if (coverage.state === "missing_from_resume") {
    return {
      label: "missing from tailored resume",
      tone: "warn",
      title: "Profile evidence may exist, but the accepted tailored resume has no provenance-linked bullet for this requirement.",
    };
  }
  if (coverage.state === "missing_from_profile") {
    return {
      label: "missing from profile",
      tone: "warn",
      title: "The pre-tailor fit audit found no grounded profile evidence for this requirement.",
    };
  }
  return {
    label: "coverage not recorded",
    tone: "muted",
    title: "No tailored resume bullet provenance was recorded for this selected material.",
  };
}

function formatRequirementFit(requirement: ApplyReviewRequirement): {
  readonly label: string;
  readonly tone: "muted" | "ok" | "info" | "warn";
  readonly title: string;
} {
  const fit = requirement.fit;
  const contribution = requirement.contribution;
  const impact =
    contribution && contribution.maxPoints > 0
      ? ` Score impact: ${formatPoints(contribution.awardedPoints)} / ${formatPoints(
          contribution.maxPoints,
        )} points.`
      : "";
  if (!fit) {
    return {
      label: "not assessed",
      tone: "muted",
      title: "No pre-tailor requirement fit assessment was recorded.",
    };
  }
  if (fit.kind === "matched") {
    return {
      label: `matched ${fit.strength}`,
      tone: "ok",
      title: `Candidate evidence matched this requirement before tailoring.${impact}`,
    };
  }
  if (fit.kind === "transferable") {
    return {
      label: "transferable",
      tone: "info",
      title: `${fit.bridge || fit.gap || "Adjacent profile evidence can support this requirement."}${impact}`,
    };
  }
  if (fit.kind === "missing") {
    return {
      label: "missing from profile",
      tone: "warn",
      title: `${fit.reason || "No grounded profile evidence was recorded for this requirement."}${impact}`,
    };
  }
  if (fit.kind === "blocked") {
    return {
      label: "blocked",
      tone: "warn",
      title: `${fit.blocker || "This requirement blocks fit."}${impact}`,
    };
  }
  return {
    label: "not assessed",
    tone: "muted",
    title: `${fit.reason || "No pre-tailor requirement fit assessment was recorded."}${impact}`,
  };
}

function formatRequirementTailoring(requirement: ApplyReviewRequirement): {
  readonly label: string;
  readonly tone: "muted" | "info" | "warn";
  readonly title: string;
} {
  const tailoring = requirement.tailoring;
  if (!tailoring) {
    return {
      label: "not recorded",
      tone: "muted",
      title: "No requirement-level tailoring directive was recorded.",
    };
  }
  return {
    label: formatReadableToken(tailoring.action),
    tone: tailoring.action === "avoid_claim" ? "warn" : "info",
    title:
      tailoring.instruction ||
      `Priority ${Math.round((tailoring.priority <= 1 ? tailoring.priority * 100 : tailoring.priority) || 0)}%.`,
  };
}

const AUDIT_TOKEN_LABELS: Record<string, string> = {
  adjacent_translation: "adjacent translation",
  draft_requires_confirmation: "draft requires confirmation",
  evidence_reframed: "evidence reframed",
  evidence_reframing: "evidence reframing",
  enhancement_coverage: "enhancement coverage",
  fit_score_and_must_have_coverage_below_threshold: "fit score and must-have coverage below threshold",
  fit_score_below_threshold: "fit score below threshold",
  mandatory_requirement_coverage: "mandatory requirement coverage",
  must_have_coverage_below_threshold: "must-have coverage below threshold",
  passed: "passed",
  pinned_required_bullet: "pinned required bullet",
  requirement_coverage: "requirement coverage",
  review_blocked_claims: "review blocked claims",
  verified_only: "verified only",
};

function formatReadableToken(value: string): string {
  const normalized = value.trim();
  const fallback = normalized.replace(/[_-]+/g, " ").trim();
  return AUDIT_TOKEN_LABELS[normalized] ?? (fallback || "not recorded");
}

function formatAuditMessage(value: string): string {
  const normalized = value.trim();
  if (!normalized) {
    return "not recorded";
  }
  return (
    AUDIT_TOKEN_LABELS[normalized] ??
    normalized.replace(/\b[a-z][a-z0-9]*(?:_[a-z0-9]+)+\b/g, (token) => formatReadableToken(token))
  );
}

function formatPoints(value: number): string {
  return Number.isInteger(value) ? `${value}` : value.toFixed(3).replace(/0+$/, "").replace(/\.$/, "");
}

function formatBulletCount(count: number): string {
  return `${count} resume bullet${count === 1 ? "" : "s"}`;
}

function formatEvidenceReference(value: string, index: number): string {
  const bullet = value.match(/(?:^|[_-])bullet[_-]?(\d+)(?:$|[_-])/i) ?? value.match(/(?:^|[_-])bullet[_-]?(\d+)$/i);
  if (bullet?.[1]) {
    return `bullet ${bullet[1]}`;
  }
  const evidence = value.match(/(?:^|[_-])ev(?:idence)?[_-]?([a-z0-9]+)$/i);
  if (evidence?.[1]) {
    return formatReadableToken(evidence[1]);
  }
  return `source ${index + 1}`;
}

function compactEvidenceReferences(values: readonly string[], limit = 4): string[] {
  const references = values
    .map((value, index) => formatEvidenceReference(value, index))
    .filter((value, index, all) => all.indexOf(value) === index)
    .slice(0, limit);
  const hidden = values.length - references.length;
  return hidden > 0 ? [...references, `+${hidden} more`] : references;
}

function formatScoreValue(value: number | null | undefined): string {
  if (value === null || value === undefined || !Number.isFinite(value)) {
    return "not scored";
  }
  return Number.isInteger(value) ? String(value) : value.toFixed(1);
}

function formatScoreBasis(item: ApplyReviewQueueItem): string | null {
  const rawScore = item.scoreTrace?.rawWeightedScore;
  if (rawScore === null || rawScore === undefined) {
    return null;
  }
  const adjustment = item.scoreTrace?.calibrationAdjustment ?? 0;
  if (!adjustment) {
    return `Numeric basis: weighted dimension score ${formatScoreValue(rawScore)}/10 with no adjustment.`;
  }
  const sign = adjustment > 0 ? "+" : "";
  return `Numeric basis: weighted dimension score ${formatScoreValue(rawScore)}/10 with ${sign}${adjustment} adjustment.`;
}

function sourceFacts(item: ApplyReviewQueueItem): ApplyAuditFact[] {
  return item.applyAudit.sources
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
  return source.status === "missing" && (
    source.kind === "application_url" ||
    source.kind === "materials.resume" ||
    source.kind === "materials.pdf"
  );
}

function sourceDetail(source: ApplyAuditSource): string {
  const status = source.status.replace(/_/g, " ");
  return source.detail ? `${status}: ${source.detail}` : status;
}

function ApplyAuditFacts({ item }: { readonly item: ApplyReviewQueueItem }) {
  const groups = [
    { label: "Missing", facts: item.applyAudit.missingPrerequisites },
    { label: "Blockers", facts: item.applyAudit.hardBlockers },
    { label: "Eligibility", facts: item.applyAudit.eligibilityConcerns },
    { label: "Sources", facts: sourceFacts(item) },
  ].filter((group) => group.facts.length > 0);

  if (!groups.length) {
    return null;
  }

  return (
    <dl className="apply-review-audit-facts">
      {groups.map((group) => (
        <div key={group.label}>
          <dt>{group.label}</dt>
          <dd>
            {group.facts.map((fact) => (
              <span className={`tag ${factTone(fact)}`} key={`${group.label}:${fact.code}:${fact.detail ?? ""}`}>
                {fact.detail ? `${fact.label}: ${fact.detail}` : fact.label}
              </span>
            ))}
          </dd>
        </div>
      ))}
    </dl>
  );
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

function ApplyReviewQueue({
  items,
  selected,
  onSelect,
}: {
  readonly items: readonly ApplyReviewQueueItem[];
  readonly selected: ApplyReviewQueueItem;
  readonly onSelect: (jobKey: string) => void;
}) {
  return (
    <aside className="apply-review-queue" aria-label="Application review queue">
      <div className="apply-review-queue-head">
        <span className="eyebrow">Queue</span>
        <b>{items.length} human decision{items.length === 1 ? "" : "s"}</b>
      </div>
      <div className="apply-review-queue-list">
        {items.map((item) => {
          const status = materialStatus(item);
          return (
            <button
              key={item.jobKey}
              type="button"
              className={`apply-review-queue-item${item.jobKey === selected.jobKey ? " selected" : ""}`}
              aria-pressed={item.jobKey === selected.jobKey}
              onClick={() => onSelect(item.jobKey)}
            >
              <span className="apply-review-queue-title">
                <span className="tag ok">{item.fitScore ?? "-"}</span>
                <b>{item.title}</b>
              </span>
              <span className="meta">
                {item.company} · {item.source}
              </span>
              <span className={`tag ${status.tone}`}>{status.label}</span>
            </button>
          );
        })}
      </div>
    </aside>
  );
}

function RequirementEvidence({ item }: { readonly item: ApplyReviewQueueItem }) {
  const groups = evidenceValues(item);
  const scoreBasis = formatScoreBasis(item);
  const scoreReasoning = item.scoreBreakdown?.reasoning || item.scoreReasoning;
  const hasIdealProfile = Boolean(item.position.idealCandidate || item.position.idealRequirements.length);
  const hasScoreRationale = Boolean(item.scoreBreakdown || scoreReasoning || item.fitScore !== null);
  if (!hasIdealProfile && !groups.length && !hasScoreRationale) {
    return <Empty title="No job-need or scoring evidence captured yet." />;
  }
  return (
    <div className="apply-review-fit-evidence">
      {hasIdealProfile ? (
        <div className="apply-review-ideal-profile">
          {item.position.idealCandidate ? (
            <section>
              <h4>Ideal profile from job post</h4>
              <p>{item.position.idealCandidate}</p>
            </section>
          ) : null}
          {item.position.idealRequirements.length ? (
            <section>
              <h4>Job needs from posting</h4>
              <ol className="apply-review-ideal-requirements">
                {item.position.idealRequirements.map((requirement) => {
                  const tier = formatRequirementTier(requirement.tier);
                  const weight = formatRequirementWeight(requirement.weight);
                  const coverage = formatRequirementCoverage(requirement.coverage);
                  const fit = formatRequirementFit(requirement);
                  const tailoring = formatRequirementTailoring(requirement);
                  return (
                    <li key={`${requirement.id}:${requirement.text}`}>
                      <div className="apply-review-ideal-requirement-head">
                        <b>{requirement.text}</b>
                        <span>
                          {tier ? <span className="tag muted">{tier}</span> : null}
                          {weight ? (
                            <span
                              className="tag muted"
                              title="Relative priority from job-post analysis, not a match score"
                            >
                              {weight}
                            </span>
                          ) : null}
                        </span>
                      </div>
                      <div
                        className="apply-review-requirement-fit-grid"
                        aria-label={`Requirement audit for ${requirement.text}`}
                      >
                        <div>
                          <span>Candidate fit</span>
                          <b className={`tag ${fit.tone}`} title={fit.title}>
                            {fit.label}
                          </b>
                        </div>
                        <div>
                          <span>Tailoring action</span>
                          <b className={`tag ${tailoring.tone}`} title={tailoring.title}>
                            {tailoring.label}
                          </b>
                        </div>
                        <div>
                          <span>Resume coverage</span>
                          <b className={`tag ${coverage.tone}`} title={coverage.title}>
                            {coverage.label}
                          </b>
                          {requirement.coverage.state === "covered" ? (
                            <b className="tag muted">
                              {formatBulletCount(requirement.coverage.bulletCount)}
                            </b>
                          ) : null}
                        </div>
                      </div>
                      {requirement.evidence ? (
                        <p className="apply-review-requirement-evidence">
                          <span>Job post evidence:</span> {requirement.evidence}
                        </p>
                      ) : null}
                      {requirement.coverage.examples.length ? (
                        <p className="apply-review-requirement-evidence">
                          <span>Tailored resume evidence:</span> {requirement.coverage.examples.join("; ")}
                        </p>
                      ) : null}
                    </li>
                  );
                })}
              </ol>
            </section>
          ) : null}
        </div>
      ) : null}
      {hasScoreRationale ? (
        <section className="apply-review-score-evidence apply-review-score-rationale" aria-label="Fit score rationale">
          <h4>Why fit score is {formatScoreValue(item.fitScore)}/10</h4>
          {scoreReasoning ? (
            <p>{scoreReasoning}</p>
          ) : (
            <p className="meta">No score rationale was stored for this job.</p>
          )}
          {item.scoreBreakdown ? (
            <div className="score-dimensions" aria-label="Score dimensions">
              {SCORE_DIMENSIONS.map(([key, label]) => (
                <div className="score-dimension" key={key}>
                  <span>{label}</span>
                  <b>{formatScoreValue(item.scoreBreakdown?.[key])} / 10</b>
                </div>
              ))}
              <div className="score-dimension">
                <span>Fit band</span>
                <b>{item.scoreBreakdown.fitBand}</b>
              </div>
              <div className="score-dimension">
                <span>Confidence</span>
                <b>{item.scoreBreakdown.confidence}</b>
              </div>
              <div className="score-dimension">
                <span>Eligibility</span>
                <b>{item.scoreBreakdown.eligibility.status}</b>
              </div>
            </div>
          ) : null}
          {scoreBasis ? <p className="meta">{scoreBasis}</p> : null}
          <dl className="apply-review-evidence-list">
            {groups.map((group) => (
              <div key={group.label}>
                <dt>{group.label}</dt>
                <dd>
                  {group.values.map((value) => (
                    <span className="tag muted" key={value}>
                      {value}
                    </span>
                  ))}
                </dd>
              </div>
            ))}
            <div>
              <dt>Profile gaps found by scorer</dt>
              <dd>
                {item.position.missing.length ? (
                  item.position.missing.map((value) => (
                    <span className="tag muted" key={value}>
                      {value}
                    </span>
                  ))
                ) : (
                  <span className="meta">No missing profile evidence recorded by the scorer.</span>
                )}
              </dd>
            </div>
          </dl>
        </section>
      ) : null}
    </div>
  );
}

function TextPreview({
  title,
  text,
  emptyTitle,
}: {
  readonly title: string;
  readonly text: string | null;
  readonly emptyTitle: string;
}) {
  return (
    <section className="apply-review-preview-block">
      <h3>{title}</h3>
      {text ? <div className="apply-review-document preformatted">{text}</div> : <Empty title={emptyTitle} />}
    </section>
  );
}

function EmailApplicationPreview({ item }: { readonly item: ApplyReviewQueueItem }) {
  const preview = item.emailApplication;
  if (!preview) {
    return null;
  }
  return (
    <section className="apply-review-preview-block">
      <h3>Email application</h3>
      <dl className="apply-review-facts">
        <div>
          <dt>To</dt>
          <dd>{preview.recipient}</dd>
        </div>
        <div>
          <dt>Subject</dt>
          <dd>{preview.subject}</dd>
        </div>
        <div>
          <dt>Attachment</dt>
          <dd>{preview.attachmentName}</dd>
        </div>
      </dl>
      <div className="apply-review-document preformatted">{preview.body}</div>
    </section>
  );
}

function RequirementLedAuditPanel({
  audit,
}: {
  readonly audit: ApplyReviewRequirementLedAudit | null | undefined;
}) {
  if (!audit) {
    return null;
  }

  const coveredLabel = `${audit.coveredRequirements.length}/${audit.requirementCount} requirements covered`;
  const reviewBlockerLabel = `review blockers: ${audit.reviewBlockers.length}`;

  return (
    <section
      className="apply-review-preview-block apply-review-requirement-led-audit"
      aria-label="Requirement-led tailoring audit"
    >
      <h3>Requirement-led tailoring audit</h3>
      <div className="apply-review-audit-summary" aria-label="Requirement-led audit summary">
        <span className={`tag ${audit.uncoveredRequirements.length ? "warn" : "ok"}`}>{coveredLabel}</span>
        {audit.reviewBlockers.length ? <span className="tag warn">{reviewBlockerLabel}</span> : null}
      </div>
      <BulletOverflowAudit overflows={audit.bulletLimitOverflows} />
      <RevisionAudit
        revision={audit.revision}
        shippedFit={audit.shippedFit ?? null}
        reviewBlockers={audit.reviewBlockers}
      />
    </section>
  );
}

function AuditTagGroup({
  label,
  values,
  tone,
  formatValue = (value) => value,
}: {
  readonly label: string;
  readonly values: readonly string[];
  readonly tone: "muted" | "ok" | "warn";
  readonly formatValue?: (value: string) => string;
}) {
  if (!values.length) {
    return null;
  }
  return (
    <div className="apply-review-audit-tags">
      <span>{label}</span>
      <span>
        {values.map((value) => (
          <span className={`tag ${tone}`} key={`${label}:${value}`}>
            {formatValue(value)}
          </span>
        ))}
      </span>
    </div>
  );
}

function BulletOverflowAudit({
  overflows,
}: {
  readonly overflows: readonly ApplyReviewRequirementLedAudit["bulletLimitOverflows"][number][];
}) {
  return (
    <section className="apply-review-audit-section">
      <h4>Mandatory bullet-limit overflow</h4>
      {overflows.length ? (
        <ol className="apply-review-audit-list">
          {overflows.map((overflow) => (
            <li key={`${overflow.experienceEntryId}:${overflow.actualBullets}`}>
              <b>{formatReadableToken(overflow.experienceEntryId)}</b>
              <span className="meta">
                {overflow.actualBullets}/{overflow.maxBullets} bullets retained:{" "}
                {formatReadableToken(overflow.reason)}
              </span>
              <AuditTagGroup label="Evidence" values={compactEvidenceReferences(overflow.evidenceIds)} tone="muted" />
            </li>
          ))}
        </ol>
      ) : (
        <p className="meta">No mandatory bullet-limit overflow was recorded.</p>
      )}
    </section>
  );
}

function RevisionAudit({
  revision,
  shippedFit,
  reviewBlockers,
}: {
  readonly revision: ApplyReviewRequirementLedAudit["revision"];
  readonly shippedFit: ApplyReviewRequirementLedAudit["shippedFit"];
  readonly reviewBlockers: readonly string[];
}) {
  if (!revision && !shippedFit && !reviewBlockers.length) {
    return null;
  }

  return (
    <section className="apply-review-audit-section">
      <h4>Revision gate</h4>
      {shippedFit ? (
        <div className="apply-review-audit-shipped-fit" aria-label="Shipped grounded fit">
          {shippedFit.mustHaveCoverage !== null ? (
            <span className="tag muted">
              Must-have coverage: {Math.round(shippedFit.mustHaveCoverage * 100)}%
            </span>
          ) : null}
          <span className={`tag ${shippedFit.coverageBasis === "grounded_shipped_text_v1" ? "ok" : "warn"}`}>
            {shippedFit.coverageBasis === "grounded_shipped_text_v1"
              ? "grounded (shipped text)"
              : "judge-claimed (legacy)"}
          </span>
          {shippedFit.score !== null ? (
            <span className="tag muted">Shipped fit: {formatScoreValue(shippedFit.score)}/10</span>
          ) : null}
          <span className={`tag ${shippedFit.passed ? "ok" : "warn"}`}>
            {shippedFit.passed ? "meets revision gate" : "below revision gate"}
          </span>
          <AuditTagGroup
            label="Post-acceptance audit findings"
            values={shippedFit.warnings}
            tone="warn"
            formatValue={formatAuditMessage}
          />
        </div>
      ) : null}
      {revision ? (
        <div className="apply-review-audit-revision">
          <span className={`tag ${revision.thresholdFailed || revision.reviewBlocked ? "warn" : "ok"}`}>
            Fit gate: {formatScoreValue(revision.score)}/10
          </span>
          <span className={`tag ${revision.coverageBasis === "grounded_shipped_text_v1" ? "ok" : "warn"}`}>
            {revision.coverageBasis === "grounded_shipped_text_v1" ? "grounded" : "judge-claimed (legacy)"}
          </span>
          {revision.mustHaveCoverage !== null ? (
            <span className="tag muted">
              {shippedFit ? "Gate-recorded coverage" : "Must-have coverage"}:{" "}
              {Math.round(revision.mustHaveCoverage * 100)}%
            </span>
          ) : null}
          {revision.revisionsUsed !== null && revision.maxRevisionAttempts !== null ? (
            <span className="tag muted">
              Revisions used: {revision.revisionsUsed} of {revision.maxRevisionAttempts}
            </span>
          ) : null}
          {revision.reason ? <p className="meta">{formatAuditMessage(revision.reason)}</p> : null}
          <AuditTagGroup label="Prioritized fixes" values={revision.prioritizedFixes} tone="muted" />
          <AuditTagGroup
            label="Revision blockers"
            values={revision.reviewBlockers}
            tone="warn"
            formatValue={formatAuditMessage}
          />
        </div>
      ) : null}
      <AuditTagGroup label="Review blockers" values={reviewBlockers} tone="warn" formatValue={formatAuditMessage} />
    </section>
  );
}

function resumeLineTargets(resumeText: string | null | undefined): PdfAuditLineTarget[] {
  return (resumeText ?? "")
    .split(/\r?\n/)
    .map((line, index) => ({
      lineNumber: index + 1,
      text: line.replace(/\t/g, "  ").trimEnd(),
    }))
    .filter((line) => line.text.trim().length > 0);
}

function ResumeLineReview({
  item,
  onComparisonTargetChange,
  onDraftGateChange,
  selectedLine,
  onSelectLine,
}: {
  readonly item: ApplyReviewQueueItem;
  readonly onComparisonTargetChange?: (target: ArtifactComparisonDraftTarget | null) => void;
  readonly onDraftGateChange: (state: ResumeDraftGateState) => void;
  readonly selectedLine: PdfAuditLineSelection | null;
  readonly onSelectLine: (line: PdfAuditLineSelection | null) => void;
}) {
  const { api } = usePorts();
  const createDraft = useCreateResumeReviewDraftMutation();
  const saveDraftRevision = useSaveResumeReviewDraftRevisionMutation();
  const seedCommentThreads = useSeedResumeReviewCommentThreadsMutation();
  const replyToComment = useReplyToResumeReviewCommentMutation();
  const renderDraft = useRenderResumeReviewDraftMutation();
  const requestedDraftKey = useRef<string | null>(null);
  const renderBaselineArtifactId = useRef<string | null>(null);
  const pdfArtifactId = item.materialsPreview.resumePdfArtifactId;
  const auditArtifactId = item.materialsPreview.resumeTextArtifactId ?? pdfArtifactId;
  const lineTargets = useMemo(() => resumeLineTargets(item.materialsPreview.resumeText), [item.materialsPreview.resumeText]);
  const draftSeedKey = pdfArtifactId && auditArtifactId ? `${item.jobKey}:${auditArtifactId}:${pdfArtifactId}` : null;
  const draftQuery = useResumeReviewDraftQuery(item.jobKey, false);
  const queriedDraft =
    draftQuery.data?.draft.jobKey === item.jobKey ? draftQuery.data.draft : null;
  const createdDraft =
    createDraft.data?.draft.jobKey === item.jobKey ? createDraft.data.draft : null;
  const savedDraft =
    saveDraftRevision.data?.draft.jobKey === item.jobKey ? saveDraftRevision.data.draft : null;
  const seededDraft =
    seedCommentThreads.data?.draft.jobKey === item.jobKey ? seedCommentThreads.data.draft : null;
  const renderedDraftResult =
    renderDraft.data?.draft.jobKey === item.jobKey ? renderDraft.data : null;
  const renderedDraft =
    renderedDraftResult?.draft ?? null;
  const baseDraft = useMemo(
    () => selectLatestResumeReviewDraft([renderedDraft, seededDraft, savedDraft, createdDraft, queriedDraft]),
    [createdDraft, queriedDraft, renderedDraft, savedDraft, seededDraft],
  );
  const draft = useMemo(
    () => mergeDraftThread(baseDraft, replyToComment.data?.thread ?? null),
    [baseDraft, replyToComment.data?.thread],
  );
  const draftError = createDraft.error instanceof Error ? createDraft.error.message : null;
  const saveError = saveDraftRevision.error instanceof Error ? saveDraftRevision.error.message : null;
  const seedError = seedCommentThreads.error instanceof Error ? seedCommentThreads.error.message : null;
  const replyError = replyToComment.error instanceof Error ? replyToComment.error.message : null;
  const renderError = renderDraft.error instanceof Error ? renderDraft.error.message : null;
  const draftLoading = createDraft.isPending && !baseDraft;
  const renderDraftAsync = renderDraft.mutateAsync;
  const handleRenderDraft = useCallback(async () => {
    if (!draft?.currentRevisionId) return false;
    renderBaselineArtifactId.current =
      renderBaselineArtifactId.current ?? draftBaseArtifactId(draft) ?? auditArtifactId;
    const result = await renderDraftAsync({
      draftId: draft.draftId,
      jobId: item.jobKey,
      body: {
        draftRevisionId: draft.currentRevisionId,
      },
    });
    return result.ok;
  }, [auditArtifactId, draft?.currentRevisionId, draft?.draftId, item.jobKey, renderDraftAsync]);
  const comparisonTarget = useMemo(
    () =>
      comparisonDraftTarget(
        renderedDraftResult,
        draft,
        renderBaselineArtifactId.current ?? draftBaseArtifactId(draft) ?? auditArtifactId,
      ),
    [auditArtifactId, draft, renderedDraftResult],
  );

  useEffect(() => {
    onComparisonTargetChange?.(comparisonTarget);
  }, [comparisonTarget, onComparisonTargetChange]);
  useEffect(() => {
    renderBaselineArtifactId.current = null;
  }, [item.jobKey]);

  useEffect(() => {
    if (!draftSeedKey || !pdfArtifactId || !auditArtifactId) return;
    if (requestedDraftKey.current === draftSeedKey) return;
    requestedDraftKey.current = draftSeedKey;
    createDraft.mutate({
      jobId: item.jobKey,
      body: {
        rendererFormat: "html_css",
        resumePdfArtifactId: pdfArtifactId,
        resumeTextArtifactId: item.materialsPreview.resumeTextArtifactId ?? undefined,
      },
    });
  }, [auditArtifactId, createDraft, draftSeedKey, item.jobKey, item.materialsPreview.resumeTextArtifactId, pdfArtifactId]);

  if (!pdfArtifactId || !auditArtifactId) {
    return (
      <TextPreview
        title="Tailored resume"
        text={item.materialsPreview.resumeText}
        emptyTitle="Resume text is still being prepared."
      />
    );
  }
  return (
    <section className="apply-review-preview-block apply-review-html-line-review" aria-label="Resume line review">
      <h3 className="sr-only">Resume line review</h3>
      <ResumePlateEditor
        artifactId={auditArtifactId}
        draft={draft}
        draftError={draftError}
        draftLoading={draftLoading}
        finalUrl={api.artifactPreviewPdfUrl(pdfArtifactId, `${pdfArtifactId}:${item.jobKey}`)}
        htmlUrl={api.artifactPreviewHtmlUrl(pdfArtifactId, `${pdfArtifactId}:${item.jobKey}`)}
        layoutBoxes={item.materialsPreview.resumePdfLayoutBoxes}
        lineTargets={lineTargets}
        profileSourceFields={item.materialsPreview.profileSourceFields}
        renderError={renderError}
        renderPending={renderDraft.isPending}
        renderResult={renderDraft.data ?? null}
        resumeText={item.materialsPreview.resumeText}
        saveError={saveError ?? seedError}
        savePending={saveDraftRevision.isPending}
        replyError={replyError}
        replyPending={replyToComment.isPending}
        selectedLine={selectedLine}
        title="Tailored resume preview"
        onDraftGateChange={onDraftGateChange}
        onPrepareApproval={handleRenderDraft}
        onRenderDraft={() => {
          void handleRenderDraft();
        }}
        onReplyToThread={(thread, input) => {
          replyToComment.mutate({
            jobId: item.jobKey,
            threadId: thread.threadId,
            body: {
              author: "user",
              body: input.body,
              decision: input.decision,
              draftRevisionId: draft?.currentRevisionId ?? undefined,
            },
          });
        }}
        onSaveDraft={({ editedText, plateDocument }) => {
          if (!draft) return;
          saveDraftRevision.mutate({
            draftId: draft.draftId,
            jobId: item.jobKey,
            body: {
              editedText,
              editDeltas: [],
              plateDocument,
            },
          });
        }}
        onSelectLine={onSelectLine}
        onSeedCommentThreads={(threads) => {
          if (!draft || threads.length === 0) return;
          seedCommentThreads.mutate({
            draftId: draft.draftId,
            jobId: item.jobKey,
            body: { threads: [...threads] },
          });
        }}
      />
    </section>
  );
}

function mergeDraftThread(
  draft: ResumeReviewDraft | null,
  thread: ResumeCommentThread | null,
): ResumeReviewDraft | null {
  if (!draft || !thread || thread.draftId !== draft.draftId) return draft;
  const seen = new Set<string>();
  const commentThreads = draft.commentThreads.map((existing) => {
    if (existing.threadId !== thread.threadId) return existing;
    seen.add(thread.threadId);
    return thread;
  });
  if (!seen.has(thread.threadId)) {
    commentThreads.unshift(thread);
  }
  return { ...draft, commentThreads };
}

function comparisonDraftTarget(
  renderResult: ResumeReviewDraftRenderResponse | null,
  draft: ResumeReviewDraft | null,
  acceptedArtifactId: string | null,
): ArtifactComparisonDraftTarget | null {
  if (!renderResult?.ok) {
    return null;
  }
  return {
    acceptedArtifactId: acceptedArtifactId ?? draftBaseArtifactId(draft),
    artifactId: renderResult.artifacts.resumeText.artifactId,
    riskLabels: uniqueRiskLabels(draft?.commentThreads ?? []),
  };
}

function draftBaseArtifactId(draft: ResumeReviewDraft | null): string | null {
  return draft?.baseResumeTextArtifactId ?? draft?.baseResumePdfArtifactId ?? null;
}

function uniqueRiskLabels(commentThreads: readonly ResumeCommentThread[]): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const thread of commentThreads) {
    const label = thread.riskLabel?.trim();
    if (!label || seen.has(label)) continue;
    seen.add(label);
    result.push(label);
  }
  return result;
}

function selectLatestResumeReviewDraft(
  drafts: ReadonlyArray<ResumeReviewDraft | null>,
): ResumeReviewDraft | null {
  return drafts
    .filter((draft): draft is ResumeReviewDraft => Boolean(draft))
    .sort((left, right) => resumeReviewDraftRank(right) - resumeReviewDraftRank(left))[0] ?? null;
}

function resumeReviewDraftRank(draft: ResumeReviewDraft): number {
  const stateRank = draft.state === "promoted" ? 3 : draft.state === "rendered" ? 2 : 1;
  const updatedAt = Date.parse(draft.updatedAt);
  return draft.latestRevisionNumber * 1_000_000_000_000 + stateRank * 1_000_000_000 + (Number.isFinite(updatedAt) ? updatedAt : 0);
}

function ResumeReviewSurface({
  item,
  onComparisonTargetChange,
  onDraftGateChange,
}: {
  readonly item: ApplyReviewQueueItem;
  readonly onComparisonTargetChange: (target: ArtifactComparisonDraftTarget | null) => void;
  readonly onDraftGateChange: (state: ResumeDraftGateState) => void;
}) {
  const [selectedLine, setSelectedLine] = useState<PdfAuditLineSelection | null>(null);

  useEffect(() => {
    setSelectedLine(null);
  }, [item.jobKey]);

  return (
    <section className="apply-review-preview-block apply-review-resume-review" aria-label="Resume audit">
      <div className="apply-review-resume-main">
        <ResumeLineReview
          item={item}
          onComparisonTargetChange={onComparisonTargetChange}
          onDraftGateChange={onDraftGateChange}
          selectedLine={selectedLine}
          onSelectLine={setSelectedLine}
        />
      </div>
    </section>
  );
}

function SelectedReview({ item }: { readonly item: ApplyReviewQueueItem }) {
  const reviewState = reviewStateLabel(item);
  const activeRun = activeApplyRun(item);
  const resumeAuditArtifactId = item.materialsPreview.resumeTextArtifactId ?? item.materialsPreview.resumePdfArtifactId;
  const templatesQuery = useResumeTemplatesQuery();
  const setJobTemplate = useSetJobResumeTemplateMutation();
  const ensureCurrentMaterials = useEnsureCurrentResumeMaterialsMutation();
  const prepareApprovalRef = useRef<(() => Promise<boolean>) | null>(null);
  const [detailJobKey, setDetailJobKey] = useState<string | null>(null);
  const [comparisonDraft, setComparisonDraft] = useState<ArtifactComparisonDraftTarget | null>(null);
  const [draftGate, setDraftGate] = useState<ResumeDraftGateState>({
    draftId: null,
    dirty: false,
    hasSavedRevision: false,
    notice: null,
    preparing: false,
    rendered: false,
    reason: null,
  });
  const handleDraftGateChange = useCallback((next: ResumeDraftGateState) => {
    prepareApprovalRef.current = next.prepareApproval ?? null;
    setDraftGate((previous) =>
      previous.draftId === next.draftId &&
      previous.dirty === next.dirty &&
      previous.hasSavedRevision === next.hasSavedRevision &&
      previous.notice === next.notice &&
      previous.preparing === next.preparing &&
      previous.rendered === next.rendered &&
      previous.reason === next.reason
        ? previous
        : next,
    );
  }, []);
  const handleComparisonTargetChange = useCallback((next: ArtifactComparisonDraftTarget | null) => {
    setComparisonDraft((previous) =>
      previous?.acceptedArtifactId === next?.acceptedArtifactId &&
      previous?.artifactId === next?.artifactId &&
      (previous?.riskLabels ?? []).join("\u0000") === (next?.riskLabels ?? []).join("\u0000")
        ? previous
        : next,
    );
  }, []);
  useEffect(() => {
    setDetailJobKey(null);
    setComparisonDraft(null);
    setDraftGate({
      draftId: null,
      dirty: false,
      hasSavedRevision: false,
      notice: null,
      preparing: false,
      rendered: false,
      reason: null,
    });
    prepareApprovalRef.current = null;
  }, [item.jobKey]);
  const handlePrepareApproval = useCallback(() => prepareApprovalRef.current?.() ?? Promise.resolve(false), []);
  const templateMutationError =
    setJobTemplate.error instanceof Error
      ? setJobTemplate.error.message
      : ensureCurrentMaterials.error instanceof Error
        ? ensureCurrentMaterials.error.message
        : null;
  const handleTemplateChange = useCallback(
    (templateId: string | null) => {
      setJobTemplate.mutate(
        {
          jobKey: item.jobKey,
          body: { templateId, versionId: null },
        },
        {
          onSuccess: (_data, variables) => {
            ensureCurrentMaterials.mutate({ jobKey: variables.jobKey, body: { force: true } });
          },
        },
      );
    },
    [ensureCurrentMaterials, item.jobKey, setJobTemplate],
  );

  return (
    <main className="apply-review-selected">
      <header className="apply-review-selected-head">
        <div
          className="apply-review-selected-context"
          aria-label={`Review controls and material facts for ${item.title}`}
        >
          {reviewState ? <span className="tag muted">Current decision: {reviewState}.</span> : null}
          <CompensationSummaryStrip
            summary={item.compensationSummary}
            label="Compensation"
          />
          <ApplyAuditFacts item={item} />
          <JobResumeTemplateSelect
            current={item.materialsPreview.resumeTemplate}
            disabled={templatesQuery.isLoading || setJobTemplate.isPending || ensureCurrentMaterials.isPending}
            onTemplateChange={handleTemplateChange}
            refreshing={setJobTemplate.isPending || ensureCurrentMaterials.isPending}
            templates={templatesQuery.data?.templates ?? []}
          />
          {templateMutationError ? <span className="tag warn">{templateMutationError}</span> : null}
        </div>
        <div className="apply-review-selected-actions">
          <button
            aria-label={`Open job detail for ${item.title}`}
            className="tab"
            type="button"
            onClick={() => setDetailJobKey(item.jobKey)}
          >
            <IconExternalLink size={14} aria-hidden="true" />
            open job detail
          </button>
          {activeRun ? (
            <CancelApplyButton
              jobId={item.jobKey}
              runId={activeRun.runId}
              className="tab danger-action"
              label="stop apply"
              ariaLabel={`Stop apply run for ${item.title}`}
            />
          ) : null}
          <ApplyReviewDecisionControls
            item={item}
            approvalDisabledReason={draftGate.reason}
            approvalNotice={draftGate.notice}
            approvalPreparing={draftGate.preparing}
            onPrepareApproval={draftGate.notice ? handlePrepareApproval : null}
          />
        </div>
      </header>

      {detailJobKey ? (
        <JobDetailDrawer
          jobId={detailJobKey}
          onClose={() => setDetailJobKey(null)}
        />
      ) : null}

      <section className="apply-review-workspace" aria-label={`Review evidence for ${item.title}`}>
        <article className="apply-review-pane">
          <header>
            <span className="eyebrow">Job Position</span>
            <h2>Requirements and original post</h2>
          </header>
          <div className="apply-review-pane-scroll">
            <section className="apply-review-preview-block">
              <h3>Requirement evidence</h3>
              <RequirementEvidence item={item} />
            </section>
            <section className="apply-review-preview-block">
              <h3>Verbatim job post</h3>
              {item.position.descriptionPreview ? (
                <div className="apply-review-document">
                  <MarkdownDocument
                    emptyTitle="No captured job post text."
                    text={item.position.descriptionPreview}
                  />
                </div>
              ) : (
                <Empty title="No captured job post text." />
              )}
            </section>
          </div>
        </article>

        <article className="apply-review-pane">
          <header>
            <span className="eyebrow">Application Materials</span>
            <h2>Tailored resume and cover</h2>
          </header>
          <div className="apply-review-pane-scroll apply-review-materials-scroll">
            {resumeAuditArtifactId ? <ArtifactGroundingRiskPanel artifactId={resumeAuditArtifactId} /> : null}
            <ArtifactComparison
              emptyRightMessage="Render a saved draft to compare it with the accepted artifact."
              leftArtifactId={comparisonDraft ? comparisonDraft.acceptedArtifactId : resumeAuditArtifactId}
              leftLabel="Accepted"
              rightArtifactId={comparisonDraft?.artifactId ?? null}
              rightLabel="Rendered draft"
              rightRiskLabels={comparisonDraft?.riskLabels ?? []}
            />
            <RequirementLedAuditPanel audit={item.materialsPreview.requirementLedAudit} />
            <ResumeReviewSurface
              item={item}
              onComparisonTargetChange={handleComparisonTargetChange}
              onDraftGateChange={handleDraftGateChange}
            />
            <EmailApplicationPreview item={item} />
            <TextPreview
              title="Cover letter"
              text={item.materialsPreview.coverLetterText}
              emptyTitle="No cover letter is required or available for this job."
            />
          </div>
        </article>
      </section>
    </main>
  );
}

export interface ApplyReviewViewProps {
  readonly targetJobKey?: string | null;
  readonly onTargetJobKeyChange?: (jobKey: string | null) => void;
}

export function ApplyReviewView({
  targetJobKey = null,
  onTargetJobKeyChange,
}: ApplyReviewViewProps = {}) {
  const queue = useApplyReviewQueueQuery();
  const queueError = queue.error instanceof Error ? queue.error.message : null;
  const items = queue.data?.items ?? [];
  const [selectedJobKey, setSelectedJobKey] = useState<string | null>(targetJobKey);
  const selected = selectedItem(items, selectedJobKey);

  useEffect(() => {
    if (!items.length) {
      setSelectedJobKey(null);
      return;
    }
    if (targetJobKey && items.some((item) => item.jobKey === targetJobKey)) {
      setSelectedJobKey(targetJobKey);
      return;
    }
    if (!selectedJobKey || !items.some((item) => item.jobKey === selectedJobKey)) {
      const fallbackJobKey = items[0]?.jobKey ?? null;
      setSelectedJobKey(fallbackJobKey);
      if (targetJobKey && fallbackJobKey !== targetJobKey) {
        onTargetJobKeyChange?.(fallbackJobKey);
      }
    }
  }, [items, onTargetJobKeyChange, selectedJobKey, targetJobKey]);

  const handleSelectJob = (jobKey: string) => {
    setSelectedJobKey(jobKey);
    onTargetJobKeyChange?.(jobKey);
  };

  const statuses = items.map(materialStatus);
  const readyCount = statuses.filter((status) => status.kind === "ready").length;
  const preparingCount = statuses.filter((status) => status.kind === "preparing").length;
  const repairCount = statuses.filter((status) => status.kind === "repair" || status.kind === "blocked").length;

  return (
    <div className="apply-review-layout">
      <PageHead
        eyebrow="Pipeline"
        title="Application review"
        subtitle={`${readyCount} ready · ${preparingCount} preparing · ${repairCount} need repair`}
      />
      <section className="card full">
        {queueError ? <div className="banner inline">{queueError}</div> : null}
        {queue.isFetching && !queue.data ? <Empty title="Loading review queue." /> : null}
        {queue.data && selected ? (
          <div className="apply-review-shell">
            <ApplyReviewQueue items={items} selected={selected} onSelect={handleSelectJob} />
            <SelectedReview item={selected} />
          </div>
        ) : null}
        {queue.data && !items.length ? <Empty title="No application review items." /> : null}
      </section>
    </div>
  );
}
