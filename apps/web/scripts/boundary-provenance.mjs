import ts from "typescript";

// A syntax provenance value can carry both authority and a container shape.
// Joins are conservative: a harmless fallback cannot erase another branch's
// authority. Literal keys use the same expression/binding rules as values.
export function origin(kind) {
  return {
    kinds: new Set([kind]),
    keys: new Set(),
    unknownKeys: true,
    fields: new Map(),
  };
}

export function join(...values) {
  const present = values.filter(Boolean);
  if (!present.length) return undefined;
  const result = {
    kinds: new Set(),
    keys: new Set(),
    unknownKeys: false,
    fields: new Map(),
  };
  for (const value of present) {
    for (const kind of value.kinds) result.kinds.add(kind);
    for (const key of value.keys) result.keys.add(key);
    result.unknownKeys ||= value.unknownKeys;
    for (const [key, field] of value.fields)
      result.fields.set(key, join(result.fields.get(key), field));
  }
  return result;
}

export const hasKind = (value, kind) => value?.kinds.has(kind) ?? false;
export const unwrap = (node) => {
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

export function allKinds(value) {
  return value
    ? [...value.kinds, ...[...value.fields.values()].flatMap(allKinds)]
    : [];
}

export function createTracer(
  checker,
  source,
  {
    seed = () => undefined,
    member = () => undefined,
    forwardArguments = false,
  } = {},
) {
  const symbolOf = (node) =>
    ts.isIdentifier(node) && ts.isShorthandPropertyAssignment(node.parent)
      ? checker.getShorthandAssignmentValueSymbol(node.parent)
      : ts.isExportSpecifier(node.parent)
        ? checker.getExportSpecifierLocalTargetSymbol(node.parent)
        : checker.getSymbolAtLocation(node);
  const field = (keys, value) =>
    value && {
      kinds: new Set(),
      keys: new Set(),
      unknownKeys: true,
      fields: new Map((keys ?? [undefined]).map((key) => [key, value])),
    };
  const literal = (key) => ({
    kinds: new Set(),
    keys: new Set([String(key)]),
    unknownKeys: false,
    fields: new Map(),
  });
  const indexOf = (key) =>
    typeof key === "string" && /^(0|[1-9][0-9]*)$/.test(key)
      ? Number(key)
      : undefined;
  function arrayLength(value) {
    const length = value?.fields.get("length");
    if (!length || length.unknownKeys || length.keys.size !== 1)
      return undefined;
    const count = indexOf([...length.keys][0]);
    if (count === undefined || value.fields.has(undefined)) return undefined;
    return value.fields.size === count + 1 ? count : undefined;
  }
  function arrayRest(node, base, start) {
    let value;
    for (const [key, item] of base?.fields ?? []) {
      const index = indexOf(key);
      if (index !== undefined && index >= start)
        value = join(value, field([String(index - start)], item));
      if (key === undefined) value = join(value, field(undefined, item));
    }
    const length = arrayLength(base);
    if (length !== undefined)
      value = join(
        value,
        field(["length"], literal(Math.max(0, length - start))),
      );
    // Unknown iterable contents retain possible authority at every position.
    const unknown = join(
      ...[...(base?.kinds ?? [])].map(origin),
      member(node, base, undefined),
    );
    if (unknown) value = join(value, field(undefined, unknown));
    return value;
  }
  function select(node, base, keys) {
    const selected = keys
      ? keys.map((key) => base?.fields.get(key))
      : [...(base?.fields.values() ?? [])];
    return join(
      ...selected,
      base?.fields.get(undefined),
      member(node, base, keys),
    );
  }
  function iterableElement(node, base) {
    // Iteration yields elements, not the array's length or named properties.
    // Unknown iterable contents conservatively retain possible authority.
    return join(
      ...[...(base?.fields ?? [])]
        .filter(([key]) => key === undefined || indexOf(key) !== undefined)
        .map(([, value]) => value),
      ...[...(base?.kinds ?? [])].map(origin),
      member(node, base, undefined),
    );
  }
  function loopOf(declaration) {
    const list = declaration.parent;
    return ts.isVariableDeclarationList(list) &&
      ts.isForOfStatement(list.parent)
      ? list.parent
      : undefined;
  }
  function declarationValue(declaration, seen, writes) {
    const loop = loopOf(declaration);
    return loop
      ? iterableElement(loop, trace(loop.expression, new Set(seen), writes))
      : trace(declaration.initializer, new Set(seen), writes);
  }
  function expressionKeys(node, seen, writes) {
    const value = trace(node, new Set(seen), writes);
    return value?.keys.size && !value.unknownKeys ? [...value.keys] : undefined;
  }
  function propertyKeys(node, seen, writes) {
    if (ts.isComputedPropertyName(node))
      return expressionKeys(node.expression, seen, writes);
    if (
      ts.isIdentifier(node) ||
      ts.isStringLiteralLike(node) ||
      ts.isNumericLiteral(node)
    )
      return [node.text];
  }
  function bindingKeys(element, seen, writes) {
    return ts.isArrayBindingPattern(element.parent)
      ? [String(element.parent.elements.indexOf(element))]
      : propertyKeys(element.propertyName ?? element.name, seen, writes);
  }
  function bindingSource(pattern, seen = new Set(), writes = true) {
    const owner = pattern.parent;
    if (ts.isVariableDeclaration(owner))
      return declarationValue(owner, seen, writes);
    if (ts.isParameter(owner))
      return join(
        seed(owner, seen, writes),
        trace(owner.initializer, seen, writes),
      );
    if (ts.isBindingElement(owner)) return bindingValue(owner, seen, writes);
  }
  function bindingValue(element, seen, writes) {
    const base = bindingSource(element.parent, new Set(seen), writes);
    return join(
      element.dotDotDotToken
        ? ts.isArrayBindingPattern(element.parent)
          ? arrayRest(element, base, element.parent.elements.indexOf(element))
          : base
        : select(element, base, bindingKeys(element, seen, writes)),
      trace(element.initializer, new Set(seen), writes),
    );
  }

  // Match writes by declaration identity and member path, following local
  // aliases. Property spellings alone cannot join unrelated shadowed objects.
  function references(node, seen = new Set()) {
    node = unwrap(node);
    if (!node || seen.has(node)) return [];
    seen.add(node);
    if (ts.isObjectLiteralExpression(node) || ts.isArrayLiteralExpression(node))
      return [{ root: node, path: [] }];
    if (
      ts.isPropertyAccessExpression(node) ||
      ts.isElementAccessExpression(node)
    ) {
      const keys = ts.isPropertyAccessExpression(node)
        ? [node.name.text]
        : expressionKeys(node.argumentExpression, seen, false);
      return references(node.expression, seen).flatMap((ref) =>
        (keys ?? [undefined]).map((key) => ({
          root: ref.root,
          path: [...ref.path, key],
        })),
      );
    }
    if (ts.isIdentifier(node)) {
      const symbol = symbolOf(node);
      if (!symbol) return [];
      for (const decl of symbol.declarations ?? []) {
        if (ts.isVariableDeclaration(decl) && loopOf(decl)) {
          const refs = references(loopOf(decl).expression, new Set(seen));
          if (refs.length)
            return refs.map((ref) => ({
              ...ref,
              path: [...ref.path, undefined],
            }));
        }
        if (ts.isVariableDeclaration(decl) && decl.initializer) {
          const refs = references(decl.initializer, new Set(seen));
          if (refs.length) return refs;
        }
        if (ts.isBindingElement(decl)) {
          // Rest creates a new container; writes target that container rather
          // than the original iterable's unshifted member path.
          if (decl.dotDotDotToken) return [{ root: symbol, path: [] }];
          const owner = decl.parent.parent;
          const sourceNode = ts.isBindingElement(owner)
            ? owner.name
            : ts.isVariableDeclaration(owner) && loopOf(owner)
              ? loopOf(owner).expression
              : (owner.initializer ?? owner);
          const keys = bindingKeys(decl, seen, false);
          const refs = references(sourceNode, new Set(seen));
          if (refs.length)
            return refs.flatMap((ref) =>
              (keys ?? [undefined]).map((key) => ({
                root: ref.root,
                path: [
                  ...ref.path,
                  ...(ts.isVariableDeclaration(owner) && loopOf(owner)
                    ? [undefined]
                    : []),
                  key,
                ],
              })),
            );
        }
      }
      return [{ root: symbol, path: [] }];
    }
    if (ts.isConditionalExpression(node))
      return [
        ...references(node.whenTrue, new Set(seen)),
        ...references(node.whenFalse, new Set(seen)),
      ];
    if (ts.isBinaryExpression(node) && branches.has(node.operatorToken.kind))
      return [
        ...references(node.left, new Set(seen)),
        ...references(node.right, new Set(seen)),
      ];
    if (
      ts.isBinaryExpression(node) &&
      node.operatorToken.kind === ts.SyntaxKind.CommaToken
    )
      return references(node.right, seen);
    return [];
  }
  const branches = new Set([
    ts.SyntaxKind.QuestionQuestionToken,
    ts.SyntaxKind.BarBarToken,
    ts.SyntaxKind.AmpersandAmpersandToken,
  ]);
  const assignmentKinds = new Set([
    ts.SyntaxKind.EqualsToken,
    ts.SyntaxKind.QuestionQuestionEqualsToken,
    ts.SyntaxKind.BarBarEqualsToken,
    ts.SyntaxKind.AmpersandAmpersandEqualsToken,
  ]);
  const assignments = [];
  function assignmentTargets(left, right, projections = []) {
    left = unwrap(left);
    if (
      ts.isBinaryExpression(left) &&
      left.operatorToken.kind === ts.SyntaxKind.EqualsToken
    ) {
      assignmentTargets(left.left, right, [
        ...projections,
        { fallback: left.right },
      ]);
    } else if (ts.isObjectLiteralExpression(left)) {
      for (const prop of left.properties) {
        if (
          ts.isPropertyAssignment(prop) ||
          ts.isShorthandPropertyAssignment(prop)
        )
          assignmentTargets(
            ts.isPropertyAssignment(prop) ? prop.initializer : prop.name,
            right,
            [
              ...projections,
              {
                keyNode: prop.name,
                fallback: prop.objectAssignmentInitializer,
              },
            ],
          );
        if (ts.isSpreadAssignment(prop))
          assignmentTargets(prop.expression, right, projections);
      }
    } else if (ts.isArrayLiteralExpression(left)) {
      for (const [index, element] of left.elements.entries()) {
        if (ts.isOmittedExpression(element)) continue;
        assignmentTargets(
          ts.isSpreadElement(element) ? element.expression : element,
          right,
          [
            ...projections,
            ts.isSpreadElement(element)
              ? { rest: index }
              : { keys: [String(index)] },
          ],
        );
      }
    } else assignments.push({ left, right, projections });
  }
  function collect(node) {
    if (
      ts.isBinaryExpression(node) &&
      assignmentKinds.has(node.operatorToken.kind)
    )
      assignmentTargets(node.left, node.right);
    if (
      ts.isForOfStatement(node) &&
      !ts.isVariableDeclarationList(node.initializer)
    )
      assignmentTargets(node.initializer, node.expression, [{ iterate: true }]);
    ts.forEachChild(node, collect);
  }
  collect(source);
  let writesByRoot;
  function assignedValue(node, seen) {
    if (!assignments.length) return undefined;
    if (!writesByRoot) {
      writesByRoot = new Map();
      for (const assignment of assignments)
        for (const ref of references(assignment.left)) {
          const entries = writesByRoot.get(ref.root) ?? [];
          entries.push({
            path: ref.path,
            value: assignment.right,
            projections: assignment.projections,
          });
          writesByRoot.set(ref.root, entries);
        }
    }
    const results = [];
    for (const ref of references(node))
      for (const write of writesByRoot.get(ref.root) ?? []) {
        if (
          ref.path.some(
            (key, i) =>
              i >= write.path.length ||
              (key !== undefined &&
                write.path[i] !== undefined &&
                key !== write.path[i]),
          )
        )
          continue;
        let value = trace(write.value, new Set(seen));
        for (const projection of write.projections) {
          if (projection.iterate) value = iterableElement(node, value);
          if ("rest" in projection)
            value = arrayRest(node, value, projection.rest);
          if (projection.keyNode || "keys" in projection)
            value = select(
              node,
              value,
              projection.keyNode
                ? propertyKeys(projection.keyNode, seen, false)
                : projection.keys,
            );
          value = join(value, trace(projection.fallback, new Set(seen)));
        }
        for (const key of write.path.slice(ref.path.length).reverse())
          value = field([key], value);
        results.push(value);
      }
    return join(...results);
  }

  function trace(node, seen = new Set(), writes = true) {
    node = unwrap(node);
    if (!node || seen.has(node)) return undefined;
    seen.add(node);
    let value;
    if (ts.isStringLiteralLike(node) || ts.isNumericLiteral(node))
      return literal(node.text);
    if (ts.isAwaitExpression(node) || ts.isSpreadElement(node))
      value = trace(node.expression, new Set(seen), writes);
    else if (forwardArguments && ts.isCallExpression(node))
      value = join(
        ...node.arguments.map((argument) =>
          trace(argument, new Set(seen), writes),
        ),
      );
    else if (ts.isConditionalExpression(node))
      value = join(
        trace(node.whenTrue, new Set(seen), writes),
        trace(node.whenFalse, new Set(seen), writes),
      );
    else if (
      ts.isBinaryExpression(node) &&
      branches.has(node.operatorToken.kind)
    )
      value = join(
        trace(node.left, new Set(seen), writes),
        trace(node.right, new Set(seen), writes),
      );
    else if (
      ts.isBinaryExpression(node) &&
      (assignmentKinds.has(node.operatorToken.kind) ||
        node.operatorToken.kind === ts.SyntaxKind.CommaToken)
    )
      value = trace(node.right, new Set(seen), writes);
    else if (
      ts.isPropertyAccessExpression(node) ||
      ts.isElementAccessExpression(node)
    )
      value = select(
        node,
        trace(node.expression, new Set(seen), writes),
        ts.isPropertyAccessExpression(node)
          ? [node.name.text]
          : expressionKeys(node.argumentExpression, seen, writes),
      );
    else if (ts.isIdentifier(node)) {
      for (const decl of symbolOf(node)?.declarations ?? []) {
        if (ts.isVariableDeclaration(decl))
          value = join(value, declarationValue(decl, new Set(seen), writes));
        if (ts.isBindingElement(decl))
          value = join(value, bindingValue(decl, new Set(seen), writes));
      }
    } else if (ts.isObjectLiteralExpression(node)) {
      for (const prop of node.properties) {
        if (
          ts.isPropertyAssignment(prop) ||
          ts.isShorthandPropertyAssignment(prop)
        )
          value = join(
            value,
            field(
              propertyKeys(prop.name, seen, writes),
              trace(
                ts.isPropertyAssignment(prop) ? prop.initializer : prop.name,
                new Set(seen),
                writes,
              ),
            ),
          );
        if (ts.isSpreadAssignment(prop))
          value = join(value, trace(prop.expression, new Set(seen), writes));
      }
    } else if (ts.isArrayLiteralExpression(node)) {
      let offset = 0;
      for (const element of node.elements) {
        if (ts.isSpreadElement(element)) {
          const spread = trace(element.expression, new Set(seen), writes);
          const length = arrayLength(spread);
          if (offset !== undefined && length !== undefined) {
            for (let index = 0; index < length; index++)
              value = join(
                value,
                field(
                  [String(offset + index)],
                  spread.fields.get(String(index)),
                ),
              );
            offset += length;
          } else {
            value = join(
              value,
              field(
                undefined,
                join(
                  select(element, spread, undefined),
                  ...[...(spread?.kinds ?? [])].map(origin),
                ),
              ),
            );
            offset = undefined;
          }
        } else {
          value = join(
            value,
            field(
              offset === undefined ? undefined : [String(offset)],
              trace(element, new Set(seen), writes),
            ),
          );
          if (offset !== undefined) offset++;
        }
      }
      if (offset !== undefined)
        value = join(value, field(["length"], literal(offset)));
    }
    return (
      join(
        value,
        seed(node, seen, writes),
        writes ? assignedValue(node, seen) : undefined,
      ) ?? {
        kinds: new Set(),
        keys: new Set(),
        unknownKeys: true,
        fields: new Map(),
      }
    );
  }
  return { trace, bindingSource };
}
