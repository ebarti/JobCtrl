import type { Options as Html2CanvasOptions } from "html2canvas";

import type {
  PdfExportPort,
  PdfExportRequest,
} from "../../ports/PdfExportPort.js";

const PDF_EXPORT_SOURCE_ATTRIBUTE = "data-resume-pdf-export-source";
const PDF_BITMAP_SCALE = 2;
const PDF_PAGE_SLICE_EPSILON_PX = 1;
const PDF_SEARCH_TEXT_FONT_SIZE_PT = 6;
const EDITOR_CHROME_SELECTOR = '[data-resume-editor-chrome="true"]';
const EDITOR_STATE_CLASSES = [
  "has-jobctrl-comment",
  "jobctrl-review-line",
  "jobctrl-selected-line",
] as const;
const TEMPLATE_STYLE_PREFIX = "--resume-template-";
const TEMPLATE_STYLE_PROPERTIES = [
  "--resume-template-accent",
  "--resume-template-body-align",
  "--resume-template-body-font-size",
  "--resume-template-bullet-gap",
  "--resume-template-contact-font-size",
  "--resume-template-entry-gap",
  "--resume-template-entry-meta-font-size",
  "--resume-template-font-family",
  "--resume-template-header-justify",
  "--resume-template-header-text-align",
  "--resume-template-heading-box-border",
  "--resume-template-heading-font-size",
  "--resume-template-heading-padding",
  "--resume-template-heading-rule-border",
  "--resume-template-line-height",
  "--resume-template-list-gap",
  "--resume-template-meta-line-height",
  "--resume-template-name-font-size",
  "--resume-template-page-block-size",
  "--resume-template-page-inline-size",
  "--resume-template-page-padding",
  "--resume-template-section-gap",
] as const;

interface PdfPageGeometry {
  readonly format: "a4" | "letter";
  readonly heightMm: number;
  readonly heightPx: number;
  readonly widthMm: number;
  readonly widthPx: number;
}

const PDF_PAGE_GEOMETRIES: Record<PdfPageGeometry["format"], PdfPageGeometry> =
  {
    a4: {
      format: "a4",
      heightMm: 297,
      heightPx: 1_123,
      widthMm: 210,
      widthPx: 794,
    },
    letter: {
      format: "letter",
      heightMm: 279.4,
      heightPx: 1_056,
      widthMm: 215.9,
      widthPx: 816,
    },
  };

export interface PdfPageSlice {
  readonly endPx: number;
  readonly startPx: number;
}

export interface PdfVerticalInterval {
  readonly bottomPx: number;
  readonly topPx: number;
}

export interface PdfRasterizedPage {
  readonly canvas: HTMLCanvasElement;
  readonly slice: PdfPageSlice;
}

export interface PdfRasterizationOptions {
  readonly ignoreElements: (element: Element) => boolean;
  readonly lineIntervals: readonly PdfVerticalInterval[];
  readonly onclone: (clonedDocument: Document) => void;
  readonly pageHeightPx: number;
  readonly windowWidth: number;
}

interface PdfSearchableTextLine {
  readonly pageNumber: number;
  readonly text: string;
  readonly xMm: number;
  readonly yMm: number;
}

interface PdfDocument {
  addPage(): void;
  addPageImage(image: HTMLCanvasElement, alias: string): void;
  addSearchableText(line: PdfSearchableTextLine): void;
  save(filename: string): void;
  setPage(pageNumber: number): void;
}

export type PdfDocumentFactory = (
  page: PdfPageGeometry,
) => Promise<PdfDocument>;

export type PdfPageRasterizer = (
  source: HTMLElement,
  options: PdfRasterizationOptions,
) => Promise<readonly PdfRasterizedPage[]>;

async function createPdfDocument(page: PdfPageGeometry): Promise<PdfDocument> {
  const { jsPDF } = await import("jspdf");
  const pdf = new jsPDF({
    compress: true,
    format: page.format,
    orientation: "portrait",
    putOnlyUsedFonts: true,
    unit: "mm",
  });
  return {
    addPage: () => {
      pdf.addPage(page.format, "portrait");
    },
    addPageImage: (image, alias) => {
      pdf.addImage(
        image,
        "PNG",
        0,
        0,
        page.widthMm,
        page.heightMm,
        alias,
        "FAST",
      );
    },
    addSearchableText: (line) => {
      pdf.setFont("helvetica", "normal");
      pdf.setFontSize(PDF_SEARCH_TEXT_FONT_SIZE_PT);
      pdf.text(line.text, line.xMm, line.yMm, {
        renderingMode: "invisible",
      });
    },
    save: (filename) => {
      pdf.save(filename);
    },
    setPage: (pageNumber) => {
      pdf.setPage(pageNumber);
    },
  };
}

function pdfFilename(value: string): string {
  const stem = value
    .trim()
    .replace(/\.pdf$/i, "")
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-zA-Z0-9_-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 96);
  return `${stem || "resume"}.pdf`;
}

function positiveCssNumber(
  style: CSSStyleDeclaration,
  ...properties: readonly string[]
): number | null {
  for (const property of properties) {
    const value = Number.parseFloat(style.getPropertyValue(property));
    if (Number.isFinite(value) && value > 0) return value;
  }
  return null;
}

function pdfPageGeometry(source: HTMLElement): PdfPageGeometry {
  const page = source.querySelector<HTMLElement>(".resume-page");
  if (!page) return PDF_PAGE_GEOMETRIES.a4;
  const style = getComputedStyle(page);
  const width = positiveCssNumber(style, "inline-size", "width");
  const height = positiveCssNumber(style, "min-block-size", "min-height");
  const measuredWidth = width ?? page.getBoundingClientRect().width;
  const measuredHeight = height ?? page.getBoundingClientRect().height;
  if (measuredWidth > 0 && measuredHeight > 0) {
    const ratio = measuredWidth / measuredHeight;
    const a4Distance = Math.abs(ratio - 210 / 297);
    const letterDistance = Math.abs(ratio - 8.5 / 11);
    if (letterDistance < a4Distance) return PDF_PAGE_GEOMETRIES.letter;
  }
  return PDF_PAGE_GEOMETRIES.a4;
}

function pdfWindowWidth(
  source: HTMLElement,
  pageGeometry: PdfPageGeometry,
): number {
  const page = source.querySelector<HTMLElement>(".resume-page");
  if (!page) return pageGeometry.widthPx;
  const style = getComputedStyle(page);
  const physicalWidth =
    positiveCssNumber(style, "inline-size", "width") ??
    page.getBoundingClientRect().width;
  // Descendant audit bubbles sit outside the page and inflate scrollWidth.
  // The clean clone removes them, so only the physical page box may set scale.
  return Math.max(pageGeometry.widthPx, Math.ceil(physicalWidth));
}

function pdfPageHeight(
  source: HTMLElement,
  pageGeometry: PdfPageGeometry,
): number {
  const page = source.querySelector<HTMLElement>(".resume-page");
  if (!page) return pageGeometry.heightPx;
  const style = getComputedStyle(page);
  const physicalHeight = positiveCssNumber(
    style,
    "min-block-size",
    "min-height",
  );
  return Math.max(
    pageGeometry.heightPx,
    Math.ceil(physicalHeight ?? pageGeometry.heightPx),
  );
}

function inheritedTemplateValue(
  source: HTMLElement,
  computedStyle: CSSStyleDeclaration,
  property: string,
): string {
  const resolved = computedStyle.getPropertyValue(property).trim();
  if (resolved) return resolved;
  for (
    let ancestor = source.parentElement;
    ancestor;
    ancestor = ancestor.parentElement
  ) {
    const inlineValue = ancestor.style.getPropertyValue(property).trim();
    if (inlineValue) return inlineValue;
  }
  return "";
}

function applyTemplateContext(source: HTMLElement): void {
  const computedStyle = getComputedStyle(source);
  const properties = new Set<string>([
    ...TEMPLATE_STYLE_PROPERTIES,
    ...TEMPLATE_STYLE_PROPERTIES.map((property) =>
      property.replace(
        TEMPLATE_STYLE_PREFIX,
        `${TEMPLATE_STYLE_PREFIX}default-`,
      ),
    ),
  ]);
  for (let index = 0; index < computedStyle.length; index += 1) {
    const property = computedStyle.item(index);
    if (property.startsWith(TEMPLATE_STYLE_PREFIX)) properties.add(property);
  }
  for (const property of properties) {
    const value = inheritedTemplateValue(source, computedStyle, property);
    if (value) source.style.setProperty(property, value, "important");
  }
}

function restoreAttribute(
  element: HTMLElement,
  attribute: string,
  value: string | null,
): void {
  if (value === null) {
    element.removeAttribute(attribute);
  } else {
    element.setAttribute(attribute, value);
  }
}

function preparePdfClone(clonedDocument: Document): void {
  clonedDocument.documentElement.style.setProperty(
    "background-color",
    "#fff",
    "important",
  );
  clonedDocument.documentElement.style.setProperty(
    "color",
    "#111",
    "important",
  );
  clonedDocument.documentElement.style.setProperty(
    "color-scheme",
    "light",
    "important",
  );
  clonedDocument.body.style.setProperty(
    "background-color",
    "#fff",
    "important",
  );
  clonedDocument.body.style.setProperty("color", "#111", "important");

  const exportRoots = clonedDocument.querySelectorAll<HTMLElement>(
    `[${PDF_EXPORT_SOURCE_ATTRIBUTE}="true"]`,
  );
  for (const exportRoot of exportRoots) {
    const source = exportRoot.matches(".resume-plate-document")
      ? exportRoot
      : exportRoot.querySelector<HTMLElement>(".resume-plate-document");
    if (!source) continue;
    source.removeAttribute("contenteditable");
    source.removeAttribute("spellcheck");
    source.style.background = "#fff";
    source.style.margin = "0";
    source.style.outline = "none";
    source
      .querySelectorAll(EDITOR_CHROME_SELECTOR)
      .forEach((element) => element.remove());
    source
      .querySelectorAll<HTMLElement>("[contenteditable]")
      .forEach((element) => {
        element.removeAttribute("contenteditable");
        element.removeAttribute("spellcheck");
      });
    source
      .querySelectorAll<HTMLElement>(`.${EDITOR_STATE_CLASSES.join(", .")}`)
      .forEach((element) => {
        element.classList.remove(...EDITOR_STATE_CLASSES);
      });
  }
}

function collectTextLineIntervals(
  source: HTMLElement,
): readonly PdfVerticalInterval[] {
  const page = source.querySelector<HTMLElement>(".resume-page") ?? source;
  const sourceRect = source.getBoundingClientRect();
  const ownerDocument = source.ownerDocument;
  const showText = ownerDocument.defaultView?.NodeFilter.SHOW_TEXT ?? 4;
  const walker = ownerDocument.createTreeWalker(page, showText);
  const intervals: PdfVerticalInterval[] = [];
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    if (!node.textContent?.trim()) continue;
    const parent = node.parentElement;
    if (!parent || parent.closest(EDITOR_CHROME_SELECTOR)) continue;
    const range = ownerDocument.createRange();
    range.selectNodeContents(node);
    if (typeof range.getClientRects !== "function") continue;
    for (const rect of Array.from(range.getClientRects())) {
      if (rect.height <= 0 || rect.width <= 0) continue;
      intervals.push({
        bottomPx: rect.bottom - sourceRect.top,
        topPx: rect.top - sourceRect.top,
      });
    }
  }
  return intervals.sort((left, right) => left.topPx - right.topPx);
}

export function pdfPageSlices(
  totalHeightPx: number,
  pageHeightPx: number,
  lineIntervals: readonly PdfVerticalInterval[],
): readonly PdfPageSlice[] {
  const slices: PdfPageSlice[] = [];
  let startPx = 0;
  while (startPx < totalHeightPx - PDF_PAGE_SLICE_EPSILON_PX) {
    let endPx = Math.min(startPx + pageHeightPx, totalHeightPx);
    if (endPx < totalHeightPx - PDF_PAGE_SLICE_EPSILON_PX) {
      const crossingLines = lineIntervals.filter(
        (interval) => interval.topPx < endPx && interval.bottomPx > endPx,
      );
      if (crossingLines.length > 0) {
        const safeEndPx = Math.floor(
          Math.min(...crossingLines.map((interval) => interval.topPx)),
        );
        if (safeEndPx > startPx + PDF_PAGE_SLICE_EPSILON_PX) {
          endPx = safeEndPx;
        }
      }
    }
    if (endPx <= startPx + PDF_PAGE_SLICE_EPSILON_PX) {
      endPx = Math.min(startPx + pageHeightPx, totalHeightPx);
    }
    slices.push({ endPx, startPx });
    startPx = endPx;
  }
  return slices.length > 0
    ? slices
    : [{ endPx: Math.max(1, totalHeightPx), startPx: 0 }];
}

async function rasterizePdfPages(
  source: HTMLElement,
  options: PdfRasterizationOptions,
): Promise<readonly PdfRasterizedPage[]> {
  const { default: html2canvasModule } = await import("html2canvas");
  const html2canvas = html2canvasModule as unknown as (
    element: HTMLElement,
    options?: Partial<Html2CanvasOptions>,
  ) => Promise<HTMLCanvasElement>;
  const continuousCanvas = await html2canvas(source, {
    backgroundColor: "#ffffff",
    ignoreElements: options.ignoreElements,
    logging: false,
    onclone: options.onclone,
    scale: PDF_BITMAP_SCALE,
    useCORS: true,
    width: options.windowWidth,
    windowWidth: options.windowWidth,
  });
  const canvasScale = Math.max(
    Number.EPSILON,
    continuousCanvas.width / options.windowWidth,
  );
  const pageHeightCanvasPx = Math.max(
    1,
    Math.round(options.pageHeightPx * canvasScale),
  );
  const scaledLineIntervals = options.lineIntervals.map((interval) => ({
    bottomPx: interval.bottomPx * canvasScale,
    topPx: interval.topPx * canvasScale,
  }));
  const slices = pdfPageSlices(
    continuousCanvas.height,
    pageHeightCanvasPx,
    scaledLineIntervals,
  );

  return slices.map((slice) => {
    const pageCanvas = source.ownerDocument.createElement("canvas");
    pageCanvas.width = continuousCanvas.width;
    pageCanvas.height = pageHeightCanvasPx;
    const context = pageCanvas.getContext("2d", { alpha: false });
    if (!context) {
      throw new Error("The browser could not prepare a PDF page canvas.");
    }
    context.fillStyle = "#ffffff";
    context.fillRect(0, 0, pageCanvas.width, pageCanvas.height);
    const sliceHeightPx = Math.max(1, slice.endPx - slice.startPx);
    context.drawImage(
      continuousCanvas,
      0,
      slice.startPx,
      continuousCanvas.width,
      sliceHeightPx,
      0,
      0,
      continuousCanvas.width,
      sliceHeightPx,
    );
    return {
      canvas: pageCanvas,
      slice: {
        endPx: slice.endPx / canvasScale,
        startPx: slice.startPx / canvasScale,
      },
    };
  });
}

const SEARCHABLE_TEXT_FALLBACK_SELECTOR = [
  ".resume-name",
  ".resume-address",
  ".resume-contact",
  ".resume-section-title",
  ".resume-summary",
  ".resume-entry-company",
  ".resume-entry-title",
  ".resume-entry-date",
  ".resume-entry-location",
  ".resume-entry-summary",
  ".resume-bullets li",
  ".resume-skills-list li",
].join(", ");

function searchableTextElements(source: HTMLElement): readonly HTMLElement[] {
  const semanticLines = Array.from(
    source.querySelectorAll<HTMLElement>("[data-resume-line-number]"),
  ).filter(
    (element) =>
      !element.closest(EDITOR_CHROME_SELECTOR) &&
      !element.querySelector("[data-resume-line-number]"),
  );
  if (semanticLines.length > 0) return semanticLines;
  return Array.from(
    source.querySelectorAll<HTMLElement>(SEARCHABLE_TEXT_FALLBACK_SELECTOR),
  ).filter(
    (element) =>
      !element.closest(EDITOR_CHROME_SELECTOR) &&
      !element.querySelector(SEARCHABLE_TEXT_FALLBACK_SELECTOR),
  );
}

function normalizedSearchableText(element: HTMLElement): string {
  if (element.matches(".resume-contact")) {
    const contactItems = Array.from(
      element.querySelectorAll<HTMLElement>(".resume-contact-item"),
    )
      .map((item) => item.textContent?.replace(/\s+/g, " ").trim() ?? "")
      .filter(Boolean);
    if (contactItems.length > 0) return contactItems.join(" | ");
  }
  return (element.innerText || element.textContent || "")
    .replace(/\u00a0/g, " ")
    .replace(/[•·]/g, " | ")
    .replace(/\s+/g, " ")
    .trim();
}

function searchableTextLayer(
  source: HTMLElement,
  pages: readonly PdfRasterizedPage[],
  geometry: PdfPageGeometry,
): readonly PdfSearchableTextLine[] {
  const sourceRect = source.getBoundingClientRect();
  const pageRect =
    source
      .querySelector<HTMLElement>(".resume-page")
      ?.getBoundingClientRect() ?? sourceRect;
  const pageWidthPx = pageRect.width > 0 ? pageRect.width : geometry.widthPx;
  const lines: PdfSearchableTextLine[] = [];
  for (const element of searchableTextElements(source)) {
    const text = normalizedSearchableText(element);
    if (!text) continue;
    const rect = element.getBoundingClientRect();
    const topPx = rect.top - sourceRect.top;
    const matchingPageIndex = pages.findIndex(
      (page, index) =>
        topPx >= page.slice.startPx &&
        (topPx < page.slice.endPx || index === pages.length - 1),
    );
    const pageIndex =
      matchingPageIndex >= 0
        ? matchingPageIndex
        : Math.max(0, pages.length - 1);
    const page = pages[pageIndex] ?? pages[0];
    if (!page) continue;
    const relativeTopPx = Math.max(0, topPx - page.slice.startPx);
    const xMm = Math.min(
      geometry.widthMm - 0.5,
      Math.max(
        0.5,
        ((rect.left - pageRect.left) / pageWidthPx) * geometry.widthMm,
      ),
    );
    const yMm = Math.min(
      geometry.heightMm - 0.5,
      Math.max(1, (relativeTopPx / geometry.heightPx) * geometry.heightMm + 1),
    );
    lines.push({ pageNumber: pageIndex + 1, text, xMm, yMm });
  }
  return lines;
}

export class BrowserPdfExportAdapter implements PdfExportPort {
  constructor(
    private readonly pdfDocumentFactory: PdfDocumentFactory = createPdfDocument,
    private readonly pdfPageRasterizer: PdfPageRasterizer = rasterizePdfPages,
  ) {}

  async downloadPdf({ filename, source }: PdfExportRequest): Promise<void> {
    if (!source.isConnected) {
      throw new Error("The resume document is no longer available to export.");
    }

    await document.fonts?.ready;
    const originalMarker = source.getAttribute(PDF_EXPORT_SOURCE_ATTRIBUTE);
    const originalStyle = source.getAttribute("style");
    try {
      applyTemplateContext(source);
      const pageGeometry = pdfPageGeometry(source);
      const windowWidth = pdfWindowWidth(source, pageGeometry);
      const pageHeightPx = pdfPageHeight(source, pageGeometry);
      const lineIntervals = collectTextLineIntervals(source);
      source.setAttribute(PDF_EXPORT_SOURCE_ATTRIBUTE, "true");
      const pdf = await this.pdfDocumentFactory(pageGeometry);
      const pages = await this.pdfPageRasterizer(source, {
        ignoreElements: (element) => element.matches(EDITOR_CHROME_SELECTOR),
        lineIntervals,
        onclone: preparePdfClone,
        pageHeightPx,
        windowWidth,
      });
      if (pages.length === 0) {
        throw new Error("The browser produced no resume pages to export.");
      }
      pages.forEach((page, index) => {
        if (index > 0) pdf.addPage();
        pdf.setPage(index + 1);
        pdf.addPageImage(page.canvas, `resume-page-${index + 1}`);
      });
      for (const line of searchableTextLayer(source, pages, pageGeometry)) {
        pdf.setPage(line.pageNumber);
        pdf.addSearchableText(line);
      }
      pdf.save(pdfFilename(filename));
    } finally {
      restoreAttribute(source, PDF_EXPORT_SOURCE_ATTRIBUTE, originalMarker);
      restoreAttribute(source, "style", originalStyle);
    }
  }
}
