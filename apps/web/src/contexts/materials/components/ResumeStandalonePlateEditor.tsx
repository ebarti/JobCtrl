import type { ResumeCommentThread, ResumeLayoutBox } from "@jobctrl/contracts";
import { JobCtrlApiError } from "@jobctrl/api-client";
import { type CSSProperties, type JSX, type ReactNode, type RefObject, useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { Value } from "platejs";
import type { PdfAuditLineSelection } from "../../../shared/ui/PdfPreviewViewer.js";
import { usePorts } from "../../../shared/providers/PortsProvider.js";
import { Button } from "../../../shared/ui/button.js";
import { Empty } from "../../../shared/ui/empty.js";
import { emptyRiskSignals } from "../lib/resume-provenance.js";
import { isPlateValue, normalizeResumePlateValue, resumePlateLinesFromHtml, resumePlateValueFromHtml,
  resumePlateValueSignature, resumeSemanticTextChangesFromPlateValues } from "../lib/resume-document.js";
import { linkSelectedResumeLine } from "../lib/resume-formatting.js";
import type { ResumeEditorFormattingApi, ResumeEditorTextAlign, ResumeEditorFontFamily, ResumeEditorFontSize, ResumePlateSemanticTextChange } from "../lib/resume-editor-types.js";
import { ResumeEditorToolbarControls } from "./ResumeEditorToolbar.js";
import { ResumePlateDocument } from "./ResumePlateDocument.js";

const EMPTY_COMMENT_THREADS_BY_LINE_INDEX: ReadonlyMap<number, readonly ResumeCommentThread[]> = new Map();

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
  const { http } = usePorts();
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
    let active = true;
    setHtmlState({ status: "loading", html: null, message: null });
    const url = new URL(htmlUrl, "http://jobctrl.local");
    let request: Promise<string>;
    try {
      request = http.text("GET", url.pathname, { query: Object.fromEntries(url.searchParams) });
    } catch (error) {
      request = Promise.reject(error);
    }
    void request
      .then((html) => {
        if (active) {
          setHtmlState({ status: "ready", html: htmlTransform ? htmlTransform(html) : html, message: null });
        }
      })
      .catch((error: unknown) => {
        if (!active) return;
        const message = error instanceof Error ? error.message : "HTML preview request failed.";
        const status = error instanceof JobCtrlApiError && error.status === 415 ? "legacy"
          : error instanceof JobCtrlApiError && error.status === 404 ? "missing" : "error";
        setHtmlState({ status, html: null, message });
      });
    return () => { active = false; };
  }, [htmlTransform, htmlUrl, http, requestKey, transformKey]);

  return loaded.key === requestKey ? loaded.state : { status: htmlUrl ? "loading" : "idle", html: null, message: null };
}

export function ResumeStandalonePlateEditor({
  className,
  enableLocalPdfExport = true,
  html,
  htmlTransform,
  htmlUrl,
  pdfFilename,
  previewStyle,
  title,
  transformKey,
  workspaceControls,
  savedPlateValue,
  initialDraftValue,
  onDirtyChange,
  onPlateValueChange,
  onSemanticTextChange,
}: {
  readonly className?: string;
  readonly enableLocalPdfExport?: boolean;
  readonly html?: string | null;
  readonly htmlTransform?: ((html: string) => string) | undefined;
  readonly htmlUrl: string | null;
  readonly pdfFilename: string;
  readonly previewStyle?: CSSProperties | undefined;
  readonly title: string;
  readonly transformKey?: string;
  readonly workspaceControls?: ReactNode;
  readonly savedPlateValue?: Value | null;
  readonly initialDraftValue?: Value | null;
  readonly onDirtyChange?: (dirty: boolean) => void;
  readonly onPlateValueChange?: (value: Value) => void;
  readonly onSemanticTextChange?: (changes: readonly ResumePlateSemanticTextChange[]) => void;
}): JSX.Element {
  const loadedHtmlState = useResumeHtmlState(html === undefined ? htmlUrl : null, htmlTransform, transformKey);
  const htmlState = useMemo(() => html === undefined ? loadedHtmlState : html === null
    ? { status: "idle" as const, html: null, message: null }
    : { status: "ready" as const, html: htmlTransform ? htmlTransform(html) : html, message: null },
  [html, htmlTransform, loadedHtmlState]);
  const layoutBoxes = useMemo<readonly ResumeLayoutBox[]>(() => [], []);
  const risk = useMemo(() => emptyRiskSignals(), []);
  const htmlLines = useMemo(
    () => (htmlState.status === "ready" ? resumePlateLinesFromHtml(htmlState.html, layoutBoxes) : []),
    [htmlState, layoutBoxes],
  );
  const initialPlateValue = useMemo<Value | null>(
    () => savedPlateValue && isPlateValue(savedPlateValue) ? normalizeResumePlateValue(savedPlateValue)
      : (htmlState.status === "ready" ? resumePlateValueFromHtml(htmlState.html) : null),
    [htmlState, savedPlateValue],
  );
  const initialCurrentValue = useMemo<Value | null>(
    () => initialDraftValue && isPlateValue(initialDraftValue) ? normalizeResumePlateValue(initialDraftValue) : initialPlateValue,
    [initialDraftValue, initialPlateValue],
  );
  const [currentPlateValue, setCurrentPlateValue] = useState<Value | null>(initialCurrentValue);
  const [selectedLine, setSelectedLine] = useState<PdfAuditLineSelection | null>(null);
  const [resetVersion, setResetVersion] = useState(0);
  const [editorVersion, setEditorVersion] = useState(0);
  const formattingApiRef = useRef<ResumeEditorFormattingApi | null>(null);
  const [formattingApiReady, setFormattingApiReady] = useState(false);
  const exportSourceRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    setCurrentPlateValue(initialCurrentValue);
    setSelectedLine(null);
    setResetVersion((currentVersion) => currentVersion + 1);
  }, [initialCurrentValue]);

  const initialSignature = useMemo(
    () => resumePlateValueSignature(initialPlateValue),
    [initialPlateValue],
  );
  const currentSignature = useMemo(
    () => resumePlateValueSignature(currentPlateValue),
    [currentPlateValue],
  );
  const dirty = Boolean(currentPlateValue && currentSignature !== initialSignature);
  useEffect(() => { onDirtyChange?.(dirty); }, [dirty, onDirtyChange]);
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
      onPlateValueChange?.(value);
      if (initialPlateValue && onSemanticTextChange) {
        onSemanticTextChange(
          resumeSemanticTextChangesFromPlateValues(initialPlateValue, value),
        );
      }
    },
    [initialPlateValue, onPlateValueChange, onSemanticTextChange],
  );
  const handleToggleBold = useCallback(() => formattingApiRef.current?.toggleBold(), []);
  const handleToggleItalic = useCallback(() => formattingApiRef.current?.toggleItalic(), []);
  const handleToggleUnderline = useCallback(() => formattingApiRef.current?.toggleUnderline(), []);
  const handleSetLink = useCallback(
    (href: string) => {
      const linkedValue = linkSelectedResumeLine(currentPlateValue, selectedLine, href);
      if (linkedValue) {
        handlePlateValueChange(linkedValue);
        setEditorVersion((currentVersion) => currentVersion + 1);
        return;
      }
      formattingApiRef.current?.setLink(href);
    },
    [currentPlateValue, handlePlateValueChange, selectedLine],
  );
  const handleClearLink = useCallback(() => {
    const linkedValue = linkSelectedResumeLine(currentPlateValue, selectedLine, null);
    if (linkedValue) {
      handlePlateValueChange(linkedValue);
      setEditorVersion((currentVersion) => currentVersion + 1);
      return;
    }
    formattingApiRef.current?.clearLink();
  }, [currentPlateValue, handlePlateValueChange, selectedLine]);
  const handleAlign = useCallback((value: ResumeEditorTextAlign) => formattingApiRef.current?.align(value), []);
  const handleFontFamily = useCallback(
    (value: ResumeEditorFontFamily) => formattingApiRef.current?.setFontFamily(value),
    [],
  );
  const handleFontSize = useCallback((value: ResumeEditorFontSize) => formattingApiRef.current?.setFontSize(value), []);
  const handleReset = useCallback(() => {
    setCurrentPlateValue(initialPlateValue);
    if (initialPlateValue) onPlateValueChange?.(initialPlateValue);
    onSemanticTextChange?.([]);
    setResetVersion((currentVersion) => currentVersion + 1);
  }, [initialPlateValue, onPlateValueChange, onSemanticTextChange]);

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
          Editable resume
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
        {enableLocalPdfExport ? <ResumePdfExportControl
          disabled={!currentPlateValue}
          filename={pdfFilename}
          sourceRef={exportSourceRef}
        /> : null}
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


export type { ResumePlateSemanticTextChange } from "../lib/resume-editor-types.js";
