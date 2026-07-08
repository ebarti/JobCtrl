import pdfWorkerUrl from "pdfjs-dist/legacy/build/pdf.worker.mjs?url";
import { useEffect, useState } from "react";

import { pdfTextLines, type PdfAuditLineTarget, type RenderedPdfLine } from "./pdf-audit-lines.js";

export type { PdfAuditLineTarget } from "./pdf-audit-lines.js";

type PdfJsModule = typeof import("pdfjs-dist/legacy/build/pdf.mjs");
type PdfLoadingTask = ReturnType<PdfJsModule["getDocument"]>;

interface RenderedPage {
  height: number;
  lines?: RenderedPdfLine[];
  pageNumber: number;
  src: string;
  width: number;
}

type PreviewState =
  | { status: "loading"; pages: RenderedPage[]; message: string }
  | { status: "ready"; pages: RenderedPage[]; message: string }
  | { status: "error"; pages: RenderedPage[]; message: string };

export interface PdfPreviewViewerProps {
  url: string;
  cacheKey?: number | string;
  title: string;
  loadingTitle: string;
  loadingMessage: string;
  pageAltPrefix: string;
  openLabel?: string;
}

export interface PdfAuditPreviewViewerProps extends PdfPreviewViewerProps {
  lineTargets: readonly PdfAuditLineTarget[];
  layoutBoxes?: readonly PdfAuditLayoutBox[];
  selectedLineKey?: string | null;
  selectedLineNumber?: number | null;
  onSelectLine?: (selection: PdfAuditLineSelection) => void;
  onSelectLineNumber?: (lineNumber: number | null) => void;
}

export interface PdfAuditLayoutBox {
  readonly semanticId: string;
  readonly pageNumber: number;
  readonly lineNumber: number | null;
  readonly textExcerpt: string;
  readonly leftPct: number;
  readonly topPct: number;
  readonly widthPct: number;
  readonly heightPct: number;
}

export interface PdfAuditLineSelection {
  lineKey: string;
  lineNumber: number | null;
  pageLineIndex: number;
  pageNumber: number;
  resumeLineText: string | null;
  text: string;
}

const PDF_RENDER_SCALE = 1.45;

async function loadPdfJs(): Promise<PdfJsModule> {
  const pdfjs = await import("pdfjs-dist/legacy/build/pdf.mjs");
  pdfjs.GlobalWorkerOptions.workerSrc = pdfWorkerUrl;
  await installMainThreadPdfWorker();
  return pdfjs;
}

async function installMainThreadPdfWorker(): Promise<void> {
  const globalScope = globalThis as typeof globalThis & {
    pdfjsWorker?: Awaited<typeof import("pdfjs-dist/legacy/build/pdf.worker.mjs")>;
  };
  globalScope.pdfjsWorker ??= await import("pdfjs-dist/legacy/build/pdf.worker.mjs");
}

async function loadingTaskForUrl(
  pdfjs: PdfJsModule,
  url: string,
  signal: AbortSignal,
): Promise<PdfLoadingTask> {
  const response = await fetch(url, { signal });
  if (!response.ok) {
    throw new Error(`PDF request failed with ${response.status}.`);
  }
  const data = new Uint8Array(await response.arrayBuffer());
  return pdfjs.getDocument({ data });
}

export function pageImageUrlForPreview(pdfUrl: string, pageNumber: number): string | null {
  try {
    const url = new URL(pdfUrl, window.location.href);
    if (!/^\/v1\/artifacts\/[^/]+\/preview\.pdf$/.test(url.pathname)) {
      return null;
    }
    const nextPath = url.pathname.replace(/\/preview\.pdf$/, `/preview/page/${pageNumber}.png`);
    if (nextPath === url.pathname) {
      return null;
    }
    url.pathname = nextPath;
    return url.toString();
  } catch {
    return null;
  }
}

export function PdfPreviewViewer({
  url,
  cacheKey,
  title,
  loadingTitle,
  loadingMessage,
  pageAltPrefix,
  openLabel = "open PDF",
}: PdfPreviewViewerProps) {
  const [state, setState] = useState<PreviewState>({
    status: "loading",
    pages: [],
    message: loadingMessage,
  });

  useEffect(() => {
    let cancelled = false;
    let loadingTask: PdfLoadingTask | undefined;
    const abortController = new AbortController();
    setState({ status: "loading", pages: [], message: loadingMessage });

    async function renderPreview() {
      const showProgress = (message: string, pages: readonly RenderedPage[] = []) => {
        if (!cancelled) {
          setState({ status: "loading", pages: [...pages], message });
        }
      };

      try {
        showProgress("Loading PDF renderer.");
        const pdfjs = await loadPdfJs();
        showProgress("Loading PDF bytes.");
        loadingTask = await loadingTaskForUrl(pdfjs, url, abortController.signal);
        showProgress("Opening PDF.");
        const document = await loadingTask.promise;
        const pages: RenderedPage[] = [];
        const outputScale = window.devicePixelRatio || 1;

        for (let pageNumber = 1; pageNumber <= document.numPages; pageNumber += 1) {
          showProgress(`Rendering page ${pageNumber} of ${document.numPages}.`, pages);
          const page = await document.getPage(pageNumber);
          const viewport = page.getViewport({ scale: PDF_RENDER_SCALE });
          const renderViewport = page.getViewport({ scale: PDF_RENDER_SCALE * outputScale });
          const pageImageUrl = pageImageUrlForPreview(url, pageNumber);
          let src = pageImageUrl;
          if (!src) {
            const canvas = window.document.createElement("canvas");
            const context = canvas.getContext("2d");
            if (!context) {
              throw new Error("Canvas rendering is unavailable.");
            }

            canvas.width = Math.floor(renderViewport.width);
            canvas.height = Math.floor(renderViewport.height);
            await page.render({ canvas, canvasContext: context, viewport: renderViewport }).promise;
            src = canvas.toDataURL("image/png");
          }
          pages.push({
            height: viewport.height,
            pageNumber,
            src,
            width: viewport.width,
          });
          showProgress(`Rendered page ${pageNumber} of ${document.numPages}.`, pages);
          page.cleanup();
        }

        if (!cancelled) {
          setState({
            status: "ready",
            pages,
            message: `${document.numPages} page${document.numPages === 1 ? "" : "s"}`,
          });
        }
        await document.destroy();
      } catch (error) {
        if (!cancelled) {
          setState({
            status: "error",
            pages: [],
            message: error instanceof Error ? error.message : "Unable to render PDF preview.",
          });
        }
      }
    }

    void renderPreview();
    return () => {
      cancelled = true;
      abortController.abort();
      void loadingTask?.destroy();
    };
  }, [cacheKey, loadingMessage, url]);

  return (
    <div className="pdf-preview-viewer">
      <div className="pdf-preview-toolbar">
        <span>{title}</span>
        <span className="toolbar-status">{state.message}</span>
        <a href={url} rel="noreferrer" target="_blank">
          {openLabel}
        </a>
      </div>
      {state.status === "error" ? (
        <div className="pdf-preview-state" role="status">
          <b>Preview failed</b>
          <span>{state.message}</span>
        </div>
      ) : null}
      {state.status === "loading" ? (
        <div className="pdf-preview-state" role="status">
          <b>{loadingTitle}</b>
          <span>{loadingMessage}</span>
        </div>
      ) : null}
      {state.pages.length ? (
        <div className="pdf-preview-pages" aria-label={`${title} pages`}>
          {state.pages.map((page) => (
            <figure className="pdf-preview-page" key={page.pageNumber}>
              <img
                alt={`${pageAltPrefix} page ${page.pageNumber}`}
                height={page.height}
                src={page.src}
                width={page.width}
              />
              <figcaption>Page {page.pageNumber}</figcaption>
            </figure>
          ))}
        </div>
      ) : null}
    </div>
  );
}

export function PdfAuditPreviewViewer({
  url,
  cacheKey,
  title,
  loadingTitle,
  loadingMessage,
  pageAltPrefix,
  openLabel = "open PDF",
  lineTargets,
  layoutBoxes = [],
  selectedLineKey = null,
  selectedLineNumber = null,
  onSelectLine,
  onSelectLineNumber,
}: PdfAuditPreviewViewerProps) {
  const [state, setState] = useState<PreviewState>({
    status: "loading",
    pages: [],
    message: loadingMessage,
  });

  useEffect(() => {
    let cancelled = false;
    let loadingTask: PdfLoadingTask | undefined;
    const abortController = new AbortController();
    setState({ status: "loading", pages: [], message: loadingMessage });

    async function renderPreview() {
      const showProgress = (message: string, pages: readonly RenderedPage[] = []) => {
        if (!cancelled) {
          setState({ status: "loading", pages: [...pages], message });
        }
      };

      try {
        showProgress("Loading PDF renderer.");
        const pdfjs = await loadPdfJs();
        showProgress("Loading PDF bytes.");
        loadingTask = await loadingTaskForUrl(pdfjs, url, abortController.signal);
        showProgress("Opening PDF.");
        const document = await loadingTask.promise;
        const pages: RenderedPage[] = [];
        const outputScale = window.devicePixelRatio || 1;

        for (let pageNumber = 1; pageNumber <= document.numPages; pageNumber += 1) {
          showProgress(`Mapping selectable text for page ${pageNumber} of ${document.numPages}.`, pages);
          const page = await document.getPage(pageNumber);
          const viewport = page.getViewport({ scale: PDF_RENDER_SCALE });
          const renderViewport = page.getViewport({ scale: PDF_RENDER_SCALE * outputScale });
          const pdfLines = layoutBoxes.length
            ? renderedLinesFromLayoutBoxes(pageNumber, layoutBoxes)
            : pdfTextLines(pdfjs, (await page.getTextContent()).items, viewport, lineTargets);
          const pageImageUrl = pageImageUrlForPreview(url, pageNumber);
          let src = pageImageUrl;
          if (!src) {
            showProgress(`Rendering page ${pageNumber} of ${document.numPages}.`, pages);
            const canvas = window.document.createElement("canvas");
            const context = canvas.getContext("2d");
            if (!context) {
              throw new Error("Canvas rendering is unavailable.");
            }

            canvas.width = Math.floor(renderViewport.width);
            canvas.height = Math.floor(renderViewport.height);
            await page.render({ canvas, canvasContext: context, viewport: renderViewport }).promise;
            src = canvas.toDataURL("image/png");
          }
          pages.push({
            height: viewport.height,
            lines: pdfLines,
            pageNumber,
            src,
            width: viewport.width,
          });
          showProgress(`Rendered page ${pageNumber} of ${document.numPages}.`, pages);
          page.cleanup();
        }

        if (!cancelled) {
          setState({
            status: "ready",
            pages,
            message: `${document.numPages} page${document.numPages === 1 ? "" : "s"}`,
          });
        }
        await document.destroy();
      } catch (error) {
        if (!cancelled) {
          setState({
            status: "error",
            pages: [],
            message: error instanceof Error ? error.message : "Unable to render PDF preview.",
          });
        }
      }
    }

    void renderPreview();
    return () => {
      cancelled = true;
      abortController.abort();
      void loadingTask?.destroy();
    };
  }, [cacheKey, layoutBoxes, lineTargets, loadingMessage, url]);

  return (
    <div className="pdf-preview-viewer pdf-audit-preview-viewer">
      <div className="pdf-preview-toolbar">
        <span>{title}</span>
        <span className="toolbar-status">{state.message}</span>
        <a href={url} rel="noreferrer" target="_blank">
          {openLabel}
        </a>
      </div>
      {state.status === "error" ? (
        <div className="pdf-preview-state" role="status">
          <b>Preview failed</b>
          <span>{state.message}</span>
        </div>
      ) : null}
      {state.status === "loading" ? (
        <div className="pdf-preview-state" role="status">
          <b>{loadingTitle}</b>
          <span>{loadingMessage}</span>
        </div>
      ) : null}
      {state.pages.length ? (
        <div className="pdf-preview-pages" aria-label={`${title} pages`}>
          {state.pages.map((page) => (
            <figure className="pdf-preview-page pdf-audit-page" key={page.pageNumber}>
              <div className="pdf-audit-page-frame">
                <img
                  alt={`${pageAltPrefix} page ${page.pageNumber}`}
                  height={page.height}
                  src={page.src}
                  width={page.width}
                />
                <div className="pdf-audit-line-layer" aria-label={`${title} selectable page ${page.pageNumber} lines`}>
                  {(page.lines ?? []).map((line, index) => {
                    const pageLineIndex = index + 1;
                    const lineKey =
                      line.resumeLineNumber === null
                        ? `pdf:${page.pageNumber}:${pageLineIndex}:${line.text}`
                        : `resume:${line.resumeLineNumber}`;
                    const selected =
                      selectedLineKey === lineKey ||
                      (selectedLineKey === null &&
                        line.resumeLineNumber !== null &&
                        line.resumeLineNumber === selectedLineNumber);
                    const labelText = line.resumeLineText ?? line.text;
                    return (
                      <button
                        aria-label={
                          line.resumeLineNumber
                            ? `Line ${line.resumeLineNumber}: ${labelText}`
                            : `PDF page ${page.pageNumber} line ${index + 1}: ${line.text}`
                        }
                        aria-pressed={selected}
                        className="pdf-audit-line-target"
                        key={`${page.pageNumber}:${index}:${line.text}`}
                        style={{
                          height: `${line.heightPct}%`,
                          left: `${line.leftPct}%`,
                          top: `${line.topPct}%`,
                          width: `${line.widthPct}%`,
                        }}
                        type="button"
                        onClick={() => {
                          onSelectLine?.({
                            lineKey,
                            lineNumber: line.resumeLineNumber,
                            pageLineIndex,
                            pageNumber: page.pageNumber,
                            resumeLineText: line.resumeLineText,
                            text: line.text,
                          });
                          onSelectLineNumber?.(line.resumeLineNumber);
                        }}
                      />
                    );
                  })}
                </div>
              </div>
              <figcaption>Page {page.pageNumber}</figcaption>
            </figure>
          ))}
        </div>
      ) : null}
    </div>
  );
}

export function renderedLinesFromLayoutBoxes(
  pageNumber: number,
  layoutBoxes: readonly PdfAuditLayoutBox[],
): RenderedPdfLine[] {
  return layoutBoxes
    .filter((box) => box.pageNumber === pageNumber)
    .map((box) => ({
      heightPct: box.heightPct,
      leftPct: box.leftPct,
      resumeLineNumber: box.lineNumber,
      resumeLineText: box.textExcerpt,
      text: box.textExcerpt,
      topPct: box.topPct,
      widthPct: box.widthPct,
    }))
    .filter((line) => line.text.trim().length > 0);
}
