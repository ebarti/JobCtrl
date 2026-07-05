import type {
  ArtifactComparison,
  ArtifactComparisonCoverageState,
  ArtifactComparisonSide,
  ArtifactDetail,
  BulletCoverageAudit,
  CoverageDelta,
} from "@jobhunter/contracts";

export interface ArtifactComparisonOptions {
  readonly leftLabel?: string;
  readonly rightLabel?: string;
  readonly leftRiskLabels?: readonly string[];
  readonly rightRiskLabels?: readonly string[];
}

export function compareArtifactCoverage(
  left: ArtifactDetail,
  right: ArtifactDetail,
  options: ArtifactComparisonOptions = {},
): ArtifactComparison {
  return {
    left: comparisonSide(left, options.leftLabel ?? "Accepted", options.leftRiskLabels ?? []),
    right: comparisonSide(right, options.rightLabel ?? "Comparison", options.rightRiskLabels ?? []),
    coverageDelta: coverageDelta(
      left.tailoringExplanation?.coverageAudit ?? null,
      right.tailoringExplanation?.coverageAudit ?? null,
    ),
  };
}

function comparisonSide(
  detail: ArtifactDetail,
  label: string,
  riskLabels: readonly string[],
): ArtifactComparisonSide {
  const explanation = detail.tailoringExplanation;
  const template = detail.artifact.resumeTemplate?.effective ?? null;
  const judge = explanation?.judge ?? null;
  const quality = explanation?.quality ?? null;
  return {
    artifactId: detail.artifact.artifactId,
    label,
    title: detail.artifact.title || detail.artifact.type,
    status: detail.artifact.status,
    templateId: template?.templateId ?? null,
    templateName: template?.templateName ?? null,
    coverageRecorded: Boolean(explanation?.coverageAudit),
    coverageCounts: explanation?.coverageAudit?.counts ?? null,
    riskLabels: uniqueStrings(riskLabels),
    validation: {
      passed: quality?.passed ?? null,
      errorCount: quality?.errors.length ?? 0,
      warningCount: quality?.warnings.length ?? 0,
    },
    judge: {
      passed: judge?.passed ?? null,
      verdict: judge?.verdict ?? null,
      score: judge?.score ?? null,
      minScore: judge?.minScore ?? null,
      issueCount:
        (judge?.issues.length ?? 0) +
        (judge?.unsupportedClaims.length ?? 0) +
        (judge?.fabrications.length ?? 0) +
        (judge?.missingRequiredEvidence.length ?? 0),
    },
  };
}

function coverageDelta(
  left: BulletCoverageAudit | null,
  right: BulletCoverageAudit | null,
): CoverageDelta {
  const state = coverageState(left, right);
  if (state !== "recorded" || !left || !right) {
    return {
      coverageRecorded: false,
      state,
      computedAgainst: null,
      newlyCovered: [],
      coverageLost: [],
      newlyDeclared: [],
      declaredLost: [],
      stillDeclared: [],
      stillMissing: [],
    };
  }

  return {
    coverageRecorded: true,
    state,
    computedAgainst: computedAgainstLabel(left, right),
    newlyCovered: difference(right.covered, left.covered),
    coverageLost: difference(left.covered, right.covered),
    newlyDeclared: difference(right.declared, left.declared),
    declaredLost: difference(left.declared, right.declared),
    stillDeclared: intersection(right.declared, left.declared),
    stillMissing: intersection(right.missing, left.missing),
  };
}

function coverageState(
  left: BulletCoverageAudit | null,
  right: BulletCoverageAudit | null,
): ArtifactComparisonCoverageState {
  if (left && right) return "recorded";
  if (!left && !right) return "not_recorded";
  return left ? "right_not_recorded" : "left_not_recorded";
}

function computedAgainstLabel(left: BulletCoverageAudit, right: BulletCoverageAudit): string {
  if (left.computedAgainst === right.computedAgainst) {
    return left.computedAgainst;
  }
  return `${left.computedAgainst} / ${right.computedAgainst}`;
}

function difference(source: readonly string[], excluded: readonly string[]): string[] {
  const excludedSet = new Set(uniqueStrings(excluded));
  return uniqueStrings(source).filter((value) => !excludedSet.has(value));
}

function intersection(source: readonly string[], other: readonly string[]): string[] {
  const otherSet = new Set(uniqueStrings(other));
  return uniqueStrings(source).filter((value) => otherSet.has(value));
}

function uniqueStrings(values: readonly string[]): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const value of values) {
    const trimmed = value.trim();
    if (!trimmed || seen.has(trimmed)) continue;
    seen.add(trimmed);
    result.push(trimmed);
  }
  return result;
}
