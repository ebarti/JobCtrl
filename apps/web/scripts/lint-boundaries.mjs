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
  exemptions = { capabilities: {}, dependencies: {} },
) {
  const checker = program.getTypeChecker();
  const options = program.getCompilerOptions();
  const diagnostics = [];
  const used = new Set();
  const src = resolve(root, "src");
  const localPath = (path) => normalize(relative(src, path));
  const context = (path) => /^contexts\/([^/]+)\//.exec(path)?.[1];
  const view = (path) => /^views\/([^/]+)\//.exec(path)?.[1];
  const resolveSource = (specifier, source) => {
    const resolved = ts.resolveModuleName(specifier, source.fileName, options, {
      fileExists: (file) =>
        Boolean(program.getSourceFile(file)) || ts.sys.fileExists(file),
      readFile: (file) =>
        program.getSourceFile(file)?.text ?? ts.sys.readFile(file),
    }).resolvedModule;
    return resolved && program.getSourceFile(resolved.resolvedFileName);
  };
  // Re-export provenance must survive missing package declarations too. Inspect
  // only the selected runtime exports, so a barrel's internal/type-only imports
  // cannot poison a legitimate public helper.
  function runtimeOrigins(specifier, names, source, seen = new Set()) {
    if (
      /^(@tanstack\/(react-query|query-core)|zustand)(?:\/|$)/.test(specifier)
    )
      return ["view-state"];
    if (/^@jobctrl\/api-client(?:\/|$)/.test(specifier))
      return names.every((name) => name === "JobCtrlApiError")
        ? []
        : ["api-adapter"];
    const target = resolveSource(specifier, source);
    if (!target) return [];
    const identity = `${target.fileName}:${names.join(",")}`;
    if (seen.has(identity)) return [];
    seen.add(identity);
    const origins = [];
    function localOrigins(
      node,
      visited = new Set(),
      symbol = node && checker.getSymbolAtLocation(node),
    ) {
      if (!node || visited.has(node)) return [];
      visited.add(node);
      if (
        ts.isParenthesizedExpression(node) ||
        ts.isAsExpression(node) ||
        ts.isTypeAssertionExpression(node) ||
        ts.isSatisfiesExpression(node)
      )
        return localOrigins(node.expression, visited);
      return (symbol?.declarations ?? []).flatMap((decl) => {
        if (ts.isImportSpecifier(decl)) {
          const statement = decl.parent.parent.parent;
          if (decl.isTypeOnly || statement.importClause?.isTypeOnly) return [];
          return runtimeOrigins(
            statement.moduleSpecifier.text,
            [(decl.propertyName ?? decl.name).text],
            target,
            seen,
          );
        }
        if (ts.isNamespaceImport(decl) || ts.isImportClause(decl)) {
          const clause = ts.isNamespaceImport(decl) ? decl.parent : decl;
          if (clause.isTypeOnly) return [];
          return runtimeOrigins(
            clause.parent.moduleSpecifier.text,
            ts.isNamespaceImport(decl) ? ["*"] : ["default"],
            target,
            seen,
          );
        }
        if (ts.isVariableDeclaration(decl))
          return localOrigins(decl.initializer, visited);
        return [];
      });
    }
    for (const statement of target.statements) {
      if (
        ts.isExportAssignment(statement) &&
        (names.includes("*") || names.includes("default"))
      )
        origins.push(...localOrigins(statement.expression));
      if (
        ts.isVariableStatement(statement) &&
        statement.modifiers?.some((m) => m.kind === ts.SyntaxKind.ExportKeyword)
      )
        for (const decl of statement.declarationList.declarations)
          if (
            ts.isIdentifier(decl.name) &&
            (names.includes("*") || names.includes(decl.name.text))
          )
            origins.push(...localOrigins(decl.initializer));
      if (
        ts.isExportDeclaration(statement) &&
        !statement.isTypeOnly &&
        !statement.moduleSpecifier &&
        statement.exportClause &&
        ts.isNamedExports(statement.exportClause)
      ) {
        for (const item of statement.exportClause.elements)
          if (
            !item.isTypeOnly &&
            (names.includes("*") || names.includes(item.name.text))
          )
            origins.push(
              ...localOrigins(
                item.propertyName ?? item.name,
                new Set(),
                checker.getExportSpecifierLocalTargetSymbol(item),
              ),
            );
      }
      if (
        !ts.isExportDeclaration(statement) ||
        statement.isTypeOnly ||
        !statement.moduleSpecifier ||
        !ts.isStringLiteralLike(statement.moduleSpecifier)
      )
        continue;
      let selected = ["*"];
      if (statement.exportClause && ts.isNamedExports(statement.exportClause))
        selected = statement.exportClause.elements
          .filter(
            (item) =>
              !item.isTypeOnly &&
              (names.includes("*") || names.includes(item.name.text)),
          )
          .map((item) => (item.propertyName ?? item.name).text);
      if (selected.length)
        origins.push(
          ...runtimeOrigins(
            statement.moduleSpecifier.text,
            selected,
            target,
            seen,
          ),
        );
    }
    return origins;
  }
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
      if (composer && !dep.typeOnly) {
        const bindings = ts.isImportDeclaration(dep.node)
          ? dep.node.importClause?.namedBindings
          : undefined;
        const names =
          bindings && ts.isNamedImports(bindings)
            ? bindings.elements
                .filter((item) => !item.isTypeOnly)
                .map((item) => (item.propertyName ?? item.name).text)
            : dep.names;
        if (names.length)
          for (const rule of runtimeOrigins(dep.specifier, names, source))
            report(
              dep.node,
              rule,
              "Runtime capabilities cannot be imported through a barrel, including when declarations are missing; use context-owned helpers and ports.",
            );
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
    // Generated router declarations can resolve to `any` (or be absent). Follow
    // capability origins through syntax as well as types; a cast cannot erase
    // authority, and an unrelated local with the same spelling is not a port.
    const unwrap = (node) => {
      while (
        node &&
        (ts.isParenthesizedExpression(node) ||
          ts.isAsExpression(node) ||
          ts.isTypeAssertionExpression(node) ||
          ts.isNonNullExpression(node) ||
          ts.isSatisfiesExpression(node))
      )
        node = node.expression;
      return node;
    };
    function keyText(node) {
      if (!node) return undefined;
      if (ts.isIdentifier(node) || ts.isStringLiteralLike(node))
        return node.text;
      if (ts.isComputedPropertyName(node)) return literalKey(node.expression);
    }
    function literalKey(node, seen = new Set()) {
      node = unwrap(node);
      if (ts.isStringLiteralLike(node) || ts.isNumericLiteral(node))
        return node.text;
      const symbol = checker.getSymbolAtLocation(node);
      if (!symbol || seen.has(symbol)) return undefined;
      seen.add(symbol);
      for (const decl of symbol.declarations ?? [])
        if (ts.isVariableDeclaration(decl) && decl.initializer)
          return literalKey(decl.initializer, seen);
    }
    function member(base, key) {
      if (base && typeof base === "object") return base[key];
      if (base === "loader" && key === "context") return "context";
      if (base === "context" && key === "ports") return "ports";
      if (base === "context" && key === "queryClient") return "query";
      if (base === "ports" && key === "api") return "api";
    }
    function weakMember(node, key) {
      // No declaration is permission: reserved capability slots on weak/error
      // types fail closed. Explicitly resolved local objects can still shadow
      // those names without acquiring application authority.
      if (!node) return undefined;
      const type = checker.getTypeAtLocation(node);
      if (!(type.flags & (ts.TypeFlags.Any | ts.TypeFlags.Unknown)))
        return undefined;
      return {
        context: "context",
        ports: "ports",
        api: "api",
        queryClient: "query",
      }[key];
    }
    const assignments = new Map();
    function collectAssignments(node) {
      if (
        ts.isBinaryExpression(node) &&
        node.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
        ts.isIdentifier(node.left)
      ) {
        const symbol = checker.getSymbolAtLocation(node.left);
        assignments.set(symbol, [
          ...(assignments.get(symbol) ?? []),
          node.right,
        ]);
      }
      ts.forEachChild(node, collectAssignments);
    }
    collectAssignments(source);
    function loaderParameter(decl) {
      const fn = decl.parent;
      if (loaderFunctions.has(fn)) return true;
      const owner = ts.isMethodDeclaration(fn) ? fn : fn?.parent;
      return (
        owner &&
        (ts.isPropertyAssignment(owner) || ts.isMethodDeclaration(owner)) &&
        keyText(owner.name) === "loader" &&
        ts.isObjectLiteralExpression(owner.parent) &&
        ts.isCallExpression(owner.parent.parent) &&
        routerOrigin(owner.parent.parent.expression)
      );
    }
    function routerOrigin(node, seen = new Set()) {
      node = unwrap(node);
      if (!node || seen.has(node)) return false;
      seen.add(node);
      if (ts.isCallExpression(node)) return routerOrigin(node.expression, seen);
      const symbol = checker.getSymbolAtLocation(node);
      for (const decl of symbol?.declarations ?? []) {
        if (ts.isImportSpecifier(decl)) {
          const statement = decl.parent.parent.parent;
          if (
            ts.isImportDeclaration(statement) &&
            ts.isStringLiteralLike(statement.moduleSpecifier) &&
            statement.moduleSpecifier.text === "@tanstack/react-router" &&
            [
              "createFileRoute",
              "createRoute",
              "createRootRouteWithContext",
            ].includes((decl.propertyName ?? decl.name).text)
          )
            return true;
        }
        if (
          ts.isVariableDeclaration(decl) &&
          decl.initializer &&
          routerOrigin(decl.initializer, seen)
        )
          return true;
      }
      return false;
    }
    const loaderFunctions = new Set();
    function registerLoader(node, seen = new Set()) {
      node = unwrap(node);
      if (!node || seen.has(node)) return;
      seen.add(node);
      if (
        ts.isArrowFunction(node) ||
        ts.isFunctionExpression(node) ||
        ts.isFunctionDeclaration(node) ||
        ts.isMethodDeclaration(node)
      )
        loaderFunctions.add(node);
      else {
        for (const decl of checker.getSymbolAtLocation(node)?.declarations ??
          []) {
          if (ts.isVariableDeclaration(decl))
            registerLoader(decl.initializer, seen);
          if (ts.isFunctionDeclaration(decl)) loaderFunctions.add(decl);
        }
      }
    }
    function collectLoaders(node) {
      if (
        ts.isObjectLiteralExpression(node) &&
        ts.isCallExpression(node.parent) &&
        routerOrigin(node.parent.expression)
      )
        for (const prop of node.properties)
          if (keyText(prop.name) === "loader")
            registerLoader(
              ts.isPropertyAssignment(prop)
                ? prop.initializer
                : ts.isShorthandPropertyAssignment(prop)
                  ? prop.name
                  : prop,
            );
      ts.forEachChild(node, collectLoaders);
    }
    collectLoaders(source);
    function bindingKey(element) {
      return ts.isArrayBindingPattern(element.parent)
        ? String(element.parent.elements.indexOf(element))
        : keyText(element.propertyName ?? element.name);
    }
    function bindingOrigin(pattern, seen) {
      const owner = pattern.parent;
      if (ts.isVariableDeclaration(owner))
        return capability(owner.initializer, seen);
      if (ts.isParameter(owner))
        return loaderParameter(owner) ? "loader" : undefined;
      if (ts.isBindingElement(owner))
        return (
          member(bindingOrigin(owner.parent, seen), bindingKey(owner)) ??
          weakMember(owner.parent, bindingKey(owner))
        );
    }
    function capability(node, seen = new Set()) {
      node = unwrap(node);
      if (!node || seen.has(node)) return undefined;
      seen.add(node);
      if (
        ts.isPropertyAccessExpression(node) ||
        ts.isElementAccessExpression(node)
      )
        return (
          member(
            capability(node.expression, seen),
            ts.isPropertyAccessExpression(node)
              ? node.name.text
              : literalKey(node.argumentExpression),
          ) ??
          weakMember(
            node.expression,
            ts.isPropertyAccessExpression(node)
              ? node.name.text
              : literalKey(node.argumentExpression),
          )
        );
      if (ts.isIdentifier(node)) {
        const symbol = ts.isShorthandPropertyAssignment(node.parent)
          ? checker.getShorthandAssignmentValueSymbol(node.parent)
          : checker.getSymbolAtLocation(node);
        let original = symbol;
        if (original?.flags & ts.SymbolFlags.Alias)
          original = checker.getAliasedSymbol(original);
        if (
          original?.name === "usePorts" &&
          original.declarations?.some(
            (decl) =>
              localPath(decl.getSourceFile().fileName) ===
              "shared/providers/PortsProvider.tsx",
          )
        )
          return "ports-factory";
        if (
          original?.name === "useRouteContext" &&
          original.declarations?.some((decl) =>
            normalize(decl.getSourceFile().fileName).includes("/@tanstack/"),
          )
        )
          return "context-factory";
        for (const decl of symbol?.declarations ?? []) {
          if (ts.isVariableDeclaration(decl) && decl.initializer) {
            const origin = capability(decl.initializer, seen);
            if (origin) return origin;
          }
          if (ts.isBindingElement(decl)) {
            if (decl.dotDotDotToken) return bindingOrigin(decl.parent, seen);
            const origin =
              member(bindingOrigin(decl.parent, seen), bindingKey(decl)) ??
              weakMember(decl.parent, bindingKey(decl));
            if (origin) return origin;
          }
          if (ts.isParameter(decl) && loaderParameter(decl)) return "loader";
        }
        for (const value of assignments.get(symbol) ?? []) {
          const origin = capability(value, seen);
          if (origin) return origin;
        }
      }
      if (ts.isObjectLiteralExpression(node)) {
        const shape = {};
        for (const prop of node.properties) {
          if (
            ts.isPropertyAssignment(prop) ||
            ts.isShorthandPropertyAssignment(prop)
          )
            shape[keyText(prop.name)] = capability(
              ts.isPropertyAssignment(prop) ? prop.initializer : prop.name,
              new Set(seen),
            );
          if (ts.isSpreadAssignment(prop)) {
            const origin = capability(prop.expression, new Set(seen));
            if (origin && typeof origin === "object")
              Object.assign(shape, origin);
          }
        }
        return shape;
      }
      if (ts.isArrayLiteralExpression(node))
        return Object.fromEntries(
          node.elements.map((element, index) => [
            String(index),
            capability(element, new Set(seen)),
          ]),
        );
      if (ts.isCallExpression(node)) {
        const callee = unwrap(node.expression);
        const factory = capability(callee, seen);
        if (factory === "ports-factory") return "ports";
        if (factory === "context-factory") return "context";
        let symbol = checker.getSymbolAtLocation(callee);
        if (symbol?.flags & ts.SymbolFlags.Alias)
          symbol = checker.getAliasedSymbol(symbol);
        if (
          symbol?.name === "usePorts" &&
          symbol.declarations?.some(
            (decl) =>
              localPath(decl.getSourceFile().fileName) ===
              "shared/providers/PortsProvider.tsx",
          )
        )
          return "ports";
        // Router hooks are capability entry points even with missing generated types.
        if (
          ts.isPropertyAccessExpression(callee) &&
          callee.name.text === "useRouteContext" &&
          routerOrigin(callee.expression)
        )
          return "context";
        if (
          symbol?.name === "useRouteContext" &&
          symbol.declarations?.some((decl) =>
            normalize(decl.getSourceFile().fileName).includes("/@tanstack/"),
          )
        )
          return "context";
      }
      const type = checker.getTypeAtLocation(node);
      for (const symbol of [type.aliasSymbol, type.getSymbol()]) {
        for (const decl of symbol?.declarations ?? []) {
          const origin = localPath(decl.getSourceFile().fileName);
          if (
            origin === "shared/ports/ApiClientPort.ts" &&
            symbol.name === "ApiClientPort"
          )
            return "api";
          if (
            origin === "shared/providers/PortsProvider.tsx" &&
            symbol.name === "Ports"
          )
            return "ports";
          if (origin === "router.ts" && symbol.name === "RouterContext")
            return "context";
          if (
            symbol.name === "QueryClient" &&
            normalize(decl.getSourceFile().fileName).includes(
              "/@tanstack/query-core/",
            )
          )
            return "query";
        }
      }
    }
    function inspectCapability(node) {
      let base, key;
      if (
        ts.isPropertyAccessExpression(node) ||
        ts.isElementAccessExpression(node)
      ) {
        base = capability(node.expression);
        key = ts.isPropertyAccessExpression(node)
          ? node.name.text
          : literalKey(node.argumentExpression);
      } else if (
        ts.isBindingElement(node) &&
        ts.isObjectBindingPattern(node.parent)
      ) {
        base = bindingOrigin(node.parent, new Set());
        key = keyText(node.propertyName ?? node.name);
      }
      if (
        composer &&
        (base === "query" ||
          (base === "context" && key === "queryClient") ||
          (key === "queryClient" &&
            weakMember(
              ts.isBindingElement(node) ? node.parent : node.expression,
              key,
            )))
      )
        report(
          node,
          "view-state",
          "QueryClient access belongs in a context-owned read helper or hook; weak/generated types and casts do not grant authority.",
        );
      if (composer && base === "api" && !exempt("capabilities", path, key))
        report(
          node,
          "view-api",
          `Move API access ${key ?? "[computed]"} into a context-owned read helper or hook; weak/generated types and casts do not grant authority.`,
        );
    }
    function inspect(node) {
      inspectCapability(node);
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
  for (const group of ["capabilities", "dependencies"])
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
    [...new Set([...parsed.fileNames, ...sourceFiles(resolve(root, "src"))])],
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
