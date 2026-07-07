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
  "--radius-sm: calc(var(--radius) * 0.6);",
  "--radius-md: calc(var(--radius) * 0.8);",
  "--radius-lg: var(--radius);",
  "--radius-xl: calc(var(--radius) * 1.4);",
] as const;

const escapeRegExp = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, String.raw`\$&`);
const cssRuleContaining = (selector: string): string => {
  const pattern = new RegExp(`[^{}]*${escapeRegExp(selector)}[^{}]*\\{(?<body>[^}]*)\\}`, "m");
  const match = globalsCss.match(pattern);
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

    expect(tokensCss, "expected the preset medium radius token").toContain("--radius: 0.625rem;");
    expect(tokensCss, "expected light sky primary value").toContain("--primary: oklch(0.5 0.134 242.749);");
    expect(tokensCss, "expected dark sky primary value").toContain("--primary: oklch(0.443 0.11 240.79);");
    expect(tokensCss, "expected amber chart token").toContain("--chart-1: oklch(0.879 0.169 91.605);");
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
    expect(componentsJson.style, "expected luma/radix shadcn style").toBe("radix-luma");
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
    expect(packageJson.dependencies["@fontsource-variable/geist"], "expected Geist font dependency").toBe("5.2.9");
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
