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
  ResumeTemplateTheme,
} from "@jobctrl/contracts";
import { BasicMarksPlugin } from "@platejs/basic-nodes/react";
import {
  IconAlignCenter,
  IconAlignLeft,
  IconAlignRight,
  IconBold,
  IconCheck,
  IconItalic,
  IconLink,
  IconUnlink,
  IconUnderline,
  IconX,
} from "@tabler/icons-react";
import type { Descendant, TElement, Value } from "platejs";
import {
  Plate,
  PlateContent,
  createPlatePlugin,
  usePlateEditor,
  type PlateEditor,
  type PlateElementProps,
} from "platejs/react";
import {
  createContext,
  createElement,
  useCallback,
  useContext,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type ChangeEvent,
  type CSSProperties,
  type Dispatch,
  type FormEvent,
  type JSX,
  type KeyboardEvent as ReactKeyboardEvent,
  type MouseEvent,
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
  readonly onPrepareApproval?: () => Promise<boolean>;
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
  readonly onSelectLine: (selection: PdfAuditLineSelection | null) => void;
  readonly onSeedCommentThreads?: (threads: readonly ResumeReviewCommentThreadSeedInput[]) => void;
}

export interface ResumeDraftGateState {
  readonly draftId: string | null;
  readonly dirty: boolean;
  readonly hasSavedRevision: boolean;
  readonly notice: string | null;
  readonly prepareApproval?: (() => Promise<boolean>) | null;
  readonly preparing: boolean;
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
  readonly fontFamily?: ResumeEditorFontFamily | null | undefined;
  readonly fontSize?: ResumeEditorFontSize | null | undefined;
  readonly href?: string | undefined;
  readonly lineNumber?: number | undefined;
  readonly pageNumber?: number | undefined;
  readonly semanticId?: string | null | undefined;
  readonly tagName: string;
  readonly textAlign?: ResumeEditorTextAlign | null | undefined;
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

type ResumeEditorTextAlign = "left" | "center" | "right";
type ResumeEditorFontFamily = ResumeTemplateTheme["fontFamily"] | "resume" | "mono";
type ResumeEditorLegacyFontSize = "resume" | "small" | "large" | "heading";
type ResumeEditorFontSize = number | ResumeEditorLegacyFontSize;

interface ResumeEditorFormattingApi {
  readonly align: (value: ResumeEditorTextAlign) => void;
  readonly clearLink: () => void;
  readonly focus: () => void;
  readonly setLink: (href: string) => void;
  readonly setFontFamily: (value: ResumeEditorFontFamily) => void;
  readonly setFontSize: (value: ResumeEditorFontSize) => void;
  readonly toggleBold: () => void;
  readonly toggleItalic: () => void;
  readonly toggleUnderline: () => void;
}

const RESUME_EDITOR_FONT_FAMILIES: readonly {
  readonly label: string;
  readonly value: ResumeEditorFontFamily;
}[] = [
  { label: "Resume", value: "resume" },
  { label: "Sans", value: "sans" },
  { label: "Serif", value: "serif" },
  { label: "System", value: "system" },
  { label: "Aptos", value: "aptos" },
  { label: "Avenir", value: "avenir" },
  { label: "Helvetica", value: "helvetica" },
  { label: "Inter", value: "inter" },
  { label: "Source Sans", value: "source_sans" },
  { label: "Calibri", value: "calibri" },
  { label: "Georgia", value: "georgia" },
  { label: "Garamond", value: "garamond" },
  { label: "Charter", value: "charter" },
  { label: "Source Serif", value: "source_serif" },
  { label: "Times New Roman", value: "times" },
  { label: "Cambria", value: "cambria" },
  { label: "Mono", value: "mono" },
];

const RESUME_EDITOR_DEFAULT_SIZE_SCALE = 1;
const RESUME_EDITOR_MIN_SIZE_SCALE = 0.75;
const RESUME_EDITOR_MAX_SIZE_SCALE = 1.5;
const RESUME_EDITOR_SIZE_SCALE_STEP = 0.05;
const RESUME_EDITOR_CHROME_SELECTOR = '[data-resume-editor-chrome="true"]';
const RESUME_LINE_SELECTOR = "[data-resume-line-number]";

const RESUME_EDITOR_FONT_FAMILY_STYLES: Record<ResumeEditorFontFamily, string | null> = {
  avenir: '"Avenir Next", "Avenir", "Nunito Sans", sans-serif',
  aptos: '"Aptos", "Aptos Display", "Arial", sans-serif',
  calibri: '"Calibri", "Aptos", "Arial", sans-serif',
  cambria: '"Cambria", "Georgia", "Times New Roman", serif',
  charter: '"Charter", "Bitstream Charter", "Georgia", serif',
  garamond: '"EB Garamond", "Garamond", "Georgia", serif',
  georgia: '"Georgia", "Times New Roman", serif',
  helvetica: '"Helvetica Neue", "Helvetica", "Arial", sans-serif',
  inter: '"Inter", "Aptos", "Arial", sans-serif',
  mono: "ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace",
  resume: null,
  sans: '"Aptos", "Inter", "Arial", sans-serif',
  serif: '"Charter", "Georgia", serif',
  source_sans: '"Source Sans 3", "Source Sans Pro", "Aptos", "Arial", sans-serif',
  source_serif: '"Source Serif 4", "Source Serif Pro", "Georgia", serif',
  system: 'system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif',
  times: '"Times New Roman", "Times", serif',
};

const RESUME_EDITOR_LEGACY_FONT_SIZE_STYLES: Record<ResumeEditorLegacyFontSize, string | null> = {
  heading: "14pt",
  large: "12pt",
  resume: null,
  small: "9pt",
};

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

const RESUME_PLATE_DISCARDED_TAGS = new Set([
  "iframe",
  "noscript",
  "script",
  "style",
  "template",
]);

const RESUME_PLATE_BLOCK_CLASS_TOKENS = new Set([
  "resume-entry-company",
  "resume-entry-date",
  "resume-entry-location",
  "resume-entry-main",
  "resume-entry-row",
  "resume-entry-title",
]);

const RESUME_PLATE_GRID_CONTAINER_CLASS_TOKENS = new Set(["resume-entry-heading", "resume-entry-row"]);

const RESUME_PLATE_BLOCK_PLUGIN = createPlatePlugin({
  key: "resume_block",
  node: { isElement: true },
});

const RESUME_PLATE_INLINE_PLUGIN = createPlatePlugin({
  key: "resume_inline",
  node: { isElement: true, isInline: true },
});

const RESUME_PLATE_PLUGINS = [RESUME_PLATE_BLOCK_PLUGIN, RESUME_PLATE_INLINE_PLUGIN, BasicMarksPlugin];

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

function hasAnyResumeClass(className: string | null | undefined, tokens: ReadonlySet<string>): boolean {
  const classes = (className ?? "").split(/\s+/);
  return classes.some((token) => tokens.has(token));
}

function shouldRenderResumeElementAsBlock(tagName: string, className: string | null | undefined): boolean {
  return RESUME_PLATE_BLOCK_TAGS.has(tagName) || hasAnyResumeClass(className, RESUME_PLATE_BLOCK_CLASS_TOKENS);
}

function normalizeResumePlateChildren(children: readonly Descendant[], parentClassName: string | null | undefined): Descendant[] {
  const normalized = children.map(normalizeResumePlateDescendant).filter((node): node is Descendant => Boolean(node));
  if (!hasAnyResumeClass(parentClassName, RESUME_PLATE_GRID_CONTAINER_CLASS_TOKENS)) {
    return normalized.length ? normalized : [{ text: "" }];
  }
  const withoutEmptyGridLeaves = normalized.filter(
    (node) => !("text" in node) || (typeof node.text === "string" && node.text.trim().length > 0),
  );
  return withoutEmptyGridLeaves.length ? withoutEmptyGridLeaves : [{ text: "" }];
}

function normalizeResumePlateDescendant(node: Descendant): Descendant | null {
  if ("text" in node) {
    return node;
  }
  const className = typeof node.className === "string" ? node.className : undefined;
  const tagName = typeof node.tagName === "string" ? node.tagName : "div";
  const normalizedType = shouldRenderResumeElementAsBlock(tagName, className) ? "resume_block" : "resume_inline";
  const normalizedTagName = hasAnyResumeClass(className, RESUME_PLATE_BLOCK_CLASS_TOKENS) ? "div" : tagName;
  return {
    ...node,
    children: normalizeResumePlateChildren(node.children, className),
    tagName: normalizedTagName,
    type: normalizedType,
  };
}

function normalizeResumePlateValue(value: Value): Value {
  const normalized = value
    .map(normalizeResumePlateDescendant)
    .filter((node): node is Descendant & { children: Descendant[] } => Boolean(node && "children" in node));
  return normalized.length ? (normalized as Value) : [{ type: "resume_block", tagName: "main", className: "resume-page", children: [{ text: "" }] }];
}

function resumePlateChildrenFromDom(element: Element): Descendant[] {
  const children = Array.from(element.childNodes)
    .map((node) => resumePlateNodeFromDom(node))
    .filter((node): node is Descendant => Boolean(node));
  return normalizeResumePlateChildren(children, element.getAttribute("class"));
}

function resumePlateNodeFromDom(node: Node): Descendant | null {
  if (node.nodeType === Node.TEXT_NODE) {
    return resumePlateTextNode(node.textContent ?? "");
  }
  if (!(node instanceof HTMLElement)) return null;
  const tagName = node.tagName.toLowerCase();
  if (RESUME_PLATE_DISCARDED_TAGS.has(tagName)) return null;
  const className = resumePlateClassNameFromDom(node);
  const isBlock = shouldRenderResumeElementAsBlock(tagName, className);
  const isInline = !isBlock && RESUME_PLATE_INLINE_TAGS.has(tagName);
  if (!isBlock && !isInline) {
    return resumePlateTextNode(cleanRenderedText(node.textContent));
  }
  return {
    children: resumePlateChildrenFromDom(node),
    className,
    href: tagName === "a" ? safeResumeHref(node.getAttribute("href")) : undefined,
    lineNumber: parsePositiveInteger(node.getAttribute("data-resume-line-number")) ?? undefined,
    pageNumber: parsePositiveInteger(node.getAttribute("data-resume-page")) ?? undefined,
    semanticId: node.getAttribute("data-resume-layout-target") || null,
    tagName: hasAnyResumeClass(className, RESUME_PLATE_BLOCK_CLASS_TOKENS) ? "div" : tagName,
    type: isInline ? "resume_inline" : "resume_block",
  };
}

function resumePlateClassNameFromDom(node: HTMLElement): string | undefined {
  const className = node.getAttribute("class")?.trim();
  if (!className) return undefined;
  const tokens = className.split(/\s+/).map((token) => token === "resume-document" ? "resume-page" : token);
  return [...new Set(tokens)].join(" ");
}

function safeResumeHref(value: string | null): string | undefined {
  const href = value?.trim();
  if (!href) return undefined;
  return /^(?:https?:|mailto:|tel:)/i.test(href) ? href : undefined;
}

function normalizeResumeHrefInput(value: string): string | null {
  const trimmed = value.trim();
  if (!trimmed) return null;
  const explicit = safeResumeHref(trimmed);
  if (explicit) return explicit;
  if (/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(trimmed)) {
    return `mailto:${trimmed}`;
  }
  if (/^(?:www\.|[a-z0-9-]+(?:\.[a-z0-9-]+)+)(?:[/?#].*)?$/i.test(trimmed)) {
    return `https://${trimmed}`;
  }
  return null;
}

function resumePlateValueFromHtml(html: string): Value {
  if (typeof DOMParser === "undefined") {
    return [{ type: "resume_block", tagName: "main", className: "resume-page", children: [{ text: "" }] }];
  }
  const doc = new DOMParser().parseFromString(html, "text/html");
  const page = doc.querySelector<HTMLElement>(".resume-page");
  const nodes = Array.from((page ? [page] : Array.from(doc.body.children)) as Iterable<Element>)
    .map((node) => resumePlateNodeFromDom(node))
    .filter((node): node is Descendant & { children: Descendant[] } => Boolean(node && "children" in node));
  return nodes.length
    ? normalizeResumePlateValue(nodes as Value)
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
  const lines = value
    .flatMap(resumeLineTextsFromPlateNode)
    .map((line) => line.replace(/\s+/g, " ").trim())
    .filter(Boolean);
  if (lines.length) {
    return lines.join("\n");
  }
  return value
    .map(resumeTextFromPlateNode)
    .map((line) => line.replace(/\s+/g, " ").trim())
    .filter(Boolean)
    .join("\n");
}

function resumeLineTextsFromPlateNode(node: Descendant): string[] {
  if ("text" in node) return [];
  if (typeof node.lineNumber === "number") {
    const text = resumeTextFromPlateNode(node).replace(/\s+/g, " ").trim();
    return text ? [text] : [];
  }
  return node.children.flatMap(resumeLineTextsFromPlateNode);
}

function resumePlateValueSignature(value: Value | null): string {
  return value ? JSON.stringify(value) : "";
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

function resumeClassForLineKind(kind: ResumeLineEntry["kind"]): string {
  if (kind === "name") return "resume-name";
  if (kind === "contact") return "resume-contact";
  if (kind === "section") return "resume-section-title";
  if (kind === "metadata") return "resume-meta";
  return "resume-line";
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
        baseArtifactId: boundedSeedIdentifier(artifactId, "artifact"),
        commentBody: boundedSeedText(body || comment.status, 4000),
        lineAnchor: {
          lineNumber: pin.lineNumber ?? null,
          pageNumber: 1,
          semanticId: boundedSeedIdentifier(pin.sourceId, "semantic"),
          textHash: null,
        },
        riskLabel: comment.status,
        semanticId: boundedSeedIdentifier(pin.sourceId, "semantic"),
        sourcePinId: boundedSeedIdentifier(pin.id, "pin"),
      };
    })
    .filter((thread): thread is ResumeReviewCommentThreadSeedInput => Boolean(thread));
}

function boundedSeedIdentifier(value: string | null | undefined, salt: string): string | null {
  const trimmed = value?.trim();
  if (!trimmed) return null;
  if (trimmed.length <= 240) return trimmed;
  const suffix = `${salt}:${stableTextHash(trimmed)}`;
  return `${trimmed.slice(0, 240 - suffix.length - 1).trimEnd()}:${suffix}`;
}

function boundedSeedText(value: string, maxLength: number): string {
  const trimmed = value.trim();
  if (trimmed.length <= maxLength) return trimmed;
  const suffix = "\n[truncated]";
  return `${trimmed.slice(0, maxLength - suffix.length).trimEnd()}${suffix}`;
}

function stableTextHash(value: string): string {
  let hash = 2166136261;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(36);
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
      aria-label="JobCtrl resume comment"
      className={`resume-plate-comment ${comment.tone}`}
      contentEditable={false}
      data-resume-editor-chrome="true"
      role="note"
      suppressContentEditableWarning
    >
      <span className="resume-plate-comment-head">
        <b>JobCtrl</b>
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
    <aside className="resume-comment-thread-panel" aria-label="JobCtrl line comments">
      <div className="resume-comment-thread-head">
        <b>JobCtrl comments</b>
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
  if (tagName === "main") return "div";
  return RESUME_PLATE_INLINE_TAGS.has(tagName) || RESUME_PLATE_BLOCK_TAGS.has(tagName)
    ? (tagName as keyof HTMLElementTagNameMap)
    : "div";
}

function resumeElementStyle(element: ResumePlateDomElement): CSSProperties | undefined {
  const style: CSSProperties = {};
  const textAlign = element.textAlign ?? null;
  const fontFamily = element.fontFamily ? RESUME_EDITOR_FONT_FAMILY_STYLES[element.fontFamily] : null;
  const fontSize = resumeEditorFontSizeStyle(element.fontSize);
  if (textAlign) {
    style.textAlign = textAlign;
  }
  if (fontFamily) {
    style.fontFamily = fontFamily;
  }
  if (fontSize) {
    style.fontSize = fontSize;
  }
  return Object.keys(style).length ? style : undefined;
}

function resumeEditorFontSizeStyle(value: ResumeEditorFontSize | null | undefined): string | null {
  if (typeof value === "number") {
    return Number.isFinite(value) && Math.abs(value - RESUME_EDITOR_DEFAULT_SIZE_SCALE) > 0.001
      ? `${value}em`
      : null;
  }
  return value ? RESUME_EDITOR_LEGACY_FONT_SIZE_STYLES[value] : null;
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
    lineEntry && !element.className ? resumeClassForLineKind(lineEntry.line.kind) : "",
    element.lineNumber ? "jobctrl-review-line" : "",
    comment ? "has-jobctrl-comment" : "",
    selected ? "jobctrl-selected-line" : "",
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
      style: resumeElementStyle(element),
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

type ResumeFormattingEditor = PlateEditor & {
  readonly tf: PlateEditor["tf"] & {
    readonly bold?: { readonly toggle: () => void };
    readonly italic?: { readonly toggle: () => void };
    readonly unwrapNodes?: (options?: Record<string, unknown>) => void;
    readonly underline?: { readonly toggle: () => void };
    readonly wrapNodes?: (element: ResumePlateDomElement, options?: Record<string, unknown>) => void;
  };
};

function formattingEditor(editor: PlateEditor): ResumeFormattingEditor {
  return editor as ResumeFormattingEditor;
}

function toggleEditorMark(editor: PlateEditor, mark: "bold" | "italic" | "underline"): void {
  const typedEditor = formattingEditor(editor);
  typedEditor.tf.focus();
  typedEditor.tf[mark]?.toggle();
}

function isResumeLinkElement(node: unknown): boolean {
  return isRecord(node) && node.type === "resume_inline" && node.tagName === "a";
}

function setEditorLink(editor: PlateEditor, href: string): void {
  const typedEditor = formattingEditor(editor);
  typedEditor.tf.focus();
  typedEditor.tf.unwrapNodes?.({
    match: isResumeLinkElement,
    split: true,
  });
  typedEditor.tf.wrapNodes?.(
    {
      type: "resume_inline",
      tagName: "a",
      href,
      children: [],
    },
    {
      split: true,
    },
  );
}

function clearEditorLink(editor: PlateEditor): void {
  const typedEditor = formattingEditor(editor);
  typedEditor.tf.focus();
  typedEditor.tf.unwrapNodes?.({
    match: isResumeLinkElement,
    split: true,
  });
}

function resumeBlockLineNumber(node: unknown): number | null {
  if (!isRecord(node) || node.type !== "resume_block") return null;
  return typeof node.lineNumber === "number" ? node.lineNumber : null;
}

function resumeBlockText(node: Record<string, unknown>): string {
  return isPlateDescendant(node) ? normalizeResumeLine(resumeTextFromPlateNode(node)) : "";
}

function resumeBlockMatchesLineSelection(node: unknown, selection: PdfAuditLineSelection | null | undefined): boolean {
  if (!isRecord(node) || node.type !== "resume_block") return false;
  const lineNumber = resumeBlockLineNumber(node);
  if (!selection) {
    return lineNumber !== null;
  }
  if (lineNumber !== null && selection.lineNumber === lineNumber) {
    return true;
  }
  if (selection.lineNumber !== null) {
    return false;
  }
  const selectionText = normalizeResumeLine(selection.resumeLineText || selection.text);
  return Boolean(selectionText) && resumeBlockText(node) === selectionText;
}

function unwrapResumeLinks(children: readonly Descendant[]): Descendant[] {
  return children.flatMap((child): Descendant[] => {
    if ("text" in child) return [child];
    const childElement = child as ResumePlateDomElement;
    if (childElement.type === "resume_inline" && childElement.tagName === "a") {
      return unwrapResumeLinks(childElement.children);
    }
    return [
      {
        ...child,
        children: unwrapResumeLinks(childElement.children),
      },
    ];
  });
}

function wrapResumeChildrenInLink(children: readonly Descendant[], href: string): Descendant[] {
  const unwrapped = unwrapResumeLinks(children);
  if (!unwrapped.length) return unwrapped;
  return [
    {
      type: "resume_inline",
      tagName: "a",
      href,
      children: unwrapped,
    },
  ];
}

function linkResumePlateDescendant(
  node: Descendant,
  selectedLine: PdfAuditLineSelection | null | undefined,
  href: string | null,
  changed: { value: boolean },
): Descendant {
  if ("text" in node) return node;
  const element = node as ResumePlateDomElement;
  if (resumeBlockMatchesLineSelection(element, selectedLine)) {
    changed.value = true;
    return {
      ...node,
      children: href ? wrapResumeChildrenInLink(element.children, href) : unwrapResumeLinks(element.children),
    };
  }
  return {
    ...node,
    children: element.children.map((child) => linkResumePlateDescendant(child, selectedLine, href, changed)),
  };
}

function linkSelectedResumeLine(
  value: Value | null,
  selectedLine: PdfAuditLineSelection | null | undefined,
  href: string | null,
): Value | null {
  if (!value || !selectedLine) return null;
  const changed = { value: false };
  const nextValue = value.map((node) => linkResumePlateDescendant(node, selectedLine, href, changed));
  return changed.value ? normalizeResumePlateValue(nextValue as Value) : null;
}

function shouldKeepResumeLineSelection(target: EventTarget | null): boolean {
  return target instanceof Element && Boolean(target.closest(`${RESUME_LINE_SELECTOR}, ${RESUME_EDITOR_CHROME_SELECTOR}`));
}

function useClearResumeLineSelection(
  selectedLine: PdfAuditLineSelection | null | undefined,
  onClearLineSelection: () => void,
): void {
  useEffect(() => {
    if (!selectedLine) return;
    const handlePointerDown = (event: PointerEvent) => {
      if (shouldKeepResumeLineSelection(event.target)) return;
      onClearLineSelection();
    };
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      onClearLineSelection();
    };
    document.addEventListener("pointerdown", handlePointerDown, true);
    window.addEventListener("keydown", handleKeyDown);
    return () => {
      document.removeEventListener("pointerdown", handlePointerDown, true);
      window.removeEventListener("keydown", handleKeyDown);
    };
  }, [onClearLineSelection, selectedLine]);
}

function applyEditorBlockStyle(
  editor: PlateEditor,
  patch: Pick<ResumePlateDomElement, "fontFamily" | "fontSize" | "textAlign">,
  selectedLine: PdfAuditLineSelection | null | undefined,
): void {
  editor.tf.focus();
  editor.tf.setNodes(patch, {
    at: [],
    match: (node: unknown) => resumeBlockMatchesLineSelection(node, selectedLine),
  });
}

function keepEditorSelection(event: MouseEvent<HTMLButtonElement>): void {
  event.preventDefault();
}

function elementContainsNode(element: Element, node: Node | null | undefined): boolean {
  if (!node) return false;
  if (node instanceof Element) return element.contains(node);
  return node.parentElement ? element.contains(node.parentElement) : false;
}

function ResumeEditorToolbarControls({
  disabled,
  onAlign,
  onClearLink,
  onFontFamily,
  onFontSize,
  onSetLink,
  onToggleBold,
  onToggleItalic,
  onToggleUnderline,
}: {
  readonly disabled: boolean;
  readonly onAlign: (value: ResumeEditorTextAlign) => void;
  readonly onClearLink: () => void;
  readonly onFontFamily: (value: ResumeEditorFontFamily) => void;
  readonly onFontSize: (value: ResumeEditorFontSize) => void;
  readonly onSetLink: (href: string) => void;
  readonly onToggleBold: () => void;
  readonly onToggleItalic: () => void;
  readonly onToggleUnderline: () => void;
}): JSX.Element {
  const toolbarRef = useRef<HTMLDivElement | null>(null);
  const linkInputRef = useRef<HTMLInputElement | null>(null);
  const linkTriggerRef = useRef<HTMLButtonElement | null>(null);
  const fontFamilyId = useId();
  const fontSizeId = useId();
  const linkInputId = useId();
  const linkErrorId = useId();
  const linkPopoverId = useId();
  const [fontSizeScale, setFontSizeScale] = useState(String(RESUME_EDITOR_DEFAULT_SIZE_SCALE));
  const [linkUrl, setLinkUrl] = useState("");
  const [linkError, setLinkError] = useState<string | null>(null);
  const [linkPopoverOpen, setLinkPopoverOpen] = useState(false);
  const openLinkPopover = useCallback(() => {
    if (disabled) return;
    setLinkError(null);
    setLinkPopoverOpen(true);
  }, [disabled]);
  const closeLinkPopover = useCallback(() => {
    setLinkError(null);
    setLinkPopoverOpen(false);
    window.requestAnimationFrame(() => linkTriggerRef.current?.focus());
  }, []);
  useEffect(() => {
    if (!linkPopoverOpen) return;
    const frame = window.requestAnimationFrame(() => {
      linkInputRef.current?.focus();
      linkInputRef.current?.select();
    });
    return () => window.cancelAnimationFrame(frame);
  }, [linkPopoverOpen]);
  useEffect(() => {
    if (!linkPopoverOpen) return;
    const handlePointerDown = (event: PointerEvent) => {
      const toolbar = toolbarRef.current;
      if (!toolbar || !(event.target instanceof Node) || toolbar.contains(event.target)) return;
      closeLinkPopover();
    };
    document.addEventListener("pointerdown", handlePointerDown, true);
    return () => document.removeEventListener("pointerdown", handlePointerDown, true);
  }, [closeLinkPopover, linkPopoverOpen]);
  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (disabled || event.defaultPrevented || event.key.toLowerCase() !== "k" || (!event.metaKey && !event.ctrlKey)) {
        return;
      }
      const toolbar = toolbarRef.current;
      const editor = toolbar?.closest(".resume-plate-editor");
      if (!toolbar || !editor) return;
      const activeElement = document.activeElement;
      const selection = document.getSelection();
      const activeWithinEditor = activeElement instanceof Element && editor.contains(activeElement);
      const selectionWithinEditor =
        Boolean(selection?.rangeCount) &&
        (elementContainsNode(editor, selection?.anchorNode) || elementContainsNode(editor, selection?.focusNode));
      const selectedLineWithinEditor = Boolean(editor.querySelector(".jobctrl-selected-line"));
      if (!activeWithinEditor && !selectionWithinEditor && !selectedLineWithinEditor) return;
      event.preventDefault();
      openLinkPopover();
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [disabled, openLinkPopover]);
  const applyFontSizeScale = useCallback(
    (rawValue: string) => {
      const value = Number(rawValue);
      if (
        !Number.isFinite(value) ||
        value < RESUME_EDITOR_MIN_SIZE_SCALE ||
        value > RESUME_EDITOR_MAX_SIZE_SCALE
      ) {
        return;
      }
      onFontSize(Number(value.toFixed(2)));
    },
    [onFontSize],
  );
  const normalizeFontSizeScale = useCallback(() => {
    const value = Number(fontSizeScale);
    if (
      !Number.isFinite(value) ||
      value < RESUME_EDITOR_MIN_SIZE_SCALE ||
      value > RESUME_EDITOR_MAX_SIZE_SCALE
    ) {
      setFontSizeScale(String(RESUME_EDITOR_DEFAULT_SIZE_SCALE));
      onFontSize(RESUME_EDITOR_DEFAULT_SIZE_SCALE);
      return;
    }
    setFontSizeScale(String(Number(value.toFixed(2))));
  }, [fontSizeScale, onFontSize]);
  const applyLink = useCallback(
    (event: FormEvent<HTMLFormElement>) => {
      event.preventDefault();
      const href = normalizeResumeHrefInput(linkUrl);
      if (!href) {
        setLinkError("Use http, https, mailto, tel, or a plain domain/email.");
        return;
      }
      setLinkError(null);
      setLinkUrl(href);
      onSetLink(href);
      closeLinkPopover();
    },
    [closeLinkPopover, linkUrl, onSetLink],
  );
  const handleLinkPopoverKeyDown = useCallback(
    (event: ReactKeyboardEvent<HTMLFormElement>) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      event.stopPropagation();
      closeLinkPopover();
    },
    [closeLinkPopover],
  );
  return (
    <div
      ref={toolbarRef}
      className="resume-format-toolbar"
      aria-label="Resume formatting controls"
      data-resume-editor-chrome="true"
    >
      <div className="resume-format-button-group" aria-label="Text style">
        <button
          aria-label="Bold"
          className="resume-format-button"
          disabled={disabled}
          title="Bold"
          type="button"
          onClick={onToggleBold}
          onMouseDown={keepEditorSelection}
        >
          <IconBold aria-hidden="true" size={16} stroke={2.2} />
        </button>
        <button
          aria-label="Italic"
          className="resume-format-button"
          disabled={disabled}
          title="Italic"
          type="button"
          onClick={onToggleItalic}
          onMouseDown={keepEditorSelection}
        >
          <IconItalic aria-hidden="true" size={16} stroke={2.2} />
        </button>
        <button
          aria-label="Underline"
          className="resume-format-button"
          disabled={disabled}
          title="Underline"
          type="button"
          onClick={onToggleUnderline}
          onMouseDown={keepEditorSelection}
        >
          <IconUnderline aria-hidden="true" size={16} stroke={2.2} />
        </button>
      </div>
      <div className="resume-link-popover-anchor">
        <div className="resume-format-button-group" aria-label="Hyperlink actions">
          <button
            ref={linkTriggerRef}
            aria-controls={linkPopoverOpen ? linkPopoverId : undefined}
            aria-expanded={linkPopoverOpen}
            aria-keyshortcuts="Meta+K Control+K"
            aria-label="Insert link"
            className={`resume-format-button${linkPopoverOpen ? " active" : ""}`}
            disabled={disabled}
            title="Insert link (⌘K)"
            type="button"
            onClick={openLinkPopover}
            onMouseDown={(event) => {
              keepEditorSelection(event);
              openLinkPopover();
            }}
          >
            <IconLink aria-hidden="true" size={16} stroke={2.2} />
          </button>
          <button
            aria-label="Remove link"
            className="resume-format-button"
            disabled={disabled}
            title="Remove link from selected text or selected resume line"
            type="button"
            onClick={() => {
              closeLinkPopover();
              onClearLink();
            }}
            onMouseDown={keepEditorSelection}
          >
            <IconUnlink aria-hidden="true" size={16} stroke={2.2} />
          </button>
        </div>
        {linkPopoverOpen ? (
          <form
            id={linkPopoverId}
            className="resume-link-popover"
            aria-label="Insert link"
            role="dialog"
            onKeyDown={handleLinkPopoverKeyDown}
            onSubmit={applyLink}
          >
            <label className="resume-format-select" htmlFor={linkInputId}>
              <span>URL</span>
              <input
                ref={linkInputRef}
                aria-describedby={linkError ? linkErrorId : undefined}
                aria-invalid={linkError ? "true" : undefined}
                aria-label="Link URL"
                disabled={disabled}
                id={linkInputId}
                inputMode="url"
                placeholder="example.com"
                type="text"
                value={linkUrl}
                onChange={(event: ChangeEvent<HTMLInputElement>) => {
                  setLinkUrl(event.currentTarget.value);
                  setLinkError(null);
                }}
              />
            </label>
            <div className="resume-format-button-group" aria-label="Link popover actions">
              <button
                aria-label="Apply link"
                className="resume-format-button"
                disabled={disabled || !linkUrl.trim()}
                title="Apply link"
                type="submit"
                onMouseDown={keepEditorSelection}
              >
                <IconCheck aria-hidden="true" size={16} stroke={2.2} />
              </button>
              <button
                aria-label="Cancel link"
                className="resume-format-button"
                disabled={disabled}
                title="Cancel"
                type="button"
                onClick={closeLinkPopover}
                onMouseDown={keepEditorSelection}
              >
                <IconX aria-hidden="true" size={16} stroke={2.2} />
              </button>
            </div>
            {linkError ? (
              <span className="resume-link-error" id={linkErrorId} role="status">
                {linkError}
              </span>
            ) : null}
          </form>
        ) : null}
      </div>
      <label className="resume-format-select" htmlFor={fontFamilyId}>
        <span>Font</span>
        <select
          aria-label="Font"
          defaultValue="resume"
          disabled={disabled}
          id={fontFamilyId}
          onChange={(event: ChangeEvent<HTMLSelectElement>) =>
            onFontFamily(event.currentTarget.value as ResumeEditorFontFamily)
          }
        >
          {RESUME_EDITOR_FONT_FAMILIES.map((option) => (
            <option key={option.value} value={option.value}>
              {option.label}
            </option>
          ))}
        </select>
      </label>
      <label className="resume-format-select" htmlFor={fontSizeId}>
        <span>Size</span>
        <input
          aria-label="Size"
          disabled={disabled}
          id={fontSizeId}
          max={RESUME_EDITOR_MAX_SIZE_SCALE}
          min={RESUME_EDITOR_MIN_SIZE_SCALE}
          step={RESUME_EDITOR_SIZE_SCALE_STEP}
          title="1 uses the resume default size."
          type="number"
          value={fontSizeScale}
          onBlur={normalizeFontSizeScale}
          onChange={(event: ChangeEvent<HTMLInputElement>) => {
            setFontSizeScale(event.currentTarget.value);
            applyFontSizeScale(event.currentTarget.value);
          }}
        />
      </label>
      <div className="resume-format-button-group" aria-label="Alignment">
        <button
          aria-label="Align left"
          className="resume-format-button"
          disabled={disabled}
          title="Align left"
          type="button"
          onClick={() => onAlign("left")}
          onMouseDown={keepEditorSelection}
        >
          <IconAlignLeft aria-hidden="true" size={16} stroke={2.2} />
        </button>
        <button
          aria-label="Align center"
          className="resume-format-button"
          disabled={disabled}
          title="Align center"
          type="button"
          onClick={() => onAlign("center")}
          onMouseDown={keepEditorSelection}
        >
          <IconAlignCenter aria-hidden="true" size={16} stroke={2.2} />
        </button>
        <button
          aria-label="Align right"
          className="resume-format-button"
          disabled={disabled}
          title="Align right"
          type="button"
          onClick={() => onAlign("right")}
          onMouseDown={keepEditorSelection}
        >
          <IconAlignRight aria-hidden="true" size={16} stroke={2.2} />
        </button>
      </div>
    </div>
  );
}

function ResumePlateDocument({
  documentKey,
  initialValue,
  layoutBoxes,
  lines,
  onClearLineSelection,
  onFormattingApiChange,
  onValueChange,
  onSelectLine,
  pins,
  risk,
  selectedLine,
  title,
}: {
  readonly documentKey: string;
  readonly initialValue: Value;
  readonly layoutBoxes: readonly ResumeLayoutBox[];
  readonly lines: readonly ResumePlateLine[];
  readonly onClearLineSelection: () => void;
  readonly onFormattingApiChange?: (api: ResumeEditorFormattingApi | null) => void;
  readonly onValueChange: (value: Value) => void;
  readonly onSelectLine: (selection: PdfAuditLineSelection | null) => void;
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
  useClearResumeLineSelection(selectedLine, onClearLineSelection);

  const editor = usePlateEditor(
    {
      components: RESUME_PLATE_COMPONENTS,
      plugins: RESUME_PLATE_PLUGINS,
      value: initialValue,
    },
    [documentKey],
  );

  useEffect(() => {
    onFormattingApiChange?.({
      align: (value) => applyEditorBlockStyle(editor, { textAlign: value }, selectedLine),
      clearLink: () => clearEditorLink(editor),
      focus: () => editor.tf.focus(),
      setLink: (href) => setEditorLink(editor, href),
      setFontFamily: (value) =>
        applyEditorBlockStyle(editor, { fontFamily: value === "resume" ? null : value }, selectedLine),
      setFontSize: (value) =>
        applyEditorBlockStyle(
          editor,
          { fontSize: value === "resume" || value === RESUME_EDITOR_DEFAULT_SIZE_SCALE ? null : value },
          selectedLine,
        ),
      toggleBold: () => toggleEditorMark(editor, "bold"),
      toggleItalic: () => toggleEditorMark(editor, "italic"),
      toggleUnderline: () => toggleEditorMark(editor, "underline"),
    });
    return () => onFormattingApiChange?.(null);
  }, [editor, onFormattingApiChange, selectedLine]);

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

function useResumeHtmlState(
  htmlUrl: string | null,
  htmlTransform?: (html: string) => string,
  transformKey?: string,
): ResumeHtmlState {
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
          setHtmlState({ status: "ready", html: htmlTransform ? htmlTransform(html) : html, message: null });
        }
      })
      .catch((error: unknown) => {
        if (abortController.signal.aborted) return;
        const message = error instanceof Error ? error.message : "HTML preview request failed.";
        setHtmlState({ status: "error", html: null, message });
      });
    return () => abortController.abort();
  }, [htmlTransform, htmlUrl, transformKey]);

  return htmlState;
}

export function ResumeStandalonePlateEditor({
  className,
  htmlTransform,
  htmlUrl,
  previewStyle,
  title,
  transformKey,
}: {
  readonly className?: string;
  readonly htmlTransform?: ((html: string) => string) | undefined;
  readonly htmlUrl: string | null;
  readonly previewStyle?: CSSProperties | undefined;
  readonly title: string;
  readonly transformKey?: string;
}): JSX.Element {
  const htmlState = useResumeHtmlState(htmlUrl, htmlTransform, transformKey);
  const layoutBoxes = useMemo<readonly ResumeLayoutBox[]>(() => [], []);
  const risk = useMemo(() => emptyRiskSignals(), []);
  const htmlLines = useMemo(
    () => (htmlState.status === "ready" ? resumePlateLinesFromHtml(htmlState.html, layoutBoxes) : []),
    [htmlState, layoutBoxes],
  );
  const initialPlateValue = useMemo<Value | null>(
    () => (htmlState.status === "ready" ? resumePlateValueFromHtml(htmlState.html) : null),
    [htmlState],
  );
  const [currentPlateValue, setCurrentPlateValue] = useState<Value | null>(initialPlateValue);
  const [selectedLine, setSelectedLine] = useState<PdfAuditLineSelection | null>(null);
  const [resetVersion, setResetVersion] = useState(0);
  const [editorVersion, setEditorVersion] = useState(0);
  const formattingApiRef = useRef<ResumeEditorFormattingApi | null>(null);
  const [formattingApiReady, setFormattingApiReady] = useState(false);

  useEffect(() => {
    setCurrentPlateValue(initialPlateValue);
    setSelectedLine(null);
    setResetVersion((currentVersion) => currentVersion + 1);
  }, [initialPlateValue]);

  const initialSignature = useMemo(
    () => resumePlateValueSignature(initialPlateValue),
    [initialPlateValue],
  );
  const currentSignature = useMemo(
    () => resumePlateValueSignature(currentPlateValue),
    [currentPlateValue],
  );
  const dirty = Boolean(currentPlateValue && currentSignature !== initialSignature);
  const canFormat = formattingApiReady && Boolean(currentPlateValue);
  const documentKey = `standalone:${htmlUrl ?? "no-html"}:${transformKey ?? "base"}:${resetVersion}:${editorVersion}`;
  const handleFormattingApiChange = useCallback((api: ResumeEditorFormattingApi | null) => {
    formattingApiRef.current = api;
    setFormattingApiReady(Boolean(api));
  }, []);
  const handleSelectLine = useCallback((selection: PdfAuditLineSelection | null) => {
    setSelectedLine(selection);
  }, []);
  const handleClearLineSelection = useCallback(() => {
    setSelectedLine(null);
  }, []);
  const handleToggleBold = useCallback(() => formattingApiRef.current?.toggleBold(), []);
  const handleToggleItalic = useCallback(() => formattingApiRef.current?.toggleItalic(), []);
  const handleToggleUnderline = useCallback(() => formattingApiRef.current?.toggleUnderline(), []);
  const handleSetLink = useCallback(
    (href: string) => {
      const linkedValue = linkSelectedResumeLine(currentPlateValue, selectedLine, href);
      if (linkedValue) {
        setCurrentPlateValue(linkedValue);
        setEditorVersion((currentVersion) => currentVersion + 1);
        return;
      }
      formattingApiRef.current?.setLink(href);
    },
    [currentPlateValue, selectedLine],
  );
  const handleClearLink = useCallback(() => {
    const linkedValue = linkSelectedResumeLine(currentPlateValue, selectedLine, null);
    if (linkedValue) {
      setCurrentPlateValue(linkedValue);
      setEditorVersion((currentVersion) => currentVersion + 1);
      return;
    }
    formattingApiRef.current?.clearLink();
  }, [currentPlateValue, selectedLine]);
  const handleAlign = useCallback((value: ResumeEditorTextAlign) => formattingApiRef.current?.align(value), []);
  const handleFontFamily = useCallback(
    (value: ResumeEditorFontFamily) => formattingApiRef.current?.setFontFamily(value),
    [],
  );
  const handleFontSize = useCallback((value: ResumeEditorFontSize) => formattingApiRef.current?.setFontSize(value), []);
  const handleReset = useCallback(() => {
    setCurrentPlateValue(initialPlateValue);
    setResetVersion((currentVersion) => currentVersion + 1);
  }, [initialPlateValue]);

  const unavailableMessage =
    htmlState.status === "legacy" || htmlState.status === "missing" || htmlState.status === "error"
      ? htmlState.message
      : null;
  const unavailableStatus =
    htmlState.status === "legacy" || htmlState.status === "missing" || htmlState.status === "error"
      ? htmlState.status
      : null;

  return (
    <section className={`resume-plate-editor ${className ?? ""}`.trim()} aria-label={title} style={previewStyle}>
      <div className="resume-plate-toolbar" data-resume-editor-chrome="true">
        <b>{title}</b>
        <span className="toolbar-status">Plate HTML/CSS editor</span>
        <ResumeEditorToolbarControls
          disabled={!canFormat}
          onAlign={handleAlign}
          onClearLink={handleClearLink}
          onFontFamily={handleFontFamily}
          onFontSize={handleFontSize}
          onSetLink={handleSetLink}
          onToggleBold={handleToggleBold}
          onToggleItalic={handleToggleItalic}
          onToggleUnderline={handleToggleUnderline}
        />
        <button
          className="tab"
          disabled={!dirty || !initialPlateValue}
          type="button"
          onClick={handleReset}
        >
          reset
        </button>
        <span className={`resume-plate-draft-status${dirty ? " dirty" : ""}`} role="status">
          {htmlState.status === "loading" ? "loading baseline" : dirty ? "local edits" : "baseline current"}
        </span>
      </div>
      <div className="resume-plate-scroll" tabIndex={0}>
        {htmlState.status === "ready" && initialPlateValue && currentPlateValue ? (
          <div
            className="resume-plate-page"
            aria-label="Editable baseline resume page"
            data-draft-dirty={dirty ? "true" : "false"}
          >
            <ResumePlateDocument
              documentKey={documentKey}
              initialValue={currentPlateValue}
              layoutBoxes={layoutBoxes}
              lines={htmlLines}
              onClearLineSelection={handleClearLineSelection}
              onFormattingApiChange={handleFormattingApiChange}
              onSelectLine={handleSelectLine}
              onValueChange={setCurrentPlateValue}
              pins={[]}
              risk={risk}
              selectedLine={selectedLine}
              title={title}
            />
          </div>
        ) : unavailableMessage && unavailableStatus ? (
          <ResumeHtmlUnavailable message={unavailableMessage} status={unavailableStatus} />
        ) : htmlState.status === "loading" ? (
          <Empty title="Loading baseline resume HTML." />
        ) : (
          <Empty title="Baseline resume HTML is not available." />
        )}
      </div>
    </section>
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
  onPrepareApproval,
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
  const htmlState = useResumeHtmlState(htmlUrl);

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
  const formattingApiRef = useRef<ResumeEditorFormattingApi | null>(null);
  const userClearedSelection = useRef(false);
  const initializedSelectionDocumentKey = useRef<string | null>(null);
  const [formattingApiReady, setFormattingApiReady] = useState(false);
  const [editorVersion, setEditorVersion] = useState(0);
  const initialPlateValue = useMemo<Value | null>(() => {
    const savedValue = draft?.latestRevision?.plateDocument;
    if (isPlateValue(savedValue)) {
      return normalizeResumePlateValue(savedValue);
    }
    return htmlState.status === "ready" ? resumePlateValueFromHtml(htmlState.html) : null;
  }, [draft?.latestRevision?.plateDocument, htmlState]);
  const [currentPlateValue, setCurrentPlateValue] = useState<Value | null>(initialPlateValue);

  useEffect(() => {
    setCurrentPlateValue(initialPlateValue);
  }, [initialPlateValue]);

  const currentDraftText = useMemo(
    () => (currentPlateValue ? resumeTextFromPlateValue(currentPlateValue) : ""),
    [currentPlateValue],
  );
  const initialDraftSignature = useMemo(
    () => resumePlateValueSignature(initialPlateValue),
    [initialPlateValue],
  );
  const currentDraftSignature = useMemo(
    () => resumePlateValueSignature(currentPlateValue),
    [currentPlateValue],
  );
  const documentKey = `${artifactId}:${draft?.draftId ?? "no-draft"}:${htmlUrl ?? "no-html"}:${editorVersion}`;
  const canFormat = formattingApiReady && Boolean(currentPlateValue);
  const draftDirty = Boolean(currentPlateValue && currentDraftSignature !== initialDraftSignature);
  const hasSavedRevision = Boolean(draft?.latestRevision);
  const draftRendered = draft?.state === "rendered" || draft?.state === "promoted";
  const savedDraftNeedsRender = hasSavedRevision && !draftRendered;
  const draftGateReason = draft
    ? draftDirty
      ? "Save and render the edited resume before approval."
      : renderPending && savedDraftNeedsRender
        ? "Rendering saved resume draft before approval."
        : renderResult && !renderResult.ok
          ? "Resolve draft validation errors before approval."
          : renderError && savedDraftNeedsRender
            ? "Resume render failed; retry render before approval."
            : savedDraftNeedsRender && !onPrepareApproval
                ? "Render the saved resume draft before approval."
                : null
    : null;
  const draftGateNotice =
    draft && savedDraftNeedsRender && !draftDirty && !renderPending && !renderError && !(renderResult && !renderResult.ok)
      ? "Saved draft will render automatically before approval."
      : null;
  const draftStatus = draftLoading
    ? "loading draft"
    : renderPending
      ? "rendering saved draft"
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
      notice: draftGateNotice,
      prepareApproval: draftGateNotice ? (onPrepareApproval ?? null) : null,
      preparing: Boolean(renderPending && savedDraftNeedsRender),
      rendered: draftRendered,
      reason: draftGateReason,
    });
  }, [
    draft?.draftId,
    draftDirty,
    draftGateNotice,
    draftGateReason,
    draftRendered,
    hasSavedRevision,
    onDraftGateChange,
    onPrepareApproval,
    renderPending,
    savedDraftNeedsRender,
  ]);

  useEffect(() => {
    if (!seedKey || seededKey.current === seedKey || !seedThreads.length || !onSeedCommentThreads) return;
    seededKey.current = seedKey;
    onSeedCommentThreads(seedThreads);
  }, [onSeedCommentThreads, seedKey, seedThreads]);

  const handleFormattingApiChange = useCallback((api: ResumeEditorFormattingApi | null) => {
    formattingApiRef.current = api;
    setFormattingApiReady(Boolean(api));
  }, []);
  const handleSelectLine = useCallback(
    (selection: PdfAuditLineSelection | null) => {
      if (selection) {
        userClearedSelection.current = false;
      }
      onSelectLine(selection);
    },
    [onSelectLine],
  );
  const handleClearLineSelection = useCallback(() => {
    userClearedSelection.current = true;
    onSelectLine(null);
  }, [onSelectLine]);
  const handleToggleBold = useCallback(() => formattingApiRef.current?.toggleBold(), []);
  const handleToggleItalic = useCallback(() => formattingApiRef.current?.toggleItalic(), []);
  const handleToggleUnderline = useCallback(() => formattingApiRef.current?.toggleUnderline(), []);
  const handleSetLink = useCallback(
    (href: string) => {
      const linkedValue = linkSelectedResumeLine(currentPlateValue, selectedLine, href);
      if (linkedValue) {
        setCurrentPlateValue(linkedValue);
        setEditorVersion((currentVersion) => currentVersion + 1);
        return;
      }
      formattingApiRef.current?.setLink(href);
    },
    [currentPlateValue, selectedLine],
  );
  const handleClearLink = useCallback(() => {
    const linkedValue = linkSelectedResumeLine(currentPlateValue, selectedLine, null);
    if (linkedValue) {
      setCurrentPlateValue(linkedValue);
      setEditorVersion((currentVersion) => currentVersion + 1);
      return;
    }
    formattingApiRef.current?.clearLink();
  }, [currentPlateValue, selectedLine]);
  const handleAlign = useCallback((value: ResumeEditorTextAlign) => formattingApiRef.current?.align(value), []);
  const handleFontFamily = useCallback(
    (value: ResumeEditorFontFamily) => formattingApiRef.current?.setFontFamily(value),
    [],
  );
  const handleFontSize = useCallback((value: ResumeEditorFontSize) => formattingApiRef.current?.setFontSize(value), []);

  const lastAutosaveSignature = useRef<string | null>(null);
  useEffect(() => {
    if (
      !autosaveDelayMs ||
      !draft ||
      !currentPlateValue ||
      !draftDirty ||
      savePending ||
      draftLoading ||
      !onSaveDraft ||
      lastAutosaveSignature.current === currentDraftSignature
    ) {
      return;
    }
    const handle = window.setTimeout(() => {
      if (!currentPlateValue || lastAutosaveSignature.current === currentDraftSignature) return;
      lastAutosaveSignature.current = currentDraftSignature;
      onSaveDraft({
        editedText: currentDraftText,
        plateDocument: currentPlateValue,
        source: "autosave",
      });
    }, autosaveDelayMs);
    return () => window.clearTimeout(handle);
  }, [
    autosaveDelayMs,
    currentDraftSignature,
    currentDraftText,
    currentPlateValue,
    draft,
    draftDirty,
    draftLoading,
    onSaveDraft,
    savePending,
  ]);

  useEffect(() => {
    userClearedSelection.current = false;
    initializedSelectionDocumentKey.current = null;
  }, [documentKey]);

  useEffect(() => {
    if (
      selectedLine ||
      !plateLines.length ||
      userClearedSelection.current ||
      initializedSelectionDocumentKey.current === documentKey
    ) {
      return;
    }
    const firstLine = plateLines[0];
    if (!firstLine) return;
    initializedSelectionDocumentKey.current = documentKey;
    onSelectLine(selectionFromPlateLine(firstLine, 0, layoutBoxes));
  }, [documentKey, layoutBoxes, onSelectLine, plateLines, selectedLine]);

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
      <div className="resume-plate-toolbar" data-resume-editor-chrome="true">
        <b>{title}</b>
        <span className="toolbar-status">Plate HTML/CSS editor</span>
        <ResumeEditorToolbarControls
          disabled={!canFormat}
          onAlign={handleAlign}
          onClearLink={handleClearLink}
          onFontFamily={handleFontFamily}
          onFontSize={handleFontSize}
          onSetLink={handleSetLink}
          onToggleBold={handleToggleBold}
          onToggleItalic={handleToggleItalic}
          onToggleUnderline={handleToggleUnderline}
        />
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
      <div className="resume-plate-scroll" tabIndex={0}>
        {htmlState.status === "ready" && initialPlateValue && currentPlateValue ? (
          <div
            className="resume-plate-page"
            aria-label="Editable resume page"
            data-draft-dirty={draftDirty ? "true" : "false"}
          >
            <ResumePlateDocument
              documentKey={documentKey}
              initialValue={currentPlateValue}
              layoutBoxes={layoutBoxes}
              lines={plateLines}
              onClearLineSelection={handleClearLineSelection}
              onFormattingApiChange={handleFormattingApiChange}
              onValueChange={setCurrentPlateValue}
              pins={linePins}
              risk={risk}
              selectedLine={selectedLine}
              title={title}
              onSelectLine={handleSelectLine}
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
