import { afterEach, describe, expect, it, vi } from "vitest";

import {
  BrowserPdfExportAdapter,
  type PdfDocumentFactory,
  type PdfPageRasterizer,
} from "./BrowserPdfExportAdapter.js";

afterEach(() => {
  document.body.replaceChildren();
});

function pdfDocumentDouble() {
  return {
    addPage: vi.fn(),
    addPageImage: vi.fn(),
    addSearchableText: vi.fn(),
    save: vi.fn(),
    setPage: vi.fn(),
  };
}

describe("BrowserPdfExportAdapter", () => {
  it("downloads a cleaned, browser-rasterized A4 PDF with searchable punctuation", async () => {
    const exportRoot = document.createElement("div");
    exportRoot.className = "resume-plate-page";
    exportRoot.style.setProperty("--resume-template-accent", "#123456");
    exportRoot.style.setProperty(
      "--resume-template-font-family",
      '"Custom Resume", serif',
    );
    exportRoot.style.setProperty("--resume-template-page-padding", "12mm 14mm");
    const source = document.createElement("div");
    source.className = "resume-plate-document";
    source.style.letterSpacing = "0.01em";
    const originalSourceStyle = source.getAttribute("style");
    source.contentEditable = "true";
    source.innerHTML = `
      <main class="resume-page" style="inline-size: 210mm; min-block-size: 297mm">
        <p class="resume-contact" data-resume-line-number="1">
          <span class="resume-contact-item resume-contact-phone"><a>+1 555-0100</a></span>
          <span class="resume-contact-separator">•</span>
          <span class="resume-contact-item resume-contact-email"><a>person@example.com</a></span>
          <span class="resume-contact-separator">•</span>
          <span class="resume-contact-item resume-contact-website"><a>example.com</a></span>
        </p>
        <p class="resume-entry-summary jobctrl-review-line has-jobctrl-comment jobctrl-selected-line" data-resume-line-number="2">Presented the plan; led the rollout.</p>
        <aside class="resume-plate-comment" data-resume-editor-chrome="true">Audit-only comment</aside>
      </main>
    `;
    const resumePage = source.querySelector<HTMLElement>(".resume-page")!;
    // Chromium includes absolutely positioned audit-bubble overflow here.
    // The render scale must remain the physical 794px A4 page width.
    Object.defineProperty(resumePage, "scrollWidth", { value: 1_014 });
    Object.defineProperty(source, "scrollWidth", { value: 1_014 });
    exportRoot.append(source);
    document.body.append(exportRoot);

    const pageCanvas = document.createElement("canvas");
    const rasterizer: PdfPageRasterizer = vi.fn(
      async (exportSource, options) => {
        expect(exportSource).toHaveAttribute(
          "data-resume-pdf-export-source",
          "true",
        );
        expect(
          exportSource.style.getPropertyValue("--resume-template-accent"),
        ).toBe("#123456");
        expect(
          exportSource.style.getPropertyValue("--resume-template-font-family"),
        ).toBe('"Custom Resume", serif');
        expect(
          exportSource.style.getPropertyValue("--resume-template-page-padding"),
        ).toBe("12mm 14mm");
        expect(options.windowWidth).toBe(794);
        expect(options.pageHeightPx).toBe(1_123);

        const clonedDocument =
          document.implementation.createHTMLDocument("PDF clone");
        clonedDocument.body.innerHTML = exportSource.outerHTML;
        options.onclone(clonedDocument);
        expect(
          clonedDocument.documentElement.style.getPropertyValue(
            "background-color",
          ),
        ).toBe("rgb(255, 255, 255)");
        expect(
          clonedDocument.documentElement.style.getPropertyPriority(
            "background-color",
          ),
        ).toBe("important");
        expect(
          clonedDocument.body.style.getPropertyValue("background-color"),
        ).toBe("rgb(255, 255, 255)");
        expect(clonedDocument.body.style.getPropertyValue("color")).toBe(
          "rgb(17, 17, 17)",
        );
        const clone = clonedDocument.querySelector<HTMLElement>(
          ".resume-plate-document",
        );
        expect(clone?.style.getPropertyValue("--resume-template-accent")).toBe(
          "#123456",
        );
        expect(clone?.textContent).toContain(
          "Presented the plan; led the rollout.",
        );
        expect(clone?.textContent).not.toContain("Audit-only comment");
        expect(clone?.hasAttribute("contenteditable")).toBe(false);
        expect([
          ...clone!.querySelector(".resume-entry-summary")!.classList,
        ]).not.toEqual(
          expect.arrayContaining([
            "jobctrl-review-line",
            "has-jobctrl-comment",
            "jobctrl-selected-line",
          ]),
        );
        return [
          {
            canvas: pageCanvas,
            slice: { endPx: 1_123, startPx: 0 },
          },
        ];
      },
    );
    const pdf = pdfDocumentDouble();
    const factory: PdfDocumentFactory = vi.fn(async () => pdf);

    await new BrowserPdfExportAdapter(factory, rasterizer).downloadPdf({
      filename: "Résumé live?.pdf",
      source,
    });

    expect(factory).toHaveBeenCalledTimes(1);
    expect(factory).toHaveBeenCalledWith({
      format: "a4",
      heightMm: 297,
      heightPx: 1_123,
      widthMm: 210,
      widthPx: 794,
    });
    expect(pdf.addPage).not.toHaveBeenCalled();
    expect(pdf.setPage).toHaveBeenCalledWith(1);
    expect(pdf.addPageImage).toHaveBeenCalledWith(pageCanvas, "resume-page-1");
    expect(pdf.addSearchableText).toHaveBeenCalledWith(
      expect.objectContaining({
        pageNumber: 1,
        text: "+1 555-0100 | person@example.com | example.com",
      }),
    );
    expect(pdf.addSearchableText).toHaveBeenCalledWith(
      expect.objectContaining({
        pageNumber: 1,
        text: "Presented the plan; led the rollout.",
      }),
    );
    expect(pdf.save).toHaveBeenCalledWith("Resume-live.pdf");
    expect(source).not.toHaveAttribute("data-resume-pdf-export-source");
    expect(source.getAttribute("style")).toBe(originalSourceStyle);
    expect(exportRoot).not.toHaveAttribute("data-resume-pdf-export-source");
    expect(source).toHaveTextContent("Presented the plan; led the rollout.");
    expect(source).toHaveTextContent("Audit-only comment");
  });

  it("preserves Letter media geometry across multiple raster pages", async () => {
    const exportRoot = document.createElement("div");
    exportRoot.className = "resume-plate-page";
    exportRoot.style.setProperty("--resume-template-page-inline-size", "8.5in");
    exportRoot.style.setProperty("--resume-template-page-block-size", "11in");
    const source = document.createElement("div");
    source.className = "resume-plate-document";
    source.innerHTML = `
      <main class="resume-page" style="inline-size: 8.5in; min-block-size: 11in">
        <p data-resume-line-number="1">Letter resume</p>
      </main>
    `;
    exportRoot.append(source);
    document.body.append(exportRoot);

    const firstCanvas = document.createElement("canvas");
    const secondCanvas = document.createElement("canvas");
    const rasterizer: PdfPageRasterizer = vi.fn(async (_source, options) => {
      expect(options.windowWidth).toBe(816);
      expect(options.pageHeightPx).toBe(1_056);
      return [
        {
          canvas: firstCanvas,
          slice: { endPx: 1_056, startPx: 0 },
        },
        {
          canvas: secondCanvas,
          slice: { endPx: 1_400, startPx: 1_056 },
        },
      ];
    });
    const pdf = pdfDocumentDouble();
    const factory: PdfDocumentFactory = vi.fn(async () => pdf);

    await new BrowserPdfExportAdapter(factory, rasterizer).downloadPdf({
      filename: "letter-resume.pdf",
      source,
    });

    expect(factory).toHaveBeenCalledWith({
      format: "letter",
      heightMm: 279.4,
      heightPx: 1_056,
      widthMm: 215.9,
      widthPx: 816,
    });
    expect(pdf.addPage).toHaveBeenCalledTimes(1);
    expect(pdf.addPageImage).toHaveBeenNthCalledWith(
      1,
      firstCanvas,
      "resume-page-1",
    );
    expect(pdf.addPageImage).toHaveBeenNthCalledWith(
      2,
      secondCanvas,
      "resume-page-2",
    );
    expect(pdf.save).toHaveBeenCalledWith("letter-resume.pdf");
    expect(source).not.toHaveAttribute("style");
    expect(source).not.toHaveAttribute("data-resume-pdf-export-source");
  });

  it("rejects a detached Plate document before loading the PDF runtime", async () => {
    const factory: PdfDocumentFactory = vi.fn(async () => pdfDocumentDouble());
    const rasterizer: PdfPageRasterizer = vi.fn(async () => []);

    await expect(
      new BrowserPdfExportAdapter(factory, rasterizer).downloadPdf({
        filename: "resume.pdf",
        source: document.createElement("div"),
      }),
    ).rejects.toThrow("no longer available");
    expect(factory).not.toHaveBeenCalled();
    expect(rasterizer).not.toHaveBeenCalled();
  });

  it("restores the live DOM marker when rasterization fails", async () => {
    const exportRoot = document.createElement("div");
    exportRoot.className = "resume-plate-page";
    const source = document.createElement("div");
    source.className = "resume-plate-document";
    source.setAttribute("data-resume-pdf-export-source", "existing");
    source.style.setProperty("--resume-template-accent", "#abcdef");
    const originalSourceStyle = source.getAttribute("style");
    exportRoot.append(source);
    document.body.append(exportRoot);
    const factory: PdfDocumentFactory = vi.fn(async () => pdfDocumentDouble());
    const rasterizer: PdfPageRasterizer = vi.fn(async () => {
      expect(source).toHaveAttribute("data-resume-pdf-export-source", "true");
      throw new Error("PDF rasterization failed");
    });

    await expect(
      new BrowserPdfExportAdapter(factory, rasterizer).downloadPdf({
        filename: "resume.pdf",
        source,
      }),
    ).rejects.toThrow("PDF rasterization failed");
    expect(exportRoot).not.toHaveAttribute("data-resume-pdf-export-source");
    expect(source).toHaveAttribute("data-resume-pdf-export-source", "existing");
    expect(source.getAttribute("style")).toBe(originalSourceStyle);
  });
});
