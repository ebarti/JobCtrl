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
const editorialFoundationCss = readText("apps/web/src/styles/editorial-foundation.css");
const editorialStatusCss = readText("apps/web/src/styles/editorial-status.css");
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

    expect(tokensCss, "expected the editorial 2px radius token").toContain("--radius: 0.125rem;");
    expect(tokensCss, "expected light violet focus value").toContain("--primary: #6d28d9;");
    expect(tokensCss, "expected dark violet focus value").toContain("--primary: #a78bfa;");
    expect(tokensCss, "expected violet-ramp chart token").toContain("--chart-1: oklch(0.541 0.281 293.009);");
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
    expect(editorialFoundationCss, "expected active shell navigation to remain unfilled").toContain(
      ".side-rail__link.on {\n  background: transparent;",
    );
    expect(globalsCss, "expected shell controls to use the popover token").toContain("background: var(--popover);");
    expect(globalsCss, "expected connection banners to use destructive token").toContain(
      "border: 1px solid var(--destructive);",
    );
  });

  it("keeps semantic status visible without capsule chrome", () => {
    expect(editorialStatusCss, "expected the shared editorial status primitive").toContain(
      ".editorial-status {",
    );
    expect(editorialStatusCss, "expected status backgrounds to remain neutral").toContain(
      "background: transparent;",
    );
    expect(editorialStatusCss, "expected success status text to use the semantic token").toContain(
      ".editorial-status.ok {\n  color: var(--success);",
    );
    expect(editorialStatusCss, "expected status to avoid rounded badge chrome").toContain(
      "border-radius: 0;",
    );
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
    expect(
      packageJson.dependencies["@fontsource-variable/plus-jakarta-sans"],
      "expected Plus Jakarta Sans font dependency",
    ).toBe("5.2.8");
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
