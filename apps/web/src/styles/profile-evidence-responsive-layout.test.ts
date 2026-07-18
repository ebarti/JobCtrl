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
    expect(configurationCss).toMatch(
      /\.profile-layout \.editor-bulk-actions\s*\{[\s\S]*?flex-wrap: wrap;[\s\S]*?align-items: center;/,
    );
    expect(configurationCss).toMatch(
      /\.profile-layout \.editor-bulk-actions > \[role="status"\]\s*\{[\s\S]*?min-width: 0;[\s\S]*?overflow-wrap: anywhere;/,
    );
  });

  it("stacks all Evidence Map panes before the compact rail reaches 1024px", () => {
    expect(detailSurfacesCss).toMatch(
      /\.evidence-map-shell\s*\{[\s\S]*?grid-template-columns:[\s\S]*?minmax\(230px, 0\.74fr\)[\s\S]*?minmax\(0, 1\.45fr\)[\s\S]*?minmax\(250px, 0\.82fr\)[\s\S]*?block-size: min\([\s\S]*?overflow: hidden;/,
    );
    expect(detailSurfacesCss).toMatch(
      /\.evidence-entry-list,[\s\S]*?\.evidence-detail,[\s\S]*?\.evidence-side-panel\s*\{[\s\S]*?min-block-size: 0;[\s\S]*?overflow-y: auto;[\s\S]*?overscroll-behavior: contain;/,
    );
    expect(detailSurfacesCss).toMatch(
      /@media \(max-width: 1180px\)\s*\{[\s\S]*?\.evidence-map-shell\s*\{\s*grid-template-columns: 1fr;/,
    );
    expect(detailSurfacesCss).toMatch(
      /@media \(max-width: 1180px\)[\s\S]*?\.evidence-entry-list,[\s\S]*?\.evidence-detail\s*\{[\s\S]*?border-bottom: 1px solid var\(--border\);/,
    );
    expect(detailSurfacesCss).toMatch(
      /@media \(max-width: 1180px\)[\s\S]*?\.evidence-entry-list,[\s\S]*?\.evidence-detail,[\s\S]*?\.evidence-side-panel\s*\{[\s\S]*?overflow: visible;/,
    );
  });

  it("clamps evidence excerpts and preserves the small-screen technical-details reflow", () => {
    expect(detailSurfacesCss).toMatch(
      /\.evidence-usage-subject\[data-clamped="true"\],[\s\S]*?-webkit-line-clamp: 3;/,
    );
    expect(detailSurfacesCss).toMatch(
      /\.evidence-excerpt__content p,[\s\S]*?\.evidence-story dd,[\s\S]*?\.evidence-usage-subject,[\s\S]*?\.evidence-detail-technical-group\s*\{[\s\S]*?max-inline-size: 68ch;/,
    );
    expect(detailSurfacesCss).toMatch(
      /@media \(max-width: 620px\)[\s\S]*?\.evidence-technical-details__content dl > div\s*\{[\s\S]*?grid-template-columns: 1fr;/,
    );
  });
});
