// Mechanical HTML/Plate transforms and recorded identity projection. No source inference.
import {
  type PdfAuditLineSelection,
  type PdfAuditLineTarget,
} from "../../../shared/ui/PdfPreviewViewer.js";
import {
  type ResumeLineEntry,
  type ResumePlateSemanticTextChange,
  type ResumePlateLine,
} from "./resume-editor-types.js";
import { type Descendant, type Value } from "platejs";
import { type ResumeLayoutBox } from "@jobctrl/contracts";

const RENDERED_RESUME_SECTION_HEADINGS = new Set([
  "certifications",
  "core skills",
  "education",
  "executive profile",
  "experience",
  "languages",
  "professional profile",
  "profile",
  "projects",
  "skills",
  "summary",
  "technical skills",
]);

export const RESUME_PLATE_BLOCK_TAGS = new Set([
  "article",
  "div",
  "h1",
  "h2",
  "h3",
  "header",
  "li",
  "main",
  "p",
  "section",
  "ul",
]);

export const RESUME_PLATE_INLINE_TAGS = new Set(["a", "b", "span", "strong"]);

const RESUME_PLATE_DISCARDED_TAGS = new Set([
  "iframe",
  "noscript",
  "script",
  "style",
  "template",
]);

const RESUME_PLATE_BLOCK_CLASS_TOKENS = new Set([
  "resume-entry-company",
  "resume-entry-date",
  "resume-entry-location",
  "resume-entry-main",
  "resume-entry-row",
  "resume-entry-title",
]);

const RESUME_PLATE_GRID_CONTAINER_CLASS_TOKENS = new Set([
  "resume-entry-heading",
  "resume-entry-row",
]);

export function normalizeResumeLine(value: string): string {
  return value
    .replace(/^[-•○]\s+/, "")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

function lineLabelForSelection(selection: PdfAuditLineSelection): string {
  return `Resume page ${selection.pageNumber} line ${selection.pageLineIndex}`;
}

function lineKindForText(
  text: string,
  index: number,
  firstContentLine: boolean,
): ResumeLineEntry["kind"] {
  const lower = text.toLowerCase();
  return firstContentLine
    ? "name"
    : RENDERED_RESUME_SECTION_HEADINGS.has(lower)
      ? "section"
      : index < 4 && /(@|https?:\/\/|linkedin|github|\+\d|\|)/i.test(text)
        ? "contact"
        : /^[-•○]\s+/.test(text)
          ? "bullet"
          : /(\b(?:jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\.?\s+\d{4}\b|\b\d{4}\b|\s\|\s)/i.test(
                text,
              )
            ? "metadata"
            : "body";
}

export function resumeLinesFromText(
  resumeText: string | null | undefined,
): ResumeLineEntry[] {
  let firstContentLine = true;
  const lines: ResumeLineEntry[] = [];
  (resumeText ?? "").split(/\r?\n/).forEach((line, index) => {
    const text = line.trim();
    if (!text) return;
    const kind = lineKindForText(text, index, firstContentLine);
    firstContentLine = false;
    lines.push({
      lineNumber: index + 1,
      text,
      kind,
    });
  });
  return lines;
}

const RESUME_HTML_LINE_SELECTOR = "[data-resume-line-number]";

function parsePositiveInteger(value: string | null): number | null {
  if (!value) return null;
  const parsed = Number.parseInt(value, 10);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : null;
}

function cleanRenderedText(value: string | null | undefined): string {
  return (value ?? "").replace(/\s+/g, " ").trim();
}

function resumePlateTextNode(text: string): Descendant | null {
  const clean = text.replace(/\s+/g, " ");
  if (!clean.trim()) return null;
  return { text: clean };
}

function hasAnyResumeClass(
  className: string | null | undefined,
  tokens: ReadonlySet<string>,
): boolean {
  const classes = (className ?? "").split(/\s+/);
  return classes.some((token) => tokens.has(token));
}

function shouldRenderResumeElementAsBlock(
  tagName: string,
  className: string | null | undefined,
): boolean {
  return (
    RESUME_PLATE_BLOCK_TAGS.has(tagName) ||
    hasAnyResumeClass(className, RESUME_PLATE_BLOCK_CLASS_TOKENS)
  );
}

function normalizeResumePlateChildren(
  children: readonly Descendant[],
  parentClassName: string | null | undefined,
): Descendant[] {
  const normalized = children
    .map(normalizeResumePlateDescendant)
    .filter((node): node is Descendant => Boolean(node));
  if (
    !hasAnyResumeClass(
      parentClassName,
      RESUME_PLATE_GRID_CONTAINER_CLASS_TOKENS,
    )
  ) {
    return normalized.length ? normalized : [{ text: "" }];
  }
  const withoutEmptyGridLeaves = normalized.filter(
    (node) =>
      !("text" in node) ||
      (typeof node.text === "string" && node.text.trim().length > 0),
  );
  return withoutEmptyGridLeaves.length
    ? withoutEmptyGridLeaves
    : [{ text: "" }];
}

function normalizeResumePlateDescendant(node: Descendant): Descendant | null {
  if ("text" in node) {
    return node;
  }
  const className =
    typeof node.className === "string" ? node.className : undefined;
  const tagName = typeof node.tagName === "string" ? node.tagName : "div";
  const normalizedType = shouldRenderResumeElementAsBlock(tagName, className)
    ? "resume_block"
    : "resume_inline";
  const normalizedTagName = hasAnyResumeClass(
    className,
    RESUME_PLATE_BLOCK_CLASS_TOKENS,
  )
    ? "div"
    : tagName;
  return {
    ...node,
    children: normalizeResumePlateChildren(node.children, className),
    tagName: normalizedTagName,
    type: normalizedType,
  };
}

export function normalizeResumePlateValue(value: Value): Value {
  const normalized = value
    .map(normalizeResumePlateDescendant)
    .filter((node): node is Descendant & { children: Descendant[] } =>
      Boolean(node && "children" in node),
    );
  return normalized.length
    ? (normalized as Value)
    : [
        {
          type: "resume_block",
          tagName: "main",
          className: "resume-page",
          children: [{ text: "" }],
        },
      ];
}

function resumePlateChildrenFromDom(element: Element): Descendant[] {
  const children = Array.from(element.childNodes)
    .map((node) => resumePlateNodeFromDom(node))
    .filter((node): node is Descendant => Boolean(node));
  return normalizeResumePlateChildren(children, element.getAttribute("class"));
}

function resumePlateNodeFromDom(node: Node): Descendant | null {
  if (node.nodeType === Node.TEXT_NODE) {
    if (node.parentElement?.hasAttribute("data-resume-profile-separator"))
      return { text: node.textContent ?? "" };
    return resumePlateTextNode(node.textContent ?? "");
  }
  if (!(node instanceof HTMLElement)) return null;
  const tagName = node.tagName.toLowerCase();
  if (RESUME_PLATE_DISCARDED_TAGS.has(tagName)) return null;
  const className = resumePlateClassNameFromDom(node);
  const isBlock = shouldRenderResumeElementAsBlock(tagName, className);
  const isInline = !isBlock && RESUME_PLATE_INLINE_TAGS.has(tagName);
  if (!isBlock && !isInline) {
    return resumePlateTextNode(cleanRenderedText(node.textContent));
  }
  return {
    children: resumePlateChildrenFromDom(node),
    className,
    href:
      tagName === "a" ? safeResumeHref(node.getAttribute("href")) : undefined,
    lineNumber:
      parsePositiveInteger(node.getAttribute("data-resume-line-number")) ??
      undefined,
    pageNumber:
      parsePositiveInteger(node.getAttribute("data-resume-page")) ?? undefined,
    semanticId: node.getAttribute("data-resume-layout-target") || null,
    profileField: node.getAttribute("data-resume-profile-field"),
    profileSource: node.getAttribute("data-resume-profile-source"),
    tagName: hasAnyResumeClass(className, RESUME_PLATE_BLOCK_CLASS_TOKENS)
      ? "div"
      : tagName,
    type: isInline ? "resume_inline" : "resume_block",
  };
}

function resumePlateClassNameFromDom(node: HTMLElement): string | undefined {
  const className = node.getAttribute("class")?.trim();
  if (!className) return undefined;
  const tokens = className
    .split(/\s+/)
    .map((token) => (token === "resume-document" ? "resume-page" : token));
  return [...new Set(tokens)].join(" ");
}

export function safeResumeHref(value: string | null): string | undefined {
  const href = value?.trim();
  if (!href) return undefined;
  return /^(?:https?:|mailto:|tel:)/i.test(href) ? href : undefined;
}

export function normalizeResumeHrefInput(value: string): string | null {
  const trimmed = value.trim();
  if (!trimmed) return null;
  const explicit = safeResumeHref(trimmed);
  if (explicit) return explicit;
  if (/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(trimmed)) {
    return `mailto:${trimmed}`;
  }
  if (/^(?:www\.|[a-z0-9-]+(?:\.[a-z0-9-]+)+)(?:[/?#].*)?$/i.test(trimmed)) {
    return `https://${trimmed}`;
  }
  return null;
}

export function resumePlateValueFromHtml(html: string): Value {
  if (typeof DOMParser === "undefined") {
    return [
      {
        type: "resume_block",
        tagName: "main",
        className: "resume-page",
        children: [{ text: "" }],
      },
    ];
  }
  const doc = new DOMParser().parseFromString(html, "text/html");
  const page = doc.querySelector<HTMLElement>(".resume-page");
  const nodes = Array.from(
    (page ? [page] : Array.from(doc.body.children)) as Iterable<Element>,
  )
    .map((node) => resumePlateNodeFromDom(node))
    .filter((node): node is Descendant & { children: Descendant[] } =>
      Boolean(node && "children" in node),
    );
  return nodes.length
    ? normalizeResumePlateValue(nodes as Value)
    : [
        {
          type: "resume_block",
          tagName: "main",
          className: "resume-page",
          children: [{ text: "" }],
        },
      ];
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

export function isPlateDescendant(value: unknown): value is Descendant {
  if (!isRecord(value)) return false;
  if (typeof value.text === "string") return true;
  return (
    Array.isArray(value.children) && value.children.every(isPlateDescendant)
  );
}

export function isPlateValue(value: unknown): value is Value {
  return Array.isArray(value) && value.every(isPlateDescendant);
}

export function resumeTextFromPlateNode(node: Descendant): string {
  if ("text" in node) {
    return typeof node.text === "string" ? node.text : "";
  }
  const children =
    "children" in node && Array.isArray(node.children) ? node.children : [];
  return children
    .map(resumeTextFromPlateNode)
    .join(" ")
    .replace(/\s+/g, " ")
    .trim();
}

function rawResumeTextFromPlateNode(node: Descendant): string {
  if ("text" in node) {
    return typeof node.text === "string" ? node.text : "";
  }
  return node.children
    .map((child) => {
      const text = rawResumeTextFromPlateNode(child);
      return "text" in child || child.type !== "resume_block"
        ? text
        : `\n${text}\n`;
    })
    .join("");
}

function resumeSemanticTextsFromPlateNode(node: Descendant): readonly string[] {
  const texts = rawResumeTextFromPlateNode(node)
    .split(/\r?\n/u)
    .map((text) => text.replace(/\s+/g, " ").trim());
  return texts.length > 0 ? texts : [""];
}

function resumeBulletSemanticId(node: Descendant): string {
  if ("text" in node || typeof node.semanticId !== "string") return "";
  const semanticId = node.semanticId.trim();
  // Baseline previews use canonical field paths; generated artifacts use
  // recorded anchor IDs. Both are current structural ID contracts.
  return /^(?:experience:.+:bullet:[1-9]\d*|experience:.+#\d+)$/u.test(
    semanticId,
  )
    ? semanticId
    : "";
}

function isResumeBulletContainer(node: Descendant): boolean {
  if ("text" in node || typeof node.className !== "string") return false;
  return node.className.split(/\s+/u).includes("resume-bullets");
}

export function resumeTextFromPlateValue(value: Value): string {
  const lines = value
    .flatMap(resumeLineTextsFromPlateNode)
    .map((line) => line.replace(/\s+/g, " ").trim())
    .filter(Boolean);
  if (lines.length) {
    return lines.join("\n");
  }
  return value
    .map(resumeTextFromPlateNode)
    .map((line) => line.replace(/\s+/g, " ").trim())
    .filter(Boolean)
    .join("\n");
}

function resumeSemanticTextSnapshotFromPlateValue(
  value: Value,
): ReadonlyMap<string, readonly string[]> {
  const textsBySemanticId = new Map<string, string[]>();

  const append = (semanticId: string, node: Descendant): void => {
    const texts = textsBySemanticId.get(semanticId) ?? [];
    texts.push(...resumeSemanticTextsFromPlateNode(node));
    textsBySemanticId.set(semanticId, texts);
  };
  const hasProfileField = (node: Descendant): boolean => {
    if ("text" in node) return false;
    return (
      typeof node.profileField === "string" ||
      node.children.some(hasProfileField)
    );
  };

  const visit = (node: Descendant): void => {
    if ("text" in node) return;
    if (isResumeBulletContainer(node)) {
      let previousSemanticId = "";
      node.children.forEach((child, index) => {
        if ("text" in child) return;
        const ownSemanticId = resumeBulletSemanticId(child);
        const nextSemanticId = node.children
          .slice(index + 1)
          .map(resumeBulletSemanticId)
          .find(Boolean);
        const semanticId =
          ownSemanticId || previousSemanticId || nextSemanticId || "";
        if (semanticId) append(semanticId, child);
        if (ownSemanticId) previousSemanticId = ownSemanticId;
      });
      return;
    }
    const fieldId =
      typeof node.profileField === "string" ? node.profileField : "";
    const semanticId =
      fieldId ||
      (typeof node.semanticId === "string" ? node.semanticId.trim() : "");
    if (semanticId && (fieldId || !node.children.some(hasProfileField))) {
      append(semanticId, node);
    }
    node.children.forEach(visit);
  };

  value.forEach(visit);
  return textsBySemanticId;
}

export function resumeSemanticTextChangesFromPlateValues(
  baselineValue: Value,
  plateValue: Value,
): readonly ResumePlateSemanticTextChange[] {
  const baseline = resumeSemanticTextSnapshotFromPlateValue(baselineValue);
  const current = resumeSemanticTextSnapshotFromPlateValue(plateValue);
  const semanticIds = new Set([...baseline.keys(), ...current.keys()]);
  const profileSources = new Map<string, string[]>();
  const collectSources = (node: Descendant): void => {
    if ("text" in node) return;
    if (
      typeof node.profileField === "string" &&
      typeof node.profileSource === "string"
    ) {
      profileSources.set(node.profileField, [
        ...(profileSources.get(node.profileField) ?? []),
        node.profileSource,
      ]);
    }
    node.children.forEach(collectSources);
  };
  baselineValue.forEach(collectSources);

  return Array.from(semanticIds).flatMap((semanticId) => {
    const baselineTexts = baseline.get(semanticId) ?? [];
    const plateTexts = current.get(semanticId) ?? [];
    if (
      baselineTexts.length === plateTexts.length &&
      baselineTexts.every((text, index) => text === plateTexts[index])
    ) {
      return [];
    }
    return [
      {
        semanticId,
        baselineTexts: profileSources.get(semanticId) ?? baselineTexts,
        plateTexts,
      },
    ];
  });
}

function resumeLineTextsFromPlateNode(node: Descendant): string[] {
  if ("text" in node) return [];
  if (typeof node.lineNumber === "number") {
    const text = resumeTextFromPlateNode(node).replace(/\s+/g, " ").trim();
    return text ? [text] : [];
  }
  return node.children.flatMap(resumeLineTextsFromPlateNode);
}

export function resumePlateValueSignature(value: Value | null): string {
  return value ? JSON.stringify(value) : "";
}

function kindForHtmlElement(
  element: HTMLElement,
  index: number,
  text: string,
): ResumeLineEntry["kind"] {
  const className = element.getAttribute("class") ?? "";
  const tagName = element.tagName.toLowerCase();
  if (className.includes("resume-name") || tagName === "h1") return "name";
  if (className.includes("resume-contact")) return "contact";
  if (tagName === "h2") return "section";
  if (tagName === "li") return "bullet";
  if (
    className.includes("resume-meta") ||
    className.includes("resume-entry-title") ||
    tagName === "h3"
  ) {
    return "metadata";
  }
  return lineKindForText(text, index, index === 0);
}

function plateTagForKind(
  kind: ResumeLineEntry["kind"],
): ResumePlateLine["tagName"] {
  if (kind === "name") return "h1";
  if (kind === "section") return "h2";
  if (kind === "metadata") return "h3";
  return "div";
}

export function resumeClassForLineKind(kind: ResumeLineEntry["kind"]): string {
  if (kind === "name") return "resume-name";
  if (kind === "contact") return "resume-contact";
  if (kind === "section") return "resume-section-title";
  if (kind === "metadata") return "resume-meta";
  return "resume-line";
}

function layoutBoxForLine(
  line: {
    readonly lineNumber?: number | null | undefined;
    readonly semanticId?: string | null | undefined;
    readonly text: string;
  },
  layoutBoxes: readonly ResumeLayoutBox[],
): ResumeLayoutBox | null {
  if (line.lineNumber) {
    const byNumber = layoutBoxes.find(
      (box) => box.lineNumber === line.lineNumber,
    );
    if (byNumber) return byNumber;
  }
  if (line.semanticId) {
    const byId = layoutBoxes.find((box) => box.semanticId === line.semanticId);
    if (byId) return byId;
  }
  return null;
}

export function resumePlateLinesFromHtml(
  html: string,
  layoutBoxes: readonly ResumeLayoutBox[],
): ResumePlateLine[] {
  if (typeof DOMParser === "undefined") return [];
  const doc = new DOMParser().parseFromString(html, "text/html");
  const page = doc.querySelector<HTMLElement>(".resume-page") ?? doc.body;
  if (!page) return [];
  return Array.from(
    page.querySelectorAll<HTMLElement>(RESUME_HTML_LINE_SELECTOR),
  )
    .map((element, index): ResumePlateLine | null => {
      const text = cleanRenderedText(element.textContent);
      if (!text) return null;
      const lineNumber =
        parsePositiveInteger(element.getAttribute("data-resume-line-number")) ??
        undefined;
      const kind = kindForHtmlElement(element, index, text);
      const semanticId =
        element.getAttribute("data-resume-layout-target") ||
        (kind === "section" ? `section:${normalizeResumeLine(text)}` : null);
      const provisionalLine = { lineNumber, semanticId, text };
      const layoutBox = layoutBoxForLine(provisionalLine, layoutBoxes);
      const pageNumber =
        layoutBox?.pageNumber ??
        parsePositiveInteger(
          element
            .closest<HTMLElement>("[data-resume-page]")
            ?.getAttribute("data-resume-page") ?? null,
        ) ??
        1;
      const id = lineNumber
        ? `resume:${lineNumber}`
        : `html:${semanticId ?? index}:${normalizeResumeLine(text)}`;
      return {
        id,
        className: element.getAttribute("class") ?? "",
        kind,
        lineLabel: lineNumber
          ? undefined
          : kind === "section"
            ? `Section: ${text}`
            : `Rendered line ${index + 1}`,
        lineNumber,
        pageNumber,
        semanticId,
        profileField: element.getAttribute("data-resume-profile-field"),
        tagName: plateTagForKind(kind),
        text,
      };
    })
    .filter((line): line is ResumePlateLine => Boolean(line));
}

function resumePlateLinesFromText(
  resumeText: string | null | undefined,
  lineTargets: readonly PdfAuditLineTarget[],
): ResumePlateLine[] {
  const targets = lineTargets.length
    ? lineTargets
    : resumeLineTargetsFromText(resumeText);
  let firstContentLine = true;
  return targets.map((target, index) => {
    const kind = lineKindForText(target.text.trim(), index, firstContentLine);
    firstContentLine = false;
    return {
      id: `resume:${target.lineNumber}`,
      className: kind === "bullet" ? "resume-line" : "",
      kind,
      lineNumber: target.lineNumber,
      pageNumber: 1,
      semanticId: null,
      tagName: plateTagForKind(kind),
      text: target.text.trim(),
    };
  });
}

function resumeLineTargetsFromText(
  resumeText: string | null | undefined,
): PdfAuditLineTarget[] {
  return (resumeText ?? "")
    .split(/\r?\n/)
    .map((line, index) => ({
      lineNumber: index + 1,
      text: line.replace(/\t/g, "  ").trimEnd(),
    }))
    .filter((line) => line.text.trim().length > 0);
}

export function selectionFromPlateLine(
  line: ResumePlateLine,
  index: number,
  layoutBoxes: readonly ResumeLayoutBox[],
): PdfAuditLineSelection {
  const layoutBox = layoutBoxForLine(line, layoutBoxes);
  const lineNumber = line.lineNumber ?? layoutBox?.lineNumber ?? null;
  return {
    lineKey: lineNumber
      ? `resume:${lineNumber}`
      : `html:${line.semanticId ?? index}:${normalizeResumeLine(line.text)}`,
    lineNumber,
    pageLineIndex: lineNumber ?? index + 1,
    pageNumber: layoutBox?.pageNumber ?? line.pageNumber,
    resumeLineText: line.text,
    text: line.text,
  };
}

export function resumeLineFromPdfSelection(
  selection: PdfAuditLineSelection,
): ResumeLineEntry {
  const text = selection.resumeLineText || selection.text;
  return {
    kind: lineKindForText(text, 999, false),
    lineLabel: lineLabelForSelection(selection),
    lineNumber: selection.lineNumber ?? undefined,
    text,
  };
}

export function selectedLineMatchesElement(
  selectedLine: PdfAuditLineSelection | null | undefined,
  line: ResumePlateLine,
  index: number,
): boolean {
  if (!selectedLine) return false;
  if (
    line.lineNumber !== undefined &&
    selectedLine.lineNumber === line.lineNumber
  ) {
    return true;
  }
  if (selectedLine.lineNumber !== null) {
    return false;
  }
  return (
    selectedLine.lineKey ===
    `html:${line.semanticId ?? index}:${normalizeResumeLine(line.text)}`
  );
}
