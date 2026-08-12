import { IconChevronDown, IconRefresh } from "@tabler/icons-react";
import type {
  JobCompensationAudit,
  JobCompensationAuditMarketEstimate,
  JobCompensationAuditPostedFact,
  JobCompensationSummary,
  JobMarketCompensationSummary,
  JobPostedCompensationSummary,
  MarketCompensationBenchmarkGeography,
  MarketCompensationBenchmarkLineage,
  MarketCompensationDirectBenchmarkInput,
  MarketCompensationEvidenceRow,
  MarketCompensationFactor,
  MarketCompensationPriceLevelInput,
  MarketCompensationReason,
  MarketCompensationSourceSnapshot,
  MarketCompensationWarning,
  PostedCompensationWarning,
} from "@jobctrl/contracts";

import { Empty } from "../../../shared/ui/empty.js";
import { Button } from "../../../shared/ui/button.js";
import { StatusBadge } from "../../../shared/ui/status-badge.js";
import { useRefreshCompensationMutation } from "../hooks/useRefreshCompensationMutation.js";

type TagTone = "ok" | "info" | "warn" | "muted";

interface PrimaryCompensation {
  readonly range: string;
  readonly source: string;
  readonly confidence: string;
  readonly tone: TagTone;
  readonly warningCount: number;
}

export interface CompensationSummaryCellProps {
  readonly summary: JobCompensationSummary | null;
  readonly fallbackSalary?: string | null;
}

export interface CompensationSummaryStripProps extends CompensationSummaryCellProps {
  readonly label?: string;
}

export interface CompensationAuditSectionProps {
  readonly jobId?: string;
  readonly summary: JobCompensationSummary | null;
  readonly audit: JobCompensationAudit | null;
  readonly fallbackSalary?: string | null;
}

function formatToken(value: string | null | undefined): string {
  return String(value ?? "")
    .replace(/[_-]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function formatPercent(value: number | null | undefined): string | null {
  if (value === null || value === undefined || !Number.isFinite(value)) {
    return null;
  }
  const percent = value <= 1 ? value * 100 : value;
  return `${Math.round(percent)}%`;
}

function finiteCount(value: number | null | undefined): number {
  return Number.isFinite(value) ? Number(value) : 0;
}

function optionalCount(value: number | null | undefined): number | null {
  return Number.isFinite(value) ? Number(value) : null;
}

function plural(
  count: number,
  singular: string,
  pluralForm = `${singular}s`,
): string {
  return `${count} ${count === 1 ? singular : pluralForm}`;
}

function benchmarkSource(market: JobMarketCompensationSummary): string {
  if (market.benchmarkKind === "direct") return "direct market benchmark";
  if (market.benchmarkKind === "extrapolated")
    return "geographically extrapolated benchmark";
  return "reported company-role market";
}

function formatGeography(
  geography: MarketCompensationBenchmarkGeography,
): string {
  return [geography.locality, geography.subdivisionCode, geography.countryCode]
    .filter(Boolean)
    .join(", ");
}

function formatMultiplier(value: number): string {
  return `${Number(value.toFixed(3))}x`;
}

const amountFormatter = new Intl.NumberFormat("en-US", {
  maximumFractionDigits: 0,
});

function formatAmount(value: number): string {
  return amountFormatter.format(value);
}

function formatEvidenceRange(row: MarketCompensationEvidenceRow): string {
  const prefix = row.currency ? `${row.currency} ` : "";
  const suffix = row.period ? `/${row.period}` : "";
  if (row.minimumAmount === row.maximumAmount) {
    return `${prefix}${formatAmount(row.minimumAmount)}${suffix}`;
  }
  return `${prefix}${formatAmount(row.minimumAmount)}-${formatAmount(row.maximumAmount)}${suffix}`;
}

function formatCompensationRange(
  currency: string | null | undefined,
  minimum: number | null | undefined,
  maximum: number | null | undefined,
  period: string | null | undefined,
): string | null {
  if (minimum === null || minimum === undefined) {
    return maximum === null || maximum === undefined
      ? null
      : `${currency ? `${currency} ` : ""}up to ${maximum}${period ? `/${period}` : ""}`;
  }
  const prefix = currency ? `${currency} ` : "";
  const suffix = period ? `/${period}` : "";
  if (maximum === null || maximum === undefined) {
    return `${prefix}${minimum}+${suffix}`;
  }
  return minimum === maximum
    ? `${prefix}${minimum}${suffix}`
    : `${prefix}${minimum}-${maximum}${suffix}`;
}

function auditPostedRange(
  fact: JobCompensationAuditPostedFact,
): JobPostedCompensationSummary["range"] {
  if (fact.parseState !== "parsed_range") return null;
  const displayRange = formatCompensationRange(
    fact.currency,
    fact.minimumAmount,
    fact.maximumAmount,
    fact.period,
  );
  if (!displayRange) return null;
  return {
    currency: fact.currency,
    period: fact.period,
    component: fact.component,
    minimumAmount: fact.minimumAmount,
    maximumAmount: fact.maximumAmount,
    annualizedMinimumAmount: fact.annualizedMinimumAmount,
    annualizedMaximumAmount: fact.annualizedMaximumAmount,
    displayRange,
  };
}

function auditMarketRange(
  estimate: JobCompensationAuditMarketEstimate,
): JobMarketCompensationSummary["range"] {
  if (estimate.estimateState !== "estimated_range") return null;
  const displayRange = formatCompensationRange(
    estimate.currency,
    estimate.minimumAmount,
    estimate.maximumAmount,
    estimate.period,
  );
  if (!displayRange) return null;
  return {
    currency: estimate.currency,
    period: estimate.period,
    component: estimate.component,
    minimumAmount: estimate.minimumAmount,
    maximumAmount: estimate.maximumAmount,
    displayRange,
  };
}

function matchScores(row: MarketCompensationEvidenceRow): string {
  return [
    `company ${formatPercent(row.companyScore)}`,
    `role ${formatPercent(row.roleScore)}`,
    `level ${formatPercent(row.levelScore)}`,
    `location ${formatPercent(row.locationScore)}`,
    `freshness ${formatPercent(row.freshnessScore)}`,
  ]
    .filter(Boolean)
    .join(" · ");
}

function confidenceTone(confidence: string | null | undefined): TagTone {
  if (confidence === "high") return "ok";
  if (confidence === "medium") return "info";
  if (confidence === "low") return "warn";
  return "muted";
}

function marketReliabilityText(market: JobMarketCompensationSummary): string {
  if (market.recordStatus !== "recorded") {
    return "market reliability not available";
  }
  const sourceCount = finiteCount(market.sourceCount);
  const sampleCount = optionalCount(market.sampleCount);
  return [
    `${formatToken(market.confidenceBand) || "no"} reliability`,
    plural(sourceCount, "provider"),
    sampleCount === null ? null : plural(sampleCount, "sample"),
  ]
    .filter(Boolean)
    .join(" · ");
}

function postedAuthorityText(posted: JobPostedCompensationSummary): string {
  if (
    posted.recordStatus === "recorded" &&
    posted.parseState === "parsed_range"
  ) {
    return "employer posted";
  }
  if (posted.recordStatus === "recorded") {
    return "posting needs review";
  }
  return "not stated by employer";
}

function primaryCompensation(
  summary: JobCompensationSummary | null,
  fallbackSalary: string | null | undefined,
): PrimaryCompensation {
  const legacy = summary?.legacyRawSalary || fallbackSalary || null;
  if (!summary) {
    return legacy
      ? {
          range: legacy,
          source: "legacy posting text",
          confidence: "confidence not recorded",
          tone: "muted",
          warningCount: 0,
        }
      : {
          range: "not recorded",
          source: "no compensation evidence",
          confidence: "confidence none",
          tone: "muted",
          warningCount: 0,
        };
  }

  if (
    summary.market.recordStatus === "recorded" &&
    summary.market.displayRange
  ) {
    return {
      range: summary.market.displayRange,
      source: benchmarkSource(summary.market),
      confidence: marketReliabilityText(summary.market),
      tone: confidenceTone(summary.market.confidenceBand),
      warningCount: finiteCount(summary.market.warningCount),
    };
  }

  if (summary.posted.displayRange) {
    return {
      range: summary.posted.displayRange,
      source: "posted salary",
      confidence: postedAuthorityText(summary.posted),
      tone: "ok",
      warningCount: finiteCount(summary.posted.warningCount),
    };
  }

  if (summary.market.recordStatus === "recorded") {
    return {
      range:
        formatToken(summary.market.estimateState) || "market estimate recorded",
      source: benchmarkSource(summary.market),
      confidence: marketReliabilityText(summary.market),
      tone: confidenceTone(summary.market.confidenceBand),
      warningCount: finiteCount(summary.market.warningCount),
    };
  }

  if (summary.posted.recordStatus === "recorded") {
    return {
      range: formatToken(summary.posted.parseState) || "posted salary recorded",
      source: "posted salary",
      confidence: postedAuthorityText(summary.posted),
      tone: "warn",
      warningCount: finiteCount(summary.posted.warningCount),
    };
  }

  if (legacy) {
    return {
      range: legacy,
      source: "legacy posting text",
      confidence: "confidence not recorded",
      tone: "muted",
      warningCount: finiteCount(summary.warningCount),
    };
  }

  return {
    range: "not recorded",
    source: "posted salary missing · market not requested",
    confidence: "confidence none",
    tone: "muted",
    warningCount: finiteCount(summary.warningCount),
  };
}

export function compensationSearchText(
  summary: JobCompensationSummary | null,
  fallbackSalary?: string | null,
): string {
  const primary = primaryCompensation(summary, fallbackSalary);
  if (!summary) {
    return `${primary.range} ${primary.source} ${primary.confidence}`;
  }
  return [
    primary.range,
    primary.source,
    primary.confidence,
    formatToken(summary.posted.parseState),
    formatToken(summary.market.estimateState),
    formatToken(summary.market.benchmarkKind),
    formatToken(summary.market.confidenceBand),
    finiteCount(summary.market.sourceCount)
      ? plural(finiteCount(summary.market.sourceCount), "source")
      : null,
    optionalCount(summary.market.sampleCount) === null
      ? null
      : plural(optionalCount(summary.market.sampleCount) ?? 0, "sample"),
    finiteCount(summary.warningCount)
      ? plural(finiteCount(summary.warningCount), "warning")
      : null,
  ]
    .filter(Boolean)
    .join(" ");
}

export function CompensationSummaryCell({
  summary,
  fallbackSalary = null,
}: CompensationSummaryCellProps) {
  const primary = primaryCompensation(summary, fallbackSalary);
  return (
    <div
      className="compensation-cell"
      aria-label={`Compensation ${primary.range}; ${primary.confidence}`}
      title={`${primary.source}; ${primary.confidence}`}
    >
      <b>{primary.range}</b>
      <span>{primary.source}</span>
      <span className={`tag ${primary.tone}`}>{primary.confidence}</span>
      {primary.warningCount ? (
        <StatusBadge tone="warn">
          {plural(primary.warningCount, "warning")}
        </StatusBadge>
      ) : null}
    </div>
  );
}

export function CompensationSummaryStrip({
  summary,
  fallbackSalary = null,
  label = "Compensation",
}: CompensationSummaryStripProps) {
  const primary = primaryCompensation(summary, fallbackSalary);
  return (
    <section className="compensation-strip" aria-label={label}>
      <span className="compensation-strip-label">{label}</span>
      <b>{primary.range}</b>
      <span>{primary.source}</span>
      <span className={`tag ${primary.tone}`}>{primary.confidence}</span>
      {primary.warningCount ? (
        <StatusBadge tone="warn">
          {plural(primary.warningCount, "warning")}
        </StatusBadge>
      ) : null}
    </section>
  );
}

function DetailRow({
  label,
  value,
}: {
  readonly label: string;
  readonly value: string | number | null | undefined;
}) {
  if (value === null || value === undefined || value === "") {
    return null;
  }
  return (
    <div>
      <dt>{label}</dt>
      <dd>{value}</dd>
    </div>
  );
}

function DetailLinkRow({
  label,
  href,
  children,
}: {
  readonly label: string;
  readonly href: string | null | undefined;
  readonly children: string;
}) {
  if (!href) {
    return null;
  }
  return (
    <div>
      <dt>{label}</dt>
      <dd>
        <a href={href} target="_blank" rel="noreferrer">
          {children}
        </a>
      </dd>
    </div>
  );
}

function WarningList({
  title,
  warnings,
}: {
  readonly title: string;
  readonly warnings: readonly (
    | PostedCompensationWarning
    | MarketCompensationWarning
  )[];
}) {
  if (!warnings.length) {
    return null;
  }
  return (
    <div className="compensation-warning-list">
      <h4>{title}</h4>
      <ul>
        {warnings.map((warning) => (
          <li key={`${warning.code}:${warning.message}`}>
            <span>{warning.message}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}

function ReasonList({
  title,
  reasons,
}: {
  readonly title: string;
  readonly reasons: readonly MarketCompensationReason[];
}) {
  if (!reasons.length) {
    return null;
  }
  return (
    <div className="compensation-warning-list">
      <h4>{title}</h4>
      <ul>
        {reasons.map((reason) => (
          <li key={`${reason.code}:${reason.message}`}>{reason.message}</li>
        ))}
      </ul>
    </div>
  );
}

function MarketReasonLists({
  estimate,
}: {
  readonly estimate: JobCompensationAuditMarketEstimate;
}) {
  if (estimate.estimateState === "unsupported") {
    return (
      <ReasonList
        title="Unsupported reasons"
        reasons={estimate.unsupportedReasons}
      />
    );
  }
  if (estimate.estimateState === "source_unavailable") {
    return (
      <ReasonList
        title="Unavailable-source reasons"
        reasons={estimate.sourceUnavailableReasons}
      />
    );
  }
  if (estimate.estimateState === "insufficient_evidence") {
    return (
      <ReasonList
        title="Why no range is shown"
        reasons={estimate.insufficientReasons}
      />
    );
  }
  return null;
}

function SourceTrail({
  sources,
}: {
  readonly sources: readonly MarketCompensationSourceSnapshot[];
}) {
  if (!sources.length) {
    return null;
  }
  return (
    <div className="compensation-source-trail">
      <h4>Reported source trail</h4>
      <ul>
        {sources.map((source) => (
          <li key={`${source.sourceId}:${source.snapshotVersion}`}>
            <b>{source.displayName}</b>
            <span>
              {[
                source.aggregateBucket,
                source.geographyScope,
                source.releaseYear,
              ]
                .filter(Boolean)
                .join(" · ")}
            </span>
            {source.sampleCount === null ? null : (
              <span>{plural(source.sampleCount, "sample")}</span>
            )}
          </li>
        ))}
      </ul>
    </div>
  );
}

function factorExplanation(
  factor: MarketCompensationFactor,
  estimate: JobCompensationAuditMarketEstimate,
): string {
  if (
    estimate.estimatorVersion.startsWith(
      "company-role-reported-compensation-canonical-benchmark-",
    )
  ) {
    return factor.reason;
  }
  const score = formatPercent(factor.score) ?? "no";
  const company = estimate.companyName || "this company";
  if (factor.name === "company") {
    if (estimate.matchScope === "exact_company_role") {
      return `Direct reported salary evidence matched ${company}; company support is ${score}.`;
    }
    if (estimate.matchScope === "company_adjacent_role") {
      return `Direct ${company} evidence exists only for adjacent roles; company support is ${score}.`;
    }
    if (estimate.matchScope === "tier_role_fallback") {
      return `No direct ${company} salary record matched; comparable-company evidence provides ${score} support.`;
    }
    if (estimate.matchScope === "same_location_role_fallback") {
      return `No direct ${company} salary record matched; same-location role evidence provides ${score} support.`;
    }
    if (estimate.matchScope === "market_baseline_fallback") {
      return `No direct ${company} salary record matched; broader market evidence provides ${score} support.`;
    }
  }
  if (factor.name === "level") {
    return `The job was classified as ${formatToken(estimate.seniorityLabel) || "an unknown level"}; selected records provide ${score} seniority support.`;
  }
  if (factor.name === "role") {
    return `Selected records provide ${score} support for ${estimate.roleTitle || "this role"}.`;
  }
  return factor.reason;
}

function benchmarkLevelLabel(
  estimate: JobCompensationAuditMarketEstimate,
): string {
  const level = formatToken(estimate.seniorityLabel);
  return !level || level === "unknown" ? "all levels" : level;
}

function isLegacyMarketAssessment(
  estimate: JobCompensationAuditMarketEstimate,
): boolean {
  return /^company-role-reported-compensation-v[12](?::|$)/.test(
    estimate.estimatorVersion,
  );
}

function isCanonicalAllLevelBenchmark(
  estimate: JobCompensationAuditMarketEstimate,
): boolean {
  return (
    estimate.estimatorVersion.startsWith(
      "company-role-reported-compensation-canonical-benchmark-",
    ) && benchmarkLevelLabel(estimate) === "all levels"
  );
}

function FactorList({
  factors,
  estimate,
}: {
  readonly factors: readonly MarketCompensationFactor[];
  readonly estimate: JobCompensationAuditMarketEstimate;
}) {
  if (!factors.length) {
    return null;
  }
  return (
    <div className="compensation-factor-list">
      <h4>Reliability factors</h4>
      <ul>
        {factors.map((factor) => (
          <li key={factor.name}>
            <span>{formatToken(factor.name)}</span>
            <b className={`tag ${confidenceTone(factor.band)}`}>
              {formatPercent(factor.score)} support
            </b>
            <p>{factorExplanation(factor, estimate)}</p>
          </li>
        ))}
      </ul>
    </div>
  );
}

function EvidenceRows({
  rows,
  sources,
  sampleCount,
}: {
  readonly rows: readonly MarketCompensationEvidenceRow[];
  readonly sources: readonly MarketCompensationSourceSnapshot[];
  readonly sampleCount: number | null;
}) {
  if (!rows.length) {
    return null;
  }
  const providerCount = new Set([
    ...rows.map((row) => row.sourceId),
    ...sources.map((source) => source.sourceId),
  ]).size;
  const reportedSampleCount = optionalCount(sampleCount);
  return (
    <details className="compensation-disclosure compensation-evidence-rows">
      <summary>
        <span className="compensation-disclosure-label">
          <IconChevronDown aria-hidden="true" size={16} />
          <span>Evidence reviewed</span>
        </span>
        <b>
          {plural(rows.length, "evidence record")} ·{" "}
          {plural(providerCount, "provider")}
          {reportedSampleCount === null
            ? null
            : ` · ${plural(reportedSampleCount, "reported sample")}`}
        </b>
      </summary>
      <div className="compensation-evidence-row-list">
        <SourceTrail sources={sources} />
        {rows.map((row, index) => (
          <article
            key={`${row.sourceId}:${row.companyName}:${row.roleTitle}:${row.minimumAmount}:${row.maximumAmount}:${index}`}
            className="compensation-evidence-row"
          >
            <header>
              <b>{row.displayName}</b>
              <span>{formatEvidenceRange(row)}</span>
            </header>
            <dl>
              <DetailRow label="Company" value={row.companyName} />
              <DetailRow label="Role" value={row.roleTitle} />
              <DetailRow label="Location" value={row.location} />
              <DetailRow label="Level" value={row.levelLabel} />
              <DetailRow label="Tier" value={formatToken(row.companyTier)} />
              <DetailRow label="Component" value={formatToken(row.component)} />
              <DetailRow
                label="Samples"
                value={
                  row.sampleCount === null
                    ? null
                    : plural(row.sampleCount, "sample")
                }
              />
              <DetailRow
                label="Release"
                value={
                  row.releaseYear === null ? null : String(row.releaseYear)
                }
              />
              <DetailLinkRow label="Source" href={row.sourceUrl}>
                Open source
              </DetailLinkRow>
            </dl>
            <p>{matchScores(row)}</p>
          </article>
        ))}
      </div>
    </details>
  );
}

function MarketAssessmentDetails({
  market,
  estimate,
}: {
  readonly market: JobMarketCompensationSummary;
  readonly estimate: JobCompensationAuditMarketEstimate;
}) {
  const lineage = estimate.benchmarkLineage ?? null;
  const score = formatPercent(estimate.confidenceScore) ?? "not scored";
  return (
    <details className="compensation-disclosure compensation-assessment-details">
      <summary>
        <span className="compensation-disclosure-label">
          <IconChevronDown aria-hidden="true" size={16} />
          <span>How this was assessed</span>
        </span>
        <b>{benchmarkLevelLabel(estimate)}</b>
      </summary>
      <div className="compensation-disclosure-content">
        <dl className="compensation-detail-grid">
          <DetailRow
            label="Reliability"
            value={`${formatToken(market.confidenceBand)} · ${score}`}
          />
          <DetailRow label="Role" value={estimate.roleTitle} />
          <DetailRow
            label={
              isLegacyMarketAssessment(estimate)
                ? "Stored benchmark level"
                : "Benchmark level"
            }
            value={benchmarkLevelLabel(estimate)}
          />
          <DetailRow
            label="Match approach"
            value={formatToken(estimate.matchScope)}
          />
          <DetailRow label="Geography" value={estimate.geographyScope} />
          <DetailRow
            label="Component"
            value={market.range ? formatToken(market.range.component) : null}
          />
          <DetailRow
            label="Confidence interval"
            value={market.displayConfidenceInterval}
          />
        </dl>
        <BenchmarkLineage lineage={lineage} />
        <div className="compensation-reliability-explainer">
          <p>
            Overall reliability is capped by the weakest critical match. Each
            percentage below is the support contributed by one input, not a
            probability that the salary is correct.
          </p>
          <FactorList factors={estimate.factors} estimate={estimate} />
        </div>
        <WarningList title="Estimate caveats" warnings={estimate.warnings} />
      </div>
    </details>
  );
}

function DirectBenchmarkInputs({
  inputs,
}: {
  readonly inputs: readonly MarketCompensationDirectBenchmarkInput[];
}) {
  if (!inputs.length) return null;
  return (
    <div className="compensation-lineage-inputs">
      <h5>Direct salary inputs</h5>
      <div className="compensation-lineage-input-list">
        {inputs.map((input) => (
          <article
            className="compensation-lineage-input"
            key={`${input.inputRole}:${input.factId}`}
          >
            <header>
              <b>{formatToken(input.inputRole)}</b>
              <span>
                EUR {formatAmount(input.minimumAmountEur)}-
                {formatAmount(input.maximumAmountEur)}/year
              </span>
            </header>
            <dl>
              <DetailRow
                label="Geography"
                value={formatGeography(input.geography)}
              />
              <DetailRow
                label="Company"
                value={input.normalizedCompany ?? "market aggregate"}
              />
              <DetailRow
                label="Source"
                value={`${input.sourceId} · ${formatToken(input.sourceProvenance)}`}
              />
              <DetailRow label="Snapshot" value={input.sourceSnapshotId} />
              <DetailRow
                label="Samples"
                value={plural(input.sampleCount, "sample")}
              />
              <DetailRow
                label="Confidence"
                value={formatPercent(input.confidenceScore)}
              />
              <DetailRow
                label="Bridge weight"
                value={formatPercent(input.weight)}
              />
              <DetailRow label="As of" value={input.asOfDate} />
              <DetailRow label="Fresh through" value={input.freshUntil} />
              <DetailRow label="Fact ID" value={input.factId} />
            </dl>
          </article>
        ))}
      </div>
    </div>
  );
}

function PriceLevelInputs({
  inputs,
}: {
  readonly inputs: readonly MarketCompensationPriceLevelInput[];
}) {
  if (!inputs.length) return null;
  return (
    <div className="compensation-lineage-inputs">
      <h5>Cost-of-living inputs</h5>
      <div className="compensation-lineage-input-list">
        {inputs.map((input) => (
          <article
            className="compensation-lineage-input"
            key={`${input.inputRole}:${input.factId}`}
          >
            <header>
              <b>{formatToken(input.inputRole)}</b>
              <span>
                {input.countryCode} index {Number(input.indexValue.toFixed(2))}
              </span>
            </header>
            <dl>
              <DetailRow label="Category" value={formatToken(input.category)} />
              <DetailRow label="Reference year" value={input.referenceYear} />
              <DetailRow label="Index base" value={input.baseGeographyCode} />
              <DetailRow label="Source" value={input.sourceId} />
              <DetailRow label="Snapshot" value={input.sourceSnapshotId} />
              <DetailRow
                label="Bridge weight"
                value={formatPercent(input.weight)}
              />
              <DetailRow label="As of" value={input.asOfDate} />
              <DetailRow label="Fresh through" value={input.freshUntil} />
              <DetailRow label="Fact ID" value={input.factId} />
            </dl>
          </article>
        ))}
      </div>
    </div>
  );
}

function BenchmarkLineage({
  lineage,
}: {
  readonly lineage: MarketCompensationBenchmarkLineage | null;
}) {
  if (!lineage) return null;
  const extrapolated = lineage.kind === "extrapolated" ? lineage : null;
  const boundTone: TagTone =
    extrapolated && extrapolated.factorBoundState !== "within_bounds"
      ? "warn"
      : "info";
  return (
    <section
      className={`compensation-benchmark-lineage compensation-benchmark-lineage-${lineage.kind}`}
      aria-label={
        lineage.kind === "direct"
          ? "Direct benchmark lineage"
          : "Geographic extrapolation lineage"
      }
    >
      <header>
        <div>
          <span className="eyebrow">Benchmark authority</span>
          <h4>
            {lineage.kind === "direct"
              ? "Direct country benchmark"
              : "Geographic extrapolation bridge"}
          </h4>
        </div>
        <StatusBadge tone={lineage.kind === "direct" ? "ok" : boundTone}>
          {lineage.kind === "direct" ? "direct evidence" : "derived estimate"}
        </StatusBadge>
      </header>
      {extrapolated ? (
        <p className="compensation-bridge-route">
          <b>{formatGeography(extrapolated.anchorGeography)}</b>
          <span aria-hidden="true">→</span>
          <b>{formatGeography(extrapolated.targetGeography)}</b>
          <span>{formatMultiplier(extrapolated.rawFactor)} raw factor</span>
        </p>
      ) : null}
      <dl className="compensation-detail-grid">
        <DetailRow
          label="Role family"
          value={formatToken(lineage.roleFamilyCode)}
        />
        <DetailRow label="Taxonomy" value={lineage.taxonomyVersion} />
        <DetailRow label="Level" value={formatToken(lineage.seniorityLabel)} />
        <DetailRow
          label="Target geography"
          value={formatGeography(lineage.targetGeography)}
        />
        <DetailRow label="Evidence as of" value={lineage.asOfDate} />
        <DetailRow label="Fresh through" value={lineage.freshUntil} />
        <DetailRow label="Benchmark fact" value={lineage.factId} />
        {extrapolated ? (
          <>
            <DetailRow
              label="Raw factor"
              value={formatMultiplier(extrapolated.rawFactor)}
            />
            <DetailRow
              label="Company evidence weight"
              value={formatPercent(extrapolated.shrinkageWeight)}
            />
            <DetailRow
              label="Matched companies"
              value={plural(
                extrapolated.matchedCompanyCount,
                "company",
                "companies",
              )}
            />
            <DetailRow
              label="Review bounds"
              value={`${formatMultiplier(extrapolated.lowerFactorBound)}-${formatMultiplier(extrapolated.upperFactorBound)} · ${formatToken(extrapolated.factorBoundState)}`}
            />
            <DetailRow label="Formula" value={extrapolated.formulaVersion} />
          </>
        ) : null}
      </dl>
      <DirectBenchmarkInputs inputs={lineage.directInputs} />
      <PriceLevelInputs inputs={lineage.priceLevelInputs} />
    </section>
  );
}

function PostedPanel({
  posted,
  fact,
}: {
  readonly posted: JobPostedCompensationSummary;
  readonly fact: JobCompensationAuditPostedFact | null;
}) {
  const hasPostedRange =
    posted.recordStatus === "recorded" && Boolean(posted.displayRange);
  const parsedFact = fact && fact.parseState === "parsed_range" ? fact : null;
  const equityMentioned =
    fact?.warnings.some((warning) => warning.code === "equity_component") ??
    false;
  const amountIsEquity = parsedFact?.component === "equity";
  const amountIsSpecifiedCash =
    parsedFact !== null &&
    parsedFact.component !== "unknown" &&
    parsedFact.component !== "equity";
  return (
    <article
      aria-label="Employer posted compensation"
      className="compensation-panel compensation-result-card compensation-posted-card"
    >
      <header className="compensation-result-header">
        <h4 className="eyebrow" data-typography="label">
          Employer posted
        </h4>
        <b className="compensation-result-value">
          {posted.displayRange ||
            (posted.recordStatus === "recorded"
              ? "No safe amount extracted"
              : "Not stated")}
        </b>
        <StatusBadge tone={hasPostedRange ? "ok" : "muted"}>
          {hasPostedRange ? "stated in posting" : "no posted range"}
        </StatusBadge>
      </header>
      {hasPostedRange ? (
        <p className="compensation-result-explanation">
          {amountIsEquity
            ? "This is the employer-stated value of the equity or stock compensation described in the posting."
            : equityMentioned && amountIsSpecifiedCash
              ? "This is the cash amount stated in the posting. Stock or equity is mentioned separately and is not included without its own posted value."
              : equityMentioned
                ? "This is the numeric compensation amount stated in the posting. Stock or equity is mentioned separately and is not included without its own posted value."
                : "This amount comes directly from the job posting; it is not a market estimate."}
        </p>
      ) : null}
      {fact ? (
        <details className="compensation-disclosure compensation-posted-evidence">
          <summary>
            <span className="compensation-disclosure-label">
              <IconChevronDown aria-hidden="true" size={16} />
              <span>View posting evidence</span>
            </span>
            <b>{formatToken(fact.parseState)}</b>
          </summary>
          <div className="compensation-disclosure-content">
            <dl className="compensation-detail-grid">
              <DetailRow label="Source field" value={fact.sourceField} />
              <DetailRow
                label="Amount type"
                value={
                  parsedFact?.component === "unknown"
                    ? "numeric amount; component not specified"
                    : formatToken(parsedFact?.component)
                }
              />
              <DetailRow
                label="Period"
                value={formatToken(parsedFact?.period)}
              />
              <DetailRow
                label="Extraction certainty"
                value={formatToken(fact.confidence)}
              />
            </dl>
            {"sourceText" in fact && fact.sourceText ? (
              <blockquote className="compensation-posting-excerpt">
                {fact.sourceText}
              </blockquote>
            ) : null}
            <WarningList
              title="Interpretation notes"
              warnings={fact.warnings}
            />
          </div>
        </details>
      ) : null}
    </article>
  );
}

function MarketPanel({
  market,
  estimate,
}: {
  readonly market: JobMarketCompensationSummary;
  readonly estimate: JobCompensationAuditMarketEstimate | null;
}) {
  const lineage = estimate?.benchmarkLineage ?? null;
  const hasRange =
    market.recordStatus === "recorded" &&
    market.estimateState === "estimated_range" &&
    Boolean(market.displayRange);
  const evidenceCount = estimate?.evidence.length ?? 0;
  const providerCount = estimate
    ? new Set([
        ...estimate.sources.map((source) => source.sourceId),
        ...estimate.evidence.map((row) => row.sourceId),
      ]).size
    : finiteCount(market.sourceCount);
  const sampleCount = optionalCount(market.sampleCount);
  const evidenceCoverage = estimate
    ? `${plural(evidenceCount, "evidence record")} ${evidenceCount === 1 ? "was" : "were"} reviewed across ${plural(providerCount, "provider")}${sampleCount === null ? "" : `, representing ${plural(sampleCount, "reported sample")}`}`
    : `Detailed evidence records are unavailable in this projection${providerCount ? `; the summary records ${plural(providerCount, "provider")}` : ""}${sampleCount === null ? "" : ` and ${plural(sampleCount, "reported sample")}`}`;
  const benchmarkKind = lineage?.kind ?? market.benchmarkKind;
  const benchmarkBasis =
    benchmarkKind === "extrapolated"
      ? "Derived from a matched role-family benchmark in another geography with an auditable adjustment."
      : benchmarkKind === "direct"
        ? "Based on a direct benchmark for the matched role family and geography."
        : "Based on stored reported-compensation evidence selected by the recorded match approach.";
  const allLevelNote =
    estimate && isCanonicalAllLevelBenchmark(estimate)
      ? " The benchmark uses all-level evidence for this role family."
      : "";
  const legacyNote =
    estimate && isLegacyMarketAssessment(estimate)
      ? " This is a stored legacy assessment; refresh this job to use the current role and level classifier."
      : "";
  const outcome = hasRange
    ? {
        value: market.displayRange,
        badge: `${formatToken(market.confidenceBand)} reliability`,
        tone: confidenceTone(market.confidenceBand),
        explanation: `${benchmarkBasis}${allLevelNote} ${evidenceCoverage}.${legacyNote}`,
      }
    : market.estimateState === "insufficient_evidence"
      ? {
          value: "No reliable market range yet",
          badge: "range withheld",
          tone: "warn" as const,
          explanation:
            estimate === null
              ? `${evidenceCoverage}. The recorded outcome did not include a trustworthy numeric range.`
              : evidenceCount > 0
                ? `${evidenceCoverage}, but the evidence did not meet the threshold for a trustworthy numeric range.${legacyNote}`
                : `Available evidence did not meet the threshold for a trustworthy numeric range. See the reasons below.${legacyNote}`,
        }
      : market.estimateState === "source_unavailable"
        ? {
            value: "Market sources unavailable",
            badge: "sources unavailable",
            tone: "warn" as const,
            explanation:
              "Current market sources could not be used. See the source status below, then refresh when current evidence is available.",
          }
        : market.estimateState === "unsupported"
          ? {
              value: "Market range unsupported",
              badge: "unsupported input",
              tone: "warn" as const,
              explanation:
                "This compensation component or input is outside the supported market model. See the reasons below.",
            }
          : {
              value: "Not researched yet",
              badge: "not researched",
              tone: "muted" as const,
              explanation:
                "Refresh this job to research a role, level, and geography benchmark.",
            };
  return (
    <article
      aria-label="Market salary estimate"
      className="compensation-panel compensation-result-card compensation-market-card"
    >
      <header className="compensation-result-header">
        <h4 className="eyebrow" data-typography="label">
          Market salary estimate
        </h4>
        <b className="compensation-result-value">{outcome.value}</b>
        <StatusBadge tone={outcome.tone}>{outcome.badge}</StatusBadge>
      </header>
      <p className="compensation-result-explanation">{outcome.explanation}</p>
      {estimate ? (
        <div className="compensation-market-details">
          <MarketReasonLists estimate={estimate} />
          <EvidenceRows
            rows={estimate.evidence}
            sources={estimate.sources}
            sampleCount={market.sampleCount}
          />
          <MarketAssessmentDetails market={market} estimate={estimate} />
        </div>
      ) : null}
    </article>
  );
}

function RawPostedFallbackPanel({ value }: { readonly value: string }) {
  return (
    <article
      aria-label="Employer posted compensation"
      className="compensation-panel compensation-result-card compensation-posted-card"
    >
      <header className="compensation-result-header">
        <h4 className="eyebrow" data-typography="label">
          Employer posted
        </h4>
        <b className="compensation-result-value">{value}</b>
        <StatusBadge tone="muted">unparsed posting value</StatusBadge>
      </header>
      <p className="compensation-result-explanation">
        This value came from the job posting, but structured compensation
        evidence is not available yet. Refresh this job to parse it.
      </p>
    </article>
  );
}

function CompensationRefreshControl({ jobId }: { readonly jobId: string }) {
  const mutation = useRefreshCompensationMutation();
  const disabled = mutation.isPending;

  return (
    <div className="compensation-refresh-control">
      <Button
        disabled={disabled}
        size="sm"
        type="button"
        variant="outline"
        onClick={() => {
          if (!disabled) mutation.mutate({ jobId });
        }}
      >
        <IconRefresh aria-hidden="true" size={14} />
        <span>{disabled ? "Refreshing this job" : "Refresh this job"}</span>
      </Button>
      <span className="compensation-refresh-status" aria-live="polite">
        {mutation.isSuccess ? "refreshed" : null}
      </span>
    </div>
  );
}

export function CompensationAuditSection({
  jobId,
  summary,
  audit,
  fallbackSalary = null,
}: CompensationAuditSectionProps) {
  if (!summary && !audit && !fallbackSalary) {
    return (
      <section
        className="section compensation-audit-section"
        aria-label="Compensation evidence"
      >
        <div className="compensation-audit-heading">
          <h3>Compensation</h3>
          {jobId ? <CompensationRefreshControl jobId={jobId} /> : null}
        </div>
        <Empty title="No compensation evidence recorded." />
      </section>
    );
  }

  const effectiveSummary =
    summary ??
    (audit
      ? (() => {
          const auditPostedFact =
            audit.posted.recordStatus === "recorded" ? audit.posted.fact : null;
          const auditPosted = auditPostedFact
            ? auditPostedRange(auditPostedFact)
            : null;
          const auditMarketEstimate =
            audit.market.recordStatus === "recorded"
              ? audit.market.estimate
              : null;
          const auditMarket = auditMarketEstimate
            ? auditMarketRange(auditMarketEstimate)
            : null;
          return {
            projectionVersion: audit.projectionVersion,
            legacyRawSalary: fallbackSalary ?? null,
            warningCount: 0,
            posted: {
              sourceKind: "posted" as const,
              recordStatus: audit.posted.recordStatus,
              parseState:
                audit.posted.recordStatus === "recorded"
                  ? audit.posted.fact.parseState
                  : null,
              confidence:
                audit.posted.recordStatus === "recorded"
                  ? audit.posted.fact.confidence
                  : "none",
              warningCount:
                audit.posted.recordStatus === "recorded"
                  ? audit.posted.fact.warnings.length
                  : 0,
              range: auditPosted,
              displayRange: auditPosted?.displayRange ?? null,
            },
            market: {
              sourceKind: "reported_company_role_market" as const,
              recordStatus: audit.market.recordStatus,
              benchmarkKind:
                audit.market.recordStatus === "recorded"
                  ? (audit.market.estimate.benchmarkLineage?.kind ?? null)
                  : null,
              estimateState:
                audit.market.recordStatus === "recorded"
                  ? audit.market.estimate.estimateState
                  : "not_requested",
              confidenceBand:
                audit.market.recordStatus === "recorded"
                  ? audit.market.estimate.confidenceBand
                  : "none",
              confidenceScore:
                audit.market.recordStatus === "recorded"
                  ? audit.market.estimate.confidenceScore
                  : null,
              sourceCount:
                audit.market.recordStatus === "recorded"
                  ? audit.market.estimate.sourceCount
                  : 0,
              sampleCount:
                audit.market.recordStatus === "recorded"
                  ? audit.market.estimate.sampleCount
                  : null,
              warningCount:
                audit.market.recordStatus === "recorded"
                  ? audit.market.estimate.warnings.length
                  : 0,
              range: auditMarket,
              displayRange: auditMarket?.displayRange ?? null,
              confidenceInterval: null,
              displayConfidenceInterval: null,
            },
          };
        })()
      : null);
  const postedFact =
    audit?.posted.recordStatus === "recorded" ? audit.posted.fact : null;
  const marketEstimate =
    audit?.market.recordStatus === "recorded" ? audit.market.estimate : null;
  const rawPostedFallback =
    effectiveSummary?.posted.displayRange || postedFact
      ? null
      : effectiveSummary?.legacyRawSalary || fallbackSalary || null;

  return (
    <section
      className="section compensation-audit-section"
      aria-label="Compensation evidence"
    >
      <div className="compensation-audit-heading">
        <h3>Compensation</h3>
        {jobId ? <CompensationRefreshControl jobId={jobId} /> : null}
      </div>
      {effectiveSummary ? (
        <div className="compensation-panels">
          {rawPostedFallback ? (
            <RawPostedFallbackPanel value={rawPostedFallback} />
          ) : (
            <PostedPanel posted={effectiveSummary.posted} fact={postedFact} />
          )}
          <MarketPanel
            market={effectiveSummary.market}
            estimate={marketEstimate}
          />
        </div>
      ) : fallbackSalary ? (
        <div className="compensation-panels">
          <RawPostedFallbackPanel value={fallbackSalary} />
        </div>
      ) : null}
    </section>
  );
}
