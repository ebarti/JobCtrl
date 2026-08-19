import type {
  PdfExportPort,
  PdfExportRequest,
} from "../../ports/PdfExportPort.js";

const PDF_EXPORT_SOURCE_ATTRIBUTE = "data-resume-pdf-export-source";
// Keep CSS-pixel conversion rounding from spilling an otherwise exact page
// boundary onto an empty trailing PDF page.
const PDF_RENDER_WIDTH_EPSILON_MM = 0.1;
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
  readonly widthMm: number;
  readonly widthPx: number;
}

const PDF_PAGE_GEOMETRIES: Record<PdfPageGeometry["format"], PdfPageGeometry> = {
  a4: { format: "a4", widthMm: 210, widthPx: 794 },
  letter: { format: "letter", widthMm: 215.9, widthPx: 816 },
};

interface PdfHtmlOptions {
  readonly autoPaging: "text";
  readonly html2canvas: {
    readonly backgroundColor: string;
    readonly ignoreElements: (element: Element) => boolean;
    readonly logging: boolean;
    readonly onclone: (clonedDocument: Document) => void;
    readonly useCORS: boolean;
  };
  readonly margin: [number, number, number, number];
  readonly width: number;
  readonly windowWidth: number;
  readonly x: number;
  readonly y: number;
}

interface PdfDocument {
  html(source: HTMLElement, options: PdfHtmlOptions): Promise<unknown>;
  save(filename: string): void;
}

export type PdfDocumentFactory = (
  page: PdfPageGeometry,
) => Promise<PdfDocument>;

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
    html: async (source, options) => {
      await pdf.html(source, options);
    },
    save: (filename) => {
      pdf.save(filename);
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
      property.replace(TEMPLATE_STYLE_PREFIX, `${TEMPLATE_STYLE_PREFIX}default-`),
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

export class BrowserPdfExportAdapter implements PdfExportPort {
  constructor(
    private readonly pdfDocumentFactory: PdfDocumentFactory = createPdfDocument,
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
      source.setAttribute(PDF_EXPORT_SOURCE_ATTRIBUTE, "true");
      const pdf = await this.pdfDocumentFactory(pageGeometry);
      await pdf.html(source, {
        autoPaging: "text",
        html2canvas: {
          backgroundColor: "#ffffff",
          ignoreElements: (element) => element.matches(EDITOR_CHROME_SELECTOR),
          logging: false,
          onclone: preparePdfClone,
          useCORS: true,
        },
        margin: [0, 0, 0, 0],
        width: pageGeometry.widthMm - PDF_RENDER_WIDTH_EPSILON_MM,
        windowWidth: pdfWindowWidth(source, pageGeometry),
        x: 0,
        y: 0,
      });
      pdf.save(pdfFilename(filename));
    } finally {
      restoreAttribute(source, PDF_EXPORT_SOURCE_ATTRIBUTE, originalMarker);
      restoreAttribute(source, "style", originalStyle);
    }
  }
}
