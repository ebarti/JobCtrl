import type { ArtifactTailoringExplanation } from "@jobhunter/contracts";

export interface TailoringExplanationSectionProps {
  readonly explanation: ArtifactTailoringExplanation | null;
  readonly className?: string;
}

type AdversarialReview = NonNullable<ArtifactTailoringExplanation["adversarialReview"]>;
type PersonaAudit = AdversarialReview["personas"][number];
type ResponseSummaryValue = {
  readonly verdict: string | null;
  readonly score: number | null;
  readonly scoreRationale: string | null;
  readonly blockers: readonly string[];
  readonly warnings: readonly string[];
  readonly repairInstructions: readonly string[];
};

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

function TextLineList({ items }: { readonly items: readonly string[] }) {
  return (
    <ul className="annotation-line-list">
      {items.map((item) => (
        <li key={item}>{item}</li>
      ))}
    </ul>
  );
}

function ResponseSummary({ response }: { readonly response: ResponseSummaryValue }) {
  const rows = [
    response.scoreRationale,
    ...response.blockers.map((item) => `Blocker: ${item}`),
    ...response.warnings.map((item) => `Warning: ${item}`),
    ...response.repairInstructions.map((item) => `Repair: ${item}`),
  ].filter((item): item is string => Boolean(item));
  return (
    <div className="audit-response">
      <b>
        {response.verdict ?? "-"} {response.score === null ? "" : `(${scoreText(response.score)})`}
      </b>
      {rows.length ? <EvidenceList items={rows} /> : null}
    </div>
  );
}

function PersonaAuditList({ personas }: { readonly personas: readonly PersonaAudit[] }) {
  return (
    <div className="persona-audit-list">
      {personas.map((persona) => (
        <article className="persona-audit" key={persona.persona}>
          <header>
            <b>{formatToken(persona.persona)}</b>
            <span>
              {persona.verdict ?? "-"} {persona.score === null ? "" : `(${scoreText(persona.score)})`}
            </span>
          </header>
          <dl className="detail-list compact">
            {persona.promptRubric ? (
              <div>
                <dt>Asked</dt>
                <dd>{persona.promptRubric}</dd>
              </div>
            ) : null}
            {persona.response ? (
              <div>
                <dt>Response</dt>
                <dd>
                  <ResponseSummary response={persona.response} />
                </dd>
              </div>
            ) : null}
            <EvidenceRow label="Why score" items={persona.scoreBasis} />
          </dl>
        </article>
      ))}
    </div>
  );
}

function PromptMessageList({
  messages,
}: {
  readonly messages: readonly { readonly role: string; readonly content: string }[];
}) {
  return (
    <div className="prompt-audit-list">
      {messages.map((message, index) => (
        <article className="prompt-audit" key={`${message.role}-${index}`}>
          <b>{formatToken(message.role)}</b>
          <pre>{message.content}</pre>
        </article>
      ))}
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
  const warningRepairAttempted = explanation.reviewFeedback.warningRepairAttempted;
  const showReviewOutcome =
    hasItems(blockingIssues) || hasItems(warnings) || warningRepairAttempted === true;
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

        {explanation.annotatedChanges.length ? (
          <div className="evidence-block">
            <h4>Annotated resume changes</h4>
            <div className="tailoring-change-list">
              {explanation.annotatedChanges.map((change) => (
                <article
                  className="tailoring-change"
                  key={`${change.section}-${change.sourceId ?? change.label}`}
                >
                  <header>
                    <b>{change.label}</b>
                    <span>{formatToken(change.changeType)}</span>
                  </header>
                  <dl className="detail-list compact">
                    <EvidenceRow label="Job signals" items={change.jobSignals} />
                    <EvidenceRow label="Evidence" items={change.evidenceIds} />
                    <EvidenceRow label="Controls" items={change.controls} />
                    {change.rationale ? (
                      <div>
                        <dt>Why</dt>
                        <dd>{change.rationale}</dd>
                      </div>
                    ) : null}
                    {change.sourceText.length ? (
                      <div>
                        <dt>Source</dt>
                        <dd>
                          <TextLineList items={change.sourceText} />
                        </dd>
                      </div>
                    ) : null}
                    {change.tailoredText.length ? (
                      <div>
                        <dt>Tailored</dt>
                        <dd>
                          <TextLineList items={change.tailoredText} />
                        </dd>
                      </div>
                    ) : null}
                    <EvidenceRow label="Evidence notes" items={change.evidenceNotes} />
                  </dl>
                </article>
              ))}
            </div>
          </div>
        ) : null}

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
          </dl>
        </div>

        {showReviewOutcome ? (
          <div className="evidence-block">
            <h4>Review outcome</h4>
            {hasItems(blockingIssues) ? (
              <div className="finding-list danger">
                <b>Blocking repair feedback</b>
                <EvidenceList items={blockingIssues} />
              </div>
            ) : null}
            {warningRepairAttempted === true && !hasItems(warnings) ? (
              <dl className="detail-list compact">
                <div>
                  <dt>Warning repair attempted</dt>
                  <dd>yes</dd>
                </div>
              </dl>
            ) : null}
            {hasItems(warnings) ? (
              <div className="finding-list warning">
                <b>Accepted residual warnings</b>
                <dl className="detail-list compact">
                  <div>
                    <dt>Warning repair attempted</dt>
                    <dd>
                      {warningRepairAttempted === null
                        ? "not recorded"
                        : yesNo(warningRepairAttempted)}
                    </dd>
                  </div>
                </dl>
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
                {explanation.adversarialReview.scoreRationale ? (
                  <div>
                    <dt>Why score</dt>
                    <dd>{explanation.adversarialReview.scoreRationale}</dd>
                  </div>
                ) : null}
                <div>
                  <dt>Personas</dt>
                  <dd>
                    {explanation.adversarialReview.personas.length ? (
                      <PersonaAuditList personas={explanation.adversarialReview.personas} />
                    ) : (
                      <span className="muted">none recorded</span>
                    )}
                  </dd>
                </div>
                {explanation.adversarialReview.audit?.promptMessages.length ? (
                  <div>
                    <dt>LLM request</dt>
                    <dd>
                      <PromptMessageList
                        messages={explanation.adversarialReview.audit.promptMessages}
                      />
                    </dd>
                  </div>
                ) : null}
                {explanation.adversarialReview.audit?.response ? (
                  <div>
                    <dt>LLM response</dt>
                    <dd>
                      <ResponseSummary response={explanation.adversarialReview.audit.response} />
                    </dd>
                  </div>
                ) : null}
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
