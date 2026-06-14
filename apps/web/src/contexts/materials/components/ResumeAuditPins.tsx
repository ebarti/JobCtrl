import type {
  ApplyReviewProfileSourceField,
  ArtifactTailoringExplanation,
  BulletProvenanceEntry,
} from "@jobhunter/contracts";
import { useEffect, useMemo, useState, type Dispatch, type JSX, type SetStateAction } from "react";

import { Empty } from "../../../shared/ui/empty.js";
import type { PdfAuditLineSelection } from "../../../shared/ui/PdfPreviewViewer.js";
import { useArtifactDetailQuery } from "../../operations/hooks/useArtifactDetailQuery.js";
import { formatToken, scorePercent } from "../lib/audit-format.js";

type AnnotatedChange = ArtifactTailoringExplanation["annotatedChanges"][number];

interface ResumeAuditPinsProps {
  readonly artifactId: string;
  readonly resumeText?: string | null;
  readonly profileSourceFields?: readonly ApplyReviewProfileSourceField[];
  readonly className?: string;
  readonly selectedLine?: PdfAuditLineSelection | null;
  readonly onSelectedLineChange?: Dispatch<SetStateAction<PdfAuditLineSelection | null>>;
}

interface ResumeLineEntry {
  readonly lineLabel?: string | undefined;
  readonly lineNumber?: number | undefined;
  readonly text: string;
  readonly kind: "name" | "contact" | "section" | "metadata" | "bullet" | "body";
}

interface ResumeAuditPin {
  readonly id: string;
  readonly lineLabel?: string | undefined;
  readonly title: string;
  readonly section: string;
  readonly lineNumber?: number | undefined;
  readonly provenanceState: "recorded" | "missing" | "not_applicable";
  readonly sourceGranularity: "bullet" | "change_span" | "profile_field" | "missing" | "structure";
  readonly sourcePrecision: "exact_line" | "section_span" | "profile_field" | "structure" | "missing";
  readonly sourceId: string | null;
  readonly sourceLabel: string | null;
  readonly sourceText: readonly string[] | null;
  readonly sourceSpanText: readonly string[] | null;
  readonly tailoredText: readonly string[];
  readonly transformType: string;
  readonly controls: readonly string[];
  readonly evidenceIds: readonly string[];
  readonly evidenceNotes: readonly string[];
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

interface ProfileSourceMatch {
  readonly fields: readonly ApplyReviewProfileSourceField[];
  readonly sourceText: readonly string[];
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

function changeFor(
  entry: BulletProvenanceEntry,
  annotatedChanges: readonly AnnotatedChange[],
): AnnotatedChange | undefined {
  return annotatedChanges.find(
    (change) => change.section === entry.section && change.sourceId === entry.sourceId,
  );
}

function bulletSourceText(entry: BulletProvenanceEntry): readonly string[] {
  const entryWithSourceText = entry as BulletProvenanceEntry & { readonly sourceText?: readonly string[] };
  return entryWithSourceText.sourceText?.filter(Boolean) ?? [];
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

interface LineChangeMatch {
  readonly change: AnnotatedChange;
  readonly sourceText: readonly string[] | null;
}

function changeMatchForLine(
  line: ResumeLineEntry,
  annotatedChanges: readonly AnnotatedChange[],
): LineChangeMatch | undefined {
  for (const change of annotatedChanges) {
    const tailoredMatch = change.tailoredText.find((text) => textsMatchLine(text, line.text));
    if (tailoredMatch) {
      return {
        change,
        sourceText: sourceTextForTailoredLine(line.text, change.sourceText),
      };
    }
  }
  return undefined;
}

function tokenSet(value: string): Set<string> {
  return new Set(
    normalizeResumeLine(value)
      .replace(/[|/]/g, " ")
      .split(/\s+/)
      .filter((token) => token.length > 2 && !["and", "the", "for", "with", "from"].includes(token)),
  );
}

function displayEvidenceNotes(notes: readonly string[]): string[] {
  return notes
    .map((note) => note.replace(/^[a-z0-9][a-z0-9_-]*:\s*/i, "").trim())
    .filter(Boolean);
}

function displayRationale(rationale: string | null | undefined): string | null {
  if (!rationale) return null;
  return rationale
    .replace(/\bevidence_reframing\b/gi, "source-backed wording")
    .replace(/\bevidence controls?\b/gi, "source constraints")
    .replace(/\bverified_only\b/gi, "verified source evidence")
    .replace(/\bauto_approvable\b/gi, "auto approvable")
    .trim();
}

function labelMatchesContext(changeLabel: string | null | undefined, sourceHeading: string | null): boolean {
  if (!changeLabel || !sourceHeading) return false;
  const changeTokens = tokenSet(changeLabel);
  const headingTokens = tokenSet(sourceHeading);
  if (!changeTokens.size || !headingTokens.size) return false;
  const matches = [...changeTokens].filter((token) => headingTokens.has(token)).length;
  return matches >= Math.min(3, changeTokens.size);
}

function looksLikeSourceHeading(line: ResumeLineEntry, section: string | null): boolean {
  const isDatedLine = /\b(?:jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\.?\b|\b\d{4}\b/i.test(line.text);
  if (isDatedLine) return false;
  if (line.kind === "metadata") return true;
  const inExperience = section ? normalizeResumeLine(section) === "experience" : false;
  const roleLikeContactLine =
    line.kind === "contact" && /\s\|\s/.test(line.text) && !/(@|https?:\/\/|linkedin|github|\+\d)/i.test(line.text);
  return inExperience && roleLikeContactLine;
}

function contextualChangeForLine(
  line: ResumeLineEntry,
  annotatedChanges: readonly AnnotatedChange[],
  section: string | null,
  sourceHeading: string | null,
): AnnotatedChange | undefined {
  if (!section || isStructuralLine(line)) return undefined;
  return annotatedChanges.find(
    (change) => normalizeResumeLine(change.section) === normalizeResumeLine(section) && labelMatchesContext(change.label, sourceHeading),
  );
}

function sourceTextForTailoredLine(lineText: string, sourceText: readonly string[]): readonly string[] | null {
  if (!sourceText.length) return null;
  const scored = sourceText
    .map((source, index) => ({ index, score: tokenOverlapScore(lineText, source), source }))
    .filter((candidate) => candidate.score > 0)
    .sort((a, b) => b.score - a.score || a.index - b.index);
  const best = scored[0];
  if (!best || best.score < 16) {
    return sourceText.slice(0, 1);
  }
  return [best.source];
}

function sourceLineForBullet(
  entry: BulletProvenanceEntry,
  annotatedChanges: readonly AnnotatedChange[],
): readonly string[] | null {
  const explicitSourceText = bulletSourceText(entry);
  if (explicitSourceText.length) {
    return sourceTextForTailoredLine(entry.generatedText, explicitSourceText);
  }
  const change = changeFor(entry, annotatedChanges);
  if (!change?.sourceText.length) return null;
  return sourceTextForTailoredLine(entry.generatedText, change.sourceText);
}

function compactComparable(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, "");
}

function profileFieldDisplay(field: ApplyReviewProfileSourceField): string {
  return `${field.label}: ${field.value}`;
}

function profileFieldScore(line: ResumeLineEntry, field: ApplyReviewProfileSourceField): number {
  const lineCompact = compactComparable(line.text);
  const valueCompact = compactComparable(field.value);
  if (!lineCompact || valueCompact.length < 4) return 0;
  const allowShortDirectMatch = line.kind === "name" || line.kind === "contact";
  const directMatch =
    valueCompact.length >= (allowShortDirectMatch ? 4 : 8) &&
    (lineCompact.includes(valueCompact) || valueCompact.includes(lineCompact));
  if (directMatch) return 100;
  return tokenOverlapScore(line.text, field.value);
}

function profileSourceMatchForLine(
  line: ResumeLineEntry,
  fields: readonly ApplyReviewProfileSourceField[],
): ProfileSourceMatch | null {
  if (!fields.length || line.kind === "section") return null;
  const scored = fields
    .map((field, index) => ({ field, index, score: profileFieldScore(line, field) }))
    .filter((candidate) => candidate.score >= 60)
    .sort((left, right) => right.score - left.score || left.index - right.index);
  const best = scored[0];
  if (!best) return null;
  const selected =
    best.score === 100
      ? scored.filter((candidate) => candidate.score === 100)
      : scored.filter((candidate) => candidate.score >= Math.max(60, best.score - 15));
  const fieldsForLine = selected.slice(0, 8).map((candidate) => candidate.field);
  return {
    fields: fieldsForLine,
    sourceText: fieldsForLine.map(profileFieldDisplay),
  };
}

function tokenOverlapScore(left: string, right: string): number {
  const leftTokens = tokenSet(left);
  const rightTokens = tokenSet(right);
  if (!leftTokens.size || !rightTokens.size) return 0;
  const matches = [...leftTokens].filter((token) => rightTokens.has(token)).length;
  return Math.round((matches / Math.min(leftTokens.size, rightTokens.size)) * 100);
}

function bulletForLine(
  line: ResumeLineEntry,
  provenance: readonly BulletProvenanceEntry[],
): BulletProvenanceEntry | undefined {
  return provenance.find((entry) => textsMatchLine(entry.generatedText, line.text));
}

function isStructuralLine(line: ResumeLineEntry): boolean {
  return line.kind === "name" || line.kind === "contact" || line.kind === "section" || /^\d+\/\d+$/.test(line.text);
}

function linePinId(line: ResumeLineEntry): string {
  return line.lineNumber ? `resume-line:${line.lineNumber}` : `rendered-line:${line.lineLabel ?? line.text}`;
}

function lineTitle(line: ResumeLineEntry): string {
  return line.lineNumber ? `Line ${line.lineNumber}` : line.lineLabel ?? "Rendered PDF line";
}

function lineLabelForSelection(selection: PdfAuditLineSelection): string {
  return `PDF page ${selection.pageNumber} line ${selection.pageLineIndex}`;
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
        sourcePrecision: "exact_line",
        sourceId: entry.sourceId,
        sourceLabel: change?.label ?? null,
        sourceText: sourceLineForBullet(entry, explanation.annotatedChanges),
        sourceSpanText: change?.sourceText.length ? change.sourceText : null,
        tailoredText: entry.generatedText ? [entry.generatedText] : [],
        transformType: entry.transformType,
        controls: entry.control ? [entry.control] : [],
        evidenceIds: entry.evidenceIds,
        evidenceNotes: [],
        requirementIds: entry.requirementIds,
        matchedSignals: entry.matchedKeywords,
        rationale: displayRationale(entry.rationale || change?.rationale),
      };
    });
  }

  return explanation.annotatedChanges.map((change, index) => ({
    id: `change:${change.section}:${change.sourceId ?? change.label}:${index}`,
    title: change.label || `${formatToken(change.section)} pin ${index + 1}`,
    section: change.section,
    provenanceState: "recorded",
    sourceGranularity: "change_span",
    sourcePrecision: "section_span",
    sourceId: change.sourceId,
    sourceLabel: change.label,
    sourceText: change.sourceText.length ? change.sourceText : null,
    sourceSpanText: change.sourceText.length ? change.sourceText : null,
    tailoredText: change.tailoredText,
    transformType: change.changeType,
    controls: change.controls,
    evidenceIds: change.evidenceIds,
    evidenceNotes: displayEvidenceNotes(change.evidenceNotes),
    requirementIds: [],
    matchedSignals: change.jobSignals,
    rationale: displayRationale(change.rationale),
  }));
}

function pinFromProfileSourceLine(
  line: ResumeLineEntry,
  match: ProfileSourceMatch,
): ResumeAuditPin {
  const sourceLabel = match.fields.length === 1 ? match.fields[0]?.label ?? "Profile source field" : "Profile source fields";
  return {
    id: linePinId(line),
    title: lineTitle(line),
    section: match.fields[0]?.section ?? "profile",
    lineNumber: line.lineNumber,
    lineLabel: line.lineLabel,
    provenanceState: "recorded",
    sourceGranularity: "profile_field",
    sourcePrecision: "profile_field",
    sourceId: match.fields.map((field) => field.path).join(", "),
    sourceLabel,
    sourceText: match.sourceText,
    sourceSpanText: null,
    tailoredText: [line.text],
    transformType: "profile_field_rendered",
    controls: [],
    evidenceIds: [],
    evidenceNotes: [],
    requirementIds: [],
    matchedSignals: [],
    rationale:
      match.fields.length === 1
        ? "This tailored resume line is rendered from the Profile field shown above."
        : "This tailored resume line is rendered from the Profile fields shown above.",
  };
}

function pinFromResumeLine(
  line: ResumeLineEntry,
  explanation: ArtifactTailoringExplanation | null,
  profileSourceFields: readonly ApplyReviewProfileSourceField[],
  contextChange?: AnnotatedChange,
): ResumeAuditPin {
  const isResumeStructure = line.kind === "section" || /^\d+\/\d+$/.test(line.text);
  if (isResumeStructure) {
    return {
      id: linePinId(line),
      title: lineTitle(line),
      section: line.kind === "section" ? "resume_section" : `resume_${line.kind}`,
      lineNumber: line.lineNumber,
      lineLabel: line.lineLabel,
      provenanceState: "not_applicable",
      sourceGranularity: "structure",
      sourcePrecision: "structure",
      sourceId: null,
      sourceLabel: null,
      sourceText: null,
      sourceSpanText: null,
      tailoredText: [line.text],
      transformType: "rendered_structure",
      controls: [],
      evidenceIds: [],
      evidenceNotes: [],
      requirementIds: [],
      matchedSignals: [],
      rationale:
        "This tailored resume line is document structure, not a generated claim requiring source attribution.",
    };
  }

  const profileSourceMatch = profileSourceMatchForLine(line, profileSourceFields);
  if (profileSourceMatch && (line.kind === "name" || line.kind === "contact")) {
    return pinFromProfileSourceLine(line, profileSourceMatch);
  }

  const bullet = explanation ? bulletForLine(line, explanation.bulletProvenance) : undefined;
  if (bullet) {
    const change = explanation ? changeFor(bullet, explanation.annotatedChanges) : undefined;
    return {
      id: linePinId(line),
      title: lineTitle(line),
      section: bullet.section,
      lineNumber: line.lineNumber,
      lineLabel: line.lineLabel,
      provenanceState: "recorded",
      sourceGranularity: "bullet",
      sourcePrecision: "exact_line",
      sourceId: bullet.sourceId,
      sourceLabel: change?.label ?? null,
      sourceText: sourceLineForBullet(bullet, explanation?.annotatedChanges ?? []),
      sourceSpanText: change?.sourceText.length ? change.sourceText : null,
      tailoredText: [line.text],
      transformType: bullet.transformType,
      controls: bullet.control ? [bullet.control] : [],
      evidenceIds: bullet.evidenceIds,
      evidenceNotes: [],
      requirementIds: bullet.requirementIds,
      matchedSignals: bullet.matchedKeywords,
      rationale: displayRationale(bullet.rationale || change?.rationale),
    };
  }

  const lineChangeMatch = explanation ? changeMatchForLine(line, explanation.annotatedChanges) : undefined;
  if (lineChangeMatch) {
    const { change } = lineChangeMatch;
    return {
      id: linePinId(line),
      title: lineTitle(line),
      section: change.section,
      lineNumber: line.lineNumber,
      lineLabel: line.lineLabel,
      provenanceState: "recorded",
      sourceGranularity: "change_span",
      sourcePrecision: "exact_line",
      sourceId: change.sourceId,
      sourceLabel: change.label,
      sourceText: lineChangeMatch.sourceText,
      sourceSpanText: change.sourceText.length ? change.sourceText : null,
      tailoredText: [line.text],
      transformType: change.changeType,
      controls: change.controls,
      evidenceIds: change.evidenceIds,
      evidenceNotes: displayEvidenceNotes(change.evidenceNotes),
      requirementIds: [],
      matchedSignals: change.jobSignals,
      rationale: displayRationale(change.rationale),
    };
  }

  if (profileSourceMatch) {
    return pinFromProfileSourceLine(line, profileSourceMatch);
  }

  if (contextChange) {
    return {
      id: linePinId(line),
      title: lineTitle(line),
      section: contextChange.section,
      lineNumber: line.lineNumber,
      lineLabel: line.lineLabel,
      provenanceState: "recorded",
      sourceGranularity: "change_span",
      sourcePrecision: "section_span",
      sourceId: contextChange.sourceId,
      sourceLabel: contextChange.label,
      sourceText: sourceTextForTailoredLine(line.text, contextChange.sourceText),
      sourceSpanText: contextChange.sourceText.length ? contextChange.sourceText : null,
      tailoredText: [line.text],
      transformType: contextChange.changeType,
      controls: contextChange.controls,
      evidenceIds: contextChange.evidenceIds,
      evidenceNotes: displayEvidenceNotes(contextChange.evidenceNotes),
      requirementIds: [],
      matchedSignals: contextChange.jobSignals,
      rationale:
        "No exact Profile source field was recorded for this tailored resume line. The generator recorded this nearby Profile source section, so review the recorded source before approving the claim.",
    };
  }

  return {
    id: linePinId(line),
    title: lineTitle(line),
    section: "rendered_resume",
    lineNumber: line.lineNumber,
    lineLabel: line.lineLabel,
    provenanceState: "missing",
    sourceGranularity: "missing",
    sourcePrecision: "missing",
    sourceId: null,
    sourceLabel: null,
    sourceText: null,
    sourceSpanText: null,
    tailoredText: [line.text],
    transformType: explanation ? "unmapped_rendered_line" : "no_generation_provenance",
    controls: [],
    evidenceIds: [],
    evidenceNotes: [],
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
  profileSourceFields: readonly ApplyReviewProfileSourceField[],
): ResumeAuditPin[] {
  let currentSection: string | null = null;
  let currentSourceHeading: string | null = null;
  return lines.map((line) => {
    if (line.kind === "section") {
      currentSection = line.text;
      currentSourceHeading = null;
    } else if (looksLikeSourceHeading(line, currentSection)) {
      currentSourceHeading = line.text;
    }
    const exactPin = pinFromResumeLine(line, explanation, profileSourceFields);
    if (exactPin.provenanceState !== "missing" || !explanation) {
      return exactPin;
    }
    return pinFromResumeLine(
      line,
      explanation,
      profileSourceFields,
      contextualChangeForLine(line, explanation.annotatedChanges, currentSection, currentSourceHeading),
    );
  });
}

function lineKindForText(text: string, index: number, firstContentLine: boolean): ResumeLineEntry["kind"] {
  const lower = text.toLowerCase();
  return firstContentLine
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
}

function resumeLinesFromText(resumeText: string | null | undefined): ResumeLineEntry[] {
  let firstContentLine = true;
  const lines: ResumeLineEntry[] = [];
  (resumeText ?? "").split(/\r?\n/).forEach((line, index) => {
    const text = line.trim();
    if (!text) return;
    const kind = lineKindForText(text, index, firstContentLine);
    firstContentLine = false;
    lines.push({
      lineNumber: index + 1,
      text,
      kind,
    });
  });
  return lines;
}

function resumeLineFromPdfSelection(selection: PdfAuditLineSelection): ResumeLineEntry {
  const text = selection.resumeLineText || selection.text;
  return {
    kind: lineKindForText(text, 999, false),
    lineLabel: lineLabelForSelection(selection),
    lineNumber: selection.lineNumber ?? undefined,
    text,
  };
}

function riskSignals(explanation: ArtifactTailoringExplanation): RiskSignals {
  const adversarial = explanation.adversarialReview;
  const auditGaps = explanation.quality.errors.filter((error) =>
    error.toLowerCase().startsWith("tailoring audit metadata incomplete"),
  );
  const blockers = uniqueRiskItems([
    ...explanation.quality.errors.filter((error) => !auditGaps.includes(error)),
    ...explanation.judge.issues,
    ...(adversarial?.blockers ?? []),
  ]);
  const rawWarnings = uniqueRiskItems([
    ...explanation.quality.warnings,
    ...(adversarial?.warnings ?? []),
  ]);
  const residualWarnings = uniqueRiskItems([
    ...explanation.reviewFeedback.acceptedWarnings,
    ...(explanation.reviewFeedback.acceptedWithResidualWarnings ? rawWarnings : []),
  ]);
  const residualWarningKeys = new Set(residualWarnings.map(riskItemKey));
  const warnings = rawWarnings.filter((warning) => !residualWarningKeys.has(riskItemKey(warning)));
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
    residualWarnings,
  };
}

function uniqueRiskItems(items: readonly string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const item of items) {
    const text = item.replace(/\s+/g, " ").trim();
    if (!text) continue;
    const key = riskItemKey(text);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(text);
  }
  return out;
}

function riskItemKey(item: string): string {
  return item.replace(/\s+/g, " ").trim().toLowerCase();
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
  if (pin.sourceGranularity === "profile_field") return "profile source";
  if (pin.sourceGranularity === "bullet") {
    return pin.evidenceIds.length ? "line evidence" : "source pointer";
  }
  if (pin.sourceGranularity === "change_span") {
    return pin.sourcePrecision === "exact_line" ? "profile field" : "profile section";
  }
  return "review";
}

function OptionalTagRow({
  label,
  values,
}: {
  readonly label: string;
  readonly values: readonly string[];
}): JSX.Element | null {
  if (!values.length) return null;
  return (
    <div>
      <dt>{label}</dt>
      <dd>
        {values.map((value) => (
          <span className="tag muted" key={value}>
            {value}
          </span>
        ))}
      </dd>
    </div>
  );
}

function CompactFindingList({
  label,
  items,
  tone,
}: {
  readonly label: string;
  readonly items: readonly string[];
  readonly tone: "danger" | "warning";
}): JSX.Element | null {
  if (!items.length) return null;
  const remainingItems = items.slice(1);
  return (
    <details className={`artifact-risk-finding ${tone}`}>
      <summary>
        <span className="artifact-risk-finding-label">
          <b>{label}</b>
          <span className="tag muted">{items.length}</span>
        </span>
        <span className="artifact-risk-finding-preview">{items[0]}</span>
      </summary>
      {remainingItems.length ? (
        <ul className="compact-list">
          {remainingItems.map((item) => (
            <li key={item}>{item}</li>
          ))}
        </ul>
      ) : null}
    </details>
  );
}

function RiskPanel({
  className = "resume-pin-risk",
  risk,
}: {
  readonly className?: string;
  readonly risk: RiskSignals;
}): JSX.Element {
  return (
    <section aria-label="Artifact-level grounding and claim risk" className={className}>
      <div className="artifact-risk-summary">
        <h4>Artifact-level grounding and claim risk</h4>
        <dl className="artifact-risk-metrics">
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
      </div>
      {!risk.hasAnyAudit ? (
        <p className="muted">No claim-risk audit was recorded for this artifact.</p>
      ) : null}
      <div className="artifact-risk-findings">
        <CompactFindingList label="Unsupported claims" items={risk.unsupportedClaims} tone="danger" />
        <CompactFindingList label="Fabrications" items={risk.fabrications} tone="danger" />
        <CompactFindingList label="Missing required evidence" items={risk.missingRequiredEvidence} tone="danger" />
        <CompactFindingList label="Blockers" items={risk.blockers} tone="danger" />
        <CompactFindingList label="Audit metadata gaps" items={risk.auditGaps} tone="warning" />
        <CompactFindingList label="Warnings" items={risk.warnings} tone="warning" />
        <CompactFindingList label="Accepted residual warnings" items={risk.residualWarnings} tone="warning" />
        <CompactFindingList label="Repair instructions" items={risk.repairInstructions} tone="warning" />
      </div>
    </section>
  );
}

export function ArtifactGroundingRiskPanel({
  artifactId,
}: {
  readonly artifactId: string;
}): JSX.Element | null {
  const detail = useArtifactDetailQuery(artifactId);
  const explanation = detail.data?.tailoringExplanation ?? null;
  const risk = useMemo(() => (explanation ? riskSignals(explanation) : emptyRiskSignals()), [explanation]);
  if (!risk.hasAnyAudit) return null;
  return <RiskPanel className="apply-review-preview-block apply-review-artifact-risk resume-pin-risk" risk={risk} />;
}

function lineagePrecision(pin: ResumeAuditPin): string {
  if (pin.sourceGranularity === "bullet") return "Bullet provenance";
  if (pin.sourceGranularity === "profile_field") return "Profile field match";
  if (pin.sourceGranularity === "change_span") {
    return pin.sourcePrecision === "exact_line" ? "Profile source field" : "Profile source span; exact field not recorded";
  }
  if (pin.sourceGranularity === "structure") return "Resume structure";
  return "No source mapping";
}

function sourcePointerLabel(pin: ResumeAuditPin): string {
  if (pin.sourceGranularity === "missing") return "No source pointer recorded";
  if (pin.sourceGranularity === "structure") return "Resume structure";
  if (pin.sourceGranularity === "profile_field") return pin.sourceLabel || "Profile source field";
  const pointerLabel = pin.sourceLabel || formatToken(pin.section);
  return `${formatToken(pin.section)} -> ${pointerLabel}`;
}

function SourceEvidencePreview({
  expanded,
  pin,
  text,
}: {
  readonly expanded: boolean;
  readonly pin: ResumeAuditPin;
  readonly text?: readonly string[] | null;
}): JSX.Element | null {
  const sourceText = text ?? pin.sourceText;
  if (pin.sourceGranularity === "structure") {
    return <span className="resume-pin-source-evidence muted">Resume structure; no Profile source field required.</span>;
  }
  if (pin.sourceGranularity === "missing") {
    return <span className="resume-pin-source-evidence missing">No Profile source field was recorded for this tailored resume line.</span>;
  }
  if (!sourceText?.length) {
    return <span className="resume-pin-source-evidence missing">No Profile source text was resolved for this pointer.</span>;
  }

  const visibleLines = expanded ? sourceText : sourceText.slice(0, 2);
  const hiddenLineCount = sourceText.length - visibleLines.length;
  return (
    <span className="resume-pin-source-evidence" aria-label={`Profile source text: ${sourceText.join(" ")}`}>
      {visibleLines.map((line, index) => (
        <span className="resume-pin-source-line" key={`${pin.id}:source:${index}`}>
          {line}
        </span>
      ))}
      {hiddenLineCount > 0 ? (
        <span className="resume-pin-source-more">
          +{hiddenLineCount} more Profile source field{hiddenLineCount === 1 ? "" : "s"}
        </span>
      ) : null}
    </span>
  );
}

function SourceEvidenceBlock({ pin }: { readonly pin: ResumeAuditPin }): JSX.Element | null {
  const sourceSpanText = pin.sourceSpanText ?? pin.sourceText;
  if (pin.sourceGranularity !== "change_span") {
    return <SourceEvidencePreview expanded pin={pin} text={sourceSpanText} />;
  }
  if (!sourceSpanText?.length) {
    return <SourceEvidencePreview expanded pin={pin} text={sourceSpanText} />;
  }

  return (
    <details className="resume-pin-source-span-details">
      <summary>
        <span>{pin.sourceLabel || formatToken(pin.section)}</span>
        <span className="muted">
          {sourceSpanText.length} Profile source field{sourceSpanText.length === 1 ? "" : "s"}
        </span>
      </summary>
      <SourceEvidencePreview expanded pin={pin} text={sourceSpanText} />
    </details>
  );
}

function primarySourceTextForPin(pin: ResumeAuditPin): readonly string[] | null {
  if (!pin.sourceText?.length) return null;
  if (pin.sourceGranularity === "profile_field") return pin.sourceText;
  if (pin.sourceText.length === 1) return pin.sourceText;
  return sourceTextForTailoredLine(pin.tailoredText.join(" "), pin.sourceText) ?? pin.sourceText.slice(0, 1);
}

function sourceLabelForJustification(pin: ResumeAuditPin): string {
  if (pin.sourceGranularity === "profile_field") {
    return pin.sourceText && pin.sourceText.length > 1 ? "Profile source fields" : "Profile source field";
  }
  if (pin.sourcePrecision === "section_span") return "Closest recorded Profile source field";
  return "Profile source field";
}

function SourcePointer({ pin }: { readonly pin: ResumeAuditPin }): JSX.Element {
  if (pin.sourceGranularity === "missing") {
    return <p className="muted">No Profile source field mapping was recorded for this tailored resume line.</p>;
  }
  if (pin.sourceGranularity === "structure") {
    return <p className="muted">This resume structure line does not require source attribution.</p>;
  }

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
      </dl>
    </div>
  );
}

function LineJustification({ pin }: { readonly pin: ResumeAuditPin }): JSX.Element {
  const signals = pin.matchedSignals.length ? ` Signals reflected: ${pin.matchedSignals.join(", ")}.` : "";
  const why = pin.rationale ? `${pin.rationale}${signals}` : signals.trim();
  const sourceLabel = sourceLabelForJustification(pin);
  const primarySourceText = primarySourceTextForPin(pin);
  return (
    <section className="resume-pin-justification">
      <h5>Line justification</h5>
      <dl className="detail-list compact">
        <div>
          <dt>{sourceLabel}</dt>
          <dd>
            <SourceEvidencePreview expanded pin={pin} text={primarySourceText} />
            {pin.sourcePrecision === "section_span" ? (
              <span className="muted">
                Exact Profile source-field provenance was not recorded for this tailored resume line.
              </span>
            ) : null}
          </dd>
        </div>
        <div>
          <dt>Tailored resume line</dt>
          <dd>{pin.tailoredText.length ? pin.tailoredText.join(" ") : <span className="muted">none recorded</span>}</dd>
        </div>
        <div>
          <dt>Why</dt>
          <dd>{why || <span className="muted">no rationale recorded</span>}</dd>
        </div>
      </dl>
    </section>
  );
}

function SelectedPinInspector({
  pin,
  risk,
}: {
  readonly pin: ResumeAuditPin;
  readonly risk: RiskSignals;
}): JSX.Element {
  const tone = pinTone(pin, risk);
  return (
    <article
      aria-label={
        pin.lineNumber
          ? `Selected resume line audit for line ${pin.lineNumber}`
          : pin.lineLabel
            ? `Selected resume line audit for ${pin.lineLabel}`
            : "Selected resume audit"
      }
      className="resume-pin-detail"
      aria-live="polite"
    >
      <header>
        <div>
          <span className="eyebrow">{formatToken(pin.section)}</span>
          <h4>{pin.title}</h4>
        </div>
        <span className={`tag ${tone}`}>{pinStatus(pin, risk)}</span>
      </header>
      <LineJustification pin={pin} />
      <details className="resume-pin-source-check">
        <summary>
          <span>Source check</span>
          <span className="muted">{lineagePrecision(pin)}</span>
        </summary>
        <div className="resume-pin-source-check-body">
          <section>
            <h5>Recorded Profile source</h5>
            <SourceEvidenceBlock pin={pin} />
          </section>
          <section>
            <h5>Lineage</h5>
            <SourcePointer pin={pin} />
          </section>
        </div>
      </details>
      <dl className="detail-list compact">
        {pin.lineNumber ? (
          <div>
            <dt>Resume line</dt>
            <dd>{pin.lineNumber}</dd>
          </div>
        ) : pin.lineLabel ? (
          <div>
            <dt>PDF line</dt>
            <dd>{pin.lineLabel}</dd>
          </div>
        ) : null}
        <OptionalTagRow label="Job signals reflected" values={pin.matchedSignals} />
        <OptionalTagRow label="Evidence notes" values={pin.evidenceNotes} />
      </dl>
    </article>
  );
}

export function ResumeAuditPins({
  artifactId,
  resumeText,
  profileSourceFields = [],
  className = "apply-review-resume-pins",
  selectedLine,
  onSelectedLineChange,
}: ResumeAuditPinsProps): JSX.Element {
  const detail = useArtifactDetailQuery(artifactId);
  const explanation = detail.data?.tailoringExplanation ?? null;
  const resumeLines = useMemo(() => resumeLinesFromText(resumeText), [resumeText]);
  const explanationPins = useMemo(() => (explanation ? pinsFromExplanation(explanation) : []), [explanation]);
  const canUseResumeLines = Boolean(
    resumeLines.length && (explanation || detail.data || detail.error),
  );
  const linePins = useMemo(
    () => (canUseResumeLines ? pinsFromResumeLines(resumeLines, explanation, profileSourceFields) : []),
    [canUseResumeLines, explanation, profileSourceFields, resumeLines],
  );
  const selectedRenderedLinePin = useMemo(() => {
    if (!selectedLine) return null;
    if (selectedLine.lineNumber !== null && linePins.some((pin) => pin.lineNumber === selectedLine.lineNumber)) {
      return null;
    }
    return pinFromResumeLine(resumeLineFromPdfSelection(selectedLine), explanation, profileSourceFields);
  }, [explanation, linePins, profileSourceFields, selectedLine]);
  const pins = useMemo(
    () => (linePins.length ? linePins : explanationPins),
    [explanationPins, linePins],
  );
  const risk = useMemo(() => (explanation ? riskSignals(explanation) : emptyRiskSignals()), [explanation]);
  const [selectedPinId, setSelectedPinId] = useState<string | null>(null);
  const usingResumeFallback = Boolean(!explanation && canUseResumeLines && linePins.length > 0);

  useEffect(() => {
    if (!pins.length) {
      setSelectedPinId(null);
      return;
    }
    const selectedLinePin =
      selectedLine?.lineNumber === null || selectedLine?.lineNumber === undefined
        ? null
        : pins.find((pin) => pin.lineNumber === selectedLine.lineNumber) ?? null;
    setSelectedPinId((currentPinId) => {
      if (selectedLinePin) {
        return selectedLinePin.id;
      }
      if (currentPinId && pins.some((pin) => pin.id === currentPinId)) {
        return currentPinId;
      }
      return pins[0]?.id ?? null;
    });
  }, [artifactId, pins, selectedLine?.lineNumber]);

  const selectedLinePin =
    selectedLine?.lineNumber === null || selectedLine?.lineNumber === undefined
      ? null
      : pins.find((pin) => pin.lineNumber === selectedLine.lineNumber) ?? null;
  const selectedPin = selectedRenderedLinePin ?? selectedLinePin ?? pins.find((pin) => pin.id === selectedPinId) ?? pins[0] ?? null;
  const errorMessage = detail.error instanceof Error ? detail.error.message : null;

  useEffect(() => {
    if (selectedLine) return;
    if (!selectedPin?.lineNumber) return;
    const initialSelection = {
      lineKey: `resume:${selectedPin.lineNumber}`,
      lineNumber: selectedPin.lineNumber,
      pageLineIndex: selectedPin.lineNumber,
      pageNumber: 0,
      resumeLineText: selectedPin.tailoredText[0] ?? null,
      text: selectedPin.tailoredText[0] ?? "",
    };
    onSelectedLineChange?.((currentSelection) => currentSelection ?? initialSelection);
  }, [onSelectedLineChange, selectedLine, selectedPin?.lineNumber, selectedPin?.tailoredText]);

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
      {selectedPin ? (
        <div className="resume-pin-shell">
          <SelectedPinInspector pin={selectedPin} risk={risk} />
        </div>
      ) : null}
    </section>
  );
}
