import {
  type ApplyReviewProfileSourceField,
  type ResumeCommentThread,
  type ResumeLayoutBox,
} from "@jobctrl/contracts";

import { type PdfAuditLineSelection } from "../../../shared/ui/PdfPreviewViewer.js";

import {
  type Dispatch,
  type SetStateAction,
  type JSX,
  useMemo,
  type RefObject,
  useState,
  useCallback,
  useEffect,
  type CSSProperties,
  type ReactNode,
  useRef,
} from "react";

import {
  type RiskSignals,
  type ResumePlateSemanticTextChange,
  type ResumeEditorFormattingApi,
  type ResumeEditorTextAlign,
  type ResumeEditorFontFamily,
  type ResumeEditorFontSize,
  type ResumePlateEditorProps,
  type ResumeAuditPin,
} from "../lib/resume-editor-types.js";

import { useArtifactDetailQuery } from "../../operations/hooks/useArtifactDetailQuery.js";

import {
  riskSignals,
  emptyRiskSignals,
  pinsFromResumeLines,
  sourceLabelForJustification,
  primarySourceTextForPin,
  pinTone,
  pinStatus,
  pinsFromExplanation,
  pinFromResumeLine,
} from "../lib/resume-provenance.js";

import { usePorts } from "../../../shared/providers/PortsProvider.js";

import { Button } from "../../../shared/ui/button.js";

import {
  resumePlateLinesFromHtml,
  resumePlateValueFromHtml,
  resumePlateValueSignature,
  resumeSemanticTextChangesFromPlateValues,
  isPlateValue,
  normalizeResumePlateValue,
  selectionFromPlateLine,
  resumeLinesFromText,
  resumeLineFromPdfSelection,
} from "../lib/resume-document.js";

import { type Value } from "platejs";

import { linkSelectedResumeLine } from "../lib/resume-formatting.js";

import { ResumeEditorToolbarControls } from "./ResumeEditorToolbar.js";

import {
  ResumePlateDocument,
  ResumeCommentThreadPanel,
} from "./ResumePlateDocument.js";

import { Empty } from "../../../shared/ui/empty.js";

import {
  placeResumeCommentThreads,
  seedThreadsFromPins,
} from "../lib/resume-comments.js";

import { formatToken } from "../lib/audit-format.js";

import { StatusBadge } from "../../../shared/ui/status-badge.js";

interface ResumeAuditPinsProps {
  readonly artifactId: string;
  readonly resumeText?: string | null;
  readonly profileSourceFields?: readonly ApplyReviewProfileSourceField[];
  readonly className?: string;
  readonly selectedLine?: PdfAuditLineSelection | null;
  readonly onSelectedLineChange?: Dispatch<SetStateAction<PdfAuditLineSelection | null>>;
}

const EMPTY_COMMENT_THREADS_BY_LINE_INDEX: ReadonlyMap<number, readonly ResumeCommentThread[]> = new Map();

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

function ResumePdfExportControl({
  disabled,
  filename,
  sourceRef,
}: {
  readonly disabled: boolean;
  readonly filename: string;
  readonly sourceRef: RefObject<HTMLElement | null>;
}): JSX.Element {
  const { pdfExport, telemetry } = usePorts();
  const [exportPending, setExportPending] = useState(false);
  const [exportError, setExportError] = useState(false);
  const handleExport = useCallback(async () => {
    const source =
      sourceRef.current?.querySelector<HTMLElement>(".resume-plate-document");
    if (!source || exportPending) return;
    setExportError(false);
    setExportPending(true);
    const startedAt = performance.now();
    try {
      await pdfExport.downloadPdf({ filename, source });
      telemetry.timing("resume_pdf_export", performance.now() - startedAt, {
        status: "succeeded",
      });
    } catch {
      telemetry.timing("resume_pdf_export", performance.now() - startedAt, {
        status: "failed",
      });
      telemetry.event("resume_pdf_export_failed", {
        operation: "resume_pdf_export",
      });
      setExportError(true);
    } finally {
      setExportPending(false);
    }
  }, [exportPending, filename, pdfExport, sourceRef, telemetry]);

  return (
    <>
      <Button
        className="tab"
        disabled={disabled || exportPending}
        size="sm"
        type="button"
        onClick={() => {
          void handleExport();
        }}
      >
        {exportPending ? "Exporting PDF…" : "Export PDF"}
      </Button>
      {exportError ? (
        <span className="resume-pdf-export-error" role="alert">
          PDF export failed. Try again.
        </span>
      ) : null}
    </>
  );
}

function useResumeHtmlState(
  htmlUrl: string | null,
  htmlTransform?: (html: string) => string,
  transformKey?: string,
): ResumeHtmlState {
  const requestKey = htmlUrl ? htmlUrl + ':' + (transformKey ?? '') : null;
  const [loaded, setLoaded] = useState<{ key: string | null; state: ResumeHtmlState }>({
    key: requestKey, state: { status: htmlUrl ? "loading" : "idle", html: null, message: null },
  });

  useEffect(() => {
    const setHtmlState = (state: ResumeHtmlState) => setLoaded({ key: requestKey, state });
    if (!htmlUrl) {
      setHtmlState({ status: "idle", html: null, message: null });
      return;
    }
    const abortController = new AbortController();
    setHtmlState({ status: "loading", html: null, message: null });
    fetch(htmlUrl, { signal: abortController.signal })
      .then(async (response) => {
        if (abortController.signal.aborted) return null;
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
  }, [htmlTransform, htmlUrl, requestKey, transformKey]);

  return loaded.key === requestKey ? loaded.state : { status: htmlUrl ? "loading" : "idle", html: null, message: null };
}

export function ResumeStandalonePlateEditor({
  className,
  htmlTransform,
  htmlUrl,
  pdfFilename,
  previewStyle,
  title,
  transformKey,
  workspaceControls,
  onSemanticTextChange,
}: {
  readonly className?: string;
  readonly htmlTransform?: ((html: string) => string) | undefined;
  readonly htmlUrl: string | null;
  readonly pdfFilename: string;
  readonly previewStyle?: CSSProperties | undefined;
  readonly title: string;
  readonly transformKey?: string;
  readonly workspaceControls?: ReactNode;
  readonly onSemanticTextChange?: (changes: readonly ResumePlateSemanticTextChange[]) => void;
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
  const exportSourceRef = useRef<HTMLDivElement | null>(null);

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
  const handlePlateValueChange = useCallback(
    (value: Value) => {
      setCurrentPlateValue(value);
      if (initialPlateValue && onSemanticTextChange) {
        onSemanticTextChange(
          resumeSemanticTextChangesFromPlateValues(initialPlateValue, value),
        );
      }
    },
    [initialPlateValue, onSemanticTextChange],
  );
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
    onSemanticTextChange?.([]);
    setResetVersion((currentVersion) => currentVersion + 1);
  }, [initialPlateValue, onSemanticTextChange]);

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
      {workspaceControls ? (
        <div className="resume-plate-workspace-controls" data-resume-editor-chrome="true">
          {workspaceControls}
        </div>
      ) : null}
      <div className="resume-plate-toolbar" data-resume-editor-chrome="true">
        <b>{title}</b>
        <span className="toolbar-status" data-typography="metadata">
          Plate HTML/CSS editor
        </span>
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
        <ResumePdfExportControl
          disabled={!currentPlateValue}
          filename={pdfFilename}
          sourceRef={exportSourceRef}
        />
        <Button
          className="tab"
          disabled={!dirty || !initialPlateValue}
          size="sm"
          type="button"
          onClick={handleReset}
        >
          Reset
        </Button>
        <span
          className={`resume-plate-draft-status${dirty ? " dirty" : ""}`}
          data-typography="status"
          role="status"
        >
          {htmlState.status === "loading" ? "loading baseline" : dirty ? "local edits" : "baseline current"}
        </span>
      </div>
      <div className="resume-plate-scroll" tabIndex={0}>
        {htmlState.status === "ready" && initialPlateValue && currentPlateValue ? (
          <div
            ref={exportSourceRef}
            className="resume-plate-page"
            aria-label="Editable baseline resume page"
            data-draft-dirty={dirty ? "true" : "false"}
          >
            <ResumePlateDocument
              commentThreadsByLineIndex={EMPTY_COMMENT_THREADS_BY_LINE_INDEX}
              documentKey={documentKey}
              initialValue={currentPlateValue}
              layoutBoxes={layoutBoxes}
              lines={htmlLines}
              onClearLineSelection={handleClearLineSelection}
              onFormattingApiChange={handleFormattingApiChange}
              onSelectLine={handleSelectLine}
              onValueChange={handlePlateValueChange}
              pins={[]}
              replyPending={false}
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
  documentState,
  artifactId,
  draft,
  draftError = null,
  finalUrl,
  htmlUrl,
  layoutBoxes,
  lineTargets,
  pdfFilename,
  profileSourceFields = [],
  renderError = null,
  renderResult = null,
  resumeText,
  saveError = null,
  replyError = null,
  seedError = null,
  replyPending = false,
  selectedLine,
  title,
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
  const threadPlacement = useMemo(
    () => placeResumeCommentThreads(plateLines, linePins, draft?.commentThreads ?? []),
    [draft?.commentThreads, linePins, plateLines],
  );
  const seedThreads = useMemo(
    () => seedThreadsFromPins(artifactId, linePins, risk),
    [artifactId, linePins, risk],
  );
  const formattingApiRef = useRef<ResumeEditorFormattingApi | null>(null);
  const userClearedSelection = useRef(false);
  const initializedSelectionDocumentKey = useRef<string | null>(null);
  const [formattingApiReady, setFormattingApiReady] = useState(false);
  const [editorVersion, setEditorVersion] = useState(0);
  const exportSourceRef = useRef<HTMLDivElement | null>(null);
  const initialPlateValue = useMemo<Value | null>(() => {
    const savedValue = draft?.latestRevision?.plateDocument;
    if (isPlateValue(savedValue)) {
      return normalizeResumePlateValue(savedValue);
    }
    return htmlState.status === "ready" ? resumePlateValueFromHtml(htmlState.html) : null;
  }, [draft?.latestRevision?.plateDocument, htmlState]);
  const currentPlateValue = documentState.value;
  const setCurrentPlateValue = documentState.onChange;
  useEffect(() => {
    if (initialPlateValue) documentState.onInitialize(initialPlateValue);
  }, [initialPlateValue, documentState.onInitialize]);
  const handleSaveDraft = () => onSaveDraft?.();
  const documentKey = documentState.version + ':' + editorVersion;
  const canFormat = formattingApiReady && Boolean(currentPlateValue);
  const draftDirty = documentState.dirty;
  const draftStatus = documentState.status;
  const saveDisabled = !documentState.canSave || !onSaveDraft;
  const renderDisabled = !documentState.canRender || !onRenderDraft;
  useEffect(() => {
    onSeedCommentThreads?.(seedThreads);
  }, [onSeedCommentThreads, seedThreads]);

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
        <span className="toolbar-status" data-typography="metadata">
          Plate HTML/CSS editor
        </span>
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
        <ResumePdfExportControl
          disabled={!currentPlateValue}
          filename={pdfFilename}
          sourceRef={exportSourceRef}
        />
        <Button
          className="tab"
          disabled={saveDisabled}
          size="sm"
          type="button"
          onClick={() => handleSaveDraft()}
        >
          Save draft
        </Button>
        <Button
          className="tab"
          disabled={renderDisabled}
          size="sm"
          type="button"
          onClick={() => onRenderDraft?.()}
        >
          Render replacement
        </Button>
        <span
          className={`resume-plate-draft-status${draftDirty ? " dirty" : ""}`}
          data-typography="status"
          role="status"
        >
          {draftStatus}
        </span>
        <a href={finalUrl} rel="noreferrer" target="_blank">
          Open final file
        </a>
      </div>
      {draftError ? <div className="banner inline">{draftError}<Button onClick={documentState.onRetryLoad}>Retry loading draft</Button></div> : null}
      {saveError ? <div className="banner inline">{saveError}</div> : null}
      {seedError ? <div className="banner inline flex-wrap"><p>{seedError} Retry saving the existing review findings; this does not run a new review.</p><Button type="button" onClick={documentState.onRetryComments}>Retry saving review comments</Button></div> : null}
      {renderError ? <div className="banner inline">{renderError}</div> : null}
      {renderResult && !renderResult.ok ? (
        <div className="banner inline" role="status">
          {renderResult.validation.errors.join(" ")}
        </div>
      ) : null}
      {renderResult?.validation.warnings.length ? (
        <div className="resume-render-warnings" role="status">
          <b>{renderResult.ok ? "Rendered replacement warnings" : "Warnings from rejected render attempt"}</b>
          {renderResult.validation.warnings.map((warning) => (
            <span key={warning}>{warning}</span>
          ))}
        </div>
      ) : null}
      <div className="resume-plate-scroll" tabIndex={0}>
        {htmlState.status === "ready" && initialPlateValue && currentPlateValue ? (
          <div
            ref={exportSourceRef}
            className="resume-plate-page"
            aria-label="Editable resume page"
            data-draft-dirty={draftDirty ? "true" : "false"}
          >
            <ResumePlateDocument
              commentThreadsByLineIndex={threadPlacement.commentThreadsByLineIndex}
              documentKey={documentKey}
              initialValue={currentPlateValue}
              layoutBoxes={layoutBoxes}
              lines={plateLines}
              onReplyToThread={onReplyToThread}
              onClearLineSelection={handleClearLineSelection}
              onFormattingApiChange={handleFormattingApiChange}
              onValueChange={setCurrentPlateValue}
              pins={linePins}
              replyPending={replyPending}
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
        threads={threadPlacement.unmatchedThreads}
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
        <StatusBadge tone={tone}>{pinStatus(pin, risk)}</StatusBadge>
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

export { resumeSemanticTextChangesFromPlateValues } from "../lib/resume-document.js";

export type {
  ResumeReviewDocumentState,
  ResumePlateSemanticTextChange,
} from "../lib/resume-editor-types.js";
