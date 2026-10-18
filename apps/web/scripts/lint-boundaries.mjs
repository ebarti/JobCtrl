import { readFileSync, readdirSync } from "node:fs";
import { dirname, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import {
  allKinds,
  createTracer,
  hasKind,
  join,
  origin,
  unwrap,
} from "./boundary-provenance.mjs";

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
    const runtimeTrace = createTracer(checker, target, {
      // Exporting a forwarded runtime capability does not change its owner.
      // Composer calls use handoff diagnostics instead, preserving helper DTOs.
      forwardArguments: true,
      seed(node) {
        const symbol =
          ts.isIdentifier(node) && ts.isShorthandPropertyAssignment(node.parent)
            ? checker.getShorthandAssignmentValueSymbol(node.parent)
            : ts.isExportSpecifier(node.parent)
              ? checker.getExportSpecifierLocalTargetSymbol(node.parent)
              : checker.getSymbolAtLocation(node);
        const found = (symbol?.declarations ?? []).flatMap((decl) => {
          if (ts.isImportSpecifier(decl)) {
            const statement = decl.parent.parent.parent;
            if (decl.isTypeOnly || statement.importClause?.isTypeOnly)
              return [];
            return runtimeOrigins(
              statement.moduleSpecifier.text,
              [(decl.propertyName ?? decl.name).text],
              target,
              new Set(seen),
            );
          }
          if (ts.isNamespaceImport(decl) || ts.isImportClause(decl)) {
            const clause = ts.isNamespaceImport(decl) ? decl.parent : decl;
            if (clause.isTypeOnly) return [];
            if (ts.isNamespaceImport(decl))
              return [{ namespace: clause.parent.moduleSpecifier.text }];
            return runtimeOrigins(
              clause.parent.moduleSpecifier.text,
              ["default"],
              target,
              new Set(seen),
            );
          }
          return [];
        });
        return join(...found.map(origin));
      },
      member(_node, base, keys) {
        return join(
          ...runtimeRules([...(base?.kinds ?? [])], keys).map(origin),
        );
      },
    });
    function runtimeRules(kinds, keys = ["*"]) {
      return kinds.flatMap((kind) =>
        typeof kind === "string"
          ? [kind]
          : runtimeOrigins(kind.namespace, keys, target, new Set(seen)),
      );
    }
    const localOrigins = (node) =>
      runtimeRules(allKinds(runtimeTrace.trace(node)));
    function bindingNames(name) {
      return ts.isIdentifier(name)
        ? [name]
        : name.elements.flatMap((element) =>
            ts.isBindingElement(element) ? bindingNames(element.name) : [],
          );
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
          for (const name of bindingNames(decl.name))
            if (names.includes("*") || names.includes(name.text))
              origins.push(...localOrigins(name));
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
            origins.push(...localOrigins(item.propertyName ?? item.name));
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

    function keyText(node) {
      if (!node) return undefined;
      if (
        ts.isIdentifier(node) ||
        ts.isStringLiteralLike(node) ||
        ts.isNumericLiteral(node)
      )
        return node.text;
      if (ts.isComputedPropertyName(node)) return literalKey(node.expression);
    }
    function literalKeys(node) {
      const value = capabilityTrace.trace(node);
      return value?.keys.size && !value.unknownKeys
        ? [...value.keys]
        : undefined;
    }
    function literalKey(node) {
      const keys = literalKeys(node);
      return keys?.length === 1 ? keys[0] : undefined;
    }
    function weakMember(node, key) {
      if (!node) return undefined;
      const type = checker.getTypeAtLocation(node);
      if (!(type.flags & (ts.TypeFlags.Any | ts.TypeFlags.Unknown)))
        return undefined;
      const kind = {
        context: "context",
        ports: "ports",
        api: "api",
        queryClient: "query",
      }[key];
      return kind ? origin(kind) : undefined;
    }
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

    const slots = {
      loader: { context: "context" },
      context: { ports: "ports", queryClient: "query" },
      ports: { api: "api" },
    };
    const capabilityTrace = createTracer(checker, source, {
      seed: capabilitySeed,
      member(node, base, keys) {
        const values = [];
        for (const kind of base?.kinds ?? []) {
          const fields = slots[kind] ?? {};
          // Unknown computed access on a known capability container must not
          // grant authority. Retain all possible child capabilities.
          for (const key of keys ?? Object.keys(fields))
            if (fields[key]) values.push(origin(fields[key]));
        }
        for (const key of keys ?? [])
          values.push(
            weakMember(
              ts.isBindingElement(node) ? node.parent : node.expression,
              key,
            ),
          );
        return join(...values);
      },
    });
    const capability = (node) => capabilityTrace.trace(node);
    function capabilitySeed(node, seen, writes) {
      const values = [];
      if (ts.isParameter(node) && loaderParameter(node))
        values.push(origin("loader"));
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
          values.push(origin("ports-factory"));
        if (
          original?.name === "useRouteContext" &&
          original.declarations?.some((decl) =>
            normalize(decl.getSourceFile().fileName).includes("/@tanstack/"),
          )
        )
          values.push(origin("context-factory"));
        if (
          symbol?.declarations?.some(
            (decl) => ts.isParameter(decl) && loaderParameter(decl),
          )
        )
          values.push(origin("loader"));
      }
      if (ts.isCallExpression(node)) {
        const callee = unwrap(node.expression);
        const factory = capabilityTrace.trace(callee, new Set(seen), writes);
        if (hasKind(factory, "ports-factory")) values.push(origin("ports"));
        if (hasKind(factory, "context-factory")) values.push(origin("context"));
        if (
          ts.isPropertyAccessExpression(callee) &&
          callee.name.text === "useRouteContext" &&
          routerOrigin(callee.expression)
        )
          values.push(origin("context"));
      }
      const type = checker.getTypeAtLocation(node);
      for (const symbol of [type.aliasSymbol, type.getSymbol()]) {
        for (const decl of symbol?.declarations ?? []) {
          const path = localPath(decl.getSourceFile().fileName);
          if (
            path === "shared/ports/ApiClientPort.ts" &&
            symbol.name === "ApiClientPort"
          )
            values.push(origin("api"));
          if (
            path === "shared/providers/PortsProvider.tsx" &&
            symbol.name === "Ports"
          )
            values.push(origin("ports"));
          if (path === "router.ts" && symbol.name === "RouterContext")
            values.push(origin("context"));
          if (
            symbol.name === "QueryClient" &&
            normalize(decl.getSourceFile().fileName).includes(
              "/@tanstack/query-core/",
            )
          )
            values.push(origin("query"));
        }
      }
      return join(...values);
    }
    collectLoaders(source);

    function inspectCapability(node) {
      let base, keys, expression;
      if (
        ts.isPropertyAccessExpression(node) ||
        ts.isElementAccessExpression(node)
      ) {
        expression = node.expression;
        base = capability(expression);
        keys = ts.isPropertyAccessExpression(node)
          ? [node.name.text]
          : literalKeys(node.argumentExpression);
      } else if (
        ts.isBindingElement(node) &&
        ts.isObjectBindingPattern(node.parent)
      ) {
        base = capabilityTrace.bindingSource(node.parent);
        expression = node.parent;
        const key = keyText(node.propertyName ?? node.name);
        keys = key === undefined ? undefined : [key];
      } else return;
      const key = keys?.length === 1 ? keys[0] : undefined;
      if (
        composer &&
        (hasKind(base, "query") ||
          (hasKind(base, "context") &&
            (!keys || keys.includes("queryClient"))) ||
          (keys?.includes("queryClient") &&
            weakMember(expression, "queryClient")))
      )
        report(
          node,
          "view-state",
          "QueryClient access belongs in a context-owned read helper or hook; weak/generated types, computed keys and aliases do not grant authority.",
        );
      if (
        composer &&
        hasKind(base, "api") &&
        !exempt("capabilities", path, key)
      )
        report(
          node,
          "view-api",
          "Move API access " +
            (key ?? "[computed]") +
            " into a context-owned read helper or hook; weak/generated types, computed keys and aliases do not grant authority.",
        );
    }
    function contextHelper(node, seen = new Set()) {
      node = unwrap(node);
      if (!node || seen.has(node)) return false;
      seen.add(node);
      // Permission requires every alternative to have a known owner.
      if (ts.isConditionalExpression(node))
        return (
          contextHelper(node.whenTrue, new Set(seen)) &&
          contextHelper(node.whenFalse, new Set(seen))
        );
      let symbol = checker.getSymbolAtLocation(node);
      if (symbol?.flags & ts.SymbolFlags.Alias)
        symbol = checker.getAliasedSymbol(symbol);
      const declarations = symbol?.declarations ?? [];
      return (
        declarations.length > 0 &&
        declarations.every((decl) => {
          const file = localPath(decl.getSourceFile().fileName);
          if (
            context(file) &&
            !isSupport(file) &&
            (ts.isFunctionDeclaration(decl) ||
              (ts.isVariableDeclaration(decl) &&
                decl.initializer &&
                (ts.isArrowFunction(unwrap(decl.initializer)) ||
                  ts.isFunctionExpression(unwrap(decl.initializer)))))
          )
            return true;
          return (
            ts.isIdentifier(node) &&
            ts.isVariableDeclaration(decl) &&
            ts.isVariableDeclarationList(decl.parent) &&
            Boolean(decl.parent.flags & ts.NodeFlags.Const) &&
            contextHelper(decl.initializer, new Set(seen))
          );
        })
      );
    }
    function inspectHandoff(argument) {
      const kinds = allKinds(capability(argument));
      if (
        kinds.some((kind) =>
          ["api", "ports", "context", "loader"].includes(kind),
        )
      )
        report(
          argument,
          "view-api",
          "API capabilities and their containers may only be handed to a context-owned helper; route/view calls, returns and class fields cannot acquire API authority.",
        );
      if (kinds.some((kind) => ["query", "context", "loader"].includes(kind)))
        report(
          argument,
          "view-state",
          "QueryClient capabilities and their containers may only be handed to a context-owned helper; route/view calls, returns and class fields cannot acquire cache authority.",
        );
    }
    function writesReceiverField(target) {
      target = unwrap(target);
      if (!target) return false;
      if (
        ts.isPropertyAccessExpression(target) ||
        ts.isElementAccessExpression(target)
      ) {
        let receiver = unwrap(target.expression);
        while (
          receiver &&
          (ts.isPropertyAccessExpression(receiver) ||
            ts.isElementAccessExpression(receiver))
        )
          receiver = unwrap(receiver.expression);
        return receiver?.kind === ts.SyntaxKind.ThisKeyword;
      }
      if (ts.isArrayLiteralExpression(target))
        return target.elements.some(writesReceiverField);
      if (ts.isObjectLiteralExpression(target))
        return target.properties.some(
          (prop) =>
            (ts.isPropertyAssignment(prop) &&
              writesReceiverField(prop.initializer)) ||
            (ts.isSpreadAssignment(prop) &&
              writesReceiverField(prop.expression)),
        );
      if (ts.isSpreadElement(target))
        return writesReceiverField(target.expression);
      if (
        ts.isBinaryExpression(target) &&
        target.operatorToken.kind === ts.SyntaxKind.EqualsToken
      )
        return writesReceiverField(target.left);
      return false;
    }
    function inspect(node) {
      inspectCapability(node);
      // An arbitrary forwarding call must not erase API authority when its
      // return type is any. Only context-owned implementations may receive it.
      // Inspect the argument handoff, including containers and spread args,
      // without pretending that every function returns its arguments.
      if (
        composer &&
        (ts.isCallExpression(node) || ts.isNewExpression(node)) &&
        !contextHelper(node.expression)
      ) {
        for (const argument of node.arguments ?? []) {
          inspectHandoff(argument);
        }
      }
      if (composer && ts.isReturnStatement(node) && node.expression)
        inspectHandoff(node.expression);
      if (composer && ts.isArrowFunction(node) && !ts.isBlock(node.body))
        inspectHandoff(node.body);
      // A field annotated any hides its initializer from later instance reads.
      // Reject capability storage at the transfer, independently of field type.
      if (composer && ts.isPropertyDeclaration(node) && node.initializer)
        inspectHandoff(node.initializer);
      if (
        composer &&
        ts.isForOfStatement(node) &&
        !ts.isVariableDeclarationList(node.initializer) &&
        writesReceiverField(node.initializer)
      )
        inspectHandoff(node.expression);
      if (
        composer &&
        ts.isBinaryExpression(node) &&
        [
          ts.SyntaxKind.EqualsToken,
          ts.SyntaxKind.QuestionQuestionEqualsToken,
          ts.SyntaxKind.BarBarEqualsToken,
          ts.SyntaxKind.AmpersandAmpersandEqualsToken,
        ].includes(node.operatorToken.kind) &&
        writesReceiverField(node.left)
      )
        inspectHandoff(node.right);
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
