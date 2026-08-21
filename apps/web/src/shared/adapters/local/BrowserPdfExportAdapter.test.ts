import { afterEach, describe, expect, it, vi } from "vitest";

import {
  BrowserPdfExportAdapter,
  collectSearchableTextFragments,
  pdfInvisibleTextOptions,
  pdfPageSlices,
  safeBlankRasterCut,
  searchableTextLayer,
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
  it("uses top-anchored invisible PDF text scaled to each measured word", () => {
    expect(pdfInvisibleTextOptions(20, 10)).toEqual({
      baseline: "top",
      horizontalScale: 0.5,
      renderingMode: "invisible",
    });
    expect(pdfInvisibleTextOptions(0, 10)).toEqual({
      baseline: "top",
      horizontalScale: 1,
      renderingMode: "invisible",
    });
  });

  it("snaps a shifted page cut onto blank raster rows after glyph bleed", () => {
    const inkRows = new Set([
      2_223, 2_224, 2_225, 2_226, 2_227, 2_241, 2_242,
    ]);

    expect(
      safeBlankRasterCut(
        2_225,
        0,
        2_246,
        12,
        8,
        (row) => !inkRows.has(row),
      ),
    ).toBe(2_232);
  });

  it("keeps a raster cut outside a crossing line with disconnected ink", () => {
    const crossingLine = { bottomPx: 111, topPx: 100 };
    const inkRows = new Set([100, 101, 104, 105, 106, 107, 108, 109, 110]);

    const slices = pdfPageSlices(180, 105, [crossingLine], (
      candidate,
      minimum,
      maximum,
    ) =>
      safeBlankRasterCut(
        candidate,
        minimum,
        maximum,
        12,
        8,
        (row) => !inkRows.has(row),
      ),
    );

    expect(slices[0]?.endPx).toBe(96);
    expect(
      slices.some(
        (slice) =>
          crossingLine.topPx < slice.endPx &&
          crossingLine.bottomPx > slice.endPx,
      ),
    ).toBe(false);
  });

  it("moves a bitmap page cut above a text line that crosses the boundary", () => {
    const crossingLine = {
      bottomPx: 2_261.906,
      topPx: 2_225.906,
    };

    const slices = pdfPageSlices(4_373, 2_246, [crossingLine]);

    expect(slices).toEqual([
      { endPx: 2_225, startPx: 0 },
      { endPx: 4_373, startPx: 2_225 },
    ]);
    expect(slices[1]?.startPx).toBe(slices[0]?.endPx);
    expect(
      slices.some(
        (slice) =>
          crossingLine.topPx < slice.endPx &&
          crossingLine.bottomPx > slice.endPx,
      ),
    ).toBe(false);
  });

  it("maps rendered word boxes through shifted PDF page slices", () => {
    const source = document.createElement("div");
    source.className = "resume-plate-document";
    source.innerHTML = `
      <main class="resume-page">
        <p><span>First line second line</span></p>
      </main>
    `;
    document.body.append(source);
    vi.spyOn(source, "getBoundingClientRect").mockReturnValue({
      bottom: 220,
      height: 200,
      left: 10,
      right: 210,
      top: 20,
      width: 200,
      x: 10,
      y: 20,
      toJSON: () => ({}),
    });
    const page = source.querySelector<HTMLElement>(".resume-page")!;
    vi.spyOn(page, "getBoundingClientRect").mockReturnValue({
      bottom: 220,
      height: 200,
      left: 10,
      right: 210,
      top: 20,
      width: 200,
      x: 10,
      y: 20,
      toJSON: () => ({}),
    });

    const rectsByOffset = new Map<string, DOMRect>([
      ["0:5", DOMRect.fromRect({ height: 12, width: 30, x: 20, y: 30 })],
      ["6:10", DOMRect.fromRect({ height: 12, width: 24, x: 55, y: 30 })],
      ["11:17", DOMRect.fromRect({ height: 12, width: 40, x: 20, y: 40 })],
      ["18:22", DOMRect.fromRect({ height: 12, width: 24, x: 65, y: 40 })],
    ]);
    const rangePrototype = document.defaultView!.Range.prototype as Range & {
      getClientRects?: () => DOMRectList;
    };
    const originalDescriptor = Object.getOwnPropertyDescriptor(
      rangePrototype,
      "getClientRects",
    );
    Object.defineProperty(rangePrototype, "getClientRects", {
      configurable: true,
      value(this: Range) {
        const rect = rectsByOffset.get(
          `${this.startOffset}:${this.endOffset}`,
        );
        return (rect ? [rect] : []) as unknown as DOMRectList;
      },
    });

    try {
      const measured = collectSearchableTextFragments(source);
      expect(measured).toEqual([
        { heightPx: 12, leftPx: 10, text: "First", topPx: 10, widthPx: 30 },
        { heightPx: 12, leftPx: 45, text: "line", topPx: 10, widthPx: 24 },
        {
          heightPx: 12,
          leftPx: 10,
          text: "second",
          topPx: 20,
          widthPx: 40,
        },
        { heightPx: 12, leftPx: 55, text: "line", topPx: 20, widthPx: 24 },
      ]);
      const positioned = searchableTextLayer(
        source,
        [
          {
            canvas: document.createElement("canvas"),
            slice: { endPx: 25, startPx: 0 },
          },
          {
            canvas: document.createElement("canvas"),
            slice: { endPx: 200, startPx: 25 },
          },
        ],
        {
          format: "a4",
          heightMm: 100,
          heightPx: 200,
          widthMm: 100,
          widthPx: 200,
        },
      );
      expect(positioned).toHaveLength(4);
      expect(positioned[0]).toEqual({
        fontSizePt: expect.closeTo(17.0079, 3),
        pageNumber: 1,
        text: "First",
        widthMm: 15,
        xMm: 5,
        yMm: 5,
      });
      expect(positioned[2]).toEqual({
        fontSizePt: expect.closeTo(17.0079, 3),
        pageNumber: 2,
        text: "second",
        widthMm: 20,
        xMm: 5,
        yMm: 0.1,
      });
    } finally {
      if (originalDescriptor) {
        Object.defineProperty(
          rangePrototype,
          "getClientRects",
          originalDescriptor,
        );
      } else {
        Reflect.deleteProperty(rangePrototype, "getClientRects");
      }
    }
  });

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
