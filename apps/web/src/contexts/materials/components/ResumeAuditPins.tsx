import type { ArtifactTailoringExplanation, BulletProvenanceEntry } from "@jobhunter/contracts";
import { useEffect, useMemo, useState, type JSX } from "react";

import { Empty } from "../../../shared/ui/empty.js";
import { useArtifactDetailQuery } from "../../operations/hooks/useArtifactDetailQuery.js";
import { formatToken, scorePercent } from "../lib/audit-format.js";

type AnnotatedChange = ArtifactTailoringExplanation["annotatedChanges"][number];

interface ResumeAuditPinsProps {
  readonly artifactId: string;
  readonly resumeText?: string | null;
  readonly className?: string;
  readonly selectedLineNumber?: number | null;
  readonly onSelectedLineNumberChange?: (lineNumber: number | null) => void;
}

interface ResumeLineEntry {
  readonly lineNumber: number;
  readonly text: string;
}

interface ResumeAuditPin {
  readonly id: string;
  readonly title: string;
  readonly section: string;
  readonly lineNumber?: number;
  readonly provenanceState: "recorded" | "missing";
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
        provenanceState: "recorded",
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
    provenanceState: "recorded",
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

function resumeLinesFromText(resumeText: string | null | undefined): ResumeLineEntry[] {
  return (resumeText ?? "")
    .split(/\r?\n/)
    .map((line, index) => ({
      lineNumber: index + 1,
      text: line.trim(),
    }))
    .filter((entry) => entry.text.length > 0);
}

function pinsFromResumeText(lines: readonly ResumeLineEntry[]): ResumeAuditPin[] {
  return lines.map((line) => ({
    id: `resume-line:${line.lineNumber}`,
    title: `Line ${line.lineNumber}`,
    section: "rendered_resume",
    lineNumber: line.lineNumber,
    provenanceState: "missing",
    sourceText: null,
    tailoredText: [line.text],
    transformType: "no_generation_provenance",
    controls: ["rendered resume fallback"],
    evidenceIds: [],
    requirementIds: [],
    matchedSignals: [],
    rationale:
      "This line is visible in the tailored resume, but no generation-time source or evidence mapping was recorded.",
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

function emptyRiskSignals(): RiskSignals {
  return {
    hasAnyAudit: false,
    quality: "not recorded",
    judge: "not recorded",
    adversarial: "not recorded",
    blockers: [],
    warnings: [],
    unsupportedClaims: [],
    fabrications: [],
    missingRequiredEvidence: [],
    repairInstructions: [],
    warningRepairAttempted: "not recorded",
    residualWarnings: [],
  };
}

function pinTone(pin: ResumeAuditPin, risk: RiskSignals): "ok" | "info" | "warn" {
  if (pin.provenanceState === "missing") {
    return "warn";
  }
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
  if (pin.provenanceState === "missing") {
    return "missing provenance";
  }
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
  const sourceEmpty =
    pin.provenanceState === "missing"
      ? "No source text was recorded for this resume line."
      : "No source text was recorded for this claim.";
  const tailoredEmpty =
    pin.provenanceState === "missing"
      ? "No resume text was recorded for this line."
      : "No tailored text was recorded for this claim.";
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
          <TextLines empty={sourceEmpty} lines={pin.sourceText} />
        </section>
        <section>
          <h5>Tailored artifact text</h5>
          <TextLines empty={tailoredEmpty} lines={pin.tailoredText} />
        </section>
      </div>
      <dl className="detail-list compact">
        {pin.lineNumber ? (
          <div>
            <dt>Resume line</dt>
            <dd>{pin.lineNumber}</dd>
          </div>
        ) : null}
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
  resumeText,
  className = "apply-review-resume-pins",
  selectedLineNumber,
  onSelectedLineNumberChange,
}: ResumeAuditPinsProps): JSX.Element {
  const detail = useArtifactDetailQuery(artifactId);
  const explanation = detail.data?.tailoringExplanation ?? null;
  const resumeLines = useMemo(() => resumeLinesFromText(resumeText), [resumeText]);
  const provenancePins = useMemo(() => (explanation ? pinsFromExplanation(explanation) : []), [explanation]);
  const canUseResumeFallback = Boolean(
    !provenancePins.length && resumeLines.length && (detail.data || detail.error),
  );
  const pins = useMemo(
    () => (provenancePins.length ? provenancePins : canUseResumeFallback ? pinsFromResumeText(resumeLines) : []),
    [canUseResumeFallback, provenancePins, resumeLines],
  );
  const risk = useMemo(() => (explanation ? riskSignals(explanation) : emptyRiskSignals()), [explanation]);
  const [selectedPinId, setSelectedPinId] = useState<string | null>(null);
  const usingResumeFallback = canUseResumeFallback && !provenancePins.length && pins.length > 0;

  useEffect(() => {
    if (!pins.length) {
      setSelectedPinId(null);
      return;
    }
    const selectedLinePin =
      selectedLineNumber === null || selectedLineNumber === undefined
        ? null
        : pins.find((pin) => pin.lineNumber === selectedLineNumber) ?? null;
    setSelectedPinId((currentPinId) => {
      if (selectedLinePin) {
        return selectedLinePin.id;
      }
      if (currentPinId && pins.some((pin) => pin.id === currentPinId)) {
        return currentPinId;
      }
      return pins[0]?.id ?? null;
    });
  }, [artifactId, pins, selectedLineNumber]);

  const selectedPin = pins.find((pin) => pin.id === selectedPinId) ?? pins[0] ?? null;
  const errorMessage = detail.error instanceof Error ? detail.error.message : null;

  useEffect(() => {
    onSelectedLineNumberChange?.(selectedPin?.lineNumber ?? null);
  }, [onSelectedLineNumberChange, selectedPin?.lineNumber]);

  return (
    <section className={className} aria-label="Line-by-line resume audit">
      <h3>Line-by-line resume audit</h3>
      {usingResumeFallback ? (
        <p className="resume-audit-note">
          No generation-time provenance was recorded. Showing the rendered resume text line by line for reviewer
          inspection.
        </p>
      ) : null}
      {errorMessage ? <div className="banner inline">{errorMessage}</div> : null}
      {!detail.data && detail.isFetching ? <Empty title="Loading resume provenance." /> : null}
      {detail.data && !pins.length && !explanation ? (
        <Empty title="No resume provenance or rendered resume text was recorded for this artifact." />
      ) : null}
      {detail.data && explanation && !pins.length ? (
        <Empty title="No resume claim pins or rendered resume text were recorded for this artifact generation." />
      ) : null}
      {pins.length ? (
        <div className="resume-pin-shell">
          <ul className="resume-pin-list" aria-label="Resume audit line list">
            {pins.map((pin, index) => {
              const tone = pinTone(pin, risk);
              const preview = pin.tailoredText[0] ?? "No generated text recorded.";
              const accessibleName = pin.lineNumber
                ? `Rendered resume line ${pin.lineNumber}: ${preview}`
                : `${formatToken(pin.section)} pin ${index + 1}: ${pin.title}`;
              return (
                <li key={pin.id}>
                  <button
                    aria-label={accessibleName}
                    aria-pressed={pin.id === selectedPin?.id}
                    className={`resume-pin-button${pin.id === selectedPin?.id ? " selected" : ""}`}
                    type="button"
                    onClick={() => {
                      setSelectedPinId(pin.id);
                      onSelectedLineNumberChange?.(pin.lineNumber ?? null);
                    }}
                  >
                    <span className="resume-pin-meta">
                      {pin.lineNumber ? <span className="resume-line-number">Line {pin.lineNumber}</span> : null}
                      <span className={`tag ${tone}`}>{pinStatus(pin, risk)}</span>
                    </span>
                    <b>{pin.lineNumber ? formatToken(pin.section) : pin.title}</b>
                    <span>{preview}</span>
                  </button>
                </li>
              );
            })}
          </ul>
          {selectedPin ? <PinDetail pin={selectedPin} risk={risk} /> : null}
        </div>
      ) : null}
    </section>
  );
}
