import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

const styleDir = resolve(process.cwd(), "src/styles");
const applyReviewCss = readFileSync(
  resolve(styleDir, "redesign-apply-review.css"),
  "utf8",
);
const dataCss = readFileSync(resolve(styleDir, "redesign-data.css"), "utf8");

function rule(source: string, selector: string): string {
  const escapedSelector = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = source.match(new RegExp(`${escapedSelector}\\s*\\{([^}]*)\\}`));
  expect(match, `Missing CSS rule for ${selector}`).not.toBeNull();
  return match?.[1] ?? "";
}

describe("Apply Review and Contacts responsive layout contracts", () => {
  it("wraps every review decision without changing the desktop or mobile queue model", () => {
    const shell = rule(applyReviewCss, ".apply-review-shell");
    const decisions = rule(applyReviewCss, ".apply-review-decision-buttons");

    expect(shell).toContain(
      "grid-template-columns: minmax(236px, 278px) minmax(0, 1fr)",
    );
    expect(decisions).toContain("flex-wrap: wrap");
    expect(decisions).toContain("overflow-x: visible");
    expect(decisions).not.toContain("flex-wrap: nowrap");
    expect(decisions).not.toContain("overflow-x: auto");
    expect(applyReviewCss).toMatch(
      /@container apply-review-surface \(max-width: 52rem\)[\s\S]*?\.apply-review-shell\s*\{\s*grid-template-columns: minmax\(0, 1fr\);/,
    );
    expect(applyReviewCss).toMatch(
      /@container apply-review-surface \(max-width: 52rem\)[\s\S]*?\.apply-review-queue-list\s*\{[\s\S]*?grid-auto-flow: column;[\s\S]*?overflow-x: auto;/,
    );
  });

  it("pads the Contacts follow-up body at desktop and mobile widths", () => {
    const content = rule(dataCss, ".outreach-due-follow-ups-content");

    expect(content).toContain("display: grid");
    expect(content).toContain("padding: 16px 20px 20px");
    expect(dataCss).toMatch(
      /@media \(max-width: 720px\)[\s\S]*?\.outreach-due-follow-ups-content\s*\{\s*padding: 12px 16px 16px;/,
    );
  });
});
