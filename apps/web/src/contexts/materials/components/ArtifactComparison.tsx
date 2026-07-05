import type {
  ArtifactComparison as ArtifactComparisonReadModel,
  ArtifactComparisonSide,
  CoverageDelta,
} from "@jobhunter/contracts";
import { useMemo } from "react";

import { Empty } from "../../../shared/ui/empty.js";
import { useArtifactDetailQuery } from "../../operations/hooks/useArtifactDetailQuery.js";
import { compareArtifactCoverage } from "../selectors/compareCoverage.js";

export interface ArtifactComparisonProps {
  readonly leftArtifactId: string | null | undefined;
  readonly rightArtifactId: string | null | undefined;
  readonly leftLabel?: string;
  readonly rightLabel?: string;
  readonly leftRiskLabels?: readonly string[];
  readonly rightRiskLabels?: readonly string[];
  readonly emptyRightMessage?: string;
  readonly showTitle?: boolean;
}

export function ArtifactComparison({
  leftArtifactId,
  rightArtifactId,
  leftLabel = "Accepted",
  rightLabel = "Comparison",
  leftRiskLabels = [],
  rightRiskLabels = [],
  emptyRightMessage = "Select a second artifact to compare coverage and review rows.",
  showTitle = true,
}: ArtifactComparisonProps) {
  const left = useArtifactDetailQuery(leftArtifactId, { enabled: Boolean(leftArtifactId) });
  const right = useArtifactDetailQuery(rightArtifactId, { enabled: Boolean(rightArtifactId) });
  const comparison = useMemo(
    () =>
      left.data && right.data
        ? compareArtifactCoverage(left.data, right.data, {
            leftLabel,
            rightLabel,
            leftRiskLabels,
            rightRiskLabels,
          })
        : null,
    [left.data, leftLabel, leftRiskLabels, right.data, rightLabel, rightRiskLabels],
  );

  const error =
    left.error instanceof Error
      ? left.error.message
      : right.error instanceof Error
        ? right.error.message
        : null;

  return (
    <div className="artifact-comparison" role="region" aria-label="Artifact comparison">
      {showTitle ? (
        <div className="artifact-comparison-head">
          <h3>Artifact comparison</h3>
          <span>artifact detail rows</span>
        </div>
      ) : null}
      {!leftArtifactId ? <Empty title="Accepted artifact not recorded." /> : null}
      {leftArtifactId && !rightArtifactId ? <Empty title={emptyRightMessage} /> : null}
      {leftArtifactId && rightArtifactId && (left.isLoading || right.isLoading) ? (
        <Empty title="Loading artifact comparison." />
      ) : null}
      {error ? <div className="banner inline">{error}</div> : null}
      {comparison ? <ArtifactComparisonBody comparison={comparison} /> : null}
    </div>
  );
}

function ArtifactComparisonBody({
  comparison,
}: {
  readonly comparison: ArtifactComparisonReadModel;
}) {
  return (
    <div className="artifact-comparison-body">
      <div className="artifact-comparison-sides">
        <ArtifactComparisonSideSummary side={comparison.left} />
        <ArtifactComparisonSideSummary side={comparison.right} />
      </div>
      <CoverageDeltaPanel delta={comparison.coverageDelta} />
    </div>
  );
}

function ArtifactComparisonSideSummary({ side }: { readonly side: ArtifactComparisonSide }) {
  return (
    <section className="artifact-comparison-side" aria-label={`${side.label} artifact summary`}>
      <div className="artifact-comparison-side-head">
        <span className="eyebrow">{side.label}</span>
        <b>{side.title}</b>
      </div>
      <dl className="detail-list compact">
        <div>
          <dt>Status</dt>
          <dd>{side.status}</dd>
        </div>
        <div>
          <dt>Template</dt>
          <dd>{side.templateName ?? side.templateId ?? "not recorded"}</dd>
        </div>
        <div>
          <dt>Coverage</dt>
          <dd>{coverageCountLabel(side)}</dd>
        </div>
        <div>
          <dt>Validation</dt>
          <dd>{validationLabel(side)}</dd>
        </div>
        <div>
          <dt>Judge</dt>
          <dd>{judgeLabel(side)}</dd>
        </div>
      </dl>
      <TagGroup label="Risk labels" values={side.riskLabels} tone="warn" empty="none recorded" />
    </section>
  );
}

function CoverageDeltaPanel({ delta }: { readonly delta: CoverageDelta }) {
  if (!delta.coverageRecorded) {
    return (
      <section className="artifact-comparison-delta" aria-label="Coverage delta">
        <h4>Coverage delta</h4>
        <div className="banner inline">{coverageMissingLabel(delta.state)}</div>
      </section>
    );
  }

  return (
    <section className="artifact-comparison-delta" aria-label="Coverage delta">
      <div className="artifact-comparison-delta-head">
        <h4>Coverage delta</h4>
        {delta.computedAgainst ? <span>{delta.computedAgainst}</span> : null}
      </div>
      <div className="artifact-comparison-delta-grid">
        <TagGroup label="+covered" values={delta.newlyCovered} tone="ok" empty="none recorded" />
        <TagGroup label="lost" values={delta.coverageLost} tone="warn" empty="none recorded" />
        <TagGroup label="missing" values={delta.stillMissing} tone="muted" empty="none recorded" />
      </div>
    </section>
  );
}

function TagGroup({
  label,
  values,
  tone,
  empty,
}: {
  readonly label: string;
  readonly values: readonly string[];
  readonly tone: "muted" | "ok" | "warn";
  readonly empty: string;
}) {
  return (
    <div className="artifact-comparison-tag-group">
      <span>{label}</span>
      <div>
        {values.length ? (
          values.map((value) => (
            <span className={`tag ${tone}`} key={`${label}:${value}`}>
              {value}
            </span>
          ))
        ) : (
          <span className="meta">{empty}</span>
        )}
      </div>
    </div>
  );
}

function coverageCountLabel(side: ArtifactComparisonSide): string {
  if (!side.coverageRecorded || !side.coverageCounts) {
    return "coverage not recorded";
  }
  return `${side.coverageCounts.covered}/${side.coverageCounts.planned} covered; ${side.coverageCounts.missing} missing`;
}

function validationLabel(side: ArtifactComparisonSide): string {
  const status = passLabel(side.validation.passed);
  return `${status}; ${side.validation.errorCount} errors; ${side.validation.warningCount} warnings`;
}

function judgeLabel(side: ArtifactComparisonSide): string {
  const verdict = side.judge.verdict ?? passLabel(side.judge.passed);
  const score =
    side.judge.score === null
      ? "score not recorded"
      : side.judge.minScore === null
        ? `score ${formatPercent(side.judge.score)}`
        : `score ${formatPercent(side.judge.score)} / minimum ${formatPercent(side.judge.minScore)}`;
  return `${verdict}; ${score}; ${side.judge.issueCount} issues`;
}

function formatPercent(value: number): string {
  return `${Math.round(value * 100)}%`;
}

function passLabel(value: boolean | null): string {
  if (value === true) return "passed";
  if (value === false) return "not passed";
  return "not recorded";
}

function coverageMissingLabel(state: CoverageDelta["state"]): string {
  switch (state) {
    case "left_not_recorded":
      return "coverage not recorded for the accepted artifact";
    case "right_not_recorded":
      return "coverage not recorded for the comparison artifact";
    case "not_recorded":
      return "coverage not recorded for either artifact";
    case "recorded":
      return "coverage recorded";
    default:
      return "coverage not recorded";
  }
}
