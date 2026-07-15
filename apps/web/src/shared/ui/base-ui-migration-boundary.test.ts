import { readdirSync, readFileSync } from "node:fs";
import { dirname, extname, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { describe, expect, it } from "vitest";

const sourceRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const globalsCssPath = resolve(sourceRoot, "styles/globals.css");
const sourceExtensions = new Set([".ts", ".tsx"]);

// Remove entries from this list as their wrappers migrate to Base UI.
const radixWrapperAllowlist = new Set<string>();

const sourceFilesIn = (directory: string): string[] =>
  readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = resolve(directory, entry.name);

    if (entry.isDirectory()) {
      return sourceFilesIn(path);
    }

    return sourceExtensions.has(extname(entry.name)) ? [path] : [];
  });

const radixModuleSpecifiersInSource = (
  path: string,
  sourceText: string,
): string[] => {
  const source = ts.createSourceFile(
    path,
    sourceText,
    ts.ScriptTarget.Latest,
    false,
    path.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
  );
  const moduleSpecifiers = new Set<string>();

  const recordIfRadix = (value: ts.Expression | undefined) => {
    if (
      value &&
      ts.isStringLiteralLike(value) &&
      value.text.startsWith("@radix-ui/")
    ) {
      moduleSpecifiers.add(value.text);
    }
  };

  const visit = (node: ts.Node) => {
    if (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) {
      recordIfRadix(node.moduleSpecifier);
    } else if (
      ts.isImportEqualsDeclaration(node) &&
      ts.isExternalModuleReference(node.moduleReference)
    ) {
      recordIfRadix(node.moduleReference.expression);
    } else if (
      ts.isCallExpression(node) &&
      node.expression.kind === ts.SyntaxKind.ImportKeyword
    ) {
      recordIfRadix(node.arguments[0]);
    }

    ts.forEachChild(node, visit);
  };

  visit(source);
  return [...moduleSpecifiers].sort();
};

const radixModuleSpecifiersIn = (path: string): string[] =>
  radixModuleSpecifiersInSource(path, readFileSync(path, "utf8"));

describe("Base UI migration boundary", () => {
  it("detects direct Radix import forms", () => {
    const fixtures = [
      [
        "static import",
        'import * as Dialog from "@radix-ui/react-dialog";',
        ["@radix-ui/react-dialog"],
      ],
      [
        "type import",
        'import type { Root } from "@radix-ui/react-dialog";',
        ["@radix-ui/react-dialog"],
      ],
      [
        "re-export",
        'export { Root } from "@radix-ui/react-dialog";',
        ["@radix-ui/react-dialog"],
      ],
      [
        "import equals",
        'import Dialog = require("@radix-ui/react-dialog");',
        ["@radix-ui/react-dialog"],
      ],
      [
        "dynamic string import",
        'import("@radix-ui/react-dialog");',
        ["@radix-ui/react-dialog"],
      ],
      [
        "dynamic template import",
        "import(`@radix-ui/react-dialog`);",
        ["@radix-ui/react-dialog"],
      ],
      ["non-Radix import", 'import("@base-ui/react");', []],
    ] as const;

    for (const [name, source, expectedModuleSpecifiers] of fixtures) {
      expect(radixModuleSpecifiersInSource(`${name}.ts`, source), name).toEqual(
        expectedModuleSpecifiers,
      );
    }
  });

  it("confines direct Radix imports to the remaining wrapper allowlist", () => {
    const violations = sourceFilesIn(sourceRoot).flatMap((path) => {
      const moduleSpecifiers = radixModuleSpecifiersIn(path);
      if (moduleSpecifiers.length === 0) {
        return [];
      }

      const sourcePath = relative(sourceRoot, path).replaceAll("\\", "/");
      return radixWrapperAllowlist.has(sourcePath)
        ? []
        : [`${sourcePath}: ${moduleSpecifiers.join(", ")}`];
    });

    expect(
      violations,
      "Direct @radix-ui/* imports must remain in an explicitly allowlisted migration wrapper.",
    ).toEqual([]);
  });

  it("preserves the isolated root stacking context for Base UI portals", () => {
    const globalsCss = readFileSync(globalsCssPath, "utf8");
    const rootRule = globalsCss.match(/#root\s*\{(?<body>[^}]*)\}/);

    expect(
      rootRule?.groups?.body,
      "expected #root to isolate portaled overlay stacking",
    ).toMatch(/\bisolation\s*:\s*isolate\s*;/);
  });
});
