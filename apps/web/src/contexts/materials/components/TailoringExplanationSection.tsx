import type { ArtifactTailoringExplanation } from "@jobctrl/contracts";
import type { ReactNode } from "react";

import { StatusLabel, type StatusLabelTone } from "../../../shared/ui/status-label.js";
import { BulletProvenanceList } from "./BulletProvenanceList.js";

export interface TailoringExplanationSectionProps {
  readonly explanation: ArtifactTailoringExplanation | null;
  readonly className?: string;
}

type AdversarialReview = NonNullable<ArtifactTailoringExplanation["adversarialReview"]>;
type PersonaAudit = AdversarialReview["personas"][number];
type AdversarialAudit = AdversarialReview["audit"];
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

function warningHandlingText(
  warningRepairAttempted: boolean | null,
  hasResidualWarnings: boolean,
): string {
  if (warningRepairAttempted === null) return "not recorded";
  if (warningRepairAttempted) {
    return hasResidualWarnings
      ? "retry attempted; selected artifact still has residual warnings"
      : "retry cleared warnings before selection";
  }
  return hasResidualWarnings
    ? "no retry; workflow selected artifact with residual warnings"
    : "no warning retry recorded";
}

function countSummary(count: number, displayed: number): string {
  if (!count) return "none recorded";
  const parts = [`${count} total`];
  if (displayed !== count) parts.push(`${displayed} shown`);
  return parts.join(" · ");
}

function hasItems(items: readonly string[]): boolean {
  return items.length > 0;
}

function EvidenceList({ items }: { readonly items: readonly string[] }) {
  return (
    <ul className="audit-value-list">
      {items.map((item) => (
        <li className="audit-value" key={item}>
          {item}
        </li>
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

function TextEvidence({
  title,
  children,
}: {
  readonly title: string;
  readonly children: ReactNode;
}) {
  return (
    <section className="audit-text-block">
      <h5>{title}</h5>
      {children}
    </section>
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

function AuditStatus({
  verdict,
  score,
}: {
  readonly verdict: string | null;
  readonly score: number | null;
}) {
  return (
    <span className="audit-status">
      <StatusLabel tone={auditStatusTone(verdict)}>{verdict ?? "not recorded"}</StatusLabel>
      {score === null ? null : <span className="audit-status__score">{scoreText(score)}</span>}
    </span>
  );
}

function auditStatusTone(verdict: string | null): StatusLabelTone {
  const normalized = verdict?.toLowerCase() ?? "";
  if (/fail|reject|block|unsafe|invalid|not[\s_-]*(pass|accept|approv|valid)/.test(normalized)) {
    return "danger";
  }
  if (/pass|accept|approv|complete|valid/.test(normalized)) return "ok";
  if (/warn|review|risk|residual/.test(normalized)) return "warn";
  return verdict ? "info" : "muted";
}

function AuditResponseList({
  label,
  items,
}: {
  readonly label: string;
  readonly items: readonly string[];
}) {
  if (!items.length) return null;
  return (
    <div className="audit-response-list">
      <b>{label}</b>
      <EvidenceList items={items} />
    </div>
  );
}

function ResponseSummary({ response }: { readonly response: ResponseSummaryValue }) {
  return (
    <div className="audit-response">
      <div className="audit-response-summary">
        <AuditStatus verdict={response.verdict} score={response.score} />
      </div>
      {response.scoreRationale ? <p>{response.scoreRationale}</p> : null}
      <AuditResponseList label="Blockers" items={response.blockers} />
      <AuditResponseList label="Warnings" items={response.warnings} />
      <AuditResponseList label="Repair" items={response.repairInstructions} />
    </div>
  );
}

function PersonaAuditDetails({
  persona,
  audit,
}: {
  readonly persona: PersonaAudit;
  readonly audit: AdversarialAudit;
}) {
  return (
    <details className="persona-audit-disclosure">
      <summary>Show LLM audit trail</summary>
      <div className="persona-audit-detail-body">
        {persona.promptRubric ? (
          <TextEvidence title="Persona rubric">{persona.promptRubric}</TextEvidence>
        ) : null}
        <TextEvidence title="Exact LLM request">
          {audit?.promptMessages.length ? (
            <PromptMessageList messages={audit.promptMessages} />
          ) : (
            <p className="muted">Exact LLM request was not captured for this artifact.</p>
          )}
        </TextEvidence>
        {persona.response ? (
          <TextEvidence title="Persona response">
            <ResponseSummary response={persona.response} />
          </TextEvidence>
        ) : null}
        <TextEvidence title="Stored LLM response">
          {audit?.response ? (
            <ResponseSummary response={audit.response} />
          ) : (
            <p className="muted">Structured LLM response was not captured for this artifact.</p>
          )}
        </TextEvidence>
      </div>
    </details>
  );
}

function PersonaAuditList({
  personas,
  audit,
}: {
  readonly personas: readonly PersonaAudit[];
  readonly audit: AdversarialAudit;
}) {
  return (
    <div className="persona-audit-list">
      {personas.map((persona) => (
        <article className="persona-audit" key={persona.persona}>
          <header>
            <div>
              <b>{formatToken(persona.persona)}</b>
              <span>Persona judgment</span>
            </div>
            <AuditStatus verdict={persona.verdict} score={persona.score} />
          </header>
          <div className="persona-audit-body">
            {persona.scoreRationale || persona.scoreBasis.length ? (
              <TextEvidence title="Why it scored this way">
                {persona.scoreRationale ? <p>{persona.scoreRationale}</p> : null}
                {persona.scoreBasis.length ? <EvidenceList items={persona.scoreBasis} /> : null}
              </TextEvidence>
            ) : null}
            {persona.response ? (
              <TextEvidence title="LLM returned">
                <ResponseSummary response={persona.response} />
              </TextEvidence>
            ) : null}
            <PersonaAuditDetails persona={persona} audit={audit} />
          </div>
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

function VoicePassBlock({
  voicePass,
}: {
  readonly voicePass: ArtifactTailoringExplanation["voicePass"];
}) {
  // INSPECT-05 honest lifecycle labeling: distinguish "no voice pass recorded"
  // (null) from "ran but not accepted" (with reason) from "ran and accepted".
  if (!voicePass) {
    return (
      <div className="evidence-block">
        <h4>Voice pass</h4>
        <p className="muted">No voice pass was recorded for this artifact.</p>
      </div>
    );
  }
  const proxyEntries = Object.entries(voicePass.proxyDelta ?? {});
  return (
    <div className="evidence-block">
      <h4>Voice pass</h4>
      <dl className="detail-list compact">
        <div>
          <dt>Ran</dt>
          <dd>{yesNo(voicePass.ran)}</dd>
        </div>
        <div>
          <dt>Outcome</dt>
          <dd>
            {voicePass.accepted ? (
              <StatusLabel tone="ok">accepted</StatusLabel>
            ) : (
              <StatusLabel tone="warn">not accepted</StatusLabel>
            )}
          </dd>
        </div>
        {voicePass.model ? (
          <div>
            <dt>Model</dt>
            <dd>{voicePass.model}</dd>
          </div>
        ) : null}
        {voicePass.reason ? (
          <div>
            <dt>Reason</dt>
            <dd>{voicePass.reason}</dd>
          </div>
        ) : null}
        {proxyEntries.length ? (
          <div>
            <dt>Proxy delta</dt>
            <dd>
              <ul className="compact-list">
                {proxyEntries.map(([key, value]) => (
                  <li key={key}>
                    {formatToken(key)}: {String(value)}
                  </li>
                ))}
              </ul>
            </dd>
          </div>
        ) : null}
      </dl>
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
    explanation.keywords.planned,
    explanation.keywords.covered,
    explanation.keywords.missing,
    explanation.evidence.representedIds,
    explanation.evidence.requiredIds,
    explanation.evidence.missingIds,
    explanation.evidence.seniorityIds,
  ].some(hasItems);
  const hasKeywordCounts =
    explanation.keywords.counts.planned > 0 ||
    explanation.keywords.counts.covered > 0 ||
    explanation.keywords.counts.missing > 0;
  const hasTargetKeywords = explanation.keywords.counts.planned > 0;
  const hasResumeKeywordAudit = explanation.keywords.coverageRecorded;
  const hasSummaryData =
    Boolean(explanation.targetSeniority) ||
    Boolean(explanation.claimMode) ||
    explanation.quality.passed !== null ||
    explanation.safety.qualityPassed !== null ||
    explanation.judge.score !== null ||
    explanation.judge.minScore !== null;
  const hasSafetyData =
    Boolean(explanation.validationMode) ||
    explanation.safety.autoApprovableClaimModes.length > 0 ||
    explanation.safety.allowAdjacentAchievementDrafts !== null ||
    explanation.evidence.verifiedMetricCount !== null;
  const hasGenerationContext =
    Boolean(explanation.models.selectedModel) ||
    Boolean(explanation.models.judgeModel) ||
    explanation.models.candidateModels.length > 0 ||
    Boolean(explanation.models.selectedCandidate) ||
    explanation.models.attempts !== null;
  const hasGenerationAuditData = hasSummaryData || hasSafetyData || hasGenerationContext;

  return (
    <section className={className}>
      <h3>Tailoring rationale</h3>
      <div className="tailoring-evidence">
        {hasSummaryData ? (
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
        ) : null}

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

        {hasChangeEvidence || hasKeywordCounts ? (
          <div className="evidence-block">
            <h4>Why these changes</h4>
            <dl className="detail-list compact">
              {hasKeywordCounts ? (
                <div>
                  <dt>Resume match audit</dt>
                  <dd>
                    {hasResumeKeywordAudit
                      ? `${explanation.keywords.counts.covered}/${explanation.keywords.counts.planned} demonstrated in resume`
                      : "not recorded for this artifact"}
                  </dd>
                </div>
              ) : null}
              {hasTargetKeywords ? (
                <div>
                  <dt>Actionable job keywords</dt>
                  <dd>
                    {countSummary(
                      explanation.keywords.counts.planned,
                      explanation.keywords.counts.displayedPlanned,
                    )}
                  </dd>
                </div>
              ) : null}
              <EvidenceRow label="Target job keywords" items={explanation.keywords.planned} />
              {hasResumeKeywordAudit ? (
                <>
                  <EvidenceRow label="Found in tailored resume" items={explanation.keywords.covered} />
                  <EvidenceRow
                    label="Declared in skills (not demonstrated)"
                    items={explanation.keywords.declared}
                  />
                  <EvidenceRow label="No resume keyword match found" items={explanation.keywords.missing} />
                </>
              ) : null}
              <EvidenceRow label="Represented evidence" items={explanation.evidence.representedIds} />
              <EvidenceRow label="Required evidence" items={explanation.evidence.requiredIds} />
              <EvidenceRow label="Missing evidence" items={explanation.evidence.missingIds} />
              <EvidenceRow label="Seniority evidence" items={explanation.evidence.seniorityIds} />
            </dl>
          </div>
        ) : null}

        <VoicePassBlock voicePass={explanation.voicePass} />

        <BulletProvenanceList
          className="evidence-block"
          provenance={explanation.bulletProvenance}
          annotatedChanges={explanation.annotatedChanges}
        />

        {hasSafetyData ? (
          <div className="evidence-block">
            <h4>Safety checks</h4>
            <dl className="detail-list compact">
              {explanation.validationMode ? (
                <div>
                  <dt>Validation mode</dt>
                  <dd>{formatToken(explanation.validationMode)}</dd>
                </div>
              ) : null}
              {explanation.safety.autoApprovableClaimModes.length ? (
                <div>
                  <dt>Auto-approvable claims</dt>
                  <dd>
                    <EvidenceList items={explanation.safety.autoApprovableClaimModes.map(formatToken)} />
                  </dd>
                </div>
              ) : null}
              {explanation.safety.allowAdjacentAchievementDrafts !== null ? (
                <div>
                  <dt>Adjacent drafts allowed</dt>
                  <dd>{yesNo(explanation.safety.allowAdjacentAchievementDrafts)}</dd>
                </div>
              ) : null}
              {explanation.evidence.verifiedMetricCount !== null ? (
                <div>
                  <dt>Verified metrics</dt>
                  <dd>{explanation.evidence.verifiedMetricCount}</dd>
                </div>
              ) : null}
            </dl>
          </div>
        ) : null}

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
                  <dt>Warning handling</dt>
                  <dd>{warningHandlingText(warningRepairAttempted, false)}</dd>
                </div>
              </dl>
            ) : null}
            {hasItems(warnings) ? (
              <div className="finding-list warning">
                <b>Residual warnings after automated review</b>
                <dl className="detail-list compact">
                  <div>
                    <dt>Warning decision source</dt>
                    <dd>Material generation workflow; no human approver recorded.</dd>
                  </div>
                  <div>
                    <dt>Warning handling</dt>
                    <dd>{warningHandlingText(warningRepairAttempted, true)}</dd>
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
              <div className="adversarial-review">
                <dl className="evidence-summary-grid">
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
                </dl>
                {explanation.adversarialReview.scoreRationale ? (
                  <TextEvidence title="Why overall score">
                    <p>{explanation.adversarialReview.scoreRationale}</p>
                  </TextEvidence>
                ) : null}
                <TextEvidence title="Persona judgments">
                  {explanation.adversarialReview.personas.length ? (
                    <PersonaAuditList
                      audit={explanation.adversarialReview.audit}
                      personas={explanation.adversarialReview.personas}
                    />
                  ) : (
                    <span className="muted">none recorded</span>
                  )}
                </TextEvidence>
              </div>
            ) : (
              <p className="muted">{explanation.adversarialReview?.skippedReason}</p>
            )}
          </div>
        ) : null}

        {hasGenerationContext ? (
          <div className="evidence-block">
            <h4>Generation context</h4>
            <dl className="detail-list compact">
              {explanation.models.selectedModel ? (
                <div>
                  <dt>Selected model</dt>
                  <dd>{explanation.models.selectedModel}</dd>
                </div>
              ) : null}
              {explanation.models.judgeModel ? (
                <div>
                  <dt>Judge model</dt>
                  <dd>{explanation.models.judgeModel}</dd>
                </div>
              ) : null}
              {explanation.models.candidateModels.length ? (
                <div>
                  <dt>Candidate models</dt>
                  <dd>
                    <EvidenceList items={explanation.models.candidateModels} />
                  </dd>
                </div>
              ) : null}
              {explanation.models.selectedCandidate ? (
                <div>
                  <dt>Selected candidate</dt>
                  <dd>{explanation.models.selectedCandidate}</dd>
                </div>
              ) : null}
              {explanation.models.attempts !== null ? (
                <div>
                  <dt>Attempts</dt>
                  <dd>{explanation.models.attempts}</dd>
                </div>
              ) : null}
            </dl>
          </div>
        ) : null}

        {!hasGenerationAuditData && hasResumeKeywordAudit ? (
          <div className="evidence-block">
            <h4>Generation audit</h4>
            <p className="muted">audit metadata incomplete for this artifact</p>
          </div>
        ) : null}
      </div>
    </section>
  );
}
