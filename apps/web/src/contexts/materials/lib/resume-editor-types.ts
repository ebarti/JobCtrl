// Shared document, provenance and editor presentation contracts. No session state.
import {
  type ResumeReviewDraft,
  type ResumeLayoutBox,
  type ApplyReviewProfileSourceField,
  type ResumeReviewDraftRenderResponse,
  type ResumeCommentThread,
  type ResumeCommentReplyDecision,
  type ResumeReviewCommentThreadSeedInput,
  type ResumeTemplateTheme,
  type ArtifactTailoringExplanation,
} from "../../operations/types.js";
import {
  type PdfAuditLineTarget,
  type PdfAuditLineSelection,
} from "../../../shared/ui/PdfPreviewViewer.js";
import { type Value, type TElement } from "platejs";

export interface ResumePlateEditorProps {
  readonly artifactId: string;
  readonly documentState: ResumeReviewDocumentState;
  readonly draft: ResumeReviewDraft | null;
  readonly draftError?: string | null;
  readonly finalUrl: string;
  readonly htmlUrl: string | null;
  readonly layoutBoxes: readonly ResumeLayoutBox[];
  readonly lineTargets: readonly PdfAuditLineTarget[];
  readonly pdfFilename: string;
  readonly profileSourceFields?: readonly ApplyReviewProfileSourceField[];
  readonly renderError?: string | null;
  readonly renderResult?: ResumeReviewDraftRenderResponse | null;
  readonly resumeText?: string | null;
  readonly saveError?: string | null;
  readonly replyError?: string | null;
  readonly seedError?: string | null;
  readonly replyPending?: boolean;
  readonly selectedLine?: PdfAuditLineSelection | null;
  readonly title: string;
  readonly onRenderDraft?: () => void;
  readonly onReplyToThread?: (
    thread: ResumeCommentThread,
    input: {
      readonly decision: ResumeCommentReplyDecision;
      readonly body: string;
    },
  ) => void | Promise<boolean | void>;
  readonly onSaveDraft?: () => void;
  readonly onSelectLine: (selection: PdfAuditLineSelection | null) => void;
  readonly onSeedCommentThreads?: (
    threads: readonly ResumeReviewCommentThreadSeedInput[],
  ) => void;
}

export interface ResumeReviewDocumentState {
  readonly value: Value | null;
  readonly version: string;
  readonly dirty: boolean;
  readonly status: string;
  readonly canSave: boolean;
  readonly canRender: boolean;
  readonly onChange: (value: Value) => void;
  readonly onInitialize: (value: Value) => void;
  readonly onRetryLoad: () => void;
  readonly onRetryComments: () => void;
}

export interface ResumeLineEntry {
  readonly semanticId?: string | null | undefined;
  readonly profileField?: string | null | undefined;
  readonly lineLabel?: string | undefined;
  readonly lineNumber?: number | undefined;
  readonly text: string;
  readonly kind:
    | "name"
    | "contact"
    | "section"
    | "metadata"
    | "bullet"
    | "body";
}

export interface ResumePlateLine extends ResumeLineEntry {
  readonly id: string;
  readonly className: string;
  readonly pageNumber: number;
  readonly semanticId: string | null;
  readonly tagName: string;
}

export interface ResumePlateComment {
  readonly sourceLabel: string | null;
  readonly sourceText: string | null;
  readonly status: string;
  readonly tone: "ok" | "info" | "warn";
  readonly why: string | null;
}

export interface ResumePlateDomElement extends TElement {
  readonly type: "resume_block" | "resume_inline";
  readonly className?: string | undefined;
  readonly fontFamily?: ResumeEditorFontFamily | null | undefined;
  readonly fontSize?: ResumeEditorFontSize | null | undefined;
  readonly href?: string | undefined;
  readonly lineNumber?: number | undefined;
  readonly pageNumber?: number | undefined;
  readonly semanticId?: string | null | undefined;
  readonly tagName: string;
  readonly profileField?: string | null | undefined;
  readonly profileSource?: string | null | undefined;
  readonly textAlign?: ResumeEditorTextAlign | null | undefined;
}

export interface ResumePlateLineEntry {
  readonly index: number;
  readonly line: ResumePlateLine;
}

export interface ResumeCommentThreadPlacement {
  readonly commentThreadsByLineIndex: ReadonlyMap<
    number,
    readonly ResumeCommentThread[]
  >;
  readonly unmatchedThreads: readonly ResumeCommentThread[];
}

export type ResumeEditorTextAlign = "left" | "center" | "right";

export type ResumeEditorFontFamily =
  | ResumeTemplateTheme["fontFamily"]
  | "resume"
  | "mono";

export type ResumeEditorLegacyFontSize =
  | "resume"
  | "small"
  | "large"
  | "heading";

export type ResumeEditorFontSize = number | ResumeEditorLegacyFontSize;

export interface ResumePlateSemanticTextChange {
  readonly semanticId: string;
  readonly baselineTexts: readonly string[];
  readonly plateTexts: readonly string[];
}

export interface ResumeEditorFormattingApi {
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

export interface ResumeAuditPin {
  readonly id: string;
  readonly lineLabel?: string | undefined;
  readonly title: string;
  readonly section: string;
  readonly lineNumber?: number | undefined;
  readonly provenanceState: "recorded" | "missing" | "not_applicable";
  readonly sourceGranularity:
    | "bullet"
    | "change_span"
    | "profile_field"
    | "missing"
    | "structure";
  readonly sourcePrecision:
    | "exact_line"
    | "section_span"
    | "profile_field"
    | "structure"
    | "missing";
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

export interface RiskSignals {
  readonly lineFindings: NonNullable<
    ArtifactTailoringExplanation["lineFindings"]
  >;
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

export interface ProfileSourceMatch {
  readonly fields: readonly ApplyReviewProfileSourceField[];
  readonly sourceText: readonly string[];
}
