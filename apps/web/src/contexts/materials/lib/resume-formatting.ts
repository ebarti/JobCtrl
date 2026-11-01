// Plate formatting commands and document-preserving link transformations.
import {
  type ResumeEditorFontFamily,
  type ResumeEditorLegacyFontSize,
  type ResumePlateDomElement,
} from "./resume-editor-types.js";
import { type PlateEditor } from "platejs/react";
import {
  isRecord,
  isPlateDescendant,
  normalizeResumeLine,
  resumeTextFromPlateNode,
  normalizeResumePlateValue,
} from "./resume-document.js";
import { type PdfAuditLineSelection } from "../../../shared/ui/PdfPreviewViewer.js";
import { type Descendant, type Value } from "platejs";

export const RESUME_EDITOR_FONT_FAMILIES: readonly {
  readonly label: string;
  readonly value: ResumeEditorFontFamily;
}[] = [
  { label: "Resume", value: "resume" },
  { label: "Sans", value: "sans" },
  { label: "Serif", value: "serif" },
  { label: "System", value: "system" },
  { label: "Aptos", value: "aptos" },
  { label: "Avenir", value: "avenir" },
  { label: "Helvetica", value: "helvetica" },
  { label: "Inter", value: "inter" },
  { label: "Source Sans", value: "source_sans" },
  { label: "Calibri", value: "calibri" },
  { label: "Georgia", value: "georgia" },
  { label: "Garamond", value: "garamond" },
  { label: "Charter", value: "charter" },
  { label: "Source Serif", value: "source_serif" },
  { label: "Times New Roman", value: "times" },
  { label: "Cambria", value: "cambria" },
  { label: "Mono", value: "mono" },
];

export const RESUME_EDITOR_DEFAULT_SIZE_SCALE = 1;

const RESUME_EDITOR_MIN_SIZE_SCALE = 0.75;

const RESUME_EDITOR_MAX_SIZE_SCALE = 1.5;

const RESUME_EDITOR_SIZE_SCALE_STEP = 0.05;

export const RESUME_EDITOR_DEFAULT_SIZE_PERCENT =
  RESUME_EDITOR_DEFAULT_SIZE_SCALE * 100;

export const RESUME_EDITOR_MIN_SIZE_PERCENT =
  RESUME_EDITOR_MIN_SIZE_SCALE * 100;

export const RESUME_EDITOR_MAX_SIZE_PERCENT =
  RESUME_EDITOR_MAX_SIZE_SCALE * 100;

export const RESUME_EDITOR_SIZE_PERCENT_STEP =
  RESUME_EDITOR_SIZE_SCALE_STEP * 100;

export const RESUME_EDITOR_CHROME_SELECTOR =
  '[data-resume-editor-chrome="true"]';

export const RESUME_LINE_SELECTOR = "[data-resume-line-number]";

export const RESUME_EDITOR_FONT_FAMILY_STYLES: Record<
  ResumeEditorFontFamily,
  string | null
> = {
  avenir: '"Avenir Next", "Avenir", "Nunito Sans", sans-serif',
  aptos: '"Aptos", "Aptos Display", "Arial", sans-serif',
  calibri: '"Calibri", "Aptos", "Arial", sans-serif',
  cambria: '"Cambria", "Georgia", "Times New Roman", serif',
  charter: '"Charter", "Bitstream Charter", "Georgia", serif',
  garamond: '"EB Garamond", "Garamond", "Georgia", serif',
  georgia: '"Georgia", "Times New Roman", serif',
  helvetica: '"Helvetica Neue", "Helvetica", "Arial", sans-serif',
  inter: '"Inter", "Aptos", "Arial", sans-serif',
  mono: "ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace",
  resume: null,
  sans: '"Geist Variable", "Geist", ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif',
  serif: '"Charter", "Georgia", serif',
  source_sans:
    '"Source Sans 3", "Source Sans Pro", "Aptos", "Arial", sans-serif',
  source_serif: '"Source Serif 4", "Source Serif Pro", "Georgia", serif',
  system:
    'system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif',
  times: '"Times New Roman", "Times", serif',
};

export const RESUME_EDITOR_LEGACY_FONT_SIZE_STYLES: Record<
  ResumeEditorLegacyFontSize,
  string | null
> = {
  heading: "14pt",
  large: "12pt",
  resume: null,
  small: "9pt",
};

type ResumeFormattingEditor = PlateEditor & {
  readonly tf: PlateEditor["tf"] & {
    readonly bold?: { readonly toggle: () => void };
    readonly italic?: { readonly toggle: () => void };
    readonly unwrapNodes?: (options?: Record<string, unknown>) => void;
    readonly underline?: { readonly toggle: () => void };
    readonly wrapNodes?: (
      element: ResumePlateDomElement,
      options?: Record<string, unknown>,
    ) => void;
  };
};

function formattingEditor(editor: PlateEditor): ResumeFormattingEditor {
  return editor as ResumeFormattingEditor;
}

export function toggleEditorMark(
  editor: PlateEditor,
  mark: "bold" | "italic" | "underline",
): void {
  const typedEditor = formattingEditor(editor);
  typedEditor.tf.focus();
  typedEditor.tf[mark]?.toggle();
}

function isResumeLinkElement(node: unknown): boolean {
  return (
    isRecord(node) && node.type === "resume_inline" && node.tagName === "a"
  );
}

export function setEditorLink(editor: PlateEditor, href: string): void {
  const typedEditor = formattingEditor(editor);
  typedEditor.tf.focus();
  typedEditor.tf.unwrapNodes?.({
    match: isResumeLinkElement,
    split: true,
  });
  typedEditor.tf.wrapNodes?.(
    {
      type: "resume_inline",
      tagName: "a",
      href,
      children: [],
    },
    {
      split: true,
    },
  );
}

export function clearEditorLink(editor: PlateEditor): void {
  const typedEditor = formattingEditor(editor);
  typedEditor.tf.focus();
  typedEditor.tf.unwrapNodes?.({
    match: isResumeLinkElement,
    split: true,
  });
}

function resumeBlockLineNumber(node: unknown): number | null {
  if (!isRecord(node) || node.type !== "resume_block") return null;
  return typeof node.lineNumber === "number" ? node.lineNumber : null;
}

function resumeBlockText(node: Record<string, unknown>): string {
  return isPlateDescendant(node)
    ? normalizeResumeLine(resumeTextFromPlateNode(node))
    : "";
}

function resumeBlockMatchesLineSelection(
  node: unknown,
  selection: PdfAuditLineSelection | null | undefined,
): boolean {
  if (!isRecord(node) || node.type !== "resume_block") return false;
  const lineNumber = resumeBlockLineNumber(node);
  if (!selection) {
    return lineNumber !== null;
  }
  if (lineNumber !== null && selection.lineNumber === lineNumber) {
    return true;
  }
  if (selection.lineNumber !== null) {
    return false;
  }
  const selectionText = normalizeResumeLine(
    selection.resumeLineText || selection.text,
  );
  return Boolean(selectionText) && resumeBlockText(node) === selectionText;
}

function unwrapResumeLinks(children: readonly Descendant[]): Descendant[] {
  return children.flatMap((child): Descendant[] => {
    if ("text" in child) return [child];
    const childElement = child as ResumePlateDomElement;
    if (childElement.type === "resume_inline" && childElement.tagName === "a") {
      return unwrapResumeLinks(childElement.children);
    }
    return [
      {
        ...child,
        children: unwrapResumeLinks(childElement.children),
      },
    ];
  });
}

function wrapResumeChildrenInLink(
  children: readonly Descendant[],
  href: string,
): Descendant[] {
  const unwrapped = unwrapResumeLinks(children);
  if (!unwrapped.length) return unwrapped;
  return [
    {
      type: "resume_inline",
      tagName: "a",
      href,
      children: unwrapped,
    },
  ];
}

function linkResumePlateDescendant(
  node: Descendant,
  selectedLine: PdfAuditLineSelection | null | undefined,
  href: string | null,
  changed: { value: boolean },
): Descendant {
  if ("text" in node) return node;
  const element = node as ResumePlateDomElement;
  if (resumeBlockMatchesLineSelection(element, selectedLine)) {
    changed.value = true;
    return {
      ...node,
      children: href
        ? wrapResumeChildrenInLink(element.children, href)
        : unwrapResumeLinks(element.children),
    };
  }
  return {
    ...node,
    children: element.children.map((child) =>
      linkResumePlateDescendant(child, selectedLine, href, changed),
    ),
  };
}

export function linkSelectedResumeLine(
  value: Value | null,
  selectedLine: PdfAuditLineSelection | null | undefined,
  href: string | null,
): Value | null {
  if (!value || !selectedLine) return null;
  const changed = { value: false };
  const nextValue = value.map((node) =>
    linkResumePlateDescendant(node, selectedLine, href, changed),
  );
  return changed.value ? normalizeResumePlateValue(nextValue as Value) : null;
}

export function applyEditorBlockStyle(
  editor: PlateEditor,
  patch: Pick<ResumePlateDomElement, "fontFamily" | "fontSize" | "textAlign">,
  selectedLine: PdfAuditLineSelection | null | undefined,
): void {
  editor.tf.focus();
  editor.tf.setNodes(patch, {
    at: [],
    match: (node: unknown) =>
      resumeBlockMatchesLineSelection(node, selectedLine),
  });
}
