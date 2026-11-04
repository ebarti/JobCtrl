import type { ResumeTemplateTheme } from "@jobctrl/contracts";
import type { CSSProperties } from "react";

export type TemplatePreviewStyle = CSSProperties & Record<`--${string}`, string | number>;

const FONT_STACKS: Record<ResumeTemplateTheme["fontFamily"], string> = {
  avenir: '"Avenir Next", "Helvetica Neue", Helvetica, Arial, sans-serif',
  aptos: '"Aptos", "Helvetica Neue", Helvetica, Arial, sans-serif',
  calibri: '"Calibri", "Aptos", Arial, sans-serif',
  cambria: '"Cambria", Georgia, "Times New Roman", serif',
  charter: '"Charter", "Bitstream Charter", Georgia, serif',
  garamond: '"EB Garamond", "Garamond", Georgia, serif',
  georgia: 'Georgia, "Times New Roman", Times, serif',
  helvetica: '"Helvetica Neue", Helvetica, Arial, sans-serif',
  inter: '"Inter", "Aptos", Arial, sans-serif',
  sans: '"Geist Variable", "Geist", ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif',
  serif: 'Georgia, "Times New Roman", Times, serif',
  source_sans: '"Source Sans 3", "Source Sans Pro", "Aptos", Arial, sans-serif',
  source_serif: '"Source Serif 4", "Source Serif Pro", Georgia, serif',
  system: 'system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif',
  times: '"Times New Roman", Times, serif',
};

// These values belong to the generated resume document, not application chrome.
// The visual-role contract keeps this bounded output-fidelity exception explicit.
const DENSITY_TOKENS: Record<
  ResumeTemplateTheme["density"],
  {
    readonly entryGapMm: number;
    readonly lineHeight: number;
    readonly listGapMm: number;
    readonly metaLineHeight: number;
    readonly sectionGapMm: number;
  }
> = {
  compact: {
    entryGapMm: 1.4,
    lineHeight: 1.2,
    listGapMm: 0.35,
    metaLineHeight: 1.12,
    sectionGapMm: 2.2,
  },
  balanced: {
    entryGapMm: 3.2,
    lineHeight: 1.32,
    listGapMm: 1.1,
    metaLineHeight: 1.22,
    sectionGapMm: 4.1,
  },
  spacious: {
    entryGapMm: 5.8,
    lineHeight: 1.48,
    listGapMm: 2.4,
    metaLineHeight: 1.34,
    sectionGapMm: 7.2,
  },
};

export function resumeTemplatePreviewStyle(theme: ResumeTemplateTheme): TemplatePreviewStyle {
  const density = DENSITY_TOKENS[theme.density];
  const scaledBodyFontSize = `${Number((10.35 * theme.fontScale).toFixed(3))}pt`;
  const headerTextAlign = theme.headerLayout === "centered" ? "center" : "left";
  const headerJustify = theme.headerLayout === "centered" ? "center" : "flex-start";
  const bodyAlign = theme.alignment === "justified" ? "justify" : "left";
  const pageInlineSize = theme.pageSize === "letter" ? "8.5in" : "210mm";
  const pageBlockSize = theme.pageSize === "letter" ? "11in" : "297mm";
  const headingRuleBorder = theme.sectionHeadingStyle === "rule" ? `0.45pt solid ${theme.accentColor}` : "none";
  const headingBoxBorder = theme.sectionHeadingStyle === "boxed" ? `0.45pt solid ${theme.accentColor}` : "0";
  return {
    "--resume-template-font-family": FONT_STACKS[theme.fontFamily],
    "--resume-template-body-font-size": scaledBodyFontSize,
    "--resume-template-contact-font-size": "8.8pt",
    "--resume-template-entry-meta-font-size": "8.9pt",
    "--resume-template-heading-font-size": "9.5pt",
    "--resume-template-name-font-size": "22pt",
    "--resume-template-accent": theme.accentColor,
    "--resume-template-page-padding": `${theme.marginMm.top}mm ${theme.marginMm.right}mm ${theme.marginMm.bottom}mm ${theme.marginMm.left}mm`,
    "--resume-template-page-inline-size": pageInlineSize,
    "--resume-template-page-block-size": pageBlockSize,
    "--resume-template-header-justify": headerJustify,
    "--resume-template-header-text-align": headerTextAlign,
    "--resume-template-body-align": bodyAlign,
    "--resume-template-heading-rule-border": headingRuleBorder,
    "--resume-template-heading-box-border": headingBoxBorder,
    "--resume-template-heading-padding": theme.sectionHeadingStyle === "boxed" ? "0.8mm 1.2mm" : "0",
    "--resume-template-line-height": density.lineHeight,
    "--resume-template-meta-line-height": density.metaLineHeight,
    "--resume-template-section-gap": `${density.sectionGapMm}mm`,
    "--resume-template-entry-gap": `${density.entryGapMm}mm`,
    "--resume-template-list-gap": `${density.listGapMm}mm`,
    "--resume-template-bullet-gap": `${bulletGap(theme.bulletSpacing)}mm`,
  };
}

function bulletGap(value: ResumeTemplateTheme["bulletSpacing"]): number {
  if (value === "tight") return 0.05;
  if (value === "loose") return 2.4;
  return 0.8;
}
