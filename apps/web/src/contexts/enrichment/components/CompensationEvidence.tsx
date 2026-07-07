import { IconRefresh } from "@tabler/icons-react";
import { type FormEvent, useState } from "react";
import type {
  JobCompensationAudit,
  JobCompensationSummary,
  JobMarketCompensationSummary,
  JobPostedCompensationSummary,
  MarketCompensationEstimate,
  MarketCompensationEvidenceRow,
  MarketCompensationFactor,
  MarketCompensationReason,
  MarketCompensationSourceSnapshot,
  MarketCompensationWarning,
  PostedCompensationFact,
  PostedCompensationWarning,
} from "@jobctl/contracts";

import { Empty } from "../../../shared/ui/empty.js";
import { Input } from "../../../shared/ui/input.js";
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

function plural(count: number, singular: string): string {
  return `${count} ${singular}${count === 1 ? "" : "s"}`;
}

const amountFormatter = new Intl.NumberFormat("en-US", { maximumFractionDigits: 0 });

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

function marketConfidenceText(market: JobMarketCompensationSummary): string {
  if (market.recordStatus !== "recorded") {
    return "market confidence none";
  }
  const score = formatPercent(market.confidenceScore);
  const sourceCount = finiteCount(market.sourceCount);
  const sampleCount = optionalCount(market.sampleCount);
  return [
    `market confidence ${formatToken(market.confidenceBand) || "none"}`,
    score,
    plural(sourceCount, "source"),
    sampleCount === null ? null : plural(sampleCount, "sample"),
  ]
    .filter(Boolean)
    .join(" · ");
}

function postedConfidenceText(posted: JobPostedCompensationSummary): string {
  return `posted confidence ${formatToken(posted.confidence) || "none"}`;
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

  if (summary.market.recordStatus === "recorded" && summary.market.displayRange) {
    return {
      range: summary.market.displayRange,
      source: "reported company-role market",
      confidence: marketConfidenceText(summary.market),
      tone: confidenceTone(summary.market.confidenceBand),
      warningCount: finiteCount(summary.market.warningCount),
    };
  }

  if (summary.posted.displayRange) {
    return {
      range: summary.posted.displayRange,
      source: "posted salary",
      confidence: postedConfidenceText(summary.posted),
      tone: confidenceTone(summary.posted.confidence),
      warningCount: finiteCount(summary.posted.warningCount),
    };
  }

  if (summary.market.recordStatus === "recorded") {
    return {
      range: formatToken(summary.market.estimateState) || "market estimate recorded",
      source: "reported company-role market",
      confidence: marketConfidenceText(summary.market),
      tone: confidenceTone(summary.market.confidenceBand),
      warningCount: finiteCount(summary.market.warningCount),
    };
  }

  if (summary.posted.recordStatus === "recorded") {
    return {
      range: formatToken(summary.posted.parseState) || "posted salary recorded",
      source: "posted salary",
      confidence: postedConfidenceText(summary.posted),
      tone: confidenceTone(summary.posted.confidence),
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
    formatToken(summary.market.confidenceBand),
    finiteCount(summary.market.sourceCount) ? plural(finiteCount(summary.market.sourceCount), "source") : null,
    optionalCount(summary.market.sampleCount) === null
      ? null
      : plural(optionalCount(summary.market.sampleCount) ?? 0, "sample"),
    finiteCount(summary.warningCount) ? plural(finiteCount(summary.warningCount), "warning") : null,
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
      {primary.warningCount ? <span className="tag warn">{plural(primary.warningCount, "warning")}</span> : null}
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
      {primary.warningCount ? <span className="tag warn">{plural(primary.warningCount, "warning")}</span> : null}
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
  readonly warnings: readonly (PostedCompensationWarning | MarketCompensationWarning)[];
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
            <code>{warning.code}</code>
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

function MarketReasonLists({ estimate }: { readonly estimate: MarketCompensationEstimate }) {
  if (estimate.estimateState === "unsupported") {
    return <ReasonList title="Unsupported reasons" reasons={estimate.unsupportedReasons} />;
  }
  if (estimate.estimateState === "source_unavailable") {
    return <ReasonList title="Unavailable-source reasons" reasons={estimate.sourceUnavailableReasons} />;
  }
  if (estimate.estimateState === "insufficient_evidence") {
    return <ReasonList title="Insufficient-evidence reasons" reasons={estimate.insufficientReasons} />;
  }
  return null;
}

function SourceTrail({ sources }: { readonly sources: readonly MarketCompensationSourceSnapshot[] }) {
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
              {[source.aggregateBucket, source.geographyScope, source.releaseYear]
                .filter(Boolean)
                .join(" · ")}
            </span>
            {source.sampleCount === null ? null : <span>{plural(source.sampleCount, "sample")}</span>}
          </li>
        ))}
      </ul>
    </div>
  );
}

function FactorList({ factors }: { readonly factors: readonly MarketCompensationFactor[] }) {
  if (!factors.length) {
    return null;
  }
  return (
    <div className="compensation-factor-list">
      <h4>Confidence factors</h4>
      <ul>
        {factors.map((factor) => (
          <li key={factor.name}>
            <span>{formatToken(factor.name)}</span>
            <b className={`tag ${confidenceTone(factor.band)}`}>
              {formatToken(factor.band)} {formatPercent(factor.score)}
            </b>
            <p>{factor.reason}</p>
          </li>
        ))}
      </ul>
    </div>
  );
}

function EvidenceRows({ rows }: { readonly rows: readonly MarketCompensationEvidenceRow[] }) {
  if (!rows.length) {
    return null;
  }
  return (
    <details className="compensation-evidence-rows">
      <summary>
        <span>Evidence rows</span>
        <b>{plural(rows.length, "row")}</b>
      </summary>
      <div className="compensation-evidence-row-list">
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
              <DetailRow label="Samples" value={row.sampleCount === null ? null : plural(row.sampleCount, "sample")} />
              <DetailRow label="Release" value={row.releaseYear === null ? null : String(row.releaseYear)} />
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

function PostedPanel({
  posted,
  fact,
}: {
  readonly posted: JobPostedCompensationSummary;
  readonly fact: PostedCompensationFact | null;
}) {
  return (
    <article className="compensation-panel">
      <header>
        <span className="eyebrow">Posted Salary</span>
        <b>{posted.displayRange || formatToken(posted.parseState) || "not recorded"}</b>
        <span className={`tag ${confidenceTone(posted.confidence)}`}>{postedConfidenceText(posted)}</span>
      </header>
      <dl className="compensation-detail-grid">
        <DetailRow label="State" value={posted.recordStatus === "recorded" ? formatToken(posted.parseState) : "not recorded"} />
        <DetailRow label="Range" value={posted.displayRange} />
        <DetailRow label="Component" value={posted.range ? formatToken(posted.range.component) : null} />
        <DetailRow label="Period" value={posted.range ? formatToken(posted.range.period) : null} />
        <DetailRow label="Source field" value={fact?.sourceField} />
      </dl>
      {fact && "sourceText" in fact && fact.sourceText ? (
        <p className="meta">Posting evidence: {fact.sourceText}</p>
      ) : null}
      <WarningList title="Posted salary warnings" warnings={fact?.warnings ?? []} />
    </article>
  );
}

function MarketPanel({
  market,
  estimate,
}: {
  readonly market: JobMarketCompensationSummary;
  readonly estimate: MarketCompensationEstimate | null;
}) {
  const score = estimate ? formatPercent(estimate.confidenceScore) : formatPercent(market.confidenceScore);
  return (
    <article className="compensation-panel">
      <header>
        <span className="eyebrow">Reported Company-Role Market</span>
        <b>{market.displayRange || formatToken(market.estimateState) || "not requested"}</b>
        <span className={`tag ${confidenceTone(market.confidenceBand)}`}>{marketConfidenceText(market)}</span>
      </header>
      <dl className="compensation-detail-grid">
        <DetailRow label="State" value={formatToken(market.estimateState)} />
        <DetailRow label="Range" value={market.displayRange} />
        <DetailRow label="Confidence interval" value={market.displayConfidenceInterval} />
        <DetailRow label="Confidence score" value={score} />
        <DetailRow label="Sources" value={finiteCount(market.sourceCount) ? plural(finiteCount(market.sourceCount), "source") : "0 sources"} />
        <DetailRow
          label="Samples"
          value={optionalCount(market.sampleCount) === null ? null : plural(optionalCount(market.sampleCount) ?? 0, "sample")}
        />
        <DetailRow label="Match scope" value={estimate ? formatToken(estimate.matchScope) : null} />
        <DetailRow label="Company tier" value={estimate ? formatToken(estimate.companyTier) : null} />
        <DetailRow label="Component" value={market.range ? formatToken(market.range.component) : null} />
      </dl>
      {estimate ? (
        <>
          <SourceTrail sources={estimate.sources} />
          <EvidenceRows rows={estimate.evidence} />
          <FactorList factors={estimate.factors} />
          <WarningList title="Market warnings" warnings={estimate.warnings} />
          <MarketReasonLists estimate={estimate} />
        </>
      ) : null}
    </article>
  );
}

function CompensationRefreshControl({ jobId }: { readonly jobId: string }) {
  const [observationsJsonPath, setObservationsJsonPath] = useState("");
  const mutation = useRefreshCompensationMutation();
  const path = observationsJsonPath.trim();
  const disabled = mutation.isPending;

  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (disabled) return;
    mutation.mutate({
      jobId,
      ...(path ? { observationsJsonPath: path } : {}),
    });
  };

  return (
    <form className="compensation-refresh-control" onSubmit={submit}>
      <label className="compensation-refresh-path">
        <span>Observation JSON path</span>
        <Input
          value={observationsJsonPath}
          placeholder="/path/to/reported-compensation.json"
          onChange={(event) => setObservationsJsonPath(event.currentTarget.value)}
        />
      </label>
      <button aria-label="refresh compensation" className="tab" disabled={disabled} type="submit">
        <IconRefresh aria-hidden="true" size={14} />
        <span>{disabled ? "refreshing" : "refresh compensation"}</span>
      </button>
      <span className="compensation-refresh-status" aria-live="polite">
        {mutation.isSuccess ? "refreshed" : null}
      </span>
    </form>
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
      <section className="section compensation-audit-section" aria-label="Compensation evidence">
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
      ? {
          projectionVersion: audit.projectionVersion,
          legacyRawSalary: fallbackSalary ?? null,
          warningCount: 0,
          posted: {
            sourceKind: "posted" as const,
            recordStatus: audit.posted.recordStatus,
            parseState: audit.posted.recordStatus === "recorded" ? audit.posted.fact.parseState : null,
            confidence: audit.posted.recordStatus === "recorded" ? audit.posted.fact.confidence : "none",
            warningCount: audit.posted.recordStatus === "recorded" ? audit.posted.fact.warnings.length : 0,
            range: null,
            displayRange: null,
          },
          market: {
            sourceKind: "reported_company_role_market" as const,
            recordStatus: audit.market.recordStatus,
            estimateState: audit.market.recordStatus === "recorded" ? audit.market.estimate.estimateState : "not_requested",
            confidenceBand: audit.market.recordStatus === "recorded" ? audit.market.estimate.confidenceBand : "none",
            confidenceScore: audit.market.recordStatus === "recorded" ? audit.market.estimate.confidenceScore : null,
            sourceCount: audit.market.recordStatus === "recorded" ? audit.market.estimate.sourceCount : 0,
            sampleCount: audit.market.recordStatus === "recorded" ? audit.market.estimate.sampleCount : null,
            warningCount: audit.market.recordStatus === "recorded" ? audit.market.estimate.warnings.length : 0,
            range: null,
            displayRange: null,
            confidenceInterval: null,
            displayConfidenceInterval: null,
          },
        }
      : null);
  const postedFact = audit?.posted.recordStatus === "recorded" ? audit.posted.fact : null;
  const marketEstimate = audit?.market.recordStatus === "recorded" ? audit.market.estimate : null;

  return (
    <section className="section compensation-audit-section" aria-label="Compensation evidence">
      <div className="compensation-audit-heading">
        <h3>Compensation</h3>
        {jobId ? <CompensationRefreshControl jobId={jobId} /> : null}
      </div>
      <CompensationSummaryStrip
        summary={effectiveSummary}
        fallbackSalary={fallbackSalary}
        label="Compensation summary"
      />
      {effectiveSummary ? (
        <div className="compensation-panels">
          <PostedPanel posted={effectiveSummary.posted} fact={postedFact} />
          <MarketPanel market={effectiveSummary.market} estimate={marketEstimate} />
        </div>
      ) : null}
    </section>
  );
}
