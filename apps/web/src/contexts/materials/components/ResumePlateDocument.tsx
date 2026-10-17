// Plate rendering and comment presentation, independent of session persistence.
import {
  type ResumeCommentThread,
  type ResumeLayoutBox,
  type ResumeCommentReplyDecision,
} from "../../operations/types.js";
import {
  type ResumePlateLineEntry,
  type ResumePlateEditorProps,
  type ResumeAuditPin,
  type RiskSignals,
  type ResumePlateComment,
  type ResumePlateDomElement,
  type ResumeEditorFontSize,
  type ResumePlateLine,
  type ResumeEditorFormattingApi,
} from "../lib/resume-editor-types.js";
import { type PdfAuditLineSelection } from "../../../shared/ui/PdfPreviewViewer.js";
import {
  createPlatePlugin,
  type PlateElementProps,
  usePlateEditor,
  Plate,
  PlateContent,
} from "platejs/react";
import { BasicMarksPlugin } from "@platejs/basic-nodes/react";
import {
  type JSX,
  useState,
  type CSSProperties,
  createContext,
  useContext,
  type MouseEvent,
  createElement,
  useEffect,
  useMemo,
} from "react";
import { formatToken } from "../lib/audit-format.js";
import { Textarea } from "../../../shared/ui/textarea.js";
import {
  Select,
  SelectTrigger,
  SelectValue,
  SelectContent,
  SelectGroup,
  SelectItem,
} from "../../../shared/ui/select.js";
import { Button } from "../../../shared/ui/button.js";
import {
  RESUME_PLATE_INLINE_TAGS,
  RESUME_PLATE_BLOCK_TAGS,
  selectedLineMatchesElement,
  resumeClassForLineKind,
  selectionFromPlateLine,
  isPlateValue,
} from "../lib/resume-document.js";
import {
  RESUME_EDITOR_FONT_FAMILY_STYLES,
  RESUME_EDITOR_DEFAULT_SIZE_SCALE,
  RESUME_EDITOR_LEGACY_FONT_SIZE_STYLES,
  RESUME_LINE_SELECTOR,
  RESUME_EDITOR_CHROME_SELECTOR,
  applyEditorBlockStyle,
  clearEditorLink,
  setEditorLink,
  toggleEditorMark,
} from "../lib/resume-formatting.js";
import {
  pinForPlateLine,
  inlineCommentForPin,
} from "../lib/resume-comments.js";
import { type Value } from "platejs";

interface ResumePlateRenderContextValue {
  readonly commentThreadsByLineIndex: ReadonlyMap<
    number,
    readonly ResumeCommentThread[]
  >;
  readonly layoutBoxes: readonly ResumeLayoutBox[];
  readonly lineEntriesBySemanticId: ReadonlyMap<string, ResumePlateLineEntry>;
  readonly lineEntries: ReadonlyMap<number | undefined, ResumePlateLineEntry>;
  readonly onSelectLine: (selection: PdfAuditLineSelection) => void;
  readonly onReplyToThread?: ResumePlateEditorProps["onReplyToThread"];
  readonly pins: readonly ResumeAuditPin[];
  readonly replyPending: boolean;
  readonly risk: RiskSignals;
  readonly selectedLine: PdfAuditLineSelection | null | undefined;
}

const RESUME_PLATE_BLOCK_PLUGIN = createPlatePlugin({
  key: "resume_block",
  node: { isElement: true },
});

const RESUME_PLATE_INLINE_PLUGIN = createPlatePlugin({
  key: "resume_inline",
  node: { isElement: true, isInline: true },
});

const RESUME_PLATE_PLUGINS = [
  RESUME_PLATE_BLOCK_PLUGIN,
  RESUME_PLATE_INLINE_PLUGIN,
  BasicMarksPlugin,
];

function ResumePlateCommentBubble({
  comment,
}: {
  readonly comment: ResumePlateComment;
}): JSX.Element {
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
        <span data-typography="status">{comment.status}</span>
      </span>
      {comment.sourceText ? (
        <span data-typography="body">
          <b>{comment.sourceLabel ?? "Source"}</b>: {comment.sourceText}
        </span>
      ) : null}
      {comment.why ? <span data-typography="body">{comment.why}</span> : null}
    </span>
  );
}

const COMMENT_REPLY_DECISIONS: readonly ResumeCommentReplyDecision[] = [
  "accepted",
  "clarified",
  "rejected",
  "rewrite_requested",
];

const COMMENT_REPLY_DECISION_ITEMS = COMMENT_REPLY_DECISIONS.map((value) => ({
  label: formatToken(value),
  value,
}));

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
  const [decision, setDecision] =
    useState<ResumeCommentReplyDecision>("clarified");
  if (!onReply) return null;
  const formId = `resume-comment-reply-${thread.threadId}`;
  const submit = async () => {
    const trimmed = body.trim();
    if (!trimmed) return;
    try {
      const saved = await onReply(thread, { body: trimmed, decision });
      if (saved === false) return;
      setBody((current) => current === body ? "" : current);
      setDecision((current) => current === decision ? "clarified" : current);
    } catch {
      // The owning session exposes the failure; retain the submitted reply.
    }
  };
  return (
    <span
      aria-label={`Reply to ${thread.riskLabel ?? "resume comment"}`}
      className="resume-comment-reply-form"
      role="group"
      onClick={(event) => event.stopPropagation()}
    >
      <label htmlFor={`${formId}-body`}>Reply</label>
      <Textarea
        id={`${formId}-body`}
        maxLength={4000}
        rows={3}
        value={body}
        aria-describedby={`${formId}-decision`}
        disabled={disabled}
        onChange={(event) => setBody(event.currentTarget.value)}
      />
      <span className="resume-comment-reply-controls">
        <label htmlFor={`${formId}-decision`}>Decision</label>
        <Select
          items={COMMENT_REPLY_DECISION_ITEMS}
          value={decision}
          disabled={disabled}
          onValueChange={(nextValue) => {
            if (nextValue !== null) setDecision(nextValue);
          }}
        >
          <SelectTrigger
            id={`${formId}-decision`}
            aria-label="Decision"
            className="min-w-40"
          >
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectGroup>
              {COMMENT_REPLY_DECISION_ITEMS.map((item) => (
                <SelectItem key={item.value} value={item.value}>
                  {item.label}
                </SelectItem>
              ))}
            </SelectGroup>
          </SelectContent>
        </Select>
        <Button
          className="tab"
          size="sm"
          type="button"
          disabled={disabled || !body.trim()}
          onClick={() => { void submit(); }}
        >
          Reply
        </Button>
      </span>
    </span>
  );
}

function ResumeCommentThreadDetails({
  pending,
  showAnchorStatus,
  showSourceIdentifiers,
  thread,
  onReply,
}: {
  readonly pending: boolean;
  readonly showAnchorStatus: boolean;
  readonly showSourceIdentifiers: boolean;
  readonly thread: ResumeCommentThread;
  readonly onReply?: ResumePlateEditorProps["onReplyToThread"];
}): JSX.Element {
  return (
    <>
      <span className="resume-comment-thread-meta">
        <span className="resume-comment-thread-state" data-typography="status">
          {commentThreadStateLabel(thread)}
        </span>
        {thread.riskLabel ? (
          <span className="resume-comment-thread-risk" data-typography="status">
            {thread.riskLabel}
          </span>
        ) : null}
        {showAnchorStatus && thread.lineAnchor?.lineNumber ? (
          <span className="mono" data-typography="code">
            line {thread.lineAnchor.lineNumber}
          </span>
        ) : null}
        {showAnchorStatus && !thread.anchorResolved ? (
          <span className="resume-comment-thread-risk" data-typography="status">
            Anchor unresolved
          </span>
        ) : null}
      </span>
      <span className="resume-comment-thread-body" data-typography="body">
        {thread.commentBody}
      </span>
      {showSourceIdentifiers && (thread.sourcePinId || thread.semanticId) ? (
        <span
          className="resume-comment-thread-source"
          data-typography="metadata"
        >
          {thread.sourcePinId ? (
            <span>Source pin: {thread.sourcePinId}</span>
          ) : null}
          {thread.semanticId ? (
            <span>Semantic id: {thread.semanticId}</span>
          ) : null}
        </span>
      ) : null}
      {thread.replies.length ? (
        <span
          className="resume-comment-replies"
          aria-label="Comment replies"
          data-typography="body"
          role="list"
        >
          {thread.replies.map((reply) => (
            <span key={reply.replyId} role="listitem">
              <b>{formatToken(reply.decision)}</b>
              <span>{reply.body}</span>
            </span>
          ))}
        </span>
      ) : null}
      <ResumeCommentReplyForm
        disabled={pending}
        thread={thread}
        onReply={onReply}
      />
    </>
  );
}

function ResumePlateCommentThreadBubble({
  expanded,
  pending,
  threads,
  onReply,
}: {
  readonly expanded: boolean;
  readonly pending: boolean;
  readonly threads: readonly ResumeCommentThread[];
  readonly onReply?: ResumePlateEditorProps["onReplyToThread"];
}): JSX.Element {
  return (
    <span
      aria-label="JobCtrl resume comment"
      className={`resume-plate-comment resume-plate-thread-bubble ${expanded ? "expanded" : "collapsed"}`}
      contentEditable={false}
      data-resume-editor-chrome="true"
      role="note"
      suppressContentEditableWarning
    >
      <span className="resume-plate-comment-head">
        <b>JobCtrl</b>
        <span data-typography="metadata">
          {threads.length} comment{threads.length === 1 ? "" : "s"}
        </span>
      </span>
      <span className="resume-plate-thread-list">
        {threads.map((thread) => (
          <span
            className={`resume-comment-thread ${thread.state}`}
            key={thread.threadId}
          >
            <ResumeCommentThreadDetails
              pending={pending}
              showAnchorStatus={false}
              showSourceIdentifiers={false}
              thread={thread}
              onReply={onReply}
            />
          </span>
        ))}
      </span>
    </span>
  );
}

export function ResumeCommentThreadPanel({
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
    <aside
      className="resume-comment-thread-panel"
      aria-label="Unanchored JobCtrl comments"
    >
      <div className="resume-comment-thread-head">
        <b>Comments without a rendered line</b>
        <span data-typography="metadata">
          {threads.length} thread{threads.length === 1 ? "" : "s"}
        </span>
      </div>
      {error ? <div className="banner inline">{error}</div> : null}
      {threads.map((thread) => (
        <article
          className={`resume-comment-thread ${thread.state}`}
          key={thread.threadId}
        >
          <ResumeCommentThreadDetails
            pending={Boolean(pending)}
            showAnchorStatus
            showSourceIdentifiers
            thread={thread}
            onReply={onReply}
          />
        </article>
      ))}
    </aside>
  );
}

function safeResumePlateTag(tagName: string): keyof HTMLElementTagNameMap {
  if (tagName === "main") return "div";
  return RESUME_PLATE_INLINE_TAGS.has(tagName) ||
    RESUME_PLATE_BLOCK_TAGS.has(tagName)
    ? (tagName as keyof HTMLElementTagNameMap)
    : "div";
}

function resumeElementStyle(
  element: ResumePlateDomElement,
): CSSProperties | undefined {
  const style: CSSProperties = {};
  const textAlign = element.textAlign ?? null;
  const fontFamily = element.fontFamily
    ? RESUME_EDITOR_FONT_FAMILY_STYLES[element.fontFamily]
    : null;
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

function resumeEditorFontSizeStyle(
  value: ResumeEditorFontSize | null | undefined,
): string | null {
  if (typeof value === "number") {
    return Number.isFinite(value) &&
      Math.abs(value - RESUME_EDITOR_DEFAULT_SIZE_SCALE) > 0.001
      ? `${value}em`
      : null;
  }
  return value ? RESUME_EDITOR_LEGACY_FONT_SIZE_STYLES[value] : null;
}

const ResumePlateRenderContext =
  createContext<ResumePlateRenderContextValue | null>(null);

function useResumePlateRenderContext(): ResumePlateRenderContextValue {
  const value = useContext(ResumePlateRenderContext);
  if (!value) {
    throw new Error(
      "ResumePlateDocument must render resume Plate elements inside ResumePlateRenderContext.",
    );
  }
  return value;
}

function ResumeBlockElement(
  props: PlateElementProps<ResumePlateDomElement>,
): JSX.Element {
  const {
    commentThreadsByLineIndex,
    layoutBoxes,
    lineEntries,
    lineEntriesBySemanticId,
    onReplyToThread,
    onSelectLine,
    pins,
    replyPending,
    risk,
    selectedLine,
  } = useResumePlateRenderContext();
  const element = props.element;
  const lineEntry =
    (element.lineNumber !== undefined
      ? lineEntries.get(element.lineNumber)
      : undefined) ??
    (element.semanticId
      ? lineEntriesBySemanticId.get(element.semanticId)
      : undefined);
  const pin = lineEntry
    ? pinForPlateLine(lineEntry.line, lineEntry.index, pins)
    : null;
  const comment = pin ? inlineCommentForPin(pin, risk) : null;
  const commentThreads = lineEntry
    ? (commentThreadsByLineIndex.get(lineEntry.index) ?? [])
    : [];
  const selected = lineEntry
    ? selectedLineMatchesElement(selectedLine, lineEntry.line, lineEntry.index)
    : false;
  const showComment = Boolean(
    !commentThreads.length && comment && (selected || comment.tone === "warn"),
  );
  const expandThreads = selected || comment?.tone === "warn";
  const className = [
    element.className,
    lineEntry && !element.className
      ? resumeClassForLineKind(lineEntry.line.kind)
      : "",
    element.lineNumber ? "jobctrl-review-line" : "",
    comment || commentThreads.length ? "has-jobctrl-comment" : "",
    selected ? "jobctrl-selected-line" : "",
  ]
    .filter(Boolean)
    .join(" ");
  const handleSelect =
    element.lineNumber && lineEntry
      ? (event: MouseEvent<HTMLElement>) => {
          const selection = event.currentTarget.ownerDocument.getSelection();
          // Publish the native caret before selecting the audit line rerenders
          // Slate, whose layout effect would otherwise restore a stale range.
          if (
            event.currentTarget.isContentEditable &&
            !(
              event.target instanceof Element &&
              event.target.closest('[contenteditable="false"]')
            ) &&
            selection?.anchorNode &&
            selection.focusNode &&
            event.currentTarget.contains(selection.anchorNode) &&
            event.currentTarget.contains(selection.focusNode)
          ) {
            const range = props.editor.api.toSlateRange(selection, {
              exactMatch: true,
              suppressThrow: true,
            });
            if (range) props.editor.tf.select(range);
          }
          onSelectLine(
            selectionFromPlateLine(
              lineEntry.line,
              lineEntry.index,
              layoutBoxes,
            ),
          );
        }
      : undefined;
  return createElement(
    safeResumePlateTag(element.tagName),
    {
      ...props.attributes,
      className: className || undefined,
      "data-resume-layout-target": element.semanticId ?? undefined,
      "data-resume-profile-field": element.profileField ?? undefined,
      "data-resume-line-number": element.lineNumber,
      "data-resume-page": element.pageNumber,
      onClick: handleSelect,
      style: resumeElementStyle(element),
    },
    props.children,
    commentThreads.length ? (
      <ResumePlateCommentThreadBubble
        expanded={expandThreads}
        pending={replyPending}
        threads={commentThreads}
        onReply={onReplyToThread}
      />
    ) : null,
    showComment && comment ? (
      <ResumePlateCommentBubble comment={comment} />
    ) : null,
  );
}

function ResumeInlineElement(
  props: PlateElementProps<ResumePlateDomElement>,
): JSX.Element {
  const element = props.element;
  const isLink = element.tagName === "a" && element.href;
  const isExternalLink = isLink && /^https?:/i.test(element.href ?? "");
  return createElement(
    safeResumePlateTag(element.tagName),
    {
      ...props.attributes,
      className: element.className,
      "data-resume-layout-target": element.semanticId ?? undefined,
      "data-resume-profile-field": element.profileField ?? undefined,
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

function shouldKeepResumeLineSelection(target: EventTarget | null): boolean {
  return (
    target instanceof Element &&
    Boolean(
      target.closest(
        `${RESUME_LINE_SELECTOR}, ${RESUME_EDITOR_CHROME_SELECTOR}`,
      ),
    )
  );
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

export function ResumePlateDocument({
  commentThreadsByLineIndex,
  documentKey,
  initialValue,
  layoutBoxes,
  lines,
  onReplyToThread,
  onClearLineSelection,
  onFormattingApiChange,
  onValueChange,
  onSelectLine,
  pins,
  replyPending,
  risk,
  selectedLine,
  title,
}: {
  readonly commentThreadsByLineIndex: ReadonlyMap<
    number,
    readonly ResumeCommentThread[]
  >;
  readonly documentKey: string;
  readonly initialValue: Value;
  readonly layoutBoxes: readonly ResumeLayoutBox[];
  readonly lines: readonly ResumePlateLine[];
  readonly onReplyToThread?: ResumePlateEditorProps["onReplyToThread"];
  readonly onClearLineSelection: () => void;
  readonly onFormattingApiChange?: (
    api: ResumeEditorFormattingApi | null,
  ) => void;
  readonly onValueChange: (value: Value) => void;
  readonly onSelectLine: (selection: PdfAuditLineSelection | null) => void;
  readonly pins: readonly ResumeAuditPin[];
  readonly replyPending: boolean;
  readonly risk: RiskSignals;
  readonly selectedLine: PdfAuditLineSelection | null | undefined;
  readonly title: string;
}): JSX.Element {
  const lineEntries = useMemo<
    ReadonlyMap<number | undefined, ResumePlateLineEntry>
  >(
    () =>
      new Map(lines.map((line, index) => [line.lineNumber, { index, line }])),
    [lines],
  );
  const lineEntriesBySemanticId = useMemo<
    ReadonlyMap<string, ResumePlateLineEntry>
  >(
    () =>
      new Map(
        lines.flatMap((line, index) =>
          line.semanticId ? [[line.semanticId, { index, line }] as const] : [],
        ),
      ),
    [lines],
  );
  const renderContext = useMemo<ResumePlateRenderContextValue>(
    () => ({
      commentThreadsByLineIndex,
      layoutBoxes,
      lineEntries,
      lineEntriesBySemanticId,
      onReplyToThread,
      onSelectLine,
      pins,
      replyPending,
      risk,
      selectedLine,
    }),
    [
      commentThreadsByLineIndex,
      layoutBoxes,
      lineEntries,
      lineEntriesBySemanticId,
      onReplyToThread,
      onSelectLine,
      pins,
      replyPending,
      risk,
      selectedLine,
    ],
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
      align: (value) =>
        applyEditorBlockStyle(editor, { textAlign: value }, selectedLine),
      clearLink: () => clearEditorLink(editor),
      focus: () => editor.tf.focus(),
      setLink: (href) => setEditorLink(editor, href),
      setFontFamily: (value) =>
        applyEditorBlockStyle(
          editor,
          { fontFamily: value === "resume" ? null : value },
          selectedLine,
        ),
      setFontSize: (value) =>
        applyEditorBlockStyle(
          editor,
          {
            fontSize:
              value === "resume" || value === RESUME_EDITOR_DEFAULT_SIZE_SCALE
                ? null
                : value,
          },
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
