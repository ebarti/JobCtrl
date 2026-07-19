import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const styleDir = dirname(fileURLToPath(import.meta.url));
const webRoot = resolve(styleDir, "../..");
const repoRoot = resolve(webRoot, "../..");
const globalsCss = readFileSync(resolve(repoRoot, "apps/web/src/styles/globals.css"), "utf8");

const escapeRegExp = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, String.raw`\$&`);
const cssRuleContaining = (selector: string): string => {
  const pattern = new RegExp(`[^{}]*${escapeRegExp(selector)}[^{}]*\\{(?<body>[^}]*)\\}`, "m");
  const match = globalsCss.match(pattern);
  return match?.groups?.body?.trim() ?? "";
};

describe("resume preview style contract", () => {
  it("falls back to the canonical rendered resume when no theme variables are supplied", () => {
    const unguardedTemplateVariables = [
      ...globalsCss.matchAll(/var\(--resume-template-(?!default-)([a-z-]+)\)/g),
    ].map((match) => match[1]);

    expect(unguardedTemplateVariables).toEqual([]);
    expect(globalsCss).toContain(
      '--resume-template-default-font-family: "Geist Variable", "Geist", ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;',
    );
    expect(globalsCss).toContain(
      "--resume-template-default-body-font-size: 10.35pt;",
    );
    expect(globalsCss).toContain(
      "padding: var(--resume-template-page-padding, var(--resume-template-default-page-padding));",
    );
    expect(globalsCss).toContain(
      "font-size: var(--resume-template-name-font-size, var(--resume-template-default-name-font-size));",
    );
    expect(globalsCss).toContain(
      "border-block-start: var(--resume-template-heading-rule-border, var(--resume-template-default-heading-rule-border));",
    );
  });

  it("keeps JobCtrl comment markers outside the resume line layout", () => {
    const lineRule = cssRuleContaining(".resume-plate-document [data-resume-line-number].has-jobctrl-comment");
    const markerRule = cssRuleContaining(".resume-plate-document [data-resume-line-number].has-jobctrl-comment::before");

    expect(lineRule, "line marker class must not shift final-PDF text geometry").not.toMatch(
      /\b(?:padding|margin|border-inline|border-left)\b/i,
    );
    expect(markerRule).toContain("position: absolute;");
    expect(markerRule).toContain("inset-inline-start: -5px;");
    expect(markerRule).toContain("pointer-events: none;");
  });

  it("preserves printed resume bullet markers inside the Plate preview", () => {
    const listRule = cssRuleContaining(".resume-plate-document .resume-bullets");
    const itemRule = cssRuleContaining(".resume-plate-document .resume-bullets li");

    expect(listRule).toContain("list-style: disc outside;");
    expect(itemRule).toContain("display: list-item;");
    expect(itemRule).toContain("list-style: disc outside;");
  });

  it("preserves moderncv-style contact and experience layout in the Plate preview", () => {
    const contactRule = cssRuleContaining(".resume-plate-document .resume-contact-items");
    const contactItemRule = cssRuleContaining(".resume-plate-document .resume-contact-item");
    const entryHeadingRule = cssRuleContaining(".resume-plate-document .resume-entry-heading");
    const entryRowRule = cssRuleContaining(".resume-plate-document .resume-entry-row");
    const titleRule = cssRuleContaining(".resume-plate-document .resume-entry-title");

    expect(contactRule).toContain("display: inline-flex;");
    expect(contactRule).toContain(
      "justify-content: var(--resume-template-header-justify, var(--resume-template-default-header-justify));",
    );
    expect(contactItemRule).toContain("display: inline-flex;");
    expect(entryHeadingRule).toContain("display: grid;");
    expect(entryRowRule).toContain("grid-template-columns: minmax(0, 1fr) max-content;");
    expect(titleRule).toContain("font-style: italic;");
    expect(globalsCss).toContain(
      ".resume-plate-document .resume-entry-location {\n  color: var(--resume-template-accent, var(--resume-template-default-accent));\n  text-align: end;",
    );
  });
});
