import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

const styleDir = dirname(fileURLToPath(import.meta.url));
const readStyle = (filename: string) =>
  readFileSync(resolve(styleDir, filename), "utf8");

const globalsCss = readStyle("globals.css");
const applyReviewCss = readStyle("redesign-apply-review.css");
const shellCss = readStyle("redesign-shell.css");

function rule(source: string, selector: string): string {
  const escapedSelector = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = source.match(new RegExp(`${escapedSelector}\\s*\\{([^}]*)\\}`));
  expect(match, `Missing CSS rule for ${selector}`).not.toBeNull();
  return match?.[1] ?? "";
}

describe("responsive editor and demo chrome contracts", () => {
  it("keeps every resume formatting control in the narrow editor flow", () => {
    const toolbar = rule(globalsCss, ".resume-format-toolbar");

    expect(toolbar).toContain("min-width: 0");
    expect(toolbar).toContain("max-width: 100%");
    expect(toolbar).toContain("flex-wrap: wrap");
    expect(globalsCss).toMatch(
      /\.resume-format-toolbar > \*,[\s\S]*?\.resume-format-select \[data-slot="select-trigger"\][\s\S]*?\{[^}]*min-inline-size: 0;[^}]*max-inline-size: 100%;/,
    );
    expect(globalsCss).toMatch(
      /@media \(max-width: 820px\)[\s\S]*?\.resume-link-popover-anchor\s*\{[^}]*position: static;[^}]*\}[\s\S]*?\.resume-link-popover\s*\{[^}]*inset-inline: 0;[^}]*grid-template-columns: minmax\(0, 1fr\) auto;[^}]*max-inline-size: 100%;/,
    );
  });

  it("contains the fixed A4 canvas in an intentional scroll surface", () => {
    const sharedScroll = rule(globalsCss, ".resume-plate-scroll");
    const reviewScroll = rule(
      applyReviewCss,
      ".apply-review-html-line-review .resume-plate-scroll",
    );

    expect(sharedScroll).toContain("min-inline-size: 0");
    expect(sharedScroll).toContain("max-inline-size: 100%");
    expect(sharedScroll).toContain("overflow: auto");
    expect(sharedScroll).toContain("overscroll-behavior: contain");
    expect(sharedScroll).toContain("scrollbar-gutter: stable");
    expect(reviewScroll).toContain("max-inline-size: 100%");
    expect(reviewScroll).toContain("overflow: auto");
    expect(
      rule(
        applyReviewCss,
        ".apply-review-html-line-review .resume-plate-toolbar",
      ),
    ).toContain("border-bottom: 1px solid var(--border)");
  });

  it("compacts demo disclosures without hiding their safety messages", () => {
    expect(globalsCss).toMatch(
      /@media \(max-width: 560px\)[\s\S]*?\.demo-workspace-notice__desktop-title,[\s\S]*?\.demo-receipt-latest__desktop-copy\s*\{[^}]*display: none;[^}]*\}[\s\S]*?\.demo-workspace-disclosure,[\s\S]*?\.demo-receipt-latest__disclosure\s*\{[^}]*display: block;/,
    );
    expect(globalsCss).toMatch(
      /\.demo-workspace-disclosure summary,[\s\S]*?\.demo-receipt-latest__disclosure summary\s*\{[^}]*min-block-size: 24px;/,
    );
  });

  it("bounds the guide and reserves clearance for its compact launcher", () => {
    expect(rule(shellCss, ".demo-guide-launcher")).toContain("position: fixed");
    expect(rule(shellCss, ".demo-guide-panel")).toContain(
      "max-height: calc(100dvh - 32px - env(safe-area-inset-bottom))",
    );
    expect(shellCss).toMatch(
      /html:has\(\.demo-guide-launcher\)\s*\{[^}]*scroll-padding-block-end:/,
    );
    expect(shellCss).toMatch(
      /\.main-shell:has\(\.demo-guide-launcher\) \.main\s*\{[^}]*padding-block-end:/,
    );
    expect(shellCss).toMatch(
      /@media \(max-width: 560px\)[\s\S]*?\.demo-guide-launcher__button\s*\{[^}]*inline-size: 36px;[^}]*\}[\s\S]*?\.demo-guide-launcher__label\s*\{[^}]*display: none;/,
    );
  });
});
