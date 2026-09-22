import { readFileSync, readdirSync } from "node:fs";
import { dirname, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";

export const webRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const normalize = (path) => path.replaceAll("\\", "/");
export const isSupport = (path) =>
  /(^|\/)(test|__tests__)\//.test(path) ||
  /\.(test|test-d|stories|fixtures)\.[cm]?[jt]sx?$/.test(path) ||
  path.endsWith(".gen.ts");
export function sourceFiles(directory) {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = resolve(directory, entry.name);
    return entry.isDirectory()
      ? sourceFiles(path)
      : /\.[cm]?[jt]sx?$/.test(path)
        ? [path]
        : [];
  });
}

// Import syntax is parsed, never matched against source-text grep patterns.
export function dependencies(source) {
  const found = [];
  function visit(node) {
    let specifier;
    let names = ["*"];
    let typeOnly = false;
    if (ts.isImportDeclaration(node)) {
      specifier = node.moduleSpecifier;
      typeOnly = node.importClause?.isTypeOnly ?? false;
      const bindings = node.importClause?.namedBindings;
      if (bindings && ts.isNamedImports(bindings)) {
        names = bindings.elements.map(
          (item) => (item.propertyName ?? item.name).text,
        );
        typeOnly ||=
          bindings.elements.length > 0 &&
          bindings.elements.every((item) => item.isTypeOnly);
      }
      if (node.importClause?.name) names.push("default");
    } else if (ts.isExportDeclaration(node)) {
      specifier = node.moduleSpecifier;
      typeOnly = node.isTypeOnly;
      if (node.exportClause && ts.isNamedExports(node.exportClause)) {
        names = node.exportClause.elements.map(
          (item) => (item.propertyName ?? item.name).text,
        );
        typeOnly ||= node.exportClause.elements.every(
          (item) => item.isTypeOnly,
        );
      }
    } else if (
      ts.isImportEqualsDeclaration(node) &&
      ts.isExternalModuleReference(node.moduleReference)
    ) {
      specifier = node.moduleReference.expression;
      typeOnly = node.isTypeOnly;
    } else if (
      ts.isImportTypeNode(node) &&
      ts.isLiteralTypeNode(node.argument)
    ) {
      specifier = node.argument.literal;
      names = node.qualifier
        ? [node.qualifier.getText(source).split(".")[0]]
        : ["*"];
      typeOnly = true;
    } else if (
      ts.isCallExpression(node) &&
      (node.expression.kind === ts.SyntaxKind.ImportKeyword ||
        (ts.isIdentifier(node.expression) &&
          node.expression.text === "require"))
    ) {
      specifier = node.arguments[0];
    }
    if (specifier)
      found.push({
        node,
        specifier: ts.isStringLiteralLike(specifier) ? specifier.text : null,
        names,
        typeOnly,
        specifierNode: specifier,
      });
    ts.forEachChild(node, visit);
  }
  visit(source);
  return found;
}

export function lintProgram(
  program,
  root,
  exemptions = { contracts: {}, capabilities: {} },
) {
  const checker = program.getTypeChecker();
  const options = program.getCompilerOptions();
  const diagnostics = [];
  const used = new Set();
  const src = resolve(root, "src");
  const localPath = (path) => normalize(relative(src, path));
  const context = (path) => /^contexts\/([^/]+)\//.exec(path)?.[1];
  const view = (path) => /^views\/([^/]+)\//.exec(path)?.[1];
  function exempt(group, path, name) {
    const entry = exemptions[group]?.[path];
    if (!entry?.reason?.trim() || !entry.symbols.includes(name)) return false;
    used.add(`${group}:${path}:${name}`);
    return true;
  }
  for (const source of program.getSourceFiles()) {
    const path = localPath(source.fileName);
    if (path.startsWith("../") || isSupport(path) || source.isDeclarationFile)
      continue;
    const feature = /^(contexts|views|routes)\//.test(path);
    const composer = /^(views|routes)\//.test(path);
    function report(node, rule, message) {
      const { line, character } = source.getLineAndCharacterOfPosition(
        node.getStart(source),
      );
      diagnostics.push({
        file: path,
        line: line + 1,
        column: character + 1,
        rule,
        message,
      });
    }
    function edge(node, target) {
      if (isSupport(target) && !target.endsWith(".gen.ts"))
        report(
          node,
          "production-import",
          `Production must not import test/story scaffolding: ${target}. Move shared runtime code to its owning layer.`,
        );
      if (context(path) && view(target))
        report(
          node,
          "context-view",
          `Contexts cannot import views (${target}); compose this dependency in a view.`,
        );
      if (
        view(path) &&
        view(target) &&
        view(path) !== view(target) &&
        !exempt("dependencies", path, target)
      )
        report(
          node,
          "view-view",
          `Views cannot import another view (${target}); move reusable code into its owning context or shared module.`,
        );
      if (
        context(path) &&
        context(target) &&
        context(path) !== context(target) &&
        context(target) !== "operations" &&
        /\/(hooks|stores)\//.test(target)
      ) {
        report(
          node,
          "aggregate-state",
          `Do not import another aggregate's hooks/stores (${target}); compose public hooks in a view or consume Operations reads.`,
        );
      }
    }
    for (const dep of dependencies(source)) {
      if (dep.specifier === null) {
        if (feature)
          report(
            dep.node,
            "static-dependency",
            "Use a literal module specifier so frontend ownership can be checked.",
          );
        continue;
      }
      const resolved = ts.resolveModuleName(
        dep.specifier,
        source.fileName,
        options,
        {
          fileExists: (file) =>
            Boolean(program.getSourceFile(file)) || ts.sys.fileExists(file),
          readFile: (file) =>
            program.getSourceFile(file)?.text ?? ts.sys.readFile(file),
        },
      ).resolvedModule;
      if (
        resolved &&
        localPath(resolved.resolvedFileName).startsWith("../") === false
      )
        edge(dep.node, localPath(resolved.resolvedFileName));
      // Resolve exports too: a barrel must not hide a forbidden hook/store edge.
      const moduleSymbol =
        checker.getSymbolAtLocation(dep.specifierNode) ??
        (resolved &&
          program.getSourceFile(resolved.resolvedFileName) &&
          checker.getSymbolAtLocation(
            program.getSourceFile(resolved.resolvedFileName),
          ));
      if (moduleSymbol)
        for (let symbol of checker.getExportsOfModule(moduleSymbol)) {
          if (!dep.names.includes("*") && !dep.names.includes(symbol.name))
            continue;
          const exportedName = symbol.name;
          if (symbol.flags & ts.SymbolFlags.Alias)
            symbol = checker.getAliasedSymbol(symbol);
          for (const declaration of symbol.declarations ?? []) {
            const target = localPath(declaration.getSourceFile().fileName);
            if (!target.startsWith("../") && target !== path)
              edge(dep.node, target);
            // Follow the declaration behind local re-exports, not just the first path.
            const origin = normalize(declaration.getSourceFile().fileName);
            const inlineType =
              ts.isImportDeclaration(dep.node) &&
              dep.node.importClause?.namedBindings &&
              ts.isNamedImports(dep.node.importClause.namedBindings)
                ? dep.node.importClause.namedBindings.elements.find(
                    (item) =>
                      (item.propertyName ?? item.name).text === exportedName,
                  )?.isTypeOnly
                : false;
            if (!dep.typeOnly && !inlineType) {
              if (
                composer &&
                /\/node_modules\/(@tanstack\/(react-query|query-core)|zustand)\//.test(
                  origin,
                )
              )
                report(
                  dep.node,
                  "view-state",
                  "Views/routes compose context-owned hooks; a local re-export must not expose runtime Query or Zustand APIs.",
                );
              if (
                feature &&
                /\/packages\/api-client\//.test(origin) &&
                symbol.name !== "JobCtrlApiError"
              )
                report(
                  dep.node,
                  "api-adapter",
                  "A local re-export must not expose the concrete API client; use context-owned hooks and ports.",
                );
              if (
                feature &&
                /\/node_modules\/(@base-ui\/react|@radix-ui\/[^/]+)\//.test(
                  origin,
                )
              )
                report(
                  dep.node,
                  "ui-wrapper",
                  "A local re-export must not bypass owned shared/ui primitive wrappers.",
                );
              if (feature && target.startsWith("shared/adapters/"))
                report(
                  dep.node,
                  "adapter-import",
                  "A local re-export must not expose concrete adapters to feature code; consume ports.",
                );
            }
          }
        }
      if (
        feature &&
        path !== "contexts/operations/types.ts" &&
        /^@jobctrl\/contracts(?:\/|$)/.test(dep.specifier)
      ) {
        for (const name of dep.names)
          if (!exempt("contracts", path, name))
            report(
              dep.node,
              "operations-acl",
              `Import ${name} through contexts/operations/types.ts. Existing direct contract access requires an exact file/symbol exemption with an architectural reason.`,
            );
      }
      if (
        feature &&
        /^@jobctrl\/api-client(?:\/|$)/.test(dep.specifier) &&
        !dep.names.every((name) => name === "JobCtrlApiError")
      ) {
        report(
          dep.node,
          "api-adapter",
          "Use context-owned hooks and ApiClientPort; only the transport error class JobCtrlApiError may be imported directly.",
        );
      }
      if (
        composer &&
        !dep.typeOnly &&
        /^(@tanstack\/react-query(?:\/|$)|@tanstack\/query-core(?:\/|$)|zustand(?:\/|$))/.test(
          dep.specifier,
        )
      ) {
        report(
          dep.node,
          "view-state",
          "Views/routes compose context-owned hooks; move Query or persistent-store ownership into a context. Type-only Query result imports are allowed.",
        );
      }
      if (feature && /^@radix-ui\//.test(dep.specifier))
        report(
          dep.node,
          "ui-wrapper",
          "Use the shared shadcn/Base UI wrappers; Radix bypasses the primitive boundary.",
        );
      if (feature && /^@base-ui\/react(?:\/|$)/.test(dep.specifier))
        report(
          dep.node,
          "ui-wrapper",
          "Import the owned shared/ui wrapper instead of Base UI directly.",
        );
      if (
        feature &&
        resolved &&
        localPath(resolved.resolvedFileName).startsWith("shared/adapters/")
      )
        report(
          dep.node,
          "adapter-import",
          "Feature code consumes ports; concrete adapters are bound at composition roots.",
        );
    }
    if (!feature) continue;
    function inspect(node) {
      let symbol;
      if (ts.isIdentifier(node)) symbol = checker.getSymbolAtLocation(node);
      else if (
        ts.isElementAccessExpression(node) &&
        ts.isStringLiteralLike(node.argumentExpression)
      ) {
        symbol = checker.getPropertyOfType(
          checker.getTypeAtLocation(node.expression),
          node.argumentExpression.text,
        );
      }
      if (ts.isBindingElement(node)) {
        const pattern = node.parent;
        const key = node.propertyName ?? node.name;
        if (
          ts.isObjectBindingPattern(pattern) &&
          (ts.isIdentifier(key) || ts.isStringLiteralLike(key))
        ) {
          symbol = checker.getPropertyOfType(
            checker.getTypeAtLocation(pattern),
            key.text,
          );
        }
      }
      if (symbol) {
        const declarations = symbol.declarations ?? [];
        const name = symbol.name;
        const browser = declarations.some((decl) =>
          /\/lib\.(dom|webworker)\.d\.ts$/.test(
            normalize(decl.getSourceFile().fileName),
          ),
        );
        if (
          browser &&
          [
            "fetch",
            "localStorage",
            "sessionStorage",
            "EventSource",
            "clipboard",
            "dispatchEvent",
          ].includes(name) &&
          !exempt("capabilities", path, name)
        )
          report(
            node,
            "browser-port",
            `Use a port for browser capability ${name}; keep concrete access in shared/adapters. URL navigation replaces DOM event-bus coordination.`,
          );
        const queryClient = declarations.some(
          (decl) =>
            /\/node_modules\/@tanstack\/query-core\//.test(
              normalize(decl.getSourceFile().fileName),
            ) &&
            ts.isClassDeclaration(decl.parent) &&
            decl.parent.name?.text === "QueryClient",
        );
        if (composer && queryClient)
          report(
            node,
            "view-state",
            "QueryClient access belongs in context-owned hooks, including clients obtained through router context.",
          );
        const api = declarations.some(
          (decl) =>
            localPath(decl.getSourceFile().fileName) ===
            "shared/ports/ApiClientPort.ts",
        );
        if (composer && api && !exempt("capabilities", path, name))
          report(
            node,
            "view-api",
            `Move API access ${name} into a context-owned hook. Only reviewed URL-building helpers may stay in views.`,
          );
      }
      ts.forEachChild(node, inspect);
    }
    inspect(source);
  }
  for (const group of ["contracts", "capabilities", "dependencies"])
    for (const [path, entry] of Object.entries(exemptions[group] ?? {})) {
      for (const name of entry.symbols)
        if (!used.has(`${group}:${path}:${name}`))
          diagnostics.push({
            file: path,
            line: 1,
            column: 1,
            rule: "stale-exemption",
            message: `Remove unused or unreasoned ${group} exemption: ${name}.`,
          });
    }
  // Multiple declarations can resolve to the same semantic edge.
  return [
    ...new Map(
      diagnostics.map((item) => [JSON.stringify(item), item]),
    ).values(),
  ];
}

export function lint(root = webRoot) {
  const configPath = resolve(root, "tsconfig.json");
  const config = ts.readConfigFile(configPath, ts.sys.readFile);
  if (config.error)
    throw new Error(
      ts.flattenDiagnosticMessageText(config.error.messageText, "\n"),
    );
  const parsed = ts.parseJsonConfigFileContent(config.config, ts.sys, root);
  const program = ts.createProgram(
    sourceFiles(resolve(root, "src")),
    parsed.options,
  );
  const exemptions = JSON.parse(
    readFileSync(resolve(root, "boundary-exemptions.json"), "utf8"),
  );
  return lintProgram(program, root, exemptions);
}

if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  const diagnostics = lint();
  for (const item of diagnostics)
    console.error(
      `${item.file}:${item.line}:${item.column} [${item.rule}] ${item.message}`,
    );
  console.log(`Web boundary lint: ${diagnostics.length} violation(s).`);
  process.exitCode = diagnostics.length ? 1 : 0;
}
