import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const styleDir = dirname(fileURLToPath(import.meta.url));
const configurationCss = readFileSync(
  resolve(styleDir, "redesign-configuration.css"),
  "utf8",
);
const detailSurfacesCss = readFileSync(
  resolve(styleDir, "redesign-detail-surfaces.css"),
  "utf8",
);

describe("Profile and Evidence Map responsive layout contracts", () => {
  it("reserves readable document width before stacking the Profile editor", () => {
    expect(configurationCss).toMatch(
      /\.profile-layout:not\(\.profile-layout-single\)\s*\{[\s\S]*?minmax\(818px, 1fr\);\s*\}/,
    );
    expect(configurationCss).toMatch(
      /\.profile-resume-plate-editor[\s\S]*?\.resume-plate-scroll\s*\{\s*padding: 8px;/,
    );
    expect(configurationCss).toMatch(
      /@media \(max-width: 1433px\)[\s\S]*?\.profile-layout:not\(\.profile-layout-single\)\s*\{\s*grid-template-columns: minmax\(0, 1fr\);/,
    );
    expect(configurationCss).toMatch(
      /@media \(max-width: 1433px\)[\s\S]*?> \.resume-editor-preview\s*\{[\s\S]*?position: static;[\s\S]*?width: 100%;[\s\S]*?scroll-margin-top: calc\(var\(--topbar-height\) \+ 32px\);/,
    );
  });

  it("stacks all Evidence Map panes before the compact rail reaches 1024px", () => {
    expect(detailSurfacesCss).toMatch(
      /@media \(max-width: 1180px\)\s*\{[\s\S]*?\.evidence-map-shell\s*\{\s*grid-template-columns: 1fr;/,
    );
    expect(detailSurfacesCss).toMatch(
      /@media \(max-width: 1180px\)[\s\S]*?\.evidence-entry-list,[\s\S]*?\.evidence-detail\s*\{[\s\S]*?border-bottom: 1px solid var\(--border\);/,
    );
  });
});
