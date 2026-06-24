import type {
  ApplyReviewProfileSourceField,
  ArtifactTailoringExplanation,
  BulletProvenanceEntry,
  ResumeCommentReplyDecision,
  ResumeCommentThread,
  ResumeReviewDraft,
  ResumeReviewDraftRenderResponse,
  ResumeReviewCommentThreadSeedInput,
  ResumeLayoutBox,
} from "@jobhunter/contracts";
import type { Descendant, TElement, Value } from "platejs";
import {
  Plate,
  PlateContent,
  createPlatePlugin,
  usePlateEditor,
  type PlateElementProps,
} from "platejs/react";
import {
  createContext,
  createElement,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type Dispatch,
  type FormEvent,
  type JSX,
  type SetStateAction,
} from "react";

import { Empty } from "../../../shared/ui/empty.js";
import type { PdfAuditLineSelection, PdfAuditLineTarget } from "../../../shared/ui/PdfPreviewViewer.js";
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

interface ResumePlateEditorProps {
  readonly artifactId: string;
  readonly autosaveDelayMs?: number;
  readonly draft: ResumeReviewDraft | null;
  readonly draftError?: string | null;
  readonly draftLoading?: boolean;
  readonly finalUrl: string;
  readonly htmlUrl: string | null;
  readonly layoutBoxes: readonly ResumeLayoutBox[];
  readonly lineTargets: readonly PdfAuditLineTarget[];
  readonly profileSourceFields?: readonly ApplyReviewProfileSourceField[];
  readonly renderError?: string | null;
  readonly renderPending?: boolean;
  readonly renderResult?: ResumeReviewDraftRenderResponse | null;
  readonly resumeText?: string | null;
  readonly saveError?: string | null;
  readonly savePending?: boolean;
  readonly replyError?: string | null;
  readonly replyPending?: boolean;
  readonly selectedLine?: PdfAuditLineSelection | null;
  readonly title: string;
  readonly onDraftGateChange?: (state: ResumeDraftGateState) => void;
  readonly onRenderDraft?: () => void;
  readonly onReplyToThread?: (
    thread: ResumeCommentThread,
    input: {
      readonly decision: ResumeCommentReplyDecision;
      readonly body: string;
    },
  ) => void;
  readonly onSaveDraft?: (input: {
    readonly editedText: string;
    readonly plateDocument: Value;
    readonly source: "autosave" | "manual";
  }) => void;
  readonly onSelectLine: (selection: PdfAuditLineSelection) => void;
  readonly onSeedCommentThreads?: (threads: readonly ResumeReviewCommentThreadSeedInput[]) => void;
}

export interface ResumeDraftGateState {
  readonly draftId: string | null;
  readonly dirty: boolean;
  readonly hasSavedRevision: boolean;
  readonly rendered: boolean;
  readonly reason: string | null;
}

interface ResumeLineEntry {
  readonly lineLabel?: string | undefined;
  readonly lineNumber?: number | undefined;
  readonly text: string;
  readonly kind: "name" | "contact" | "section" | "metadata" | "bullet" | "body";
}

interface ResumePlateLine extends ResumeLineEntry {
  readonly id: string;
  readonly className: string;
  readonly pageNumber: number;
  readonly semanticId: string | null;
  readonly tagName: string;
}

interface ResumePlateComment {
  readonly sourceLabel: string | null;
  readonly sourceText: string | null;
  readonly status: string;
  readonly tone: "ok" | "info" | "warn";
  readonly why: string | null;
}

interface ResumePlateDomElement extends TElement {
  readonly type: "resume_block" | "resume_inline";
  readonly className?: string | undefined;
  readonly href?: string | undefined;
  readonly lineNumber?: number | undefined;
  readonly pageNumber?: number | undefined;
  readonly semanticId?: string | null | undefined;
  readonly tagName: string;
}

interface ResumePlateLineEntry {
  readonly index: number;
  readonly line: ResumePlateLine;
}

interface ResumePlateRenderContextValue {
  readonly layoutBoxes: readonly ResumeLayoutBox[];
  readonly lineEntries: ReadonlyMap<number | undefined, ResumePlateLineEntry>;
  readonly onSelectLine: (selection: PdfAuditLineSelection) => void;
  readonly pins: readonly ResumeAuditPin[];
  readonly risk: RiskSignals;
  readonly selectedLine: PdfAuditLineSelection | null | undefined;
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
  readonly matchedKeywords: readonly string[];
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
  readonly warningHandling: string;
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

const RESUME_PLATE_BLOCK_TAGS = new Set([
  "article",
  "div",
  "h1",
  "h2",
  "h3",
  "header",
  "li",
  "main",
  "p",
  "section",
  "ul",
]);

const RESUME_PLATE_INLINE_TAGS = new Set(["a", "b", "span", "strong"]);

const RESUME_PLATE_BLOCK_PLUGIN = createPlatePlugin({
  key: "resume_block",
  node: { isElement: true },
});

const RESUME_PLATE_INLINE_PLUGIN = createPlatePlugin({
  key: "resume_inline",
  node: { isElement: true, isInline: true },
});

const RESUME_PLATE_PLUGINS = [RESUME_PLATE_BLOCK_PLUGIN, RESUME_PLATE_INLINE_PLUGIN];

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
  return line.lineNumber ? `Line ${line.lineNumber}` : line.lineLabel ?? "Rendered resume line";
}

function lineLabelForSelection(selection: PdfAuditLineSelection): string {
  return `Resume page ${selection.pageNumber} line ${selection.pageLineIndex}`;
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
        matchedSignals: change?.jobSignals ?? [],
        matchedKeywords: entry.matchedKeywords,
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
    matchedKeywords: [],
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
    matchedKeywords: [],
    rationale:
      match.fields.length === 1
        ? "This selected resume line is rendered from the Profile field shown above."
        : "This selected resume line is rendered from the Profile fields shown above.",
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
      matchedKeywords: [],
      rationale:
        "This selected resume line is document structure, not a generated claim requiring source attribution.",
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
      matchedSignals: change?.jobSignals ?? [],
      matchedKeywords: bullet.matchedKeywords,
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
      matchedKeywords: [],
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
      matchedKeywords: [],
      rationale:
        "No exact Profile source field was recorded for this selected resume line. The generator recorded this nearby Profile source section, so review the recorded source before approving the claim.",
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
    matchedKeywords: [],
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

const RESUME_HTML_LINE_SELECTOR = "[data-resume-line-number]";

function parsePositiveInteger(value: string | null): number | null {
  if (!value) return null;
  const parsed = Number.parseInt(value, 10);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : null;
}

function cleanRenderedText(value: string | null | undefined): string {
  return (value ?? "").replace(/\s+/g, " ").trim();
}

function resumePlateTextNode(text: string): Descendant | null {
  const clean = text.replace(/\s+/g, " ");
  if (!clean.trim()) return null;
  return { text: clean };
}

function resumePlateChildrenFromDom(element: Element): Descendant[] {
  const children = Array.from(element.childNodes)
    .map((node) => resumePlateNodeFromDom(node))
    .filter((node): node is Descendant => Boolean(node));
  return children.length ? children : [{ text: "" }];
}

function resumePlateNodeFromDom(node: Node): Descendant | null {
  if (node.nodeType === Node.TEXT_NODE) {
    return resumePlateTextNode(node.textContent ?? "");
  }
  if (!(node instanceof HTMLElement)) return null;
  const tagName = node.tagName.toLowerCase();
  const isInline = RESUME_PLATE_INLINE_TAGS.has(tagName);
  if (!isInline && !RESUME_PLATE_BLOCK_TAGS.has(tagName)) {
    return resumePlateTextNode(cleanRenderedText(node.textContent));
  }
  return {
    children: resumePlateChildrenFromDom(node),
    className: node.getAttribute("class") || undefined,
    href: tagName === "a" ? safeResumeHref(node.getAttribute("href")) : undefined,
    lineNumber: parsePositiveInteger(node.getAttribute("data-resume-line-number")) ?? undefined,
    pageNumber: parsePositiveInteger(node.getAttribute("data-resume-page")) ?? undefined,
    semanticId: node.getAttribute("data-resume-layout-target") || null,
    tagName,
    type: isInline ? "resume_inline" : "resume_block",
  };
}

function safeResumeHref(value: string | null): string | undefined {
  const href = value?.trim();
  if (!href) return undefined;
  return /^(?:https?:|mailto:|tel:)/i.test(href) ? href : undefined;
}

function resumePlateValueFromHtml(html: string): Value {
  if (typeof DOMParser === "undefined") {
    return [{ type: "resume_block", tagName: "main", className: "resume-page", children: [{ text: "" }] }];
  }
  const doc = new DOMParser().parseFromString(html, "text/html");
  const page = doc.querySelector<HTMLElement>(".resume-page");
  const nodes = Array.from((page ? [page] : Array.from(doc.body.children)) as Iterable<Element>)
    .map((node) => resumePlateNodeFromDom(node))
    .filter((node): node is Descendant => Boolean(node));
  return nodes.length
    ? (nodes as Value)
    : [{ type: "resume_block", tagName: "main", className: "resume-page", children: [{ text: "" }] }];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function isPlateDescendant(value: unknown): value is Descendant {
  if (!isRecord(value)) return false;
  if (typeof value.text === "string") return true;
  return Array.isArray(value.children) && value.children.every(isPlateDescendant);
}

function isPlateValue(value: unknown): value is Value {
  return Array.isArray(value) && value.every(isPlateDescendant);
}

function resumeTextFromPlateNode(node: Descendant): string {
  if ("text" in node) {
    return typeof node.text === "string" ? node.text : "";
  }
  const children = "children" in node && Array.isArray(node.children) ? node.children : [];
  return children
    .map(resumeTextFromPlateNode)
    .join(" ")
    .replace(/\s+/g, " ")
    .trim();
}

function resumeTextFromPlateValue(value: Value): string {
  return value
    .map(resumeTextFromPlateNode)
    .map((line) => line.replace(/\s+/g, " ").trim())
    .filter(Boolean)
    .join("\n");
}

function kindForHtmlElement(element: HTMLElement, index: number, text: string): ResumeLineEntry["kind"] {
  const className = element.getAttribute("class") ?? "";
  const tagName = element.tagName.toLowerCase();
  if (className.includes("resume-name") || tagName === "h1") return "name";
  if (className.includes("resume-contact")) return "contact";
  if (tagName === "h2") return "section";
  if (tagName === "li") return "bullet";
  if (className.includes("resume-meta") || className.includes("resume-entry-title") || tagName === "h3") {
    return "metadata";
  }
  return lineKindForText(text, index, index === 0);
}

function plateTagForKind(kind: ResumeLineEntry["kind"]): ResumePlateLine["tagName"] {
  if (kind === "name") return "h1";
  if (kind === "section") return "h2";
  if (kind === "metadata") return "h3";
  return "div";
}

function layoutBoxForLine(
  line: {
    readonly lineNumber?: number | null | undefined;
    readonly semanticId?: string | null | undefined;
    readonly text: string;
  },
  layoutBoxes: readonly ResumeLayoutBox[],
): ResumeLayoutBox | null {
  if (line.lineNumber) {
    const byNumber = layoutBoxes.find((box) => box.lineNumber === line.lineNumber);
    if (byNumber) return byNumber;
  }
  if (line.semanticId) {
    const byId = layoutBoxes.find((box) => box.semanticId === line.semanticId);
    if (byId) return byId;
  }
  const normalizedText = normalizeResumeLine(line.text);
  return layoutBoxes.find((box) => textsMatchLine(box.textExcerpt, normalizedText)) ?? null;
}

function resumePlateLinesFromHtml(html: string, layoutBoxes: readonly ResumeLayoutBox[]): ResumePlateLine[] {
  if (typeof DOMParser === "undefined") return [];
  const doc = new DOMParser().parseFromString(html, "text/html");
  const page = doc.querySelector<HTMLElement>(".resume-page") ?? doc.body;
  if (!page) return [];
  return Array.from(page.querySelectorAll<HTMLElement>(RESUME_HTML_LINE_SELECTOR))
    .map((element, index): ResumePlateLine | null => {
      const text = cleanRenderedText(element.textContent);
      if (!text) return null;
      const lineNumber = parsePositiveInteger(element.getAttribute("data-resume-line-number")) ?? undefined;
      const kind = kindForHtmlElement(element, index, text);
      const semanticId =
        element.getAttribute("data-resume-layout-target") ||
        (kind === "section" ? `section:${normalizeResumeLine(text)}` : null);
      const provisionalLine = { lineNumber, semanticId, text };
      const layoutBox = layoutBoxForLine(provisionalLine, layoutBoxes);
      const pageNumber =
        layoutBox?.pageNumber ??
        parsePositiveInteger(element.closest<HTMLElement>("[data-resume-page]")?.getAttribute("data-resume-page") ?? null) ??
        1;
      const id = lineNumber ? `resume:${lineNumber}` : `html:${semanticId ?? index}:${normalizeResumeLine(text)}`;
      return {
        id,
        className: element.getAttribute("class") ?? "",
        kind,
        lineLabel: lineNumber ? undefined : kind === "section" ? `Section: ${text}` : `Rendered line ${index + 1}`,
        lineNumber,
        pageNumber,
        semanticId,
        tagName: plateTagForKind(kind),
        text,
      };
    })
    .filter((line): line is ResumePlateLine => Boolean(line));
}

function resumePlateLinesFromText(
  resumeText: string | null | undefined,
  lineTargets: readonly PdfAuditLineTarget[],
): ResumePlateLine[] {
  const targets = lineTargets.length ? lineTargets : resumeLineTargetsFromText(resumeText);
  let firstContentLine = true;
  return targets.map((target, index) => {
    const kind = lineKindForText(target.text.trim(), index, firstContentLine);
    firstContentLine = false;
    return {
      id: `resume:${target.lineNumber}`,
      className: kind === "bullet" ? "resume-line" : "",
      kind,
      lineNumber: target.lineNumber,
      pageNumber: 1,
      semanticId: null,
      tagName: plateTagForKind(kind),
      text: target.text.trim(),
    };
  });
}

function resumeLineTargetsFromText(resumeText: string | null | undefined): PdfAuditLineTarget[] {
  return (resumeText ?? "")
    .split(/\r?\n/)
    .map((line, index) => ({
      lineNumber: index + 1,
      text: line.replace(/\t/g, "  ").trimEnd(),
    }))
    .filter((line) => line.text.trim().length > 0);
}

function pinForPlateLine(
  line: ResumePlateLine,
  index: number,
  pins: readonly ResumeAuditPin[],
): ResumeAuditPin | null {
  if (pins[index]?.tailoredText.some((text) => textsMatchLine(text, line.text))) {
    return pins[index] ?? null;
  }
  if (line.lineNumber) {
    const byNumber = pins.find((pin) => pin.lineNumber === line.lineNumber);
    if (byNumber) return byNumber;
  }
  return pins.find((pin) => pin.tailoredText.some((text) => textsMatchLine(text, line.text))) ?? null;
}

function inlineCommentForPin(pin: ResumeAuditPin, risk: RiskSignals): ResumePlateComment {
  const signals = pin.matchedSignals.length ? `Signals reflected: ${pin.matchedSignals.join(", ")}.` : "";
  const sourceText = primarySourceTextForPin(pin)?.[0] ?? null;
  const why = [pin.rationale, signals].filter(Boolean).join(" ").trim() || null;
  return {
    sourceLabel:
      pin.sourceGranularity === "structure" || pin.sourceGranularity === "missing"
        ? null
        : sourceLabelForJustification(pin),
    sourceText,
    status: pinStatus(pin, risk),
    tone: pinTone(pin, risk),
    why,
  };
}

function seedThreadsFromPins(
  artifactId: string,
  pins: readonly ResumeAuditPin[],
  risk: RiskSignals,
): ResumeReviewCommentThreadSeedInput[] {
  return pins
    .map((pin): ResumeReviewCommentThreadSeedInput | null => {
      const comment = inlineCommentForPin(pin, risk);
      if (!comment.why && !comment.sourceText && comment.tone !== "warn") return null;
      const body = [
        comment.why,
        comment.sourceText ? `${comment.sourceLabel ?? "Source"}: ${comment.sourceText}` : null,
      ]
        .filter(Boolean)
        .join("\n");
      return {
        baseArtifactId: artifactId,
        commentBody: body || comment.status,
        lineAnchor: {
          lineNumber: pin.lineNumber ?? null,
          pageNumber: 1,
          semanticId: pin.sourceId,
          textHash: null,
        },
        riskLabel: comment.status,
        semanticId: pin.sourceId,
        sourcePinId: pin.id,
      };
    })
    .filter((thread): thread is ResumeReviewCommentThreadSeedInput => Boolean(thread));
}

function seedThreadKey(thread: ResumeReviewCommentThreadSeedInput): string {
  return [
    thread.sourcePinId ?? "",
    thread.semanticId ?? "",
    thread.lineAnchor?.lineNumber ?? "",
    thread.riskLabel ?? "",
    thread.commentBody,
  ].join(":");
}

function selectionFromPlateLine(
  line: ResumePlateLine,
  index: number,
  layoutBoxes: readonly ResumeLayoutBox[],
): PdfAuditLineSelection {
  const layoutBox = layoutBoxForLine(line, layoutBoxes);
  const lineNumber = line.lineNumber ?? layoutBox?.lineNumber ?? null;
  return {
    lineKey: lineNumber ? `resume:${lineNumber}` : `html:${line.semanticId ?? index}:${normalizeResumeLine(line.text)}`,
    lineNumber,
    pageLineIndex: lineNumber ?? index + 1,
    pageNumber: layoutBox?.pageNumber ?? line.pageNumber,
    resumeLineText: line.text,
    text: line.text,
  };
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
    warningHandling: warningHandlingText(
      explanation.reviewFeedback.warningRepairAttempted,
      residualWarnings.length > 0,
    ),
    residualWarnings,
  };
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
    warningHandling: "not recorded",
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
    ...pin.matchedKeywords,
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
  tone = "muted",
  values,
}: {
  readonly label: string;
  readonly tone?: "muted" | "ok" | "info" | "warn";
  readonly values: readonly string[];
}): JSX.Element | null {
  if (!values.length) return null;
  return (
    <div>
      <dt>{label}</dt>
      <dd>
        {values.map((value) => (
          <span className={`tag ${tone}`} key={value}>
            {value}
          </span>
        ))}
      </dd>
    </div>
  );
}

function CompactFindingList({
  detail,
  label,
  items,
  sourceLabel,
  tone,
}: {
  readonly detail?: string;
  readonly label: string;
  readonly items: readonly string[];
  readonly sourceLabel?: string;
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
          {sourceLabel ? <span className="tag muted">{sourceLabel}</span> : null}
        </span>
        <span className="artifact-risk-finding-preview">{items[0]}</span>
      </summary>
      {detail ? <p className="meta">{detail}</p> : null}
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
            <dt>Warning handling</dt>
            <dd>{risk.warningHandling}</dd>
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
        <CompactFindingList
          detail="The material generation workflow selected this candidate after the warning-repair loop. No human approver is recorded for this warning state."
          label="Residual warnings after automated review"
          items={risk.residualWarnings}
          sourceLabel="workflow-selected"
          tone="warning"
        />
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

type ResumeHtmlState =
  | { readonly status: "idle"; readonly html: null; readonly message: null }
  | { readonly status: "loading"; readonly html: null; readonly message: null }
  | { readonly status: "ready"; readonly html: string; readonly message: null }
  | { readonly status: "legacy"; readonly html: null; readonly message: string }
  | { readonly status: "missing"; readonly html: null; readonly message: string }
  | { readonly status: "error"; readonly html: null; readonly message: string };

function selectedLineMatchesElement(
  selectedLine: PdfAuditLineSelection | null | undefined,
  line: ResumePlateLine,
  index: number,
): boolean {
  if (!selectedLine) return false;
  if (line.lineNumber !== undefined && selectedLine.lineNumber === line.lineNumber) {
    return true;
  }
  if (selectedLine.lineNumber !== null) {
    return false;
  }
  return selectedLine.lineKey === `html:${line.semanticId ?? index}:${normalizeResumeLine(line.text)}`;
}

function ResumePlateCommentBubble({ comment }: { readonly comment: ResumePlateComment }): JSX.Element {
  return (
    <span
      aria-label="JobHunter resume comment"
      className={`resume-plate-comment ${comment.tone}`}
      contentEditable={false}
      role="note"
    >
      <span className="resume-plate-comment-head">
        <b>JobHunter</b>
        <span>{comment.status}</span>
      </span>
      {comment.sourceText ? (
        <span>
          <b>{comment.sourceLabel ?? "Source"}</b>: {comment.sourceText}
        </span>
      ) : null}
      {comment.why ? <span>{comment.why}</span> : null}
    </span>
  );
}

const COMMENT_REPLY_DECISIONS: readonly ResumeCommentReplyDecision[] = [
  "accepted",
  "clarified",
  "rejected",
  "rewrite_requested",
];

function commentThreadStateLabel(thread: ResumeCommentThread): string {
  return formatToken(thread.state.replaceAll("_", " "));
}

function ResumeCommentReplyForm({
  disabled,
  thread,
  onReply,
}: {
  readonly disabled: boolean;
  readonly thread: ResumeCommentThread;
  readonly onReply?: ResumePlateEditorProps["onReplyToThread"];
}): JSX.Element | null {
  const [body, setBody] = useState("");
  const [decision, setDecision] = useState<ResumeCommentReplyDecision>("clarified");
  if (!onReply) return null;
  const formId = `resume-comment-reply-${thread.threadId}`;
  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const trimmed = body.trim();
    if (!trimmed) return;
    onReply(thread, { body: trimmed, decision });
    setBody("");
    setDecision("clarified");
  };
  return (
    <form className="resume-comment-reply-form" onSubmit={submit}>
      <label htmlFor={`${formId}-body`}>Reply</label>
      <textarea
        id={`${formId}-body`}
        maxLength={4000}
        rows={3}
        value={body}
        aria-describedby={`${formId}-decision`}
        disabled={disabled}
        onChange={(event) => setBody(event.currentTarget.value)}
      />
      <div className="resume-comment-reply-controls">
        <label htmlFor={`${formId}-decision`}>Decision</label>
        <select
          id={`${formId}-decision`}
          value={decision}
          disabled={disabled}
          onChange={(event) => setDecision(event.currentTarget.value as ResumeCommentReplyDecision)}
        >
          {COMMENT_REPLY_DECISIONS.map((value) => (
            <option key={value} value={value}>
              {formatToken(value)}
            </option>
          ))}
        </select>
        <button className="tab" type="submit" disabled={disabled || !body.trim()}>
          reply
        </button>
      </div>
    </form>
  );
}

function ResumeCommentThreadPanel({
  error,
  pending,
  threads,
  onReply,
}: {
  readonly error?: string | null;
  readonly pending?: boolean;
  readonly threads: readonly ResumeCommentThread[];
  readonly onReply?: ResumePlateEditorProps["onReplyToThread"];
}): JSX.Element | null {
  if (!threads.length && !error) return null;
  return (
    <aside className="resume-comment-thread-panel" aria-label="JobHunter line comments">
      <div className="resume-comment-thread-head">
        <b>JobHunter comments</b>
        <span>{threads.length} thread{threads.length === 1 ? "" : "s"}</span>
      </div>
      {error ? <div className="banner inline">{error}</div> : null}
      {threads.map((thread) => (
        <article className={`resume-comment-thread ${thread.state}`} key={thread.threadId}>
          <div className="resume-comment-thread-meta">
            <span className="tag info">{commentThreadStateLabel(thread)}</span>
            {thread.riskLabel ? <span className="tag warn">{thread.riskLabel}</span> : null}
            {thread.lineAnchor?.lineNumber ? <span className="mono">line {thread.lineAnchor.lineNumber}</span> : null}
            {!thread.anchorResolved ? <span className="tag warn">anchor unresolved</span> : null}
          </div>
          <p>{thread.commentBody}</p>
          <div className="resume-comment-thread-source">
            {thread.sourcePinId ? <span>Source pin: {thread.sourcePinId}</span> : null}
            {thread.semanticId ? <span>Semantic id: {thread.semanticId}</span> : null}
          </div>
          {thread.replies.length ? (
            <ul className="resume-comment-replies" aria-label="Comment replies">
              {thread.replies.map((reply) => (
                <li key={reply.replyId}>
                  <b>{formatToken(reply.decision)}</b>
                  <span>{reply.body}</span>
                </li>
              ))}
            </ul>
          ) : null}
          <ResumeCommentReplyForm disabled={Boolean(pending)} thread={thread} onReply={onReply} />
        </article>
      ))}
    </aside>
  );
}

function safeResumePlateTag(tagName: string): keyof HTMLElementTagNameMap {
  return RESUME_PLATE_INLINE_TAGS.has(tagName) || RESUME_PLATE_BLOCK_TAGS.has(tagName)
    ? (tagName as keyof HTMLElementTagNameMap)
    : "div";
}

const ResumePlateRenderContext = createContext<ResumePlateRenderContextValue | null>(null);

function useResumePlateRenderContext(): ResumePlateRenderContextValue {
  const value = useContext(ResumePlateRenderContext);
  if (!value) {
    throw new Error("ResumePlateDocument must render resume Plate elements inside ResumePlateRenderContext.");
  }
  return value;
}

function ResumeBlockElement(props: PlateElementProps<ResumePlateDomElement>): JSX.Element {
  const { layoutBoxes, lineEntries, onSelectLine, pins, risk, selectedLine } = useResumePlateRenderContext();
  const element = props.element;
  const lineEntry = element.lineNumber ? lineEntries.get(element.lineNumber) : undefined;
  const pin = lineEntry ? pinForPlateLine(lineEntry.line, lineEntry.index, pins) : null;
  const comment = pin ? inlineCommentForPin(pin, risk) : null;
  const selected = lineEntry ? selectedLineMatchesElement(selectedLine, lineEntry.line, lineEntry.index) : false;
  const showComment = Boolean(comment && (selected || comment.tone === "warn"));
  const className = [
    element.className,
    element.lineNumber ? "jobhunter-review-line" : "",
    comment ? "has-jobhunter-comment" : "",
    selected ? "jobhunter-selected-line" : "",
  ]
    .filter(Boolean)
    .join(" ");
  const handleSelect = element.lineNumber && lineEntry
    ? () => onSelectLine(selectionFromPlateLine(lineEntry.line, lineEntry.index, layoutBoxes))
    : undefined;
  return createElement(
    safeResumePlateTag(element.tagName),
    {
      ...props.attributes,
      className: className || undefined,
      "data-resume-layout-target": element.semanticId ?? undefined,
      "data-resume-line-number": element.lineNumber,
      "data-resume-page": element.pageNumber,
      onClick: handleSelect,
      onMouseDown: handleSelect,
      onPointerDown: handleSelect,
    },
    props.children,
    showComment && comment ? <ResumePlateCommentBubble comment={comment} /> : null,
  );
}

function ResumeInlineElement(props: PlateElementProps<ResumePlateDomElement>): JSX.Element {
  const element = props.element;
  const isLink = element.tagName === "a" && element.href;
  const isExternalLink = isLink && /^https?:/i.test(element.href ?? "");
  return createElement(
    safeResumePlateTag(element.tagName),
    {
      ...props.attributes,
      className: element.className,
      "data-resume-layout-target": element.semanticId ?? undefined,
      "data-resume-line-number": element.lineNumber,
      href: isLink ? element.href : undefined,
      rel: isExternalLink ? "noreferrer" : undefined,
      target: isExternalLink ? "_blank" : undefined,
    },
    props.children,
  );
}

const RESUME_PLATE_COMPONENTS = {
  resume_block: ResumeBlockElement,
  resume_inline: ResumeInlineElement,
};

function ResumePlateDocument({
  initialValue,
  layoutBoxes,
  lines,
  onValueChange,
  onSelectLine,
  pins,
  risk,
  selectedLine,
  title,
}: {
  readonly initialValue: Value;
  readonly layoutBoxes: readonly ResumeLayoutBox[];
  readonly lines: readonly ResumePlateLine[];
  readonly onValueChange: (value: Value) => void;
  readonly onSelectLine: (selection: PdfAuditLineSelection) => void;
  readonly pins: readonly ResumeAuditPin[];
  readonly risk: RiskSignals;
  readonly selectedLine: PdfAuditLineSelection | null | undefined;
  readonly title: string;
}): JSX.Element {
  const lineEntries = useMemo<ReadonlyMap<number | undefined, ResumePlateLineEntry>>(
    () => new Map(lines.map((line, index) => [line.lineNumber, { index, line }])),
    [lines],
  );
  const renderContext = useMemo<ResumePlateRenderContextValue>(
    () => ({
      layoutBoxes,
      lineEntries,
      onSelectLine,
      pins,
      risk,
      selectedLine,
    }),
    [layoutBoxes, lineEntries, onSelectLine, pins, risk, selectedLine],
  );

  const editor = usePlateEditor(
    {
      components: RESUME_PLATE_COMPONENTS,
      plugins: RESUME_PLATE_PLUGINS,
      value: initialValue,
    },
    [initialValue],
  );

  return (
    <ResumePlateRenderContext.Provider value={renderContext}>
      <Plate
        editor={editor}
        onValueChange={({ value }) => {
          if (isPlateValue(value)) {
            onValueChange(value);
          }
        }}
      >
        <PlateContent
          aria-label={`${title} editor`}
          aria-multiline="true"
          className="resume-plate-document"
          data-rendered-line-count={lines.length}
          role="textbox"
          spellCheck={false}
        />
      </Plate>
    </ResumePlateRenderContext.Provider>
  );
}

function ResumeHtmlUnavailable({
  message,
  status,
}: {
  readonly message: string;
  readonly status: Exclude<ResumeHtmlState["status"], "idle" | "loading" | "ready">;
}): JSX.Element {
  const title =
    status === "legacy"
      ? "This resume was rendered before the HTML/CSS renderer."
      : status === "missing"
        ? "The generated HTML source is missing."
        : "The generated HTML source could not be loaded.";
  return (
    <div className={`resume-html-unavailable ${status}`} role="status">
      <b>{title}</b>
      <span>{message}</span>
      <span>The printable final file is still available from the open final file link.</span>
    </div>
  );
}

export function ResumePlateEditor({
  autosaveDelayMs = 1500,
  artifactId,
  draft,
  draftError = null,
  draftLoading = false,
  finalUrl,
  htmlUrl,
  layoutBoxes,
  lineTargets,
  profileSourceFields = [],
  renderError = null,
  renderPending = false,
  renderResult = null,
  resumeText,
  saveError = null,
  savePending = false,
  replyError = null,
  replyPending = false,
  selectedLine,
  title,
  onDraftGateChange,
  onRenderDraft,
  onReplyToThread,
  onSaveDraft,
  onSelectLine,
  onSeedCommentThreads,
}: ResumePlateEditorProps): JSX.Element {
  const detail = useArtifactDetailQuery(artifactId);
  const explanation = detail.data?.tailoringExplanation ?? null;
  const risk = useMemo(() => (explanation ? riskSignals(explanation) : emptyRiskSignals()), [explanation]);
  const provenanceReady = detail.isSuccess || detail.isError;
  const [htmlState, setHtmlState] = useState<ResumeHtmlState>({
    status: htmlUrl ? "loading" : "idle",
    html: null,
    message: null,
  });

  useEffect(() => {
    if (!htmlUrl) {
      setHtmlState({ status: "idle", html: null, message: null });
      return;
    }
    const abortController = new AbortController();
    setHtmlState({ status: "loading", html: null, message: null });
    fetch(htmlUrl, { signal: abortController.signal })
      .then(async (response) => {
        if (!response.ok) {
          const errorBody = await response.json().catch(() => null);
          const message =
            errorBody && typeof errorBody === "object" && "message" in errorBody && typeof errorBody.message === "string"
              ? errorBody.message
              : `HTML preview request failed with ${response.status}.`;
          if (response.status === 415) {
            setHtmlState({ status: "legacy", html: null, message });
            return null;
          }
          if (response.status === 404) {
            setHtmlState({ status: "missing", html: null, message });
            return null;
          }
          throw new Error(message);
        }
        return response.text();
      })
      .then((html) => {
        if (!abortController.signal.aborted && html !== null) {
          setHtmlState({ status: "ready", html, message: null });
        }
      })
      .catch((error: unknown) => {
        if (abortController.signal.aborted) return;
        const message = error instanceof Error ? error.message : "HTML preview request failed.";
        setHtmlState({ status: "error", html: null, message });
      });
    return () => abortController.abort();
  }, [htmlUrl]);

  const htmlLines = useMemo(
    () => (htmlState.status === "ready" ? resumePlateLinesFromHtml(htmlState.html, layoutBoxes) : []),
    [htmlState, layoutBoxes],
  );
  const plateLines = htmlLines;
  const linePins = useMemo(
    () => (provenanceReady && plateLines.length ? pinsFromResumeLines(plateLines, explanation, profileSourceFields) : []),
    [explanation, plateLines, profileSourceFields, provenanceReady],
  );
  const seedThreads = useMemo(
    () => seedThreadsFromPins(artifactId, linePins, risk),
    [artifactId, linePins, risk],
  );
  const seedKey = useMemo(
    () => (draft && seedThreads.length ? `${draft.draftId}:${seedThreads.map(seedThreadKey).join("|")}` : null),
    [draft, seedThreads],
  );
  const seededKey = useRef<string | null>(null);
  const initialPlateValue = useMemo<Value | null>(() => {
    const savedValue = draft?.latestRevision?.plateDocument;
    if (isPlateValue(savedValue)) {
      return savedValue;
    }
    return htmlState.status === "ready" ? resumePlateValueFromHtml(htmlState.html) : null;
  }, [draft?.latestRevision?.plateDocument, htmlState]);
  const [currentPlateValue, setCurrentPlateValue] = useState<Value | null>(initialPlateValue);

  useEffect(() => {
    setCurrentPlateValue(initialPlateValue);
  }, [initialPlateValue]);

  const initialDraftText = useMemo(
    () => (initialPlateValue ? resumeTextFromPlateValue(initialPlateValue) : ""),
    [initialPlateValue],
  );
  const currentDraftText = useMemo(
    () => (currentPlateValue ? resumeTextFromPlateValue(currentPlateValue) : ""),
    [currentPlateValue],
  );
  const draftDirty = Boolean(currentPlateValue && currentDraftText !== initialDraftText);
  const hasSavedRevision = Boolean(draft?.latestRevision);
  const draftRendered = draft?.state === "rendered" || draft?.state === "promoted";
  const draftGateReason = draft
    ? draftDirty
      ? "Save and render the edited resume before approval."
      : hasSavedRevision && !draftRendered
        ? "Render the saved resume draft before approval."
        : renderResult && !renderResult.ok
          ? "Resolve draft validation errors before approval."
          : null
    : null;
  const draftStatus = draftLoading
    ? "loading draft"
    : renderPending
      ? "rendering replacement"
    : savePending
      ? "saving draft"
      : saveError || draftError || renderError || (renderResult && !renderResult.ok)
        ? "draft save issue"
      : draftDirty
        ? "unsaved changes"
        : draftRendered
          ? "replacement rendered"
        : draft?.latestRevision
          ? `saved revision ${draft.latestRevision.revisionNumber}`
          : draft
            ? "draft ready"
            : "draft unavailable";
  const saveDisabled = !draft || !currentPlateValue || !draftDirty || savePending || draftLoading || !onSaveDraft;
  const renderDisabled =
    !draft ||
    !draft.latestRevision ||
    draftDirty ||
    savePending ||
    renderPending ||
    draftLoading ||
    !onRenderDraft;

  useEffect(() => {
    onDraftGateChange?.({
      draftId: draft?.draftId ?? null,
      dirty: draftDirty,
      hasSavedRevision,
      rendered: draftRendered,
      reason: draftGateReason,
    });
  }, [draft?.draftId, draftDirty, draftGateReason, draftRendered, hasSavedRevision, onDraftGateChange]);

  useEffect(() => {
    if (!seedKey || seededKey.current === seedKey || !seedThreads.length || !onSeedCommentThreads) return;
    seededKey.current = seedKey;
    onSeedCommentThreads(seedThreads);
  }, [onSeedCommentThreads, seedKey, seedThreads]);

  const lastAutosaveText = useRef<string | null>(null);
  useEffect(() => {
    if (
      !autosaveDelayMs ||
      !draft ||
      !currentPlateValue ||
      !draftDirty ||
      savePending ||
      draftLoading ||
      !onSaveDraft ||
      lastAutosaveText.current === currentDraftText
    ) {
      return;
    }
    const handle = window.setTimeout(() => {
      if (!currentPlateValue || lastAutosaveText.current === currentDraftText) return;
      lastAutosaveText.current = currentDraftText;
      onSaveDraft({
        editedText: currentDraftText,
        plateDocument: currentPlateValue,
        source: "autosave",
      });
    }, autosaveDelayMs);
    return () => window.clearTimeout(handle);
  }, [
    autosaveDelayMs,
    currentDraftText,
    currentPlateValue,
    draft,
    draftDirty,
    draftLoading,
    onSaveDraft,
    savePending,
  ]);

  useEffect(() => {
    if (selectedLine || !plateLines.length) return;
    const firstLine = plateLines[0];
    if (!firstLine) return;
    onSelectLine(selectionFromPlateLine(firstLine, 0, layoutBoxes));
  }, [layoutBoxes, onSelectLine, plateLines, selectedLine]);

  const unavailableMessage =
    htmlState.status === "legacy" || htmlState.status === "missing" || htmlState.status === "error"
      ? htmlState.message
      : null;
  const unavailableStatus =
    htmlState.status === "legacy" || htmlState.status === "missing" || htmlState.status === "error"
      ? htmlState.status
      : null;

  return (
    <section className="resume-plate-editor" aria-label={title} data-layout-box-count={layoutBoxes.length}>
      <div className="resume-plate-toolbar">
        <b>{title}</b>
        <span className="mono">Plate HTML/CSS editor</span>
        <button
          className="tab"
          disabled={saveDisabled}
          type="button"
          onClick={() => {
            if (!currentPlateValue) return;
            onSaveDraft?.({
              editedText: currentDraftText,
              plateDocument: currentPlateValue,
              source: "manual",
            });
          }}
        >
          save draft
        </button>
        <button
          className="tab"
          disabled={renderDisabled}
          type="button"
          onClick={() => onRenderDraft?.()}
        >
          render replacement
        </button>
        <span className={`resume-plate-draft-status${draftDirty ? " dirty" : ""}`} role="status">
          {draftStatus}
        </span>
        <a href={finalUrl} rel="noreferrer" target="_blank">
          open final file
        </a>
      </div>
      {draftError ? <div className="banner inline">{draftError}</div> : null}
      {saveError ? <div className="banner inline">{saveError}</div> : null}
      {renderError ? <div className="banner inline">{renderError}</div> : null}
      {renderResult && !renderResult.ok ? (
        <div className="banner inline" role="status">
          {renderResult.validation.errors.join(" ")}
        </div>
      ) : null}
      {renderResult?.validation.warnings.length ? (
        <div className="resume-render-warnings" role="status">
          {renderResult.validation.warnings.map((warning) => (
            <span key={warning}>{warning}</span>
          ))}
        </div>
      ) : null}
      <div className="resume-plate-scroll">
        {htmlState.status === "ready" && currentPlateValue ? (
          <div
            className="resume-plate-page"
            aria-label="Editable resume page"
            data-draft-dirty={draftDirty ? "true" : "false"}
          >
            <ResumePlateDocument
              initialValue={currentPlateValue}
              layoutBoxes={layoutBoxes}
              lines={plateLines}
              onValueChange={setCurrentPlateValue}
              pins={linePins}
              risk={risk}
              selectedLine={selectedLine}
              title={title}
              onSelectLine={onSelectLine}
            />
          </div>
        ) : unavailableMessage && unavailableStatus ? (
          <ResumeHtmlUnavailable
            message={unavailableMessage}
            status={unavailableStatus}
          />
        ) : htmlState.status === "loading" ? (
          <Empty title="Loading generated resume HTML." />
        ) : (
          <Empty
            title={
              resumeText || lineTargets.length
                ? "This resume needs HTML migration before review."
                : "Resume text is still being prepared."
            }
          />
        )}
      </div>
      <ResumeCommentThreadPanel
        error={replyError}
        pending={replyPending}
        threads={draft?.commentThreads ?? []}
        onReply={onReplyToThread}
      />
    </section>
  );
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
    return <span className="resume-pin-source-evidence missing">No Profile source field was recorded for this selected resume line.</span>;
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
    return <p className="muted">No Profile source field mapping was recorded for this selected resume line.</p>;
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
                Exact Profile source-field provenance was not recorded for this selected resume line.
              </span>
            ) : null}
          </dd>
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
            <dt>Resume line</dt>
            <dd>{pin.lineLabel}</dd>
          </div>
        ) : null}
        <OptionalTagRow label="Keywords demonstrated" tone="ok" values={pin.matchedKeywords} />
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
