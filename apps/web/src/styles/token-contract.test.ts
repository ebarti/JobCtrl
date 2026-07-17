import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const styleDir = dirname(fileURLToPath(import.meta.url));
const webRoot = resolve(styleDir, "../..");
const repoRoot = resolve(webRoot, "../..");

const readText = (path: string) => readFileSync(resolve(repoRoot, path), "utf8");
const readJson = <T>(path: string): T => JSON.parse(readText(path)) as T;

const tokensCss = readText("apps/web/src/styles/tokens.css");
const globalsCss = readText("apps/web/src/styles/globals.css");
const applyReviewCss = readText("apps/web/src/styles/redesign-apply-review.css");
const commonCss = readText("apps/web/src/styles/redesign-common.css");
const configurationCss = readText("apps/web/src/styles/redesign-configuration.css");
const dataCss = readText("apps/web/src/styles/redesign-data.css");
const shellCss = readText("apps/web/src/styles/redesign-shell.css");
const tabsSource = readText("apps/web/src/shared/ui/tabs.tsx");
const componentsJson = readJson<{
  style: string;
  tailwind: { config: string; css: string; baseColor: string; cssVariables: boolean };
  iconLibrary: string;
  menuColor: string;
  menuAccent: string;
}>("apps/web/components.json");
const packageJson = readJson<{
  dependencies: Record<string, string | undefined>;
  devDependencies: Record<string, string | undefined>;
}>("apps/web/package.json");

const requiredSemanticTokens = [
  "background",
  "foreground",
  "card",
  "card-foreground",
  "popover",
  "popover-foreground",
  "primary",
  "primary-foreground",
  "secondary",
  "secondary-foreground",
  "muted",
  "muted-foreground",
  "accent",
  "accent-foreground",
  "destructive",
  "border",
  "input",
  "ring",
  "chart-1",
  "chart-2",
  "chart-3",
  "chart-4",
  "chart-5",
  "sidebar",
  "sidebar-foreground",
  "sidebar-primary",
  "sidebar-primary-foreground",
  "sidebar-accent",
  "sidebar-accent-foreground",
  "sidebar-border",
  "sidebar-ring",
] as const;

const requiredExtensionTokens = [
  "success",
  "success-foreground",
  "success-muted",
  "warning",
  "warning-foreground",
  "warning-muted",
  "status-info",
  "status-info-foreground",
  "status-info-muted",
] as const;

const requiredThemeMappings = [
  ...requiredSemanticTokens.map((token) => `--color-${token}: var(--${token});`),
  ...requiredExtensionTokens.map((token) => `--color-${token}: var(--${token});`),
  "--font-sans: var(--jh-font-sans);",
  "--font-heading: var(--jh-font-heading);",
  "--font-mono: var(--jh-font-mono);",
  "--radius-sm: calc(var(--radius) - 4px);",
  "--radius-md: calc(var(--radius) - 2px);",
  "--radius-lg: var(--radius);",
  "--radius-xl: calc(var(--radius) + 4px);",
  "--radius-2xl: calc(var(--radius) + 8px);",
  "--radius-3xl: calc(var(--radius) + 12px);",
  "--radius-4xl: calc(var(--radius) + 16px);",
] as const;

const escapeRegExp = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, String.raw`\$&`);
const cssRuleContaining = (selector: string, css = globalsCss): string => {
  const pattern = new RegExp(`[^{}]*${escapeRegExp(selector)}[^{}]*\\{(?<body>[^}]*)\\}`, "m");
  const match = css.match(pattern);
  return match?.groups?.body?.trim() ?? "";
};
const absentPattern = (prefix: string, parts: readonly string[], joiner = "") =>
  new RegExp(`${escapeRegExp(prefix)}${parts.map(escapeRegExp).join(escapeRegExp(joiner))}(?![a-z0-9-])`, "i");

const forbiddenCssVariablePatterns = [
  ["b", "g"],
  ["paper"],
  ["paper", "2"],
  ["ink"],
  ["rule"],
  ["rule", "2"],
  ["danger"],
  ["warn"],
  ["ok"],
  ["info"],
  ["font"],
  ["mono"],
  ["row"],
].map((parts) => absentPattern("--", parts, parts.length > 1 ? "-" : ""));

const forbiddenUtilityPatterns = [
  ["bg", "paper"],
  ["text", "ink"],
  ["border", "rule"],
  ["ring", "info"],
].map((parts) => absentPattern("", parts, "-"));

describe("shadcn token contract", () => {
  it("defines required light and dark semantic tokens", () => {
    for (const token of [...requiredSemanticTokens, ...requiredExtensionTokens]) {
      const pattern = new RegExp(`--${escapeRegExp(token)}\\s*:`, "g");
      const matches = tokensCss.match(pattern) ?? [];
      expect(matches.length, `expected light and dark definitions for token ${token}`).toBeGreaterThanOrEqual(2);
    }

    expect(tokensCss, "expected the Rhea radius token").toContain("--radius: 0.625rem;");
    expect(tokensCss, "expected light JobCtrl violet primary value").toContain(
      "--primary: oklch(0.541 0.281 293.009);",
    );
    expect(tokensCss, "expected dark JobCtrl violet primary value").toContain(
      "--primary: oklch(0.702 0.183 293.541);",
    );
    expect(tokensCss, "expected a violet-neutral light canvas").toContain(
      "--background: oklch(0.972 0.008 293);",
    );
    expect(tokensCss, "expected a violet-neutral light navigation rail").toContain(
      "--sidebar: oklch(0.982 0.014 294.588);",
    );
    expect(tokensCss, "expected a violet-neutral dark navigation rail").toContain(
      "--sidebar: oklch(0.19 0.024 293.5);",
    );
    expect(tokensCss, "expected neutral chart ramp anchor").toContain("--chart-1: oklch(0.24 0 0);");
  });

  it("keeps JobCtrl interaction emphasis on semantic violet tokens", () => {
    expect(tokensCss, "expected a pale violet selection surface").toContain(
      "--accent: oklch(0.943 0.029 294.588);",
    );
    expect(tokensCss, "expected an opaque violet focus ring").toContain(
      "--ring: oklch(0.541 0.281 293.009);",
    );
    expect(cssRuleContaining(".tab.on", commonCss), "primary legacy actions must not be black").toContain(
      "background: var(--primary);",
    );
    expect(
      cssRuleContaining(".side-rail__link.on", shellCss),
      "active navigation should not be a solid black rounded rectangle",
    ).toContain("background: transparent;");
    expect(
      cssRuleContaining(".side-rail", shellCss),
      "the final shell override should consume the sidebar surface token",
    ).toContain("background: var(--sidebar);");
    expect(
      cssRuleContaining(".side-rail", shellCss),
      "the final shell override should consume the sidebar border token",
    ).toContain("border-right-color: var(--sidebar-border);");
    expect(
      cssRuleContaining(".side-rail__link.on", shellCss),
      "active navigation text should carry the violet identity",
    ).toContain("color: var(--sidebar-accent-foreground);");
    expect(
      cssRuleContaining(".side-rail__link.on::before", shellCss),
      "active navigation should use the violet selection rule",
    ).toContain("background: var(--sidebar-primary);");
    expect(
      cssRuleContaining(
        '.discovery-workspace .discovery-tab-list [role="tab"][data-active]',
        configurationCss,
      ),
      "selected discovery tabs should use the violet rule",
    ).toContain("border-color: var(--primary);");
    expect(tabsSource, "shared tabs should use the semantic violet rule").toContain(
      "data-active:border-primary",
    );
    expect(tabsSource, "shared active tabs should use semantic violet text").toContain(
      "data-active:text-accent-foreground",
    );
    expect(
      cssRuleContaining('.topbar__density [data-pressed]', shellCss),
      "the selected density should use a violet rule instead of a filled blob",
    ).toContain("box-shadow: inset 0 -2px 0 var(--primary);");
    expect(
      cssRuleContaining('.filterable-data-grid-table tbody tr[aria-selected="true"]', dataCss),
      "selected data rows should use a restrained violet marker",
    ).toContain("box-shadow: inset 2px 0 0 var(--primary);");
  });

  it("maps tokens through Tailwind CSS-first theme variables", () => {
    expect(globalsCss, "expected CSS-first theme block").toContain("@theme inline");
    for (const mapping of requiredThemeMappings) {
      expect(globalsCss, `missing theme mapping ${mapping}`).toContain(mapping);
    }
  });

  it("preserves JobCtrl theme and density selectors", () => {
    expect(globalsCss, "expected data-theme dark custom variant").toContain(
      '@custom-variant dark (&:where([data-theme="dark"], [data-theme="dark"] *));',
    );
    expect(tokensCss, "expected dark variables under the existing ThemeProvider selector").toContain(
      ':root[data-theme="dark"]',
    );
    expect(tokensCss, "expected regular density row height").toContain("--jh-row-height: 40px;");
    expect(tokensCss, "expected compact density row height").toContain("--jh-row-height: 32px;");
    expect(tokensCss, "expected comfy density row height").toContain("--jh-row-height: 48px;");
  });

  it("applies global density to shared rows, tables, fields, and controls", () => {
    expect(
      tokensCss,
      "expected global density to reach grids without an explicit override",
    ).toContain(".filterable-data-grid:not([data-density])");
    expect(
      tokensCss,
      "expected saved-view density to remain an explicit override",
    ).toContain(
      ".app-shell[data-density]\n  .filterable-data-grid:not([data-density])",
    );
    expect(
      tokensCss,
      "expected shared row spacing to consume the density token",
    ).toContain("padding-block: var(--jh-row-padding-block);");
    expect(
      tokensCss,
      "expected shared field spacing to consume the density token",
    ).toContain("gap: var(--jh-field-gap);");
    expect(
      tokensCss,
      "expected shared controls to consume the density token",
    ).toContain("height: var(--jh-control-height);");

    const style = document.createElement("style");
    style.textContent = tokensCss;
    const shell = document.createElement("div");
    shell.className = "app-shell";
    shell.innerHTML = [
      '<div class="data-row" data-testid="density-row"></div>',
      '<div class="field" data-testid="density-field"></div>',
      '<div data-slot="input-group" data-testid="density-control"></div>',
    ].join("");
    document.head.append(style);
    document.body.append(shell);

    try {
      for (const [density, expected] of Object.entries({
        compact: {
          controlHeight: "28px",
          fieldGap: "5px",
          rowHeight: "32px",
          rowPadding: "6px",
          tablePadding: "7px",
        },
        regular: {
          controlHeight: "32px",
          fieldGap: "7px",
          rowHeight: "40px",
          rowPadding: "9px",
          tablePadding: "10px",
        },
        comfy: {
          controlHeight: "36px",
          fieldGap: "10px",
          rowHeight: "48px",
          rowPadding: "12px",
          tablePadding: "14px",
        },
      })) {
        shell.dataset["density"] = density;
        const computed = getComputedStyle(shell);

        expect(computed.getPropertyValue("--jh-row-height").trim()).toBe(
          expected.rowHeight,
        );
        expect(computed.getPropertyValue("--jh-row-padding-block").trim()).toBe(
          expected.rowPadding,
        );
        expect(
          computed.getPropertyValue("--jh-table-cell-padding-block").trim(),
        ).toBe(expected.tablePadding);
        expect(computed.getPropertyValue("--jh-field-gap").trim()).toBe(
          expected.fieldGap,
        );
        expect(computed.getPropertyValue("--jh-control-height").trim()).toBe(
          expected.controlHeight,
        );
        expect(
          getComputedStyle(
            shell.querySelector<HTMLElement>("[data-testid=density-row]")!,
          ).paddingBlock,
        ).toBe("var(--jh-row-padding-block)");
        expect(
          getComputedStyle(
            shell.querySelector<HTMLElement>("[data-testid=density-field]")!,
          ).gap,
        ).toBe("var(--jh-field-gap)");
        expect(
          getComputedStyle(
            shell.querySelector<HTMLElement>("[data-testid=density-control]")!,
          ).height,
        ).toBe("var(--jh-control-height)");
      }
    } finally {
      shell.remove();
      style.remove();
    }
  });

  it("uses shadcn semantic tokens for shell chrome", () => {
    expect(globalsCss, "expected topbar to consume the standard card token").toContain(
      "background: color-mix(in oklch, var(--card) 96%, transparent);",
    );
    expect(globalsCss, "expected brand mark to use the primary token").toContain("background: var(--primary);");
    expect(globalsCss, "expected active shell tabs to use accent token").toContain("background: var(--accent);");
    expect(globalsCss, "expected shell controls to use the popover token").toContain("background: var(--popover);");
    expect(globalsCss, "expected connection banners to use destructive token").toContain(
      "border: 1px solid var(--destructive);",
    );
  });

  it("keeps Apply Review as a left-queue card workspace with stacked review cards", () => {
    const shellRule = cssRuleContaining(".apply-review-shell", applyReviewCss);
    const workspaceRule = cssRuleContaining(".apply-review-workspace", applyReviewCss);
    const paneRule = cssRuleContaining(".apply-review-pane ", applyReviewCss);
    const documentRule = cssRuleContaining(".apply-review-document", applyReviewCss);
    const jobPostRule = cssRuleContaining(".apply-review-document > .description-text", applyReviewCss);

    expect(shellRule, "review shell should own its layout without legacy CSS").toContain("display: grid;");
    expect(shellRule, "review queue should remain a dedicated left rail").toContain(
      "grid-template-columns: minmax(236px, 278px) minmax(0, 1fr);",
    );
    expect(workspaceRule, "review workspace should own its layout without legacy CSS").toContain(
      "display: grid;",
    );
    expect(workspaceRule, "Job Position and Application Materials must stack full width").toContain(
      "grid-template-columns: minmax(0, 1fr);",
    );
    expect(workspaceRule, "review cards should use consistent inter-card spacing").toContain("gap: 20px;");
    expect(paneRule, "review regions should preserve the shared shadcn Card radius").toContain(
      "border-radius: min(var(--radius-4xl), 24px);",
    );
    expect(documentRule, "verbatim document prose should not carry a decorative left rule").not.toContain(
      "border-left:",
    );
    expect(documentRule, "verbatim document prose should align to the card content edge").toContain(
      "padding: 2px 0;",
    );
    expect(jobPostRule, "the verbatim job post should use the full review-card width").toContain(
      "width: 100%;",
    );
    expect(jobPostRule, "wide review cards must not inherit the shared 72ch prose cap").toContain(
      "max-width: none;",
    );
  });

  it("keeps success badges visibly green", () => {
    const tagOkRule = cssRuleContaining(".tag.ok");
    const stagePillOkRule = cssRuleContaining(".stage-pill.ok");

    expect(tagOkRule, "expected a shared success badge rule").toContain(
      "background: color-mix(in oklab, var(--success) 32%, var(--card));",
    );
    expect(tagOkRule, "expected success badge border to stay green").toContain(
      "box-shadow: inset 0 0 0 1px color-mix(in oklab, var(--success) 52%, transparent);",
    );
    expect(tagOkRule, "expected success badge text to stay green").toContain(
      "color: color-mix(in oklab, var(--success) 78%, var(--foreground));",
    );
    expect(stagePillOkRule, "stage pills should use the same success rule as tags").toBe(tagOkRule);
  });

  it("keeps shadcn preset config and packages wired", () => {
    expect(componentsJson.style, "expected Rhea/Base shadcn style").toBe("base-rhea");
    expect(componentsJson.tailwind.config, "expected CSS-first shadcn Tailwind config").toBe("");
    expect(componentsJson.tailwind.css, "expected shadcn to use the global CSS entrypoint").toBe(
      "src/styles/globals.css",
    );
    expect(componentsJson.tailwind.baseColor, "expected neutral base color").toBe("neutral");
    expect(componentsJson.tailwind.cssVariables, "expected CSS variable mode").toBe(true);
    expect(componentsJson.iconLibrary, "expected Tabler preset target").toBe("tabler");
    expect(componentsJson.menuColor, "expected default translucent menu preset").toBe("default-translucent");
    expect(componentsJson.menuAccent, "expected subtle menu preset").toBe("subtle");

    expect(packageJson.dependencies.shadcn, "expected shadcn dependency").toBe("4.11.0");
    expect(packageJson.dependencies["tw-animate-css"], "expected Tailwind v4 animation dependency").toBe("1.4.0");
    expect(
      packageJson.dependencies["@fontsource-variable/geist"],
      "expected Geist font dependency",
    ).toBe("^5.2.9");
    expect(
      packageJson.dependencies["@fontsource-variable/jetbrains-mono"],
      "expected JetBrains Mono font dependency",
    ).toBe("5.2.8");
    expect(packageJson.dependencies["@tabler/icons-react"], "expected Tabler icon dependency").toBe("3.44.0");
    expect(packageJson.devDependencies["@types/node"], "expected shadcn Vite alias type dependency").toBe("25.9.2");
  });

  it("does not expose the old token bridge in token and config files", () => {
    const contractFiles = [
      ["tokens.css", tokensCss],
      ["globals.css", globalsCss],
      ["components.json", JSON.stringify(componentsJson)],
    ] as const;

    for (const [name, content] of contractFiles) {
      for (const pattern of [...forbiddenCssVariablePatterns, ...forbiddenUtilityPatterns]) {
        expect(content, `${name} still exposes a forbidden legacy token bridge matching ${pattern}`).not.toMatch(
          pattern,
        );
      }
    }
  });
});
