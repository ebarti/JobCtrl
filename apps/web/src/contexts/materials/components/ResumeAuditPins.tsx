import type { ArtifactTailoringExplanation, BulletProvenanceEntry } from "@jobhunter/contracts";
import { useEffect, useMemo, useState, type JSX } from "react";

import { Empty } from "../../../shared/ui/empty.js";
import { useArtifactDetailQuery } from "../../operations/hooks/useArtifactDetailQuery.js";
import { formatToken, scorePercent } from "../lib/audit-format.js";

type AnnotatedChange = ArtifactTailoringExplanation["annotatedChanges"][number];

interface ResumeAuditPinsProps {
  readonly artifactId: string;
  readonly className?: string;
}

interface ResumeAuditPin {
  readonly id: string;
  readonly title: string;
  readonly section: string;
  readonly sourceText: readonly string[] | null;
  readonly tailoredText: readonly string[];
  readonly transformType: string;
  readonly controls: readonly string[];
  readonly evidenceIds: readonly string[];
  readonly requirementIds: readonly string[];
  readonly matchedSignals: readonly string[];
  readonly rationale: string | null;
}

interface RiskSignals {
  readonly hasAnyAudit: boolean;
  readonly quality: string;
  readonly judge: string;
  readonly adversarial: string;
  readonly blockers: readonly string[];
  readonly warnings: readonly string[];
  readonly unsupportedClaims: readonly string[];
  readonly fabrications: readonly string[];
  readonly missingRequiredEvidence: readonly string[];
  readonly repairInstructions: readonly string[];
  readonly warningRepairAttempted: string;
  readonly residualWarnings: readonly string[];
}

function yesNo(value: boolean | null | undefined): string {
  if (value === null || value === undefined) return "not recorded";
  return value ? "yes" : "no";
}

function originalTextFor(
  entry: BulletProvenanceEntry,
  annotatedChanges: readonly AnnotatedChange[],
): readonly string[] | null {
  const match = annotatedChanges.find(
    (change) => change.section === entry.section && change.sourceId === entry.sourceId,
  );
  return match?.sourceText ?? null;
}

function changeFor(
  entry: BulletProvenanceEntry,
  annotatedChanges: readonly AnnotatedChange[],
): AnnotatedChange | undefined {
  return annotatedChanges.find(
    (change) => change.section === entry.section && change.sourceId === entry.sourceId,
  );
}

function pinsFromExplanation(explanation: ArtifactTailoringExplanation): ResumeAuditPin[] {
  if (explanation.bulletProvenance.length) {
    return explanation.bulletProvenance.map((entry, index) => {
      const change = changeFor(entry, explanation.annotatedChanges);
      return {
        id: entry.bulletId,
        title: change?.label || `${formatToken(entry.section)} pin ${index + 1}`,
        section: entry.section,
        sourceText: originalTextFor(entry, explanation.annotatedChanges),
        tailoredText: entry.generatedText ? [entry.generatedText] : [],
        transformType: entry.transformType,
        controls: entry.control ? [entry.control] : [],
        evidenceIds: entry.evidenceIds,
        requirementIds: entry.requirementIds,
        matchedSignals: entry.matchedKeywords,
        rationale: entry.rationale || change?.rationale || null,
      };
    });
  }

  return explanation.annotatedChanges.map((change, index) => ({
    id: `change:${change.section}:${change.sourceId ?? change.label}:${index}`,
    title: change.label || `${formatToken(change.section)} pin ${index + 1}`,
    section: change.section,
    sourceText: change.sourceText.length ? change.sourceText : null,
    tailoredText: change.tailoredText,
    transformType: change.changeType,
    controls: change.controls,
    evidenceIds: change.evidenceIds,
    requirementIds: [],
    matchedSignals: change.jobSignals,
    rationale: change.rationale,
  }));
}

function riskSignals(explanation: ArtifactTailoringExplanation): RiskSignals {
  const adversarial = explanation.adversarialReview;
  const blockers = [
    ...explanation.quality.errors,
    ...explanation.judge.issues,
    ...(adversarial?.blockers ?? []),
  ];
  const warnings = [
    ...explanation.quality.warnings,
    ...(adversarial?.warnings ?? []),
  ];
  const hasAnyAudit =
    explanation.quality.passed !== null ||
    explanation.judge.verdict !== null ||
    explanation.judge.score !== null ||
    Boolean(adversarial?.ran || adversarial?.skippedReason) ||
    explanation.reviewFeedback.warningRepairAttempted !== null ||
    explanation.reviewFeedback.acceptedWithResidualWarnings !== null;

  return {
    hasAnyAudit,
    quality: yesNo(explanation.quality.passed ?? explanation.safety.qualityPassed),
    judge:
      explanation.judge.verdict || explanation.judge.score !== null
        ? `${explanation.judge.verdict ?? "recorded"} ${scorePercent(explanation.judge.score)}`
        : "not recorded",
    adversarial: adversarial?.ran
      ? `${yesNo(adversarial.passed)} ${scorePercent(adversarial.score)}`
      : adversarial?.skippedReason ?? "not recorded",
    blockers,
    warnings,
    unsupportedClaims: explanation.judge.unsupportedClaims,
    fabrications: explanation.judge.fabrications,
    missingRequiredEvidence: explanation.judge.missingRequiredEvidence,
    repairInstructions: [
      ...explanation.judge.repairInstructions,
      ...(adversarial?.repairInstructions ?? []),
    ],
    warningRepairAttempted: yesNo(explanation.reviewFeedback.warningRepairAttempted),
    residualWarnings: [
      ...explanation.reviewFeedback.acceptedWarnings,
      ...(explanation.reviewFeedback.acceptedWithResidualWarnings ? warnings : []),
    ],
  };
}

function pinTone(pin: ResumeAuditPin, risk: RiskSignals): "ok" | "info" | "warn" {
  if (
    risk.blockers.length ||
    risk.unsupportedClaims.length ||
    risk.fabrications.length ||
    risk.missingRequiredEvidence.length ||
    !pin.evidenceIds.length ||
    pin.sourceText === null
  ) {
    return "warn";
  }
  if (risk.warnings.length || risk.residualWarnings.length || !risk.hasAnyAudit) {
    return "info";
  }
  return "ok";
}

function pinStatus(pin: ResumeAuditPin, risk: RiskSignals): string {
  const tone = pinTone(pin, risk);
  if (tone === "ok") return "grounded";
  if (
    risk.unsupportedClaims.length ||
    risk.fabrications.length ||
    risk.missingRequiredEvidence.length ||
    !pin.evidenceIds.length
  ) {
    return "claim risk";
  }
  return "review";
}

function TagRow({
  label,
  values,
}: {
  readonly label: string;
  readonly values: readonly string[];
}): JSX.Element {
  return (
    <div>
      <dt>{label}</dt>
      <dd>
        {values.length ? (
          values.map((value) => (
            <span className="tag muted" key={value}>
              {value}
            </span>
          ))
        ) : (
          <span className="muted">none recorded</span>
        )}
      </dd>
    </div>
  );
}

function TextLines({
  empty,
  lines,
}: {
  readonly empty: string;
  readonly lines: readonly string[] | null;
}): JSX.Element {
  if (lines === null) {
    return <p className="muted">{empty}</p>;
  }
  if (!lines.length) {
    return <p className="muted">No text was recorded.</p>;
  }
  return (
    <ul className="annotation-line-list">
      {lines.map((line) => (
        <li key={line}>{line}</li>
      ))}
    </ul>
  );
}

function FindingList({
  label,
  items,
  tone,
}: {
  readonly label: string;
  readonly items: readonly string[];
  readonly tone: "danger" | "warning";
}): JSX.Element | null {
  if (!items.length) return null;
  return (
    <div className={`finding-list ${tone}`}>
      <b>{label}</b>
      <ul className="compact-list">
        {items.map((item) => (
          <li key={item}>{item}</li>
        ))}
      </ul>
    </div>
  );
}

function RiskPanel({ risk }: { readonly risk: RiskSignals }): JSX.Element {
  return (
    <div className="resume-pin-risk">
      <h4>Grounding and claim risk</h4>
      <dl className="evidence-summary-grid">
        <div>
          <dt>Quality gate</dt>
          <dd>{risk.quality}</dd>
        </div>
        <div>
          <dt>Judge</dt>
          <dd>{risk.judge}</dd>
        </div>
        <div>
          <dt>High-fit review</dt>
          <dd>{risk.adversarial}</dd>
        </div>
        <div>
          <dt>Warning repair attempted</dt>
          <dd>{risk.warningRepairAttempted}</dd>
        </div>
      </dl>
      {!risk.hasAnyAudit ? (
        <p className="muted">No claim-risk audit was recorded for this artifact.</p>
      ) : null}
      <FindingList label="Unsupported claims" items={risk.unsupportedClaims} tone="danger" />
      <FindingList label="Fabrications" items={risk.fabrications} tone="danger" />
      <FindingList label="Missing required evidence" items={risk.missingRequiredEvidence} tone="danger" />
      <FindingList label="Blockers" items={risk.blockers} tone="danger" />
      <FindingList label="Warnings" items={risk.warnings} tone="warning" />
      <FindingList label="Accepted residual warnings" items={risk.residualWarnings} tone="warning" />
      <FindingList label="Repair instructions" items={risk.repairInstructions} tone="warning" />
    </div>
  );
}

function PinDetail({
  pin,
  risk,
}: {
  readonly pin: ResumeAuditPin;
  readonly risk: RiskSignals;
}): JSX.Element {
  const tone = pinTone(pin, risk);
  return (
    <article className="resume-pin-detail" aria-live="polite">
      <header>
        <div>
          <span className="eyebrow">{formatToken(pin.section)}</span>
          <h4>{pin.title}</h4>
        </div>
        <span className={`tag ${tone}`}>{pinStatus(pin, risk)}</span>
      </header>
      <div className="resume-pin-diff">
        <section>
          <h5>Source profile or resume text</h5>
          <TextLines empty="No source text was recorded for this claim." lines={pin.sourceText} />
        </section>
        <section>
          <h5>Tailored artifact text</h5>
          <TextLines empty="No tailored text was recorded for this claim." lines={pin.tailoredText} />
        </section>
      </div>
      <dl className="detail-list compact">
        <div>
          <dt>Transform</dt>
          <dd>{formatToken(pin.transformType)}</dd>
        </div>
        <TagRow label="Controls" values={pin.controls} />
        <TagRow label="Requirement IDs" values={pin.requirementIds} />
        <TagRow label="Evidence IDs" values={pin.evidenceIds} />
        <TagRow label="Matched keywords" values={pin.matchedSignals} />
        <div>
          <dt>Why</dt>
          <dd>{pin.rationale || <span className="muted">no rationale recorded</span>}</dd>
        </div>
      </dl>
      <RiskPanel risk={risk} />
    </article>
  );
}

export function ResumeAuditPins({
  artifactId,
  className = "apply-review-resume-pins",
}: ResumeAuditPinsProps): JSX.Element {
  const detail = useArtifactDetailQuery(artifactId);
  const explanation = detail.data?.tailoringExplanation ?? null;
  const pins = useMemo(() => (explanation ? pinsFromExplanation(explanation) : []), [explanation]);
  const risk = useMemo(() => (explanation ? riskSignals(explanation) : null), [explanation]);
  const [selectedPinId, setSelectedPinId] = useState<string | null>(null);

  useEffect(() => {
    setSelectedPinId(pins[0]?.id ?? null);
  }, [artifactId, pins]);

  const selectedPin = pins.find((pin) => pin.id === selectedPinId) ?? pins[0] ?? null;
  const errorMessage = detail.error instanceof Error ? detail.error.message : null;

  return (
    <section className={className} aria-label="Resume claim pins">
      <h3>Resume claim pins</h3>
      {errorMessage ? <div className="banner inline">{errorMessage}</div> : null}
      {!detail.data && detail.isFetching ? <Empty title="Loading resume provenance." /> : null}
      {detail.data && !explanation ? (
        <Empty title="No resume provenance recorded for this artifact." />
      ) : null}
      {explanation && !pins.length ? (
        <Empty title="No resume claim pins were recorded for this artifact generation." />
      ) : null}
      {pins.length && risk ? (
        <div className="resume-pin-shell">
          <div className="resume-pin-list" role="list" aria-label="Resume claim pin list">
            {pins.map((pin, index) => {
              const tone = pinTone(pin, risk);
              const preview = pin.tailoredText[0] ?? "No generated text recorded.";
              return (
                <button
                  aria-label={`${formatToken(pin.section)} pin ${index + 1}: ${pin.title}`}
                  aria-pressed={pin.id === selectedPin?.id}
                  className={`resume-pin-button${pin.id === selectedPin?.id ? " selected" : ""}`}
                  key={pin.id}
                  type="button"
                  onClick={() => setSelectedPinId(pin.id)}
                >
                  <span className={`tag ${tone}`}>{pinStatus(pin, risk)}</span>
                  <b>{pin.title}</b>
                  <span>{preview}</span>
                </button>
              );
            })}
          </div>
          {selectedPin ? <PinDetail pin={selectedPin} risk={risk} /> : null}
        </div>
      ) : null}
    </section>
  );
}

