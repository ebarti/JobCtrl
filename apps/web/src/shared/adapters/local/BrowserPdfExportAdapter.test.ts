import { afterEach, describe, expect, it, vi } from "vitest";

import {
  BrowserPdfExportAdapter,
  type PdfDocumentFactory,
} from "./BrowserPdfExportAdapter.js";

afterEach(() => {
  document.body.replaceChildren();
});

describe("BrowserPdfExportAdapter", () => {
  it("downloads the live Plate document as a cleaned A4 PDF", async () => {
    const exportRoot = document.createElement("div");
    exportRoot.className = "resume-plate-page";
    exportRoot.style.setProperty("--resume-template-accent", "#123456");
    exportRoot.style.setProperty(
      "--resume-template-font-family",
      '"Custom Resume", serif',
    );
    exportRoot.style.setProperty(
      "--resume-template-page-padding",
      "12mm 14mm",
    );
    const source = document.createElement("div");
    source.className = "resume-plate-document";
    source.style.letterSpacing = "0.01em";
    const originalSourceStyle = source.getAttribute("style");
    source.contentEditable = "true";
    source.innerHTML = `
      <main class="resume-page" style="inline-size: 210mm; min-block-size: 297mm">
        <p class="jobctrl-review-line has-jobctrl-comment jobctrl-selected-line">Unsaved live edit</p>
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

    const save = vi.fn();
    const html = vi.fn(
      async (
        exportSource: HTMLElement,
        options: Parameters<Awaited<ReturnType<PdfDocumentFactory>>["html"]>[1],
      ) => {
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
        const clonedDocument =
          document.implementation.createHTMLDocument("PDF clone");
        clonedDocument.body.innerHTML = exportSource.outerHTML;
        options.html2canvas.onclone(clonedDocument);
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
        expect(
          clonedDocument.body.style.getPropertyValue("color"),
        ).toBe("rgb(17, 17, 17)");
        const clone = clonedDocument.querySelector<HTMLElement>(
          ".resume-plate-document",
        );
        expect(clone?.style.getPropertyValue("--resume-template-accent")).toBe(
          "#123456",
        );
        expect(clone?.textContent).toContain("Unsaved live edit");
        expect(clone?.textContent).not.toContain("Audit-only comment");
        expect(clone?.hasAttribute("contenteditable")).toBe(false);
        expect([...clone!.querySelector("p")!.classList]).not.toEqual(
          expect.arrayContaining([
            "jobctrl-review-line",
            "has-jobctrl-comment",
            "jobctrl-selected-line",
          ]),
        );
      },
    );
    const factory: PdfDocumentFactory = vi.fn(async () => ({ html, save }));

    await new BrowserPdfExportAdapter(factory).downloadPdf({
      filename: "Résumé live?.pdf",
      source,
    });

    expect(factory).toHaveBeenCalledTimes(1);
    expect(factory).toHaveBeenCalledWith({
      format: "a4",
      widthMm: 210,
      widthPx: 794,
    });
    expect(html).toHaveBeenCalledWith(
      source,
      expect.objectContaining({
        autoPaging: "text",
        margin: [0, 0, 0, 0],
        width: 209.9,
        windowWidth: 794,
      }),
    );
    expect(save).toHaveBeenCalledWith("Resume-live.pdf");
    expect(source).not.toHaveAttribute("data-resume-pdf-export-source");
    expect(source.getAttribute("style")).toBe(originalSourceStyle);
    expect(exportRoot).not.toHaveAttribute("data-resume-pdf-export-source");
    expect(source).toHaveTextContent("Unsaved live edit");
    expect(source).toHaveTextContent("Audit-only comment");
  });

  it("preserves Letter media geometry from the mounted Plate page", async () => {
    const exportRoot = document.createElement("div");
    exportRoot.className = "resume-plate-page";
    exportRoot.style.setProperty(
      "--resume-template-page-inline-size",
      "8.5in",
    );
    exportRoot.style.setProperty(
      "--resume-template-page-block-size",
      "11in",
    );
    const source = document.createElement("div");
    source.className = "resume-plate-document";
    source.innerHTML = `
      <main class="resume-page" style="inline-size: 8.5in; min-block-size: 11in">
        <p>Letter resume</p>
      </main>
    `;
    exportRoot.append(source);
    document.body.append(exportRoot);

    const save = vi.fn();
    const html = vi.fn(async () => undefined);
    const factory: PdfDocumentFactory = vi.fn(async () => ({ html, save }));

    await new BrowserPdfExportAdapter(factory).downloadPdf({
      filename: "letter-resume.pdf",
      source,
    });

    expect(factory).toHaveBeenCalledWith({
      format: "letter",
      widthMm: 215.9,
      widthPx: 816,
    });
    expect(html).toHaveBeenCalledWith(
      source,
      expect.objectContaining({
        width: 215.8,
        windowWidth: 816,
      }),
    );
    expect(save).toHaveBeenCalledWith("letter-resume.pdf");
    expect(source).not.toHaveAttribute("style");
    expect(source).not.toHaveAttribute("data-resume-pdf-export-source");
  });

  it("rejects a detached Plate document before loading the PDF runtime", async () => {
    const factory: PdfDocumentFactory = vi.fn(async () => ({
      html: vi.fn(async () => undefined),
      save: vi.fn(),
    }));

    await expect(
      new BrowserPdfExportAdapter(factory).downloadPdf({
        filename: "resume.pdf",
        source: document.createElement("div"),
      }),
    ).rejects.toThrow("no longer available");
    expect(factory).not.toHaveBeenCalled();
  });

  it("restores the live DOM marker when PDF generation fails", async () => {
    const exportRoot = document.createElement("div");
    exportRoot.className = "resume-plate-page";
    const source = document.createElement("div");
    source.className = "resume-plate-document";
    source.setAttribute("data-resume-pdf-export-source", "existing");
    source.style.setProperty("--resume-template-accent", "#abcdef");
    const originalSourceStyle = source.getAttribute("style");
    exportRoot.append(source);
    document.body.append(exportRoot);
    const factory: PdfDocumentFactory = vi.fn(async () => {
      expect(source).toHaveAttribute(
        "data-resume-pdf-export-source",
        "true",
      );
      throw new Error("PDF runtime failed");
    });

    await expect(
      new BrowserPdfExportAdapter(factory).downloadPdf({
        filename: "resume.pdf",
        source,
      }),
    ).rejects.toThrow("PDF runtime failed");
    expect(exportRoot).not.toHaveAttribute("data-resume-pdf-export-source");
    expect(source).toHaveAttribute(
      "data-resume-pdf-export-source",
      "existing",
    );
    expect(source.getAttribute("style")).toBe(originalSourceStyle);
  });
});
