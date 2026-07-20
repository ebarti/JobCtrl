import type {
  ApplyAuditFact,
  ApplyAuditSource,
  ApplyReviewRequirementLedAudit,
  ApplyReviewQueueItem,
  ResumeCommentThread,
  ResumeReviewDraft,
  ResumeReviewDraftRenderResponse,
} from "@jobctrl/contracts";
import {
  IconAlertTriangle,
  IconChevronDown,
  IconExternalLink,
  IconLock,
  IconShieldCheck,
} from "@tabler/icons-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { ACTIVE_APPLY_RUN_STATUSES, CancelApplyButton } from "../../contexts/apply/components/CancelApplyButton.js";
import { ApplyReviewDecisionControls } from "../../contexts/apply/components/ApplyReviewDecisionControls.js";
import {
  useCreateResumeReviewDraftMutation,
  useRenderResumeReviewDraftMutation,
  useRepeatApplicationOverrideMutation,
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
import { Alert, AlertDescription, AlertTitle } from "../../shared/ui/alert.js";
import { Button, buttonVariants } from "../../shared/ui/button.js";
import {
  Card,
  CardAction,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
} from "../../shared/ui/card.js";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "../../shared/ui/collapsible.js";
import { Empty } from "../../shared/ui/empty.js";
import { Input } from "../../shared/ui/input.js";
import { MarkdownDocument } from "../../shared/ui/MarkdownDocument.js";
import { PageHead } from "../../shared/ui/page-head.js";
import type { PdfAuditLineSelection, PdfAuditLineTarget } from "../../shared/ui/PdfPreviewViewer.js";
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "../../shared/ui/select.js";
import { StatusBadge } from "../../shared/ui/status-badge.js";
import "../../styles/redesign-apply-review.css";

type MaterialStatus = {
  readonly kind: ApplyReviewQueueItem["applyAudit"]["state"];
  readonly label: string;
  readonly tone: "ok" | "info" | "warn";
};

type ApplyRun = NonNullable<ApplyReviewQueueItem["latestApplyRun"]>;
type ApplyReviewRequirement = ApplyReviewQueueItem["position"]["idealRequirements"][number];
type ApplyReviewShippedFit = NonNullable<ApplyReviewRequirementLedAudit["shippedFit"]>;
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

function fitTone(score: number | null): "positive" | "neutral" | "negative" | "unknown" {
  if (score === null || !Number.isFinite(score)) return "unknown";
  if (score >= 7) return "positive";
  if (score >= 5) return "neutral";
  return "negative";
}

function selectedItem(
  items: readonly ApplyReviewQueueItem[],
  selectedJobKey: string | null,
  fallbackToFirst: boolean,
) {
  return items.find((item) => item.jobKey === selectedJobKey) ?? (fallbackToFirst ? items[0] : null) ?? null;
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
  age_18_plus: "Age 18+",
  adjacent_translation: "adjacent translation",
  background_check_consent: "Background check consent",
  draft_requires_confirmation: "draft requires confirmation",
  evidence_reframed: "evidence reframed",
  evidence_reframing: "evidence reframing",
  felony_conviction: "Felony conviction",
  enhancement_coverage: "enhancement coverage",
  fit_score_and_must_have_coverage_below_threshold: "fit score and must-have coverage below threshold",
  fit_score_below_threshold: "fit score below threshold",
  mandatory_requirement_coverage: "mandatory requirement coverage",
  must_have_coverage_below_threshold: "must-have coverage below threshold",
  passed: "passed",
  pinned_required_bullet: "pinned required bullet",
  previously_worked_at_employer: "Previously worked at employer",
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
  const missingProfileData = normalized.match(/missing_profile_data\s*:\s*([a-z0-9_, -]+)/i);
  if (missingProfileData?.[1]) {
    const labels = missingProfileData[1]
      .split(",")
      .map((field) => formatReadableToken(field))
      .filter(Boolean);
    const replacement = `required profile answers missing: ${labels.join(", ")}`;
    return normalized.replace(missingProfileData[0], replacement);
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

type ReviewAuditFact = {
  readonly category: string;
  readonly fact: ApplyAuditFact;
  readonly message: string;
};

function reviewAuditMessage(fact: ApplyAuditFact): string {
  return formatAuditMessage(fact.detail ? `${fact.label}: ${fact.detail}` : fact.label);
}

function isTechnicalAuditMessage(message: string): boolean {
  return /\b(?:https?:\/\/|profile[_\s-]?version\b|(?:evidence|artifact|run|source|trace|request)[_\s-]?id\b|diagnostic(?:[_\s-]?(?:id|code|detail))?\b|version\s*[:=])/i.test(
    message,
  );
}

function reviewAuditFacts(item: ApplyReviewQueueItem): readonly ReviewAuditFact[] {
  const groups = [
    { label: "Missing", facts: item.applyAudit.missingPrerequisites },
    { label: "Blockers", facts: item.applyAudit.hardBlockers },
    { label: "Eligibility", facts: item.applyAudit.eligibilityConcerns },
    { label: "Sources", facts: sourceFacts(item) },
  ];
  const seen = new Set<string>();
  const actionableSources = new Set(
    groups
      .filter((group) => group.label !== "Sources")
      .flatMap((group) => group.facts.map((fact) => fact.source)),
  );

  return groups.flatMap((group) =>
    group.facts.flatMap((fact) => {
      if (group.label === "Sources" && actionableSources.has(fact.source)) {
        return [];
      }
      const message = reviewAuditMessage(fact);
      const key = message.toLocaleLowerCase();
      if (seen.has(key)) {
        return [];
      }
      seen.add(key);
      return [{ category: group.label, fact, message }];
    }),
  );
}

function ApplyAuditFacts({ item }: { readonly item: ApplyReviewQueueItem }) {
  const facts = reviewAuditFacts(item);
  const summaryFacts = facts.filter((entry) => !isTechnicalAuditMessage(entry.message));
  const technicalFacts = facts.filter((entry) => isTechnicalAuditMessage(entry.message));
  const blockingCount = summaryFacts.filter((entry) => entry.fact.severity === "blocking").length;
  const warningCount = summaryFacts.filter((entry) => entry.fact.severity === "warning").length;
  const noticeCount = summaryFacts.length - blockingCount - warningCount;

  if (!facts.length) {
    return null;
  }

  return (
    <section className="apply-review-attention-summary" aria-label="Application review summary">
      {summaryFacts.length ? (
        <Alert variant="warning">
          <IconAlertTriangle aria-hidden="true" />
          <AlertTitle>
            {summaryFacts.length} review issue{summaryFacts.length === 1 ? "" : "s"}{" "}
            {summaryFacts.length === 1 ? "requires" : "require"} attention
          </AlertTitle>
          <AlertDescription>
            <div className="apply-review-audit-counts" aria-label="Issue severity summary">
              {blockingCount ? <StatusBadge tone="warn">{blockingCount} blocking</StatusBadge> : null}
              {warningCount ? (
                <StatusBadge tone="warn">
                  {warningCount} warning{warningCount === 1 ? "" : "s"}
                </StatusBadge>
              ) : null}
              {noticeCount ? (
                <StatusBadge tone="muted">
                  {noticeCount} notice{noticeCount === 1 ? "" : "s"}
                </StatusBadge>
              ) : null}
            </div>
            <details className="apply-review-issue-details">
              <summary data-typography="control">Review issue details ({summaryFacts.length})</summary>
              <ul className="apply-review-audit-summary-list">
                {summaryFacts.map(({ category, fact, message }) => (
                  <li key={`${category}:${fact.code}:${fact.detail ?? ""}`}>
                    <strong data-typography="strong-body">{category}:</strong> {message}
                  </li>
                ))}
              </ul>
            </details>
          </AlertDescription>
        </Alert>
      ) : null}
      {technicalFacts.length ? (
        <details className="apply-review-technical-details">
          <summary data-typography="control">Technical details ({technicalFacts.length})</summary>
          <dl>
            {technicalFacts.map(({ category, fact, message }) => (
              <div key={`${category}:${fact.code}:${fact.detail ?? ""}`}>
                <dt data-typography="label">{category}</dt>
                <dd data-typography="body">{message}</dd>
              </div>
            ))}
          </dl>
        </details>
      ) : null}
    </section>
  );
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
  const [query, setQuery] = useState("");
  const normalizedQuery = query.trim().toLocaleLowerCase();
  const filteredItems = normalizedQuery
    ? items.filter((item) =>
        [item.title, item.company, item.source].some((value) =>
          value.toLocaleLowerCase().includes(normalizedQuery),
        ),
      )
    : items;

  return (
    <aside className="apply-review-queue" aria-label="Application review queue">
      <Card className="apply-review-queue-card" size="sm">
        <CardHeader className="apply-review-queue-head border-b">
          <CardTitle>
            <h2 data-typography="component-title">Review queue</h2>
          </CardTitle>
          <CardDescription>Select the next application decision.</CardDescription>
          <CardAction className="apply-review-queue-count">
            {filteredItems.length} of {items.length}
          </CardAction>
        </CardHeader>
        <div className="apply-review-queue-filter">
          <label htmlFor="apply-review-queue-filter" data-typography="label">
            Filter review queue
          </label>
          <Input
            id="apply-review-queue-filter"
            placeholder="Title, company, or source"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
          />
        </div>
        <div className="apply-review-queue-mobile">
          <label id="apply-review-mobile-selector-label" data-typography="label">
            Review item
          </label>
          <Select
            items={items.map((item) => ({
              label: `${item.title} · ${item.company}`,
              value: item.jobKey,
            }))}
            value={selected.jobKey}
            onValueChange={(value) => {
              if (value) onSelect(value);
            }}
          >
            <SelectTrigger
              aria-labelledby="apply-review-mobile-selector-label"
              className="apply-review-queue-mobile-trigger"
            >
              <SelectValue />
            </SelectTrigger>
            <SelectContent alignItemWithTrigger={false}>
              <SelectGroup>
                {items.map((item) => (
                  <SelectItem key={item.jobKey} value={item.jobKey}>
                    {item.title} · {item.company}
                  </SelectItem>
                ))}
              </SelectGroup>
            </SelectContent>
          </Select>
          <span data-typography="metadata">
            {items.findIndex((item) => item.jobKey === selected.jobKey) + 1} of {items.length}
          </span>
        </div>
        <CardContent className="apply-review-queue-list">
          {filteredItems.map((item) => {
            const status = materialStatus(item);
            return (
              <Button
                key={item.jobKey}
                type="button"
                variant="ghost"
                size="content"
                className={`apply-review-queue-item${item.jobKey === selected.jobKey ? " selected" : ""}`}
                aria-pressed={item.jobKey === selected.jobKey}
                onClick={() => onSelect(item.jobKey)}
              >
                <span className="apply-review-queue-title">
                  <span
                    className="apply-review-queue-fit"
                    data-typography="strong-body"
                    data-score-tone={fitTone(item.fitScore)}
                    aria-label={
                      item.fitScore === null
                        ? "Fit score not recorded"
                        : `Fit score ${item.fitScore} out of 10`
                    }
                  >
                    {item.fitScore ?? "–"}
                  </span>
                  <b data-typography="strong-body">{item.title}</b>
                </span>
                <span className="meta" data-typography="metadata">
                  {item.company} · {item.source}
                </span>
                <StatusBadge tone={status.tone}>{status.label}</StatusBadge>
              </Button>
            );
          })}
          {!filteredItems.length ? <Empty title="No review items match this filter." /> : null}
        </CardContent>
      </Card>
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
                          {tier ? <span className="apply-review-requirement-meta">{tier}</span> : null}
                          {weight ? (
                            <span
                              className="apply-review-requirement-meta"
                              title="Relative priority from job-post analysis, not a match score"
                            >
                              {weight}
                            </span>
                          ) : null}
                        </span>
                      </div>
                      <dl
                        className="apply-review-requirement-summary"
                        aria-label={`Requirement audit for ${requirement.text}`}
                      >
                        <div>
                          <dt>Candidate fit</dt>
                          <dd>
                            <StatusBadge tone={fit.tone} title={fit.title}>
                              {fit.label}
                            </StatusBadge>
                          </dd>
                        </div>
                        <div>
                          <dt>Tailoring action</dt>
                          <dd>
                            <StatusBadge tone={tailoring.tone} title={tailoring.title}>
                              {tailoring.label}
                            </StatusBadge>
                          </dd>
                        </div>
                        <div>
                          <dt>Resume coverage</dt>
                          <dd>
                            <StatusBadge tone={coverage.tone} title={coverage.title}>
                              {coverage.label}
                            </StatusBadge>
                            {requirement.coverage.state === "covered" ? (
                              <StatusBadge tone="muted">
                                {formatBulletCount(requirement.coverage.bulletCount)}
                              </StatusBadge>
                            ) : null}
                          </dd>
                        </div>
                      </dl>
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
                    <span className="apply-review-evidence-token" key={value}>
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
                    <span className="apply-review-evidence-token" key={value}>
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
      {text ? (
        <div className="apply-review-document preformatted" data-typography="body">
          {text}
        </div>
      ) : (
        <Empty title={emptyTitle} />
      )}
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
      <div className="apply-review-document preformatted" data-typography="body">
        {preview.body}
      </div>
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
        <StatusBadge tone={audit.uncoveredRequirements.length ? "warn" : "ok"}>{coveredLabel}</StatusBadge>
        {audit.reviewBlockers.length ? <StatusBadge tone="warn">{reviewBlockerLabel}</StatusBadge> : null}
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
      <span data-typography="label">{label}</span>
      <span>
        {values.map((value) => (
          <StatusBadge tone={tone} key={`${label}:${value}`}>
            {formatValue(value)}
          </StatusBadge>
        ))}
      </span>
    </div>
  );
}

function shippedFitFindingsLabel(shippedFit: ApplyReviewShippedFit): string {
  const lifecycle = shippedFit.lifecycle ?? "";
  if (lifecycle === "post_voice_shipped") {
    return shippedFit.passed ? "Post-voice shipped findings" : "Post-voice gate findings";
  }
  if (lifecycle.includes("accept")) {
    return "Post-acceptance audit findings";
  }
  return shippedFit.passed ? "Shipped material findings" : "Gate failure findings";
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
            <StatusBadge tone="muted">
              Must-have coverage: {Math.round(shippedFit.mustHaveCoverage * 100)}%
            </StatusBadge>
          ) : null}
          <StatusBadge tone={shippedFit.coverageBasis === "grounded_shipped_text_v1" ? "ok" : "warn"}>
            {shippedFit.coverageBasis === "grounded_shipped_text_v1"
              ? "grounded (shipped text)"
              : "judge-claimed (legacy)"}
          </StatusBadge>
          {shippedFit.score !== null ? (
            <StatusBadge tone="muted">Shipped fit: {formatScoreValue(shippedFit.score)}/10</StatusBadge>
          ) : null}
          <StatusBadge tone={shippedFit.passed ? "ok" : "warn"}>
            {shippedFit.passed ? "meets revision gate" : "below revision gate"}
          </StatusBadge>
          <AuditTagGroup
            label={shippedFitFindingsLabel(shippedFit)}
            values={shippedFit.warnings}
            tone="warn"
            formatValue={formatAuditMessage}
          />
        </div>
      ) : null}
      {revision ? (
        <div className="apply-review-audit-revision">
          <StatusBadge tone={revision.thresholdFailed || revision.reviewBlocked ? "warn" : "ok"}>
            Fit gate: {formatScoreValue(revision.score)}/10
          </StatusBadge>
          <StatusBadge tone={revision.coverageBasis === "grounded_shipped_text_v1" ? "ok" : "warn"}>
            {revision.coverageBasis === "grounded_shipped_text_v1" ? "grounded" : "judge-claimed (legacy)"}
          </StatusBadge>
          {revision.mustHaveCoverage !== null ? (
            <StatusBadge tone="muted">
              {shippedFit ? "Gate-recorded coverage" : "Must-have coverage"}:{" "}
              {Math.round(revision.mustHaveCoverage * 100)}%
            </StatusBadge>
          ) : null}
          {revision.revisionsUsed !== null && revision.maxRevisionAttempts !== null ? (
            <StatusBadge tone="muted">
              Revisions used: {revision.revisionsUsed} of {revision.maxRevisionAttempts}
            </StatusBadge>
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

function repeatApplicationLiveBlock(item: ApplyReviewQueueItem): string | null {
  const { status } = item.repeatApplication;
  if (status === "blocked") {
    return "Live-submit authorization is blocked by a confirmed application to this canonical opening.";
  }
  if (status === "confirmation_required") {
    return "Live-submit authorization requires confirmation of the related prior application.";
  }
  if (status === "override_consumed") {
    return "The prior confirmation was already used; confirm the current evidence again for another live attempt.";
  }
  return null;
}

function repeatFactLabel(kind: ApplyReviewQueueItem["repeatApplication"]["matches"][number]["priorApplication"]["factKind"]): string {
  switch (kind) {
    case "application_submitted":
      return "worker-confirmed submission";
    case "application_manually_marked":
      return "user-attested external application";
    case "applied_confirmation":
      return "confirmed application outcome";
    case "legacy_applied_status":
      return "historical applied status";
  }
}

function relationshipLabel(
  relationship: ApplyReviewQueueItem["repeatApplication"]["matches"][number]["relationship"],
): string {
  switch (relationship) {
    case "canonical_job":
      return "same canonical job";
    case "canonical_identity":
      return "matching canonical ATS identity";
    case "accepted_duplicate":
      return "accepted duplicate identity";
    case "same_employer_equivalent_role":
      return "same employer and equivalent role";
  }
}

function RepeatApplicationGuardPanel({ item }: { readonly item: ApplyReviewQueueItem }) {
  const assessment = item.repeatApplication;
  const mutation = useRepeatApplicationOverrideMutation();
  const [reason, setReason] = useState("");
  const needsConfirmation = ["blocked", "confirmation_required", "override_consumed"].includes(
    assessment.status,
  );
  const primary = assessment.matches[0] ?? null;

  useEffect(() => {
    setReason("");
    mutation.reset();
  }, [item.jobKey]); // eslint-disable-line react-hooks/exhaustive-deps

  if (assessment.status === "clear" && assessment.auditTrail.length === 0) return null;

  const staleError = mutation.error?.message.includes("stale") || mutation.error?.message.includes("changed");
  const variant = assessment.status === "blocked" ? "destructive" : ["clear", "override_ready"].includes(assessment.status) ? "info" : "warning";
  return (
    <section className="repeat-application-guard" aria-label="Repeat application protection">
      <Alert variant={variant} role={needsConfirmation ? "alert" : "status"}>
        {["clear", "override_ready"].includes(assessment.status) ? (
          <IconShieldCheck aria-hidden="true" />
        ) : (
          <IconLock aria-hidden="true" />
        )}
        <AlertTitle>
          {assessment.status === "override_ready"
            ? "Repeat application confirmation recorded"
            : assessment.status === "clear"
              ? "Repeat application history"
            : assessment.status === "blocked"
              ? "Repeat application blocked"
              : "Review prior application before live submit"}
        </AlertTitle>
        <AlertDescription>{assessment.summary}</AlertDescription>
      </Alert>

      <div className="repeat-application-evidence">
        {assessment.matches.map((match) => (
          <article key={`${match.relationship}:${match.priorApplication.factId}`}>
            <div className="repeat-application-evidence-heading">
              <strong>{match.priorApplication.title}</strong>
              <StatusBadge tone={match.relationship === "same_employer_equivalent_role" ? "warn" : "danger"}>
                {relationshipLabel(match.relationship)}
              </StatusBadge>
            </div>
            <p>
              {match.priorApplication.company} · {repeatFactLabel(match.priorApplication.factKind)} on{" "}
              {formatDateTime(match.priorApplication.confirmedAt)}
            </p>
            <p className="meta">{match.reason}</p>
            <a href={`/jobs/${encodeURIComponent(match.priorApplication.jobKey)}`}>
              Inspect prior application
            </a>
            <details>
              <summary>Identity and audit evidence</summary>
              <ul>
                {match.identityEvidence.map((evidence) => <li key={evidence}>{evidence}</li>)}
                <li>fact: {match.priorApplication.factId}</li>
                <li>evidence fingerprint: {assessment.evidenceFingerprint}</li>
              </ul>
            </details>
          </article>
        ))}
      </div>

      {assessment.override ? (
        <details className="repeat-application-override-audit">
          <summary>Recorded confirmation</summary>
          <dl>
            <div><dt>Reason</dt><dd>{assessment.override.reason}</dd></div>
            <div><dt>Confirmed by</dt><dd>{assessment.override.confirmedBy}</dd></div>
            <div><dt>Confirmed at</dt><dd>{formatDateTime(assessment.override.confirmedAt)}</dd></div>
            <div><dt>Confirmation ID</dt><dd>{assessment.override.overrideId}</dd></div>
            {assessment.override.consumedAt ? (
              <div><dt>Used at</dt><dd>{formatDateTime(assessment.override.consumedAt)}</dd></div>
            ) : null}
          </dl>
        </details>
      ) : null}

      {needsConfirmation && primary && assessment.evidenceFingerprint ? (
        <div className="repeat-application-confirmation-form">
          <label htmlFor={`repeat-application-reason-${encodeURIComponent(item.jobKey)}`}>
            Reason for another live attempt
          </label>
          <Input
            id={`repeat-application-reason-${encodeURIComponent(item.jobKey)}`}
            value={reason}
            maxLength={400}
            placeholder="Explain why another application is intentional (at least 10 characters)."
            onChange={(event) => setReason(event.target.value)}
          />
          <Button
            type="button"
            variant="outline"
            disabled={mutation.isPending || reason.trim().length < 10}
            onClick={() => mutation.mutate({
              jobId: item.jobKey,
              body: {
                evidenceFingerprint: assessment.evidenceFingerprint!,
                priorJobKey: primary.priorApplication.jobKey,
                reason: reason.trim(),
                confirmedBy: "user",
              },
            })}
          >
            {mutation.isPending ? "Recording confirmation" : "Confirm one live attempt"}
          </Button>
          <p className="meta">
            This confirmation is bound to this target, the prior application above, and the current evidence. It is consumed by one worker claim.
          </p>
        </div>
      ) : null}

      {mutation.isError ? (
        <Alert variant="destructive">
          <IconAlertTriangle aria-hidden="true" />
          <AlertTitle>{staleError ? "Prior-application evidence changed" : "Confirmation was not saved"}</AlertTitle>
          <AlertDescription>
            {staleError
              ? "The page is refreshing. Inspect the current relationship before confirming again."
              : mutation.error.message || "Try again after refreshing the review queue."}
          </AlertDescription>
        </Alert>
      ) : null}

      {assessment.auditTrail.length ? (
        <details className="repeat-application-audit-trail">
          <summary>Protection audit trail ({assessment.auditTrail.length})</summary>
          <ol>
            {assessment.auditTrail.map((entry) => (
              <li key={entry.auditId}>
                <p>
                  {entry.action.replaceAll("_", " ")} · {formatDateTime(entry.occurredAt)} · {entry.actor}
                  {entry.reason ? ` — ${entry.reason}` : ""}
                </p>
                <details>
                  <summary>Inspect recorded evidence</summary>
                  {entry.priorJobKey ? (
                    <a href={`/jobs/${encodeURIComponent(entry.priorJobKey)}`}>
                      Inspect selected prior application
                    </a>
                  ) : null}
                  <ul>
                    {entry.evidence.map((match) => (
                      <li key={`${entry.auditId}:${match.relationship}:${match.priorApplication.factId}`}>
                        <a href={`/jobs/${encodeURIComponent(match.priorApplication.jobKey)}`}>
                          {match.priorApplication.title}
                        </a>{" "}at {match.priorApplication.company}
                        {" — "}{relationshipLabel(match.relationship)}; {match.reason}; fact {match.priorApplication.factId}
                      </li>
                    ))}
                    <li>evidence fingerprint: {entry.evidenceFingerprint}</li>
                    <li>target: {entry.targetJobKey}</li>
                  </ul>
                </details>
              </li>
            ))}
          </ol>
        </details>
      ) : null}
    </section>
  );
}

function SelectedReview({ item }: { readonly item: ApplyReviewQueueItem }) {
  const reviewState = reviewStateLabel(item);
  const activeRun = activeApplyRun(item);
  const status = materialStatus(item);
  const resumeAuditArtifactId = item.materialsPreview.resumeTextArtifactId ?? item.materialsPreview.resumePdfArtifactId;
  const templatesQuery = useResumeTemplatesQuery();
  const setJobTemplate = useSetJobResumeTemplateMutation();
  const ensureCurrentMaterials = useEnsureCurrentResumeMaterialsMutation();
  const prepareApprovalRef = useRef<(() => Promise<boolean>) | null>(null);
  const [positionOpen, setPositionOpen] = useState(true);
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
    setPositionOpen(true);
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
    <section className="apply-review-selected" aria-label={`Application decision for ${item.title}`}>
      <Card className="apply-review-decision-card">
        <CardHeader
          className="apply-review-selected-head border-b"
          aria-label={`Review controls and material facts for ${item.title}`}
        >
          <div className="apply-review-selected-context">
            <div className="apply-review-selected-identity">
              <CardTitle>
                <h2 data-typography="section-title">{item.title}</h2>
              </CardTitle>
              <CardDescription>
                {item.company} · discovered via {item.source}
              </CardDescription>
            </div>
          </div>
          <CardAction className="apply-review-selected-card-action">
            <div className="apply-review-selected-summary" aria-label="Selected job status">
              <span className="apply-review-selected-score" data-score-tone={fitTone(item.fitScore)}>
                <b data-typography="metric">{item.fitScore ?? "–"}</b>
                <span data-typography="label">fit</span>
              </span>
              <StatusBadge tone={status.tone}>{status.label}</StatusBadge>
              {reviewState ? <StatusBadge tone="muted">{reviewState}</StatusBadge> : null}
            </div>
            <div className="apply-review-selected-utilities">
              <a
                aria-label={`Open job detail for ${item.title}`}
                className={buttonVariants({ size: "sm", variant: "outline" })}
                href={`/jobs/${encodeURIComponent(item.jobKey)}`}
              >
                <IconExternalLink aria-hidden="true" data-icon="inline-start" />
                open job detail
              </a>
              {activeRun ? (
                <CancelApplyButton
                  jobId={item.jobKey}
                  runId={activeRun.runId}
                  className={buttonVariants({ variant: "destructive", size: "sm" })}
                  label="stop apply"
                  ariaLabel={`Stop apply run for ${item.title}`}
                />
              ) : null}
            </div>
          </CardAction>
        </CardHeader>
        <CardFooter className="apply-review-selected-actions border-b">
          <ApplyReviewDecisionControls
            item={item}
            approvalDisabledReason={draftGate.reason}
            liveSubmitDisabledReason={repeatApplicationLiveBlock(item)}
            approvalNotice={draftGate.notice}
            approvalPreparing={draftGate.preparing}
            onPrepareApproval={draftGate.notice ? handlePrepareApproval : null}
          />
        </CardFooter>
        <CardContent className="apply-review-selected-facts">
          <RepeatApplicationGuardPanel item={item} />
          <CompensationSummaryStrip
            summary={item.compensationSummary}
            label="Compensation"
          />
          <ApplyAuditFacts item={item} />
        </CardContent>
      </Card>

      <section className="apply-review-workspace" aria-label={`Review evidence for ${item.title}`}>
        <Collapsible
          className="apply-review-position-disclosure"
          data-open={positionOpen ? "true" : "false"}
          open={positionOpen}
          onOpenChange={setPositionOpen}
        >
          <Card
            className="apply-review-pane apply-review-evidence-pane"
            role="region"
            aria-labelledby="apply-review-position-heading"
          >
            <CardHeader className="apply-review-pane-heading border-b">
              <CardDescription className="eyebrow" data-typography="label">
                Job position
              </CardDescription>
              <CardTitle>
                <h2
                  data-typography="component-title"
                  id="apply-review-position-heading"
                >
                  Requirements and original post
                </h2>
              </CardTitle>
              <CardAction>
                <CollapsibleTrigger
                  render={
                    <Button
                      aria-label={`${positionOpen ? "Collapse" : "Expand"} job position`}
                      className="apply-review-position-toggle"
                      data-open={positionOpen ? "true" : "false"}
                      size="sm"
                      type="button"
                      variant="ghost"
                    />
                  }
                >
                  {positionOpen ? "Collapse" : "Expand"}
                  <IconChevronDown aria-hidden="true" data-icon="inline-end" />
                </CollapsibleTrigger>
              </CardAction>
            </CardHeader>
            <CollapsibleContent>
              <CardContent className="apply-review-pane-scroll">
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
                <RequirementLedAuditPanel audit={item.materialsPreview.requirementLedAudit} />
              </CardContent>
            </CollapsibleContent>
          </Card>
        </Collapsible>

        <Card
          className="apply-review-pane apply-review-materials-pane"
          role="region"
          aria-labelledby="apply-review-materials-heading"
        >
          <CardHeader className="apply-review-pane-heading border-b">
            <CardDescription className="eyebrow" data-typography="label">
              Application materials
            </CardDescription>
            <CardTitle>
              <h2
                data-typography="component-title"
                id="apply-review-materials-heading"
              >
                Tailored resume and cover
              </h2>
            </CardTitle>
          </CardHeader>
          <CardContent className="apply-review-pane-scroll apply-review-materials-scroll">
            <div className="apply-review-resume-template-control">
              <JobResumeTemplateSelect
                current={item.materialsPreview.resumeTemplate}
                disabled={templatesQuery.isLoading || setJobTemplate.isPending || ensureCurrentMaterials.isPending}
                onTemplateChange={handleTemplateChange}
                refreshing={setJobTemplate.isPending || ensureCurrentMaterials.isPending}
                templates={templatesQuery.data?.templates ?? []}
              />
              {templateMutationError ? (
                <Alert variant="destructive" className="apply-review-inline-alert">
                  <IconAlertTriangle aria-hidden="true" />
                  <AlertTitle>Resume template could not be updated</AlertTitle>
                  <AlertDescription>{templateMutationError}</AlertDescription>
                </Alert>
              ) : null}
            </div>
            <ResumeReviewSurface
              item={item}
              onComparisonTargetChange={handleComparisonTargetChange}
              onDraftGateChange={handleDraftGateChange}
            />
            {resumeAuditArtifactId ? <ArtifactGroundingRiskPanel artifactId={resumeAuditArtifactId} /> : null}
            <ArtifactComparison
              emptyRightMessage="Render a saved draft to compare it with the accepted artifact."
              leftArtifactId={comparisonDraft ? comparisonDraft.acceptedArtifactId : resumeAuditArtifactId}
              leftLabel="Accepted"
              rightArtifactId={comparisonDraft?.artifactId ?? null}
              rightLabel="Rendered draft"
              rightRiskLabels={comparisonDraft?.riskLabels ?? []}
            />
            <EmailApplicationPreview item={item} />
            <TextPreview
              title="Cover letter"
              text={item.materialsPreview.coverLetterText}
              emptyTitle="No cover letter is required or available for this job."
            />
          </CardContent>
        </Card>
      </section>
    </section>
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
  const selected = selectedItem(items, selectedJobKey, !targetJobKey);

  useEffect(() => {
    if (targetJobKey) {
      setSelectedJobKey(targetJobKey);
      return;
    }
    if (!items.length) {
      setSelectedJobKey(null);
      return;
    }
    if (!selectedJobKey || !items.some((item) => item.jobKey === selectedJobKey)) {
      const fallbackJobKey = items[0]?.jobKey ?? null;
      setSelectedJobKey(fallbackJobKey);
    }
  }, [items, selectedJobKey, targetJobKey]);

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
      <section className="apply-review-surface">
        {queueError ? (
          <Alert variant="destructive" className="apply-review-queue-alert">
            <IconAlertTriangle aria-hidden="true" />
            <AlertTitle>Application review queue could not be loaded</AlertTitle>
            <AlertDescription>{queueError}</AlertDescription>
          </Alert>
        ) : null}
        {queue.isFetching && !queue.data ? <Empty title="Loading review queue." /> : null}
        {queue.data && selected ? (
          <div className="apply-review-shell">
            <ApplyReviewQueue items={items} selected={selected} onSelect={handleSelectJob} />
            <SelectedReview item={selected} />
          </div>
        ) : null}
        {queue.data && targetJobKey && !selected ? (
          <Empty title="This job is not in the application review queue." />
        ) : null}
        {queue.data && !targetJobKey && !items.length ? <Empty title="No application review items." /> : null}
      </section>
    </div>
  );
}
