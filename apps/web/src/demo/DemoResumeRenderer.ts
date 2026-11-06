import pdfWorkerUrl from "pdfjs-dist/build/pdf.worker.min.mjs?url";

import {
  BrowserPdfExportAdapter,
  pdfInvisibleTextOptions,
  type PdfDocumentFactory,
} from "../shared/adapters/local/BrowserPdfExportAdapter.js";

type Data = Record<string, unknown>;
type Line = { id: string; text: string; tag: string; className: string; section: string };
const record = (value: unknown): Data => value !== null && typeof value === "object" && !Array.isArray(value) ? value as Data : {};
const rows = (value: unknown): Data[] => Array.isArray(value) ? value.map(record) : [];
const string = (value: unknown): string => typeof value === "string" ? value : "";
const normalized = (value: string): string => value.normalize("NFKC").replace(/\s+/gu, " ").trim();
const escape = (value: string): string => value.replace(/[&<>"']/g, (character) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[character]!);

/** Stable field IDs come from the saved document, never from interpreting prose. */
function documentLines(document: Data, theme: Data = {}): Line[] {
  const lines: Line[] = [];
  let section = "personal";
  const line = (id: string, text: unknown, tag = "p", className = "resume-line") => {
    if (typeof text === "string" && text.trim()) lines.push({ id, text, tag, className, section });
  };
  const personal = record(document.personal);
  line("personal:full_name", personal.full_name, "h1", "resume-name");
  line("personal:address", personal.address, "p", "resume-contact");
  rows(personal.contact_items).forEach((contact, index) => line(`personal:contact:${index}`, contact.label, "p", "resume-contact"));
  section = "summary";
  line("executive_profile#0", document.summary);
  section = "experience";
  const experience = rows(document.experience);
  if (experience.length) line("section:experience", "Experience", "h2", "resume-section-title");
  for (const role of experience) {
    const id = string(role.id);
    for (const field of ["title", "company", "location", "date_range", "summary"] as const) {
      line(`experience:${id}:${field}`, role[field], field === "title" ? "h3" : "p");
    }
    for (const bullet of rows(role.bullets)) line(string(bullet.id), bullet.text, "p", "resume-bullet");
  }
  const education = rows(document.education);
  section = "education";
  if (education.length) line("section:education", "Education", "h2", "resume-section-title");
  for (const entry of education) for (const field of ["degree", "institution", "location", "date", "details"] as const) {
    line(`education:${string(entry.id)}:${field}`, entry[field]);
  }
  const skills = rows(document.skills);
  section = "skills";
  if (skills.length) line("section:skills", "Skills", "h2", "resume-section-title");
  skills.forEach((category, index) => {
    line(`skills:${string(category.id) || index}:label`, category.label);
    if (Array.isArray(category.items)) line(`skills:${string(category.id) || index}:items`, category.items.filter((item): item is string => typeof item === "string").join(", "));
  });
  if (new Set(lines.map((item) => item.id)).size !== lines.length) throw new Error("The saved document contains duplicate field IDs.");
  const order = Array.isArray(theme.sectionOrder) ? theme.sectionOrder : ["summary", "experience", "education", "skills"];
  if (order.length !== 4 || new Set(order).size !== 4 || order.some((value) => !["summary", "experience", "education", "skills"].includes(String(value))) || Array.isArray(theme.hiddenSections) && theme.hiddenSections.length) throw new Error("A baseline resume must retain every authored section.");
  return [...lines.filter((line) => line.section === "personal"), ...order.flatMap((value) => lines.filter((line) => line.section === value))];
}

export function documentText(document: Data, theme: Data = {}): string {
  return documentLines(document, theme).map((line) => line.text).join("\n");
}

const fontFamilies: Readonly<Record<string, string>> = {
  resume: "Arial,sans-serif", sans: "Arial,sans-serif", serif: "Georgia,serif", system: "system-ui,sans-serif",
  aptos: "Aptos,Arial,sans-serif", avenir: "Avenir Next,Avenir,sans-serif", helvetica: "Helvetica,Arial,sans-serif",
  inter: "Inter,Arial,sans-serif", source_sans: "Source Sans 3,Arial,sans-serif", calibri: "Calibri,Arial,sans-serif",
  georgia: "Georgia,serif", garamond: "Garamond,serif", charter: "Charter,serif", source_serif: "Source Serif 4,Georgia,serif",
  times: "Times New Roman,serif", cambria: "Cambria,Georgia,serif", mono: "monospace",
};

/** Serialize only the editor's bounded presentation vocabulary. */
function plateNode(value: unknown): string {
  const node = record(value);
  if (typeof node.text === "string") {
    let content = escape(node.text);
    if (node.bold === true) content = `<strong>${content}</strong>`;
    if (node.italic === true) content = `<em>${content}</em>`;
    if (node.underline === true) content = `<u>${content}</u>`;
    if (node.strikethrough === true) content = `<s>${content}</s>`;
    return content;
  }
  if (!Array.isArray(node.children)) throw new Error("The saved editor document is malformed.");
  const allowed = new Set(["main", "div", "p", "h1", "h2", "h3", "h4", "ul", "ol", "li", "span", "strong", "em", "u", "s", "blockquote"]);
  const tag = typeof node.tagName === "string" && allowed.has(node.tagName) ? node.tagName : "div";
  const attributes: string[] = [];
  if (typeof node.semanticId === "string" && node.semanticId) attributes.push(`data-resume-layout-target="${escape(node.semanticId)}"`);
  if (typeof node.lineNumber === "number" && Number.isSafeInteger(node.lineNumber) && node.lineNumber > 0) attributes.push(`data-resume-line-number="${node.lineNumber}"`);
  if (typeof node.className === "string") attributes.push(`class="${escape(node.className)}"`);
  const styles: string[] = [];
  if (typeof node.textAlign === "string") {
    if (!["left", "right", "center", "justify"].includes(node.textAlign)) throw new Error("The saved text alignment is invalid.");
    styles.push(`text-align:${node.textAlign}`);
  }
  if (typeof node.fontFamily === "string") {
    const family = fontFamilies[node.fontFamily]; if (!family) throw new Error("The saved font is unavailable in the browser demo.");
    styles.push(`font-family:${family}`);
  }
  if (typeof node.fontSize === "number") {
    if (!Number.isFinite(node.fontSize) || node.fontSize < .75 || node.fontSize > 1.5) throw new Error("The saved font size is invalid.");
    styles.push(`font-size:${node.fontSize}em`);
  } else if (typeof node.fontSize === "string") {
    const size = ({ small: "9pt", resume: "11pt", large: "12pt", heading: "14pt" } as Record<string, string>)[node.fontSize];
    if (!size) throw new Error("The saved font size is invalid."); styles.push(`font-size:${size}`);
  }
  if (styles.length) attributes.push(`style="${escape(styles.join(";"))}"`);
  return `<${tag}${attributes.length ? ` ${attributes.join(" ")}` : ""}>${node.children.map(plateNode).join("")}</${tag}>`;
}

export function documentHtml(document: Data, plate?: unknown, themeValue?: unknown, templatePlate?: unknown): string {
  const theme = record(themeValue);
  const lines = documentLines(document, theme);
  let body = lines.map((line, index) => `<${line.tag} class="${line.className}" data-resume-layout-target="${escape(line.id)}" data-resume-line-number="${index + 1}">${escape(line.text)}</${line.tag}>`).join("");
  let hasPage = false;
  if (Array.isArray(plate)) {
    const edited = plate.map(plateNode).join("");
    const dom = new DOMParser().parseFromString(edited, "text/html");
    const targets = [...dom.querySelectorAll("[data-resume-layout-target]")];
    const unbound = dom.body.cloneNode(true) as HTMLElement;
    for (const target of unbound.querySelectorAll("[data-resume-layout-target]")) target.textContent = "";
    if (targets.length !== lines.length || targets.some((node, index) => node.getAttribute("data-resume-layout-target") !== lines[index]!.id || normalized(node.textContent ?? "") !== normalized(lines[index]!.text)) || normalized(unbound.textContent ?? "")) {
      throw new Error("The saved editor formatting no longer belongs to these exact source fields.");
    }
    body = edited;
    hasPage = dom.querySelector(".resume-page") !== null;
  }
  let markup = hasPage ? body : `<main class="resume-page" data-resume-page="1">${body}</main>`;
  if (!Array.isArray(plate) && Array.isArray(templatePlate)) {
    const current = new DOMParser().parseFromString(markup, "text/html");
    const template = new DOMParser().parseFromString(templatePlate.map(plateNode).join(""), "text/html");
    const styles = new Map([...template.querySelectorAll<HTMLElement>("[data-resume-layout-target]")].map((node) => [node.dataset.resumeLayoutTarget, node.style.cssText]));
    for (const node of current.querySelectorAll<HTMLElement>("[data-resume-layout-target]")) { const style = styles.get(node.dataset.resumeLayoutTarget); if (style) node.style.cssText += style; }
    const root = current.querySelector<HTMLElement>(".resume-page"); const rootStyle = template.querySelector<HTMLElement>(".resume-page")?.style.cssText;
    if (root && rootStyle) root.style.cssText += rootStyle;
    markup = current.body.innerHTML;
  }
  return `<!doctype html><html><head><meta charset="utf-8"><title>Synthetic resume</title><style>${themeCss(theme)}</style></head><body>${markup}</body></html>`;
}

function themeCss(theme: Data): string {
  const family = fontFamilies[string(theme.fontFamily) || "sans"]; if (!family) throw new Error("The saved template font is unavailable.");
  const scale = theme.fontScale === undefined ? 1 : theme.fontScale; if (typeof scale !== "number" || !Number.isFinite(scale) || scale < .85 || scale > 1.2) throw new Error("The template font scale is invalid.");
  const page = string(theme.pageSize) || "a4"; if (!["a4", "letter"].includes(page)) throw new Error("The saved paper size is invalid.");
  const margins = record(theme.marginMm); const padding = ["top", "right", "bottom", "left"].map((edge) => { const value = margins[edge] ?? 16; if (typeof value !== "number" || !Number.isFinite(value) || value < 8 || value > 28) throw new Error("The saved margin is invalid."); return `${value}mm`; }).join(" ");
  const density = ({ compact: 1.25, balanced: 1.45, spacious: 1.6 } as Record<string, number>)[string(theme.density) || "balanced"]; if (!density) throw new Error("The saved density is invalid.");
  const bullet = ({ tight: 3, normal: 5, loose: 8 } as Record<string, number>)[string(theme.bulletSpacing) || "normal"]; if (!bullet) throw new Error("The saved bullet spacing is invalid.");
  const accent = string(theme.accentColor) || "#334155"; if (!/^#[0-9a-f]{6}$/iu.test(accent)) throw new Error("The template accent color is invalid.");
  const heading = string(theme.sectionHeadingStyle) || "rule"; if (!["rule", "plain", "boxed"].includes(heading)) throw new Error("The saved section heading style is invalid.");
  const header = string(theme.headerLayout) || "left"; if (!["left", "centered", "split"].includes(header)) throw new Error("The saved header layout is invalid.");
  const alignment = string(theme.alignment) || "left"; if (!["left", "justified"].includes(alignment)) throw new Error("The saved alignment is invalid.");
  const width = page === "letter" ? 215.9 : 210; const height = page === "letter" ? 279.4 : 297;
  return `html,body{margin:0;padding:0;background:white}body{font:${11 * scale}pt/${density} ${family};color:#171717;text-align:${alignment === "justified" ? "justify" : "left"}}.resume-page{--resume-template-page-inline-size:${width}mm;--resume-template-page-block-size:${height}mm;--resume-template-page-padding:${padding};box-sizing:border-box;width:${width}mm;padding:${padding};margin:0;background:white;overflow:visible}.resume-line,.resume-bullet,.resume-contact{margin:5px 0;overflow-wrap:anywhere;white-space:pre-wrap}.resume-name{font-size:24pt;margin:0 0 12px;text-align:${header === "centered" ? "center" : "left"}}.resume-contact{text-align:${header === "centered" ? "center" : header === "split" ? "right" : "left"}}.resume-section-title{font-size:15pt;margin:18px 0 8px;color:${accent};${heading === "boxed" ? `border:1px solid ${accent};padding:6px` : heading === "rule" ? `border-bottom:1px solid ${accent};padding-bottom:4px` : "border:0"}}.resume-bullet{padding-left:14px;margin-top:${bullet}px;margin-bottom:${bullet}px}h3{font-size:12pt;margin:10px 0 4px}`;
}

export async function renderDemoResume(documentValue: Data, plate?: unknown, themeValue?: unknown, templatePlate?: unknown) {
  const theme = record(themeValue);
  const html = documentHtml(documentValue, plate, theme, templatePlate);
  const frame = document.createElement("iframe");
  frame.setAttribute("sandbox", "allow-same-origin");
  frame.setAttribute("aria-hidden", "true");
  frame.style.cssText = "position:fixed;left:-10000px;top:0;width:794px;height:1123px;border:0";
  let blob: Blob | null = null;
  let pages = 0;
  try {
    await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error("The browser resume surface did not load.")), 5000);
      frame.onload = () => { clearTimeout(timeout); resolve(); };
      frame.srcdoc = html; document.body.append(frame);
    });
    const source = frame.contentDocument?.querySelector<HTMLElement>(".resume-page");
    if (!source) throw new Error("The browser resume surface is unavailable.");
    const layoutConflicts = [...source.querySelectorAll<HTMLElement>("[data-resume-layout-target]")].filter((node) => node.scrollWidth > node.clientWidth + 1).map((node) => ({ kind: "horizontal_overflow", source_id: node.dataset.resumeLayoutTarget }));
    const factory: PdfDocumentFactory = async (page) => {
      const { jsPDF } = await import("jspdf");
      const pdf = new jsPDF({ compress: true, format: page.format, orientation: "portrait", putOnlyUsedFonts: true, unit: "mm" });
      return {
        addPage: () => { pdf.addPage(page.format, "portrait"); },
        addPageImage: (image, alias) => { pdf.addImage(image, "PNG", 0, 0, page.widthMm, page.heightMm, alias, "FAST"); },
        addSearchableText: (fragment) => {
          pdf.setFont("helvetica", "normal"); pdf.setFontSize(fragment.fontSizePt);
          pdf.text(fragment.text, fragment.xMm, fragment.yMm, pdfInvisibleTextOptions(pdf.getTextWidth(fragment.text), fragment.widthMm));
        },
        setPage: (number) => { pdf.setPage(number); },
        save: () => { blob = pdf.output("blob"); pages = pdf.getNumberOfPages(); },
      };
    };
    await new BrowserPdfExportAdapter(factory).downloadPdf({ source, filename: "synthetic-resume.pdf" });
    if (!blob) throw new Error("The browser did not produce PDF bytes.");
    const result: Blob = blob;
    const pdfjs = await import("pdfjs-dist");
    if (!pdfjs.GlobalWorkerOptions.workerSrc) pdfjs.GlobalWorkerOptions.workerSrc = pdfWorkerUrl;
    const task = pdfjs.getDocument({ data: new Uint8Array(await result.arrayBuffer()) });
    try {
      const pdf = await task.promise;
      const text: string[] = [];
      for (let number = 1; number <= pdf.numPages; number += 1) {
        const page = await pdf.getPage(number); const content = await page.getTextContent();
        text.push(content.items.map((item) => "str" in item ? item.str : "").join(" "));
      }
      if (normalized(text.join(" ")) !== normalized(documentText(documentValue, theme))) throw new Error("The generated PDF text does not match the saved document.");
    } finally { await task.destroy(); }
    const digest = await crypto.subtle.digest("SHA-256", await result.arrayBuffer());
    const sha256 = Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
    return { blob: result, pageCount: pages, sha256, layoutConflicts, layoutBoxes: [],
      layoutMetadata: { renderer: "browser_demo_capture", semanticFieldIds: documentLines(documentValue, theme).map((line) => line.id), positionalBoxesAvailable: false },
      textVerified: true as const };
  } finally { frame.remove(); }
}
