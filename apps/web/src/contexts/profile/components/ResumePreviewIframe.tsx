import pdfWorkerUrl from "pdfjs-dist/legacy/build/pdf.worker.mjs?url";
import { useEffect, useState } from "react";

import { useProfilePdfPreviewUrl } from "../hooks/useProfilePdfPreviewUrl.js";

type PdfJsModule = typeof import("pdfjs-dist/legacy/build/pdf.mjs");
type PdfLoadingTask = ReturnType<PdfJsModule["getDocument"]>;

interface RenderedPage {
  height: number;
  pageNumber: number;
  src: string;
  width: number;
}

type PreviewState =
  | { status: "loading"; pages: RenderedPage[]; message: string }
  | { status: "ready"; pages: RenderedPage[]; message: string }
  | { status: "error"; pages: RenderedPage[]; message: string };

const PDF_RENDER_SCALE = 1.45;

export function ResumePreviewIframe() {
  const { url, cacheKey } = useProfilePdfPreviewUrl();
  const [state, setState] = useState<PreviewState>({
    status: "loading",
    pages: [],
    message: "Rendering resume preview.",
  });

  useEffect(() => {
    let cancelled = false;
    let loadingTask: PdfLoadingTask | undefined;
    setState({ status: "loading", pages: [], message: "Rendering resume preview." });

    async function renderPreview() {
      try {
        const pdfjs = await import("pdfjs-dist/legacy/build/pdf.mjs");
        pdfjs.GlobalWorkerOptions.workerSrc = pdfWorkerUrl;
        loadingTask = pdfjs.getDocument({ url });
        const document = await loadingTask.promise;
        const pages: RenderedPage[] = [];
        const outputScale = window.devicePixelRatio || 1;

        for (let pageNumber = 1; pageNumber <= document.numPages; pageNumber += 1) {
          const page = await document.getPage(pageNumber);
          const viewport = page.getViewport({ scale: PDF_RENDER_SCALE });
          const renderViewport = page.getViewport({ scale: PDF_RENDER_SCALE * outputScale });
          const canvas = window.document.createElement("canvas");
          const context = canvas.getContext("2d");
          if (!context) {
            throw new Error("Canvas rendering is unavailable.");
          }

          canvas.width = Math.floor(renderViewport.width);
          canvas.height = Math.floor(renderViewport.height);
          await page.render({ canvas, canvasContext: context, viewport: renderViewport }).promise;
          pages.push({
            height: viewport.height,
            pageNumber,
            src: canvas.toDataURL("image/png"),
            width: viewport.width,
          });
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
            message: error instanceof Error ? error.message : "Unable to render resume preview.",
          });
        }
      }
    }

    void renderPreview();
    return () => {
      cancelled = true;
      void loadingTask?.destroy();
    };
  }, [cacheKey, url]);

  return (
    <div className="pdf-preview-viewer">
      <div className="pdf-preview-toolbar">
        <span>Resume preview</span>
        <span className="mono">{state.message}</span>
        <a href={url} rel="noreferrer" target="_blank">
          open PDF
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
          <b>Rendering resume.</b>
          <span>The PDF endpoint is loading into the in-app preview.</span>
        </div>
      ) : null}
      {state.pages.length ? (
        <div className="pdf-preview-pages" aria-label="Rendered resume pages">
          {state.pages.map((page) => (
            <figure className="pdf-preview-page" key={page.pageNumber}>
              <img
                alt={`Resume page ${page.pageNumber}`}
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
