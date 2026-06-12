import type { ArtifactTailoringExplanation, BulletProvenanceEntry } from "@jobhunter/contracts";
import { useEffect, useMemo, useRef, useState, type JSX } from "react";

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
  readonly kind: "name" | "contact" | "section" | "metadata" | "bullet" | "body";
}

interface ResumeAuditPin {
  readonly id: string;
  readonly title: string;
  readonly section: string;
  readonly lineNumber?: number;
  readonly provenanceState: "recorded" | "missing" | "not_applicable";
  readonly sourceGranularity: "bullet" | "change_span" | "missing" | "structure";
  readonly sourceId: string | null;
  readonly sourceLabel: string | null;
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
  readonly auditGaps: readonly string[];
  readonly blockers: readonly string[];
  readonly warnings: readonly string[];
  readonly unsupportedClaims: readonly string[];
  readonly fabrications: readonly string[];
  readonly missingRequiredEvidence: readonly string[];
  readonly repairInstructions: readonly string[];
  readonly warningRepairAttempted: string;
  readonly residualWarnings: readonly string[];
}

const RENDERED_RESUME_SECTION_HEADINGS = new Set([
  "certifications",
  "core skills",
  "education",
  "executive profile",
  "experience",
  "languages",
  "professional profile",
  "profile",
  "projects",
  "skills",
  "summary",
  "technical skills",
]);

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

function normalizeResumeLine(value: string): string {
  return value
    .replace(/^[-•○]\s+/, "")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

function textsMatchLine(candidateText: string, lineText: string): boolean {
  const candidate = normalizeResumeLine(candidateText);
  const line = normalizeResumeLine(lineText);
  if (!candidate || !line) return false;
  return candidate === line || candidate.includes(line) || line.includes(candidate);
}

function changeForLine(
  line: ResumeLineEntry,
  annotatedChanges: readonly AnnotatedChange[],
): AnnotatedChange | undefined {
  return annotatedChanges.find((change) => change.tailoredText.some((text) => textsMatchLine(text, line.text)));
}

function bulletForLine(
  line: ResumeLineEntry,
  provenance: readonly BulletProvenanceEntry[],
): BulletProvenanceEntry | undefined {
  return provenance.find((entry) => textsMatchLine(entry.generatedText, line.text));
}

function isStructuralLine(line: ResumeLineEntry): boolean {
  return line.kind === "name" || line.kind === "contact" || line.kind === "section" || line.kind === "metadata";
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
        sourceGranularity: "bullet",
        sourceId: entry.sourceId,
        sourceLabel: change?.label ?? null,
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
    sourceGranularity: "change_span",
    sourceId: change.sourceId,
    sourceLabel: change.label,
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

function pinFromResumeLine(
  line: ResumeLineEntry,
  explanation: ArtifactTailoringExplanation | null,
): ResumeAuditPin {
  const bullet = explanation ? bulletForLine(line, explanation.bulletProvenance) : undefined;
  if (bullet) {
    const change = explanation ? changeFor(bullet, explanation.annotatedChanges) : undefined;
    return {
      id: `resume-line:${line.lineNumber}`,
      title: `Line ${line.lineNumber}`,
      section: bullet.section,
      lineNumber: line.lineNumber,
      provenanceState: "recorded",
      sourceGranularity: "bullet",
      sourceId: bullet.sourceId,
      sourceLabel: change?.label ?? null,
      sourceText: originalTextFor(bullet, explanation?.annotatedChanges ?? []),
      tailoredText: [line.text],
      transformType: bullet.transformType,
      controls: bullet.control ? [bullet.control] : [],
      evidenceIds: bullet.evidenceIds,
      requirementIds: bullet.requirementIds,
      matchedSignals: bullet.matchedKeywords,
      rationale: bullet.rationale || change?.rationale || null,
    };
  }

  const change = explanation ? changeForLine(line, explanation.annotatedChanges) : undefined;
  if (change) {
    return {
      id: `resume-line:${line.lineNumber}`,
      title: `Line ${line.lineNumber}`,
      section: change.section,
      lineNumber: line.lineNumber,
      provenanceState: "recorded",
      sourceGranularity: "change_span",
      sourceId: change.sourceId,
      sourceLabel: change.label,
      sourceText: change.sourceText.length ? change.sourceText : null,
      tailoredText: [line.text],
      transformType: change.changeType,
      controls: change.controls,
      evidenceIds: change.evidenceIds,
      requirementIds: [],
      matchedSignals: change.jobSignals,
      rationale: change.rationale,
    };
  }

  if (isStructuralLine(line)) {
    return {
      id: `resume-line:${line.lineNumber}`,
      title: `Line ${line.lineNumber}`,
      section: line.kind === "section" ? "resume_section" : `resume_${line.kind}`,
      lineNumber: line.lineNumber,
      provenanceState: "not_applicable",
      sourceGranularity: "structure",
      sourceId: null,
      sourceLabel: null,
      sourceText: null,
      tailoredText: [line.text],
      transformType: "rendered_structure",
      controls: ["rendered resume structure"],
      evidenceIds: [],
      requirementIds: [],
      matchedSignals: [],
      rationale:
        "This rendered line is resume structure or identity text, not a generated claim requiring source attribution.",
    };
  }

  return {
    id: `resume-line:${line.lineNumber}`,
    title: `Line ${line.lineNumber}`,
    section: "rendered_resume",
    lineNumber: line.lineNumber,
    provenanceState: "missing",
    sourceGranularity: "missing",
    sourceId: null,
    sourceLabel: null,
    sourceText: null,
    tailoredText: [line.text],
    transformType: explanation ? "unmapped_rendered_line" : "no_generation_provenance",
    controls: [explanation ? "line not mapped to recorded change" : "rendered resume fallback"],
    evidenceIds: [],
    requirementIds: [],
    matchedSignals: [],
    rationale: explanation
      ? "This line is visible in the tailored resume, but it did not match a recorded generation-time source mapping."
      : "This line is visible in the tailored resume, but no generation-time source or evidence mapping was recorded.",
  };
}

function pinsFromResumeLines(
  lines: readonly ResumeLineEntry[],
  explanation: ArtifactTailoringExplanation | null,
): ResumeAuditPin[] {
  return lines.map((line) => pinFromResumeLine(line, explanation));
}

function resumeLinesFromText(resumeText: string | null | undefined): ResumeLineEntry[] {
  let firstContentLine = true;
  const lines: ResumeLineEntry[] = [];
  (resumeText ?? "").split(/\r?\n/).forEach((line, index) => {
    const text = line.trim();
    if (!text) return;
    const lower = text.toLowerCase();
    const kind: ResumeLineEntry["kind"] = firstContentLine
      ? "name"
      : RENDERED_RESUME_SECTION_HEADINGS.has(lower)
        ? "section"
        : index < 4 && /(@|https?:\/\/|linkedin|github|\+\d|\|)/i.test(text)
          ? "contact"
          : /^[-•○]\s+/.test(text)
            ? "bullet"
            : /(\b(?:jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\.?\s+\d{4}\b|\b\d{4}\b|\s\|\s)/i.test(
                  text,
                )
              ? "metadata"
              : "body";
    firstContentLine = false;
    lines.push({
      lineNumber: index + 1,
      text,
      kind,
    });
  });
  return lines;
}

function riskSignals(explanation: ArtifactTailoringExplanation): RiskSignals {
  const adversarial = explanation.adversarialReview;
  const auditGaps = explanation.quality.errors.filter((error) =>
    error.toLowerCase().startsWith("tailoring audit metadata incomplete"),
  );
  const blockers = [
    ...explanation.quality.errors.filter((error) => !auditGaps.includes(error)),
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
    auditGaps,
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
    auditGaps: [],
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

function riskSearchFieldsForPin(pin: ResumeAuditPin): string[] {
  return [
    pin.title,
    pin.section,
    pin.transformType,
    ...pin.controls,
    ...pin.evidenceIds,
    ...pin.requirementIds,
    ...pin.matchedSignals,
    ...pin.tailoredText,
  ]
    .map(normalizeResumeLine)
    .filter(Boolean);
}

function riskItemMatchesPin(pin: ResumeAuditPin, riskItem: string): boolean {
  const normalizedRisk = normalizeResumeLine(riskItem);
  if (!normalizedRisk) return false;
  const fields = riskSearchFieldsForPin(pin);
  if (fields.some((field) => field === normalizedRisk)) return true;
  if (normalizedRisk.length < 24) return false;
  return fields.some((field) => field.includes(normalizedRisk) || normalizedRisk.includes(field));
}

function pinHasClaimRisk(pin: ResumeAuditPin, risk: RiskSignals): boolean {
  return [
    ...risk.blockers,
    ...risk.unsupportedClaims,
    ...risk.fabrications,
    ...risk.missingRequiredEvidence,
  ].some((riskItem) => riskItemMatchesPin(pin, riskItem));
}

function pinTone(pin: ResumeAuditPin, risk: RiskSignals): "ok" | "info" | "warn" {
  if (pin.provenanceState === "missing") {
    return "warn";
  }
  if (pinHasClaimRisk(pin, risk)) {
    return "warn";
  }
  if (pin.sourceGranularity === "bullet" && pin.evidenceIds.length) return "ok";
  if (pin.sourceGranularity === "bullet" || pin.sourceGranularity === "change_span") return "info";
  if (pin.provenanceState === "not_applicable") return "info";
  if (risk.warnings.length || risk.residualWarnings.length || !risk.hasAnyAudit) {
    return "info";
  }
  return "ok";
}

function pinStatus(pin: ResumeAuditPin, risk: RiskSignals): string {
  if (pin.provenanceState === "missing") {
    return "missing source";
  }
  if (pinHasClaimRisk(pin, risk)) {
    return "claim risk";
  }
  if (pin.provenanceState === "not_applicable") return "structure";
  if (pin.sourceGranularity === "bullet") {
    return pin.evidenceIds.length ? "grounded" : "source pointer";
  }
  if (pin.sourceGranularity === "change_span") {
    return "source span";
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
      <FindingList label="Audit metadata gaps" items={risk.auditGaps} tone="warning" />
      <FindingList label="Warnings" items={risk.warnings} tone="warning" />
      <FindingList label="Accepted residual warnings" items={risk.residualWarnings} tone="warning" />
      <FindingList label="Repair instructions" items={risk.repairInstructions} tone="warning" />
    </div>
  );
}

function lineagePrecision(pin: ResumeAuditPin): string {
  if (pin.sourceGranularity === "bullet") return "Bullet provenance";
  if (pin.sourceGranularity === "change_span") return "Section source span";
  if (pin.sourceGranularity === "structure") return "Resume structure";
  return "No source mapping";
}

function sourcePointerLabel(pin: ResumeAuditPin): string {
  if (pin.sourceGranularity === "missing") return "No source pointer recorded";
  if (pin.sourceGranularity === "structure") return "Resume structure";
  const pointerLabel = pin.sourceLabel || formatToken(pin.section);
  return `${formatToken(pin.section)} -> ${pointerLabel}`;
}

function SourcePointer({ pin }: { readonly pin: ResumeAuditPin }): JSX.Element {
  if (pin.sourceGranularity === "missing") {
    return <p className="muted">No source pointer was recorded for this resume line.</p>;
  }
  if (pin.sourceGranularity === "structure") {
    return <p className="muted">This resume structure line does not require source attribution.</p>;
  }

  const sourceSpanCount = pin.sourceText?.length ?? 0;
  return (
    <div className="source-pointer">
      <p>
        <b>{sourcePointerLabel(pin)}</b>
      </p>
      <dl className="detail-list compact">
        <div>
          <dt>Lineage precision</dt>
          <dd>{lineagePrecision(pin)}</dd>
        </div>
        <div>
          <dt>Source ID</dt>
          <dd>{pin.sourceId || <span className="muted">none recorded</span>}</dd>
        </div>
      </dl>
      {sourceSpanCount ? (
        <details className="source-span-disclosure">
          <summary>Recorded source span ({sourceSpanCount} line{sourceSpanCount === 1 ? "" : "s"})</summary>
          <TextLines empty="No source text was recorded." lines={pin.sourceText} />
        </details>
      ) : (
        <p className="muted">No source text span was recorded for this pointer.</p>
      )}
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
          <h5>Source pointer</h5>
          <SourcePointer pin={pin} />
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
  const explanationPins = useMemo(() => (explanation ? pinsFromExplanation(explanation) : []), [explanation]);
  const canUseResumeLines = Boolean(
    resumeLines.length && (explanation || detail.data || detail.error),
  );
  const linePins = useMemo(
    () => (canUseResumeLines ? pinsFromResumeLines(resumeLines, explanation) : []),
    [canUseResumeLines, explanation, resumeLines],
  );
  const pins = useMemo(
    () => (linePins.length ? linePins : explanationPins),
    [explanationPins, linePins],
  );
  const risk = useMemo(() => (explanation ? riskSignals(explanation) : emptyRiskSignals()), [explanation]);
  const [selectedPinId, setSelectedPinId] = useState<string | null>(null);
  const usingResumeFallback = Boolean(!explanation && canUseResumeLines && linePins.length > 0);
  const selectedPinRef = useRef<HTMLLIElement | null>(null);

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
    if (typeof selectedPinRef.current?.scrollIntoView === "function") {
      selectedPinRef.current.scrollIntoView({ block: "nearest" });
    }
  }, [selectedPin?.id]);

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
              const pointerPreview = sourcePointerLabel(pin);
              const accessibleName = pin.lineNumber
                ? `Source pointer for rendered resume line ${pin.lineNumber}: ${pointerPreview}`
                : `${formatToken(pin.section)} pin ${index + 1}: ${pin.title}`;
              return (
                <li key={pin.id} ref={pin.id === selectedPin?.id ? selectedPinRef : undefined}>
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
                    <span>{pointerPreview}</span>
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
