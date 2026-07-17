import { readFileSync, readdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const styleDir = dirname(fileURLToPath(import.meta.url));
const readStyle = (filename: string) =>
  readFileSync(resolve(styleDir, filename), "utf8");
const activeRedesignStyles = readdirSync(styleDir).filter(
  (filename) => filename.startsWith("redesign-") && filename.endsWith(".css"),
);
const activeApplicationStyles = ["globals.css", ...activeRedesignStyles];
const documentTypographySelectors = [
  ".pdf-preview-page",
  ".pdf-preview-canvas",
  ".resume-template-document",
  ".resume-plate-document",
  ".resume-preview-document",
] as const;
const sharedUiDir = resolve(styleDir, "../shared/ui");
const activeSharedUiSources = readdirSync(sharedUiDir)
  .filter(
    (filename) =>
      filename.endsWith(".tsx") &&
      !filename.includes(".test.") &&
      !filename.includes(".stories."),
  )
  .map((filename) => ({
    filename,
    source: readFileSync(resolve(sharedUiDir, filename), "utf8"),
  }));

const tokensCss = readStyle("tokens.css");
const commonCss = readStyle("redesign-common.css");
const shellCss = readStyle("redesign-shell.css");
const workspaceCss = readStyle("redesign-route-workspaces.css");
const pipelinesCss = readStyle("redesign-pipelines.css");

describe("shared typography and layout contract", () => {
  it("keeps the core type scale readable and independent from density", () => {
    expect(tokensCss).toContain("--jh-font-size-caption: 0.8125rem;");
    expect(tokensCss).toContain("--jh-font-size-code: 0.875rem;");
    expect(tokensCss).toContain("--jh-font-size-body-sm: 0.9375rem;");
    expect(tokensCss).toContain("--jh-font-size-body: 1rem;");
    expect(tokensCss).toContain("--jh-font-size-heading-sm: 1.0625rem;");
    expect(tokensCss).toContain("font-size: var(--jh-font-size-body);");

    const compactRule = tokensCss.match(
      /:where\(\.app-shell\[data-density="compact"\]\)\s*\{(?<body>[^}]*)\}/m,
    );
    const comfyRule = tokensCss.match(
      /:where\(\.app-shell\[data-density="comfy"\]\)\s*\{(?<body>[^}]*)\}/m,
    );

    expect(compactRule?.groups?.["body"]).not.toContain("font-size:");
    expect(comfyRule?.groups?.["body"]).not.toContain("font-size:");
  });

  it("keeps active route typography on semantic tokens above the product floor", () => {
    const undersized: string[] = [];

    for (const filename of activeApplicationStyles) {
      const css = readStyle(filename);
      for (const match of css.matchAll(
        /(?<selector>[^{}]+)\{(?<body>[^{}]*)\}/g,
      )) {
        const selector = match.groups?.["selector"]?.trim() ?? "";
        if (
          documentTypographySelectors.some((allowed) =>
            selector.includes(allowed),
          )
        ) {
          continue;
        }

        const body = match.groups?.["body"] ?? "";
        for (const size of body.matchAll(
          /font-size:\s*(?<value>\d*\.?\d+)(?<unit>px|rem|em)\s*;/g,
        )) {
          const value = Number(size.groups?.["value"]);
          const unit = size.groups?.["unit"];
          if (
            (unit === "px" && value < 15) ||
            (unit === "rem" && value < 0.9375) ||
            (unit === "em" && value < 1)
          ) {
            undersized.push(`${filename}: ${selector} uses ${value}${unit}`);
          }
        }
      }
    }

    expect(undersized).toEqual([]);
    expect(readStyle("globals.css")).toMatch(
      /small\s*\{[^}]*font-size: var\(--jh-font-size-body-sm\);/s,
    );
    expect(readStyle("globals.css")).toMatch(
      /\.field-hint\s*\{[^}]*font-size: var\(--jh-font-size-body-sm\);/s,
    );
    expect(readStyle("globals.css")).toMatch(
      /\.provider-choice small,[\s\S]*?\.provider-field \.field-hint\s*\{[^}]*font-size: var\(--jh-font-size-body-sm\);/s,
    );
    expect(commonCss).toMatch(
      /\.field-hint,[\s\S]*?\.field \.meta,[\s\S]*?\.field small\s*\{[^}]*color: var\(--muted-foreground\);[^}]*font-weight: 400;/s,
    );
  });

  it("keeps the document typography exception list explicit and narrow", () => {
    expect(documentTypographySelectors).toEqual([
      ".pdf-preview-page",
      ".pdf-preview-canvas",
      ".resume-template-document",
      ".resume-plate-document",
      ".resume-preview-document",
    ]);

    const globalsCss = readStyle("globals.css");
    const exceptionRules = [
      ...globalsCss.matchAll(/(?<selector>[^{}]+)\{(?<body>[^{}]*)\}/g),
    ].flatMap((match) => {
      const selector = match.groups?.["selector"]?.trim() ?? "";
      if (
        !documentTypographySelectors.some((allowed) =>
          selector.includes(allowed),
        )
      ) {
        return [];
      }

      return [
        ...(match.groups?.["body"] ?? "").matchAll(
          /font-size:\s*(?<value>\d*\.?\d+)(?<unit>px|rem|em)\s*;/g,
        ),
      ].flatMap((size) => {
        const value = Number(size.groups?.["value"]);
        const unit = size.groups?.["unit"];
        const belowFloor =
          (unit === "px" && value < 15) ||
          (unit === "rem" && value < 0.9375) ||
          (unit === "em" && value < 1);
        return belowFloor ? [`${selector}: ${value}${unit}`] : [];
      });
    });

    expect(exceptionRules).toEqual([
      ".resume-plate-document .resume-contact-item::before: 0.95em",
      ".resume-plate-document .resume-contact-linkedin::before: 0.92em",
      ".resume-plate-document .resume-contact-github::before: 0.82em",
    ]);
  });

  it("keeps shared application primitives on the readable scale", () => {
    const belowCaptionFloor = activeSharedUiSources.flatMap(
      ({ filename, source }) => {
        const arbitrarySizes = [
          ...source.matchAll(/text-\[(?<value>\d+)px\]/g),
        ].flatMap((match) => {
          const value = Number(match.groups?.["value"]);
          return value < 13 ? [`${filename}: text-[${value}px]`] : [];
        });
        const textXs = source.includes("text-xs")
          ? [`${filename}: text-xs`]
          : [];
        return [...arbitrarySizes, ...textXs];
      },
    );

    expect(belowCaptionFloor).toEqual([]);
    const buttonSource = readFileSync(
      resolve(sharedUiDir, "button.tsx"),
      "utf8",
    );
    const fieldSource = readFileSync(resolve(sharedUiDir, "field.tsx"), "utf8");
    const labelSource = readFileSync(resolve(sharedUiDir, "label.tsx"), "utf8");
    const toggleSource = readFileSync(
      resolve(sharedUiDir, "toggle.tsx"),
      "utf8",
    );

    expect(buttonSource).toContain("text-sm");
    expect(buttonSource).not.toContain("text-[12px]");
    expect(fieldSource).not.toContain("text-[12px]");
    expect(labelSource).toContain("text-sm");
    expect(labelSource).not.toContain("text-[12px]");
    expect(toggleSource).not.toContain("text-[12px]");
    expect(readFileSync(resolve(sharedUiDir, "input.tsx"), "utf8")).toContain(
      "text-sm",
    );
    expect(
      readFileSync(resolve(sharedUiDir, "textarea.tsx"), "utf8"),
    ).toContain("text-sm");
    expect(readFileSync(resolve(sharedUiDir, "tabs.tsx"), "utf8")).toContain(
      "text-sm",
    );
    expect(fieldSource).toContain("data-[variant=legend]:text-base");
    expect(readFileSync(resolve(sharedUiDir, "alert.tsx"), "utf8")).toContain(
      "text-base font-medium",
    );
    expect(readFileSync(resolve(sharedUiDir, "toast.tsx"), "utf8")).toContain(
      "text-base font-semibold",
    );
  });

  it("keeps route breadcrumbs compact and lets their content wrap", () => {
    expect(commonCss).toMatch(
      /\.page-head \[data-slot="breadcrumb-list"\]\s*\{[^}]*font-size: var\(--jh-font-size-body\);/s,
    );
    expect(commonCss).toMatch(
      /\.page-head \[data-slot="breadcrumb-page"\]\s*\{[^}]*font-size: inherit;/s,
    );
    expect(commonCss).toMatch(/\.page-head\s*\{[^}]*flex-wrap: wrap;/s);
    expect(commonCss).toMatch(/\.page-head\s*\{[^}]*margin-bottom: 12px;/s);
    expect(commonCss).toMatch(/\.page-head-text\s*\{[^}]*flex: 1 1 24rem;/s);
    expect(commonCss).toMatch(
      /\.page-head-text\s*\{[^}]*grid-template-columns: auto minmax\(0, 1fr\);/s,
    );
    expect(commonCss).toMatch(/\.page-head-actions\s*\{[^}]*max-width: 100%;/s);
    expect(commonCss).toMatch(
      /@media \(max-width: 720px\)[\s\S]*\.page-head\s*\{[^}]*align-items: stretch;/,
    );
    expect(commonCss).toMatch(
      /@media \(max-width: 720px\)[\s\S]*\.page-head-text,[\s\S]*\.page-head-actions\s*\{[^}]*width: 100%;/,
    );
  });

  it("uses the shared readable scale in the shell and reflows workspaces", () => {
    expect(shellCss).toMatch(/\.side-rail\s*\{[^}]*border-right: 0;/s);
    expect(shellCss).toMatch(
      /\.side-rail__link\s*\{[^}]*font-size: var\(--jh-font-size-body-sm\);/s,
    );
    expect(shellCss).toMatch(
      /\.global-search\s*\{[^}]*font-size: var\(--jh-font-size-body-sm\);/s,
    );
    expect(workspaceCss).toMatch(
      /\.route-workspace__grid > \*\s*\{[^}]*min-width: 0;/s,
    );
    expect(workspaceCss).toMatch(
      /@media \(max-width: 1000px\)[\s\S]*\.route-workspace__grid[\s\S]*grid-template-columns: minmax\(0, 1fr\);/,
    );
    expect(pipelinesCss).toMatch(
      /\.pipeline-operations-inspector[\s\S]*\.pipeline-compact-ledger[\s\S]*> \.inspector-ledger__item[\s\S]*> dt,[\s\S]*> dd\s*\{[^}]*font-size: var\(--jh-font-size-body-sm\);/,
    );
  });
});
