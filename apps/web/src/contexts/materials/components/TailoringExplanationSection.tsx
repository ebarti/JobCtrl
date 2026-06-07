import type { ArtifactTailoringExplanation } from "@jobhunter/contracts";

export interface TailoringExplanationSectionProps {
  readonly explanation: ArtifactTailoringExplanation | null;
  readonly className?: string;
}

function formatToken(value: string | null | undefined): string {
  if (!value) return "-";
  return value
    .split(/[_-]+/)
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
}

function scoreText(score: number | null, minScore?: number | null): string {
  if (score === null) return "-";
  const formatted = `${Math.round(score * 100)}%`;
  return minScore === null || minScore === undefined
    ? formatted
    : `${formatted} / minimum ${Math.round(minScore * 100)}%`;
}

function yesNo(value: boolean | null): string {
  if (value === null) return "-";
  return value ? "yes" : "no";
}

function hasItems(items: readonly string[]): boolean {
  return items.length > 0;
}

function EvidenceList({ items }: { readonly items: readonly string[] }) {
  return (
    <ul className="compact-list">
      {items.map((item) => (
        <li key={item}>{item}</li>
      ))}
    </ul>
  );
}

function EvidenceRow({
  label,
  items,
}: {
  readonly label: string;
  readonly items: readonly string[];
}) {
  if (!items.length) return null;
  return (
    <div>
      <dt>{label}</dt>
      <dd>
        <EvidenceList items={items} />
      </dd>
    </div>
  );
}

export function TailoringExplanationSection({
  explanation,
  className = "section",
}: TailoringExplanationSectionProps) {
  if (!explanation) return null;

  const blockingIssues = [
    ...explanation.quality.errors,
    ...explanation.judge.issues,
    ...explanation.judge.unsupportedClaims,
    ...explanation.judge.fabrications,
    ...explanation.judge.missingRequiredEvidence,
    ...(explanation.adversarialReview?.blockers ?? []),
  ];
  const warnings = [
    ...explanation.quality.warnings,
    ...(explanation.adversarialReview?.warnings ?? []),
  ];
  const showAdversarial =
    explanation.adversarialReview &&
    (explanation.adversarialReview.ran || explanation.adversarialReview.skippedReason);
  const hasChangeEvidence = [
    explanation.keywords.covered,
    explanation.keywords.missing,
    explanation.evidence.representedIds,
    explanation.evidence.requiredIds,
    explanation.evidence.missingIds,
    explanation.evidence.seniorityIds,
  ].some(hasItems);

  return (
    <section className={className}>
      <h3>Tailoring rationale</h3>
      <div className="tailoring-evidence">
        <dl className="evidence-summary-grid">
          <div>
            <dt>Target seniority</dt>
            <dd>{formatToken(explanation.targetSeniority)}</dd>
          </div>
          <div>
            <dt>Claim mode</dt>
            <dd>{formatToken(explanation.claimMode)}</dd>
          </div>
          <div>
            <dt>Quality gate</dt>
            <dd>{yesNo(explanation.quality.passed ?? explanation.safety.qualityPassed)}</dd>
          </div>
          <div>
            <dt>Judge score</dt>
            <dd>{scoreText(explanation.judge.score, explanation.judge.minScore)}</dd>
          </div>
        </dl>

        {hasChangeEvidence ? (
          <div className="evidence-block">
            <h4>Why these changes</h4>
            <dl className="detail-list compact">
              <EvidenceRow label="Covered keywords" items={explanation.keywords.covered} />
              <EvidenceRow label="Missing keywords" items={explanation.keywords.missing} />
              <EvidenceRow label="Represented evidence" items={explanation.evidence.representedIds} />
              <EvidenceRow label="Required evidence" items={explanation.evidence.requiredIds} />
              <EvidenceRow label="Missing evidence" items={explanation.evidence.missingIds} />
              <EvidenceRow label="Seniority evidence" items={explanation.evidence.seniorityIds} />
            </dl>
          </div>
        ) : null}

        <div className="evidence-block">
          <h4>Safety checks</h4>
          <dl className="detail-list compact">
            <div>
              <dt>Validation mode</dt>
              <dd>{formatToken(explanation.validationMode)}</dd>
            </div>
            <div>
              <dt>Auto-approvable claims</dt>
              <dd>
                {explanation.safety.autoApprovableClaimModes.length ? (
                  <EvidenceList items={explanation.safety.autoApprovableClaimModes.map(formatToken)} />
                ) : (
                  <span className="muted">none recorded</span>
                )}
              </dd>
            </div>
            <div>
              <dt>Adjacent drafts allowed</dt>
              <dd>{yesNo(explanation.safety.allowAdjacentAchievementDrafts)}</dd>
            </div>
            <div>
              <dt>Verified metrics</dt>
              <dd>{explanation.evidence.verifiedMetricCount ?? "-"}</dd>
            </div>
            <div>
              <dt>Metric claims</dt>
              <dd>
                {explanation.quality.metricClaims.length ? (
                  <EvidenceList items={explanation.quality.metricClaims} />
                ) : (
                  <span className="muted">none recorded</span>
                )}
              </dd>
            </div>
          </dl>
        </div>

        {hasItems(blockingIssues) || hasItems(warnings) ? (
          <div className="evidence-block">
            <h4>Review findings</h4>
            {hasItems(blockingIssues) ? (
              <div className="finding-list danger">
                <b>Blocking</b>
                <EvidenceList items={blockingIssues} />
              </div>
            ) : null}
            {hasItems(warnings) ? (
              <div className="finding-list warning">
                <b>Warnings</b>
                <EvidenceList items={warnings} />
              </div>
            ) : null}
          </div>
        ) : null}

        {showAdversarial ? (
          <div className="evidence-block">
            <h4>High-fit review</h4>
            {explanation.adversarialReview?.ran ? (
              <dl className="detail-list compact">
                <div>
                  <dt>Passed</dt>
                  <dd>{yesNo(explanation.adversarialReview.passed)}</dd>
                </div>
                <div>
                  <dt>Score</dt>
                  <dd>
                    {scoreText(
                      explanation.adversarialReview.score,
                      explanation.adversarialReview.threshold,
                    )}
                  </dd>
                </div>
                <div>
                  <dt>Personas</dt>
                  <dd>
                    {explanation.adversarialReview.personas.length ? (
                      <EvidenceList
                        items={explanation.adversarialReview.personas.map((persona) =>
                          `${formatToken(persona.persona)}: ${persona.verdict ?? "-"} ${
                            persona.score === null ? "" : `(${Math.round(persona.score * 100)}%)`
                          }`.trim(),
                        )}
                      />
                    ) : (
                      <span className="muted">none recorded</span>
                    )}
                  </dd>
                </div>
              </dl>
            ) : (
              <p className="muted">{explanation.adversarialReview?.skippedReason}</p>
            )}
          </div>
        ) : null}

        <div className="evidence-block">
          <h4>Generation context</h4>
          <dl className="detail-list compact">
            <div>
              <dt>Selected model</dt>
              <dd>{explanation.models.selectedModel ?? "-"}</dd>
            </div>
            <div>
              <dt>Judge model</dt>
              <dd>{explanation.models.judgeModel ?? "-"}</dd>
            </div>
            <div>
              <dt>Candidate models</dt>
              <dd>
                {explanation.models.candidateModels.length ? (
                  <EvidenceList items={explanation.models.candidateModels} />
                ) : (
                  <span className="muted">none recorded</span>
                )}
              </dd>
            </div>
            <div>
              <dt>Selected candidate</dt>
              <dd>{explanation.models.selectedCandidate ?? "-"}</dd>
            </div>
            <div>
              <dt>Attempts</dt>
              <dd>{explanation.models.attempts ?? "-"}</dd>
            </div>
          </dl>
        </div>
      </div>
    </section>
  );
}
