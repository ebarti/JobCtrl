var __create = Object.create;
var __defProp = Object.defineProperty;
var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __getProtoOf = Object.getPrototypeOf;
var __hasOwnProp = Object.prototype.hasOwnProperty;
var __commonJS = (cb, mod) => function __require() {
  try {
    return mod || (0, cb[__getOwnPropNames(cb)[0]])((mod = { exports: {} }).exports, mod), mod.exports;
  } catch (e) {
    throw mod = 0, e;
  }
};
var __copyProps = (to, from, except, desc) => {
  if (from && typeof from === "object" || typeof from === "function") {
    for (let key of __getOwnPropNames(from))
      if (!__hasOwnProp.call(to, key) && key !== except)
        __defProp(to, key, { get: () => from[key], enumerable: !(desc = __getOwnPropDesc(from, key)) || desc.enumerable });
  }
  return to;
};
var __toESM = (mod, isNodeMode, target) => (target = mod != null ? __create(__getProtoOf(mod)) : {}, __copyProps(
  // If the importer is in node compatibility mode or this is not an ESM
  // file that has been converted to a CommonJS file using a Babel-
  // compatible transform (i.e. "__esModule" has not been set), then set
  // "default" to the CommonJS "module.exports" for node compatibility.
  isNodeMode || !mod || !mod.__esModule ? __defProp(target, "default", { value: mod, enumerable: true }) : target,
  mod
));

// node_modules/.pnpm/ajv@8.20.0/node_modules/ajv/dist/compile/codegen/code.js
var require_code = __commonJS({
  "node_modules/.pnpm/ajv@8.20.0/node_modules/ajv/dist/compile/codegen/code.js"(exports) {
    "use strict";
    Object.defineProperty(exports, "__esModule", { value: true });
    exports.regexpCode = exports.getEsmExportName = exports.getProperty = exports.safeStringify = exports.stringify = exports.strConcat = exports.addCodeArg = exports.str = exports._ = exports.nil = exports._Code = exports.Name = exports.IDENTIFIER = exports._CodeOrName = void 0;
    var _CodeOrName = class {
    };
    exports._CodeOrName = _CodeOrName;
    exports.IDENTIFIER = /^[a-z$_][a-z$_0-9]*$/i;
    var Name = class extends _CodeOrName {
      constructor(s) {
        super();
        if (!exports.IDENTIFIER.test(s))
          throw new Error("CodeGen: name must be a valid identifier");
        this.str = s;
      }
      toString() {
        return this.str;
      }
      emptyStr() {
        return false;
      }
      get names() {
        return { [this.str]: 1 };
      }
    };
    exports.Name = Name;
    var _Code = class extends _CodeOrName {
      constructor(code) {
        super();
        this._items = typeof code === "string" ? [code] : code;
      }
      toString() {
        return this.str;
      }
      emptyStr() {
        if (this._items.length > 1)
          return false;
        const item = this._items[0];
        return item === "" || item === '""';
      }
      get str() {
        var _a;
        return (_a = this._str) !== null && _a !== void 0 ? _a : this._str = this._items.reduce((s, c) => `${s}${c}`, "");
      }
      get names() {
        var _a;
        return (_a = this._names) !== null && _a !== void 0 ? _a : this._names = this._items.reduce((names, c) => {
          if (c instanceof Name)
            names[c.str] = (names[c.str] || 0) + 1;
          return names;
        }, {});
      }
    };
    exports._Code = _Code;
    exports.nil = new _Code("");
    function _(strs, ...args) {
      const code = [strs[0]];
      let i = 0;
      while (i < args.length) {
        addCodeArg(code, args[i]);
        code.push(strs[++i]);
      }
      return new _Code(code);
    }
    exports._ = _;
    var plus = new _Code("+");
    function str(strs, ...args) {
      const expr = [safeStringify(strs[0])];
      let i = 0;
      while (i < args.length) {
        expr.push(plus);
        addCodeArg(expr, args[i]);
        expr.push(plus, safeStringify(strs[++i]));
      }
      optimize(expr);
      return new _Code(expr);
    }
    exports.str = str;
    function addCodeArg(code, arg) {
      if (arg instanceof _Code)
        code.push(...arg._items);
      else if (arg instanceof Name)
        code.push(arg);
      else
        code.push(interpolate(arg));
    }
    exports.addCodeArg = addCodeArg;
    function optimize(expr) {
      let i = 1;
      while (i < expr.length - 1) {
        if (expr[i] === plus) {
          const res = mergeExprItems(expr[i - 1], expr[i + 1]);
          if (res !== void 0) {
            expr.splice(i - 1, 3, res);
            continue;
          }
          expr[i++] = "+";
        }
        i++;
      }
    }
    function mergeExprItems(a, b) {
      if (b === '""')
        return a;
      if (a === '""')
        return b;
      if (typeof a == "string") {
        if (b instanceof Name || a[a.length - 1] !== '"')
          return;
        if (typeof b != "string")
          return `${a.slice(0, -1)}${b}"`;
        if (b[0] === '"')
          return a.slice(0, -1) + b.slice(1);
        return;
      }
      if (typeof b == "string" && b[0] === '"' && !(a instanceof Name))
        return `"${a}${b.slice(1)}`;
      return;
    }
    function strConcat(c1, c2) {
      return c2.emptyStr() ? c1 : c1.emptyStr() ? c2 : str`${c1}${c2}`;
    }
    exports.strConcat = strConcat;
    function interpolate(x) {
      return typeof x == "number" || typeof x == "boolean" || x === null ? x : safeStringify(Array.isArray(x) ? x.join(",") : x);
    }
    function stringify(x) {
      return new _Code(safeStringify(x));
    }
    exports.stringify = stringify;
    function safeStringify(x) {
      return JSON.stringify(x).replace(/\u2028/g, "\\u2028").replace(/\u2029/g, "\\u2029");
    }
    exports.safeStringify = safeStringify;
    function getProperty(key) {
      return typeof key == "string" && exports.IDENTIFIER.test(key) ? new _Code(`.${key}`) : _`[${key}]`;
    }
    exports.getProperty = getProperty;
    function getEsmExportName(key) {
      if (typeof key == "string" && exports.IDENTIFIER.test(key)) {
        return new _Code(`${key}`);
      }
      throw new Error(`CodeGen: invalid export name: ${key}, use explicit $id name mapping`);
    }
    exports.getEsmExportName = getEsmExportName;
    function regexpCode(rx) {
      return new _Code(rx.toString());
    }
    exports.regexpCode = regexpCode;
  }
});

// node_modules/.pnpm/ajv@8.20.0/node_modules/ajv/dist/compile/codegen/scope.js
var require_scope = __commonJS({
  "node_modules/.pnpm/ajv@8.20.0/node_modules/ajv/dist/compile/codegen/scope.js"(exports) {
    "use strict";
    Object.defineProperty(exports, "__esModule", { value: true });
    exports.ValueScope = exports.ValueScopeName = exports.Scope = exports.varKinds = exports.UsedValueState = void 0;
    var code_1 = require_code();
    var ValueError = class extends Error {
      constructor(name) {
        super(`CodeGen: "code" for ${name} not defined`);
        this.value = name.value;
      }
    };
    var UsedValueState;
    (function(UsedValueState2) {
      UsedValueState2[UsedValueState2["Started"] = 0] = "Started";
      UsedValueState2[UsedValueState2["Completed"] = 1] = "Completed";
    })(UsedValueState || (exports.UsedValueState = UsedValueState = {}));
    exports.varKinds = {
      const: new code_1.Name("const"),
      let: new code_1.Name("let"),
      var: new code_1.Name("var")
    };
    var Scope = class {
      constructor({ prefixes, parent } = {}) {
        this._names = {};
        this._prefixes = prefixes;
        this._parent = parent;
      }
      toName(nameOrPrefix) {
        return nameOrPrefix instanceof code_1.Name ? nameOrPrefix : this.name(nameOrPrefix);
      }
      name(prefix) {
        return new code_1.Name(this._newName(prefix));
      }
      _newName(prefix) {
        const ng = this._names[prefix] || this._nameGroup(prefix);
        return `${prefix}${ng.index++}`;
      }
      _nameGroup(prefix) {
        var _a, _b;
        if (((_b = (_a = this._parent) === null || _a === void 0 ? void 0 : _a._prefixes) === null || _b === void 0 ? void 0 : _b.has(prefix)) || this._prefixes && !this._prefixes.has(prefix)) {
          throw new Error(`CodeGen: prefix "${prefix}" is not allowed in this scope`);
        }
        return this._names[prefix] = { prefix, index: 0 };
      }
    };
    exports.Scope = Scope;
    var ValueScopeName = class extends code_1.Name {
      constructor(prefix, nameStr) {
        super(nameStr);
        this.prefix = prefix;
      }
      setValue(value, { property, itemIndex }) {
        this.value = value;
        this.scopePath = (0, code_1._)`.${new code_1.Name(property)}[${itemIndex}]`;
      }
    };
    exports.ValueScopeName = ValueScopeName;
    var line = (0, code_1._)`\n`;
    var ValueScope = class extends Scope {
      constructor(opts) {
        super(opts);
        this._values = {};
        this._scope = opts.scope;
        this.opts = { ...opts, _n: opts.lines ? line : code_1.nil };
      }
      get() {
        return this._scope;
      }
      name(prefix) {
        return new ValueScopeName(prefix, this._newName(prefix));
      }
      value(nameOrPrefix, value) {
        var _a;
        if (value.ref === void 0)
          throw new Error("CodeGen: ref must be passed in value");
        const name = this.toName(nameOrPrefix);
        const { prefix } = name;
        const valueKey = (_a = value.key) !== null && _a !== void 0 ? _a : value.ref;
        let vs = this._values[prefix];
        if (vs) {
          const _name = vs.get(valueKey);
          if (_name)
            return _name;
        } else {
          vs = this._values[prefix] = /* @__PURE__ */ new Map();
        }
        vs.set(valueKey, name);
        const s = this._scope[prefix] || (this._scope[prefix] = []);
        const itemIndex = s.length;
        s[itemIndex] = value.ref;
        name.setValue(value, { property: prefix, itemIndex });
        return name;
      }
      getValue(prefix, keyOrRef) {
        const vs = this._values[prefix];
        if (!vs)
          return;
        return vs.get(keyOrRef);
      }
      scopeRefs(scopeName, values = this._values) {
        return this._reduceValues(values, (name) => {
          if (name.scopePath === void 0)
            throw new Error(`CodeGen: name "${name}" has no value`);
          return (0, code_1._)`${scopeName}${name.scopePath}`;
        });
      }
      scopeCode(values = this._values, usedValues, getCode) {
        return this._reduceValues(values, (name) => {
          if (name.value === void 0)
            throw new Error(`CodeGen: name "${name}" has no value`);
          return name.value.code;
        }, usedValues, getCode);
      }
      _reduceValues(values, valueCode, usedValues = {}, getCode) {
        let code = code_1.nil;
        for (const prefix in values) {
          const vs = values[prefix];
          if (!vs)
            continue;
          const nameSet = usedValues[prefix] = usedValues[prefix] || /* @__PURE__ */ new Map();
          vs.forEach((name) => {
            if (nameSet.has(name))
              return;
            nameSet.set(name, UsedValueState.Started);
            let c = valueCode(name);
            if (c) {
              const def = this.opts.es5 ? exports.varKinds.var : exports.varKinds.const;
              code = (0, code_1._)`${code}${def} ${name} = ${c};${this.opts._n}`;
            } else if (c = getCode === null || getCode === void 0 ? void 0 : getCode(name)) {
              code = (0, code_1._)`${code}${c}${this.opts._n}`;
            } else {
              throw new ValueError(name);
            }
            nameSet.set(name, UsedValueState.Completed);
          });
        }
        return code;
      }
    };
    exports.ValueScope = ValueScope;
  }
});

// node_modules/.pnpm/ajv@8.20.0/node_modules/ajv/dist/compile/codegen/index.js
var require_codegen = __commonJS({
  "node_modules/.pnpm/ajv@8.20.0/node_modules/ajv/dist/compile/codegen/index.js"(exports) {
    "use strict";
    Object.defineProperty(exports, "__esModule", { value: true });
    exports.or = exports.and = exports.not = exports.CodeGen = exports.operators = exports.varKinds = exports.ValueScopeName = exports.ValueScope = exports.Scope = exports.Name = exports.regexpCode = exports.stringify = exports.getProperty = exports.nil = exports.strConcat = exports.str = exports._ = void 0;
    var code_1 = require_code();
    var scope_1 = require_scope();
    var code_2 = require_code();
    Object.defineProperty(exports, "_", { enumerable: true, get: function() {
      return code_2._;
    } });
    Object.defineProperty(exports, "str", { enumerable: true, get: function() {
      return code_2.str;
    } });
    Object.defineProperty(exports, "strConcat", { enumerable: true, get: function() {
      return code_2.strConcat;
    } });
    Object.defineProperty(exports, "nil", { enumerable: true, get: function() {
      return code_2.nil;
    } });
    Object.defineProperty(exports, "getProperty", { enumerable: true, get: function() {
      return code_2.getProperty;
    } });
    Object.defineProperty(exports, "stringify", { enumerable: true, get: function() {
      return code_2.stringify;
    } });
    Object.defineProperty(exports, "regexpCode", { enumerable: true, get: function() {
      return code_2.regexpCode;
    } });
    Object.defineProperty(exports, "Name", { enumerable: true, get: function() {
      return code_2.Name;
    } });
    var scope_2 = require_scope();
    Object.defineProperty(exports, "Scope", { enumerable: true, get: function() {
      return scope_2.Scope;
    } });
    Object.defineProperty(exports, "ValueScope", { enumerable: true, get: function() {
      return scope_2.ValueScope;
    } });
    Object.defineProperty(exports, "ValueScopeName", { enumerable: true, get: function() {
      return scope_2.ValueScopeName;
    } });
    Object.defineProperty(exports, "varKinds", { enumerable: true, get: function() {
      return scope_2.varKinds;
    } });
    exports.operators = {
      GT: new code_1._Code(">"),
      GTE: new code_1._Code(">="),
      LT: new code_1._Code("<"),
      LTE: new code_1._Code("<="),
      EQ: new code_1._Code("==="),
      NEQ: new code_1._Code("!=="),
      NOT: new code_1._Code("!"),
      OR: new code_1._Code("||"),
      AND: new code_1._Code("&&"),
      ADD: new code_1._Code("+")
    };
    var Node = class {
      optimizeNodes() {
        return this;
      }
      optimizeNames(_names, _constants) {
        return this;
      }
    };
    var Def = class extends Node {
      constructor(varKind, name, rhs) {
        super();
        this.varKind = varKind;
        this.name = name;
        this.rhs = rhs;
      }
      render({ es5, _n }) {
        const varKind = es5 ? scope_1.varKinds.var : this.varKind;
        const rhs = this.rhs === void 0 ? "" : ` = ${this.rhs}`;
        return `${varKind} ${this.name}${rhs};` + _n;
      }
      optimizeNames(names, constants) {
        if (!names[this.name.str])
          return;
        if (this.rhs)
          this.rhs = optimizeExpr(this.rhs, names, constants);
        return this;
      }
      get names() {
        return this.rhs instanceof code_1._CodeOrName ? this.rhs.names : {};
      }
    };
    var Assign = class extends Node {
      constructor(lhs, rhs, sideEffects) {
        super();
        this.lhs = lhs;
        this.rhs = rhs;
        this.sideEffects = sideEffects;
      }
      render({ _n }) {
        return `${this.lhs} = ${this.rhs};` + _n;
      }
      optimizeNames(names, constants) {
        if (this.lhs instanceof code_1.Name && !names[this.lhs.str] && !this.sideEffects)
          return;
        this.rhs = optimizeExpr(this.rhs, names, constants);
        return this;
      }
      get names() {
        const names = this.lhs instanceof code_1.Name ? {} : { ...this.lhs.names };
        return addExprNames(names, this.rhs);
      }
    };
    var AssignOp = class extends Assign {
      constructor(lhs, op, rhs, sideEffects) {
        super(lhs, rhs, sideEffects);
        this.op = op;
      }
      render({ _n }) {
        return `${this.lhs} ${this.op}= ${this.rhs};` + _n;
      }
    };
    var Label = class extends Node {
      constructor(label) {
        super();
        this.label = label;
        this.names = {};
      }
      render({ _n }) {
        return `${this.label}:` + _n;
      }
    };
    var Break = class extends Node {
      constructor(label) {
        super();
        this.label = label;
        this.names = {};
      }
      render({ _n }) {
        const label = this.label ? ` ${this.label}` : "";
        return `break${label};` + _n;
      }
    };
    var Throw = class extends Node {
      constructor(error) {
        super();
        this.error = error;
      }
      render({ _n }) {
        return `throw ${this.error};` + _n;
      }
      get names() {
        return this.error.names;
      }
    };
    var AnyCode = class extends Node {
      constructor(code) {
        super();
        this.code = code;
      }
      render({ _n }) {
        return `${this.code};` + _n;
      }
      optimizeNodes() {
        return `${this.code}` ? this : void 0;
      }
      optimizeNames(names, constants) {
        this.code = optimizeExpr(this.code, names, constants);
        return this;
      }
      get names() {
        return this.code instanceof code_1._CodeOrName ? this.code.names : {};
      }
    };
    var ParentNode = class extends Node {
      constructor(nodes = []) {
        super();
        this.nodes = nodes;
      }
      render(opts) {
        return this.nodes.reduce((code, n) => code + n.render(opts), "");
      }
      optimizeNodes() {
        const { nodes } = this;
        let i = nodes.length;
        while (i--) {
          const n = nodes[i].optimizeNodes();
          if (Array.isArray(n))
            nodes.splice(i, 1, ...n);
          else if (n)
            nodes[i] = n;
          else
            nodes.splice(i, 1);
        }
        return nodes.length > 0 ? this : void 0;
      }
      optimizeNames(names, constants) {
        const { nodes } = this;
        let i = nodes.length;
        while (i--) {
          const n = nodes[i];
          if (n.optimizeNames(names, constants))
            continue;
          subtractNames(names, n.names);
          nodes.splice(i, 1);
        }
        return nodes.length > 0 ? this : void 0;
      }
      get names() {
        return this.nodes.reduce((names, n) => addNames(names, n.names), {});
      }
    };
    var BlockNode = class extends ParentNode {
      render(opts) {
        return "{" + opts._n + super.render(opts) + "}" + opts._n;
      }
    };
    var Root = class extends ParentNode {
    };
    var Else = class extends BlockNode {
    };
    Else.kind = "else";
    var If = class _If extends BlockNode {
      constructor(condition, nodes) {
        super(nodes);
        this.condition = condition;
      }
      render(opts) {
        let code = `if(${this.condition})` + super.render(opts);
        if (this.else)
          code += "else " + this.else.render(opts);
        return code;
      }
      optimizeNodes() {
        super.optimizeNodes();
        const cond = this.condition;
        if (cond === true)
          return this.nodes;
        let e = this.else;
        if (e) {
          const ns = e.optimizeNodes();
          e = this.else = Array.isArray(ns) ? new Else(ns) : ns;
        }
        if (e) {
          if (cond === false)
            return e instanceof _If ? e : e.nodes;
          if (this.nodes.length)
            return this;
          return new _If(not(cond), e instanceof _If ? [e] : e.nodes);
        }
        if (cond === false || !this.nodes.length)
          return void 0;
        return this;
      }
      optimizeNames(names, constants) {
        var _a;
        this.else = (_a = this.else) === null || _a === void 0 ? void 0 : _a.optimizeNames(names, constants);
        if (!(super.optimizeNames(names, constants) || this.else))
          return;
        this.condition = optimizeExpr(this.condition, names, constants);
        return this;
      }
      get names() {
        const names = super.names;
        addExprNames(names, this.condition);
        if (this.else)
          addNames(names, this.else.names);
        return names;
      }
    };
    If.kind = "if";
    var For = class extends BlockNode {
    };
    For.kind = "for";
    var ForLoop = class extends For {
      constructor(iteration) {
        super();
        this.iteration = iteration;
      }
      render(opts) {
        return `for(${this.iteration})` + super.render(opts);
      }
      optimizeNames(names, constants) {
        if (!super.optimizeNames(names, constants))
          return;
        this.iteration = optimizeExpr(this.iteration, names, constants);
        return this;
      }
      get names() {
        return addNames(super.names, this.iteration.names);
      }
    };
    var ForRange = class extends For {
      constructor(varKind, name, from, to) {
        super();
        this.varKind = varKind;
        this.name = name;
        this.from = from;
        this.to = to;
      }
      render(opts) {
        const varKind = opts.es5 ? scope_1.varKinds.var : this.varKind;
        const { name, from, to } = this;
        return `for(${varKind} ${name}=${from}; ${name}<${to}; ${name}++)` + super.render(opts);
      }
      get names() {
        const names = addExprNames(super.names, this.from);
        return addExprNames(names, this.to);
      }
    };
    var ForIter = class extends For {
      constructor(loop, varKind, name, iterable) {
        super();
        this.loop = loop;
        this.varKind = varKind;
        this.name = name;
        this.iterable = iterable;
      }
      render(opts) {
        return `for(${this.varKind} ${this.name} ${this.loop} ${this.iterable})` + super.render(opts);
      }
      optimizeNames(names, constants) {
        if (!super.optimizeNames(names, constants))
          return;
        this.iterable = optimizeExpr(this.iterable, names, constants);
        return this;
      }
      get names() {
        return addNames(super.names, this.iterable.names);
      }
    };
    var Func = class extends BlockNode {
      constructor(name, args, async) {
        super();
        this.name = name;
        this.args = args;
        this.async = async;
      }
      render(opts) {
        const _async = this.async ? "async " : "";
        return `${_async}function ${this.name}(${this.args})` + super.render(opts);
      }
    };
    Func.kind = "func";
    var Return = class extends ParentNode {
      render(opts) {
        return "return " + super.render(opts);
      }
    };
    Return.kind = "return";
    var Try = class extends BlockNode {
      render(opts) {
        let code = "try" + super.render(opts);
        if (this.catch)
          code += this.catch.render(opts);
        if (this.finally)
          code += this.finally.render(opts);
        return code;
      }
      optimizeNodes() {
        var _a, _b;
        super.optimizeNodes();
        (_a = this.catch) === null || _a === void 0 ? void 0 : _a.optimizeNodes();
        (_b = this.finally) === null || _b === void 0 ? void 0 : _b.optimizeNodes();
        return this;
      }
      optimizeNames(names, constants) {
        var _a, _b;
        super.optimizeNames(names, constants);
        (_a = this.catch) === null || _a === void 0 ? void 0 : _a.optimizeNames(names, constants);
        (_b = this.finally) === null || _b === void 0 ? void 0 : _b.optimizeNames(names, constants);
        return this;
      }
      get names() {
        const names = super.names;
        if (this.catch)
          addNames(names, this.catch.names);
        if (this.finally)
          addNames(names, this.finally.names);
        return names;
      }
    };
    var Catch = class extends BlockNode {
      constructor(error) {
        super();
        this.error = error;
      }
      render(opts) {
        return `catch(${this.error})` + super.render(opts);
      }
    };
    Catch.kind = "catch";
    var Finally = class extends BlockNode {
      render(opts) {
        return "finally" + super.render(opts);
      }
    };
    Finally.kind = "finally";
    var CodeGen = class {
      constructor(extScope, opts = {}) {
        this._values = {};
        this._blockStarts = [];
        this._constants = {};
        this.opts = { ...opts, _n: opts.lines ? "\n" : "" };
        this._extScope = extScope;
        this._scope = new scope_1.Scope({ parent: extScope });
        this._nodes = [new Root()];
      }
      toString() {
        return this._root.render(this.opts);
      }
      // returns unique name in the internal scope
      name(prefix) {
        return this._scope.name(prefix);
      }
      // reserves unique name in the external scope
      scopeName(prefix) {
        return this._extScope.name(prefix);
      }
      // reserves unique name in the external scope and assigns value to it
      scopeValue(prefixOrName, value) {
        const name = this._extScope.value(prefixOrName, value);
        const vs = this._values[name.prefix] || (this._values[name.prefix] = /* @__PURE__ */ new Set());
        vs.add(name);
        return name;
      }
      getScopeValue(prefix, keyOrRef) {
        return this._extScope.getValue(prefix, keyOrRef);
      }
      // return code that assigns values in the external scope to the names that are used internally
      // (same names that were returned by gen.scopeName or gen.scopeValue)
      scopeRefs(scopeName) {
        return this._extScope.scopeRefs(scopeName, this._values);
      }
      scopeCode() {
        return this._extScope.scopeCode(this._values);
      }
      _def(varKind, nameOrPrefix, rhs, constant) {
        const name = this._scope.toName(nameOrPrefix);
        if (rhs !== void 0 && constant)
          this._constants[name.str] = rhs;
        this._leafNode(new Def(varKind, name, rhs));
        return name;
      }
      // `const` declaration (`var` in es5 mode)
      const(nameOrPrefix, rhs, _constant) {
        return this._def(scope_1.varKinds.const, nameOrPrefix, rhs, _constant);
      }
      // `let` declaration with optional assignment (`var` in es5 mode)
      let(nameOrPrefix, rhs, _constant) {
        return this._def(scope_1.varKinds.let, nameOrPrefix, rhs, _constant);
      }
      // `var` declaration with optional assignment
      var(nameOrPrefix, rhs, _constant) {
        return this._def(scope_1.varKinds.var, nameOrPrefix, rhs, _constant);
      }
      // assignment code
      assign(lhs, rhs, sideEffects) {
        return this._leafNode(new Assign(lhs, rhs, sideEffects));
      }
      // `+=` code
      add(lhs, rhs) {
        return this._leafNode(new AssignOp(lhs, exports.operators.ADD, rhs));
      }
      // appends passed SafeExpr to code or executes Block
      code(c) {
        if (typeof c == "function")
          c();
        else if (c !== code_1.nil)
          this._leafNode(new AnyCode(c));
        return this;
      }
      // returns code for object literal for the passed argument list of key-value pairs
      object(...keyValues) {
        const code = ["{"];
        for (const [key, value] of keyValues) {
          if (code.length > 1)
            code.push(",");
          code.push(key);
          if (key !== value || this.opts.es5) {
            code.push(":");
            (0, code_1.addCodeArg)(code, value);
          }
        }
        code.push("}");
        return new code_1._Code(code);
      }
      // `if` clause (or statement if `thenBody` and, optionally, `elseBody` are passed)
      if(condition, thenBody, elseBody) {
        this._blockNode(new If(condition));
        if (thenBody && elseBody) {
          this.code(thenBody).else().code(elseBody).endIf();
        } else if (thenBody) {
          this.code(thenBody).endIf();
        } else if (elseBody) {
          throw new Error('CodeGen: "else" body without "then" body');
        }
        return this;
      }
      // `else if` clause - invalid without `if` or after `else` clauses
      elseIf(condition) {
        return this._elseNode(new If(condition));
      }
      // `else` clause - only valid after `if` or `else if` clauses
      else() {
        return this._elseNode(new Else());
      }
      // end `if` statement (needed if gen.if was used only with condition)
      endIf() {
        return this._endBlockNode(If, Else);
      }
      _for(node, forBody) {
        this._blockNode(node);
        if (forBody)
          this.code(forBody).endFor();
        return this;
      }
      // a generic `for` clause (or statement if `forBody` is passed)
      for(iteration, forBody) {
        return this._for(new ForLoop(iteration), forBody);
      }
      // `for` statement for a range of values
      forRange(nameOrPrefix, from, to, forBody, varKind = this.opts.es5 ? scope_1.varKinds.var : scope_1.varKinds.let) {
        const name = this._scope.toName(nameOrPrefix);
        return this._for(new ForRange(varKind, name, from, to), () => forBody(name));
      }
      // `for-of` statement (in es5 mode replace with a normal for loop)
      forOf(nameOrPrefix, iterable, forBody, varKind = scope_1.varKinds.const) {
        const name = this._scope.toName(nameOrPrefix);
        if (this.opts.es5) {
          const arr = iterable instanceof code_1.Name ? iterable : this.var("_arr", iterable);
          return this.forRange("_i", 0, (0, code_1._)`${arr}.length`, (i) => {
            this.var(name, (0, code_1._)`${arr}[${i}]`);
            forBody(name);
          });
        }
        return this._for(new ForIter("of", varKind, name, iterable), () => forBody(name));
      }
      // `for-in` statement.
      // With option `ownProperties` replaced with a `for-of` loop for object keys
      forIn(nameOrPrefix, obj, forBody, varKind = this.opts.es5 ? scope_1.varKinds.var : scope_1.varKinds.const) {
        if (this.opts.ownProperties) {
          return this.forOf(nameOrPrefix, (0, code_1._)`Object.keys(${obj})`, forBody);
        }
        const name = this._scope.toName(nameOrPrefix);
        return this._for(new ForIter("in", varKind, name, obj), () => forBody(name));
      }
      // end `for` loop
      endFor() {
        return this._endBlockNode(For);
      }
      // `label` statement
      label(label) {
        return this._leafNode(new Label(label));
      }
      // `break` statement
      break(label) {
        return this._leafNode(new Break(label));
      }
      // `return` statement
      return(value) {
        const node = new Return();
        this._blockNode(node);
        this.code(value);
        if (node.nodes.length !== 1)
          throw new Error('CodeGen: "return" should have one node');
        return this._endBlockNode(Return);
      }
      // `try` statement
      try(tryBody, catchCode, finallyCode) {
        if (!catchCode && !finallyCode)
          throw new Error('CodeGen: "try" without "catch" and "finally"');
        const node = new Try();
        this._blockNode(node);
        this.code(tryBody);
        if (catchCode) {
          const error = this.name("e");
          this._currNode = node.catch = new Catch(error);
          catchCode(error);
        }
        if (finallyCode) {
          this._currNode = node.finally = new Finally();
          this.code(finallyCode);
        }
        return this._endBlockNode(Catch, Finally);
      }
      // `throw` statement
      throw(error) {
        return this._leafNode(new Throw(error));
      }
      // start self-balancing block
      block(body, nodeCount) {
        this._blockStarts.push(this._nodes.length);
        if (body)
          this.code(body).endBlock(nodeCount);
        return this;
      }
      // end the current self-balancing block
      endBlock(nodeCount) {
        const len = this._blockStarts.pop();
        if (len === void 0)
          throw new Error("CodeGen: not in self-balancing block");
        const toClose = this._nodes.length - len;
        if (toClose < 0 || nodeCount !== void 0 && toClose !== nodeCount) {
          throw new Error(`CodeGen: wrong number of nodes: ${toClose} vs ${nodeCount} expected`);
        }
        this._nodes.length = len;
        return this;
      }
      // `function` heading (or definition if funcBody is passed)
      func(name, args = code_1.nil, async, funcBody) {
        this._blockNode(new Func(name, args, async));
        if (funcBody)
          this.code(funcBody).endFunc();
        return this;
      }
      // end function definition
      endFunc() {
        return this._endBlockNode(Func);
      }
      optimize(n = 1) {
        while (n-- > 0) {
          this._root.optimizeNodes();
          this._root.optimizeNames(this._root.names, this._constants);
        }
      }
      _leafNode(node) {
        this._currNode.nodes.push(node);
        return this;
      }
      _blockNode(node) {
        this._currNode.nodes.push(node);
        this._nodes.push(node);
      }
      _endBlockNode(N1, N2) {
        const n = this._currNode;
        if (n instanceof N1 || N2 && n instanceof N2) {
          this._nodes.pop();
          return this;
        }
        throw new Error(`CodeGen: not in block "${N2 ? `${N1.kind}/${N2.kind}` : N1.kind}"`);
      }
      _elseNode(node) {
        const n = this._currNode;
        if (!(n instanceof If)) {
          throw new Error('CodeGen: "else" without "if"');
        }
        this._currNode = n.else = node;
        return this;
      }
      get _root() {
        return this._nodes[0];
      }
      get _currNode() {
        const ns = this._nodes;
        return ns[ns.length - 1];
      }
      set _currNode(node) {
        const ns = this._nodes;
        ns[ns.length - 1] = node;
      }
    };
    exports.CodeGen = CodeGen;
    function addNames(names, from) {
      for (const n in from)
        names[n] = (names[n] || 0) + (from[n] || 0);
      return names;
    }
    function addExprNames(names, from) {
      return from instanceof code_1._CodeOrName ? addNames(names, from.names) : names;
    }
    function optimizeExpr(expr, names, constants) {
      if (expr instanceof code_1.Name)
        return replaceName(expr);
      if (!canOptimize(expr))
        return expr;
      return new code_1._Code(expr._items.reduce((items, c) => {
        if (c instanceof code_1.Name)
          c = replaceName(c);
        if (c instanceof code_1._Code)
          items.push(...c._items);
        else
          items.push(c);
        return items;
      }, []));
      function replaceName(n) {
        const c = constants[n.str];
        if (c === void 0 || names[n.str] !== 1)
          return n;
        delete names[n.str];
        return c;
      }
      function canOptimize(e) {
        return e instanceof code_1._Code && e._items.some((c) => c instanceof code_1.Name && names[c.str] === 1 && constants[c.str] !== void 0);
      }
    }
    function subtractNames(names, from) {
      for (const n in from)
        names[n] = (names[n] || 0) - (from[n] || 0);
    }
    function not(x) {
      return typeof x == "boolean" || typeof x == "number" || x === null ? !x : (0, code_1._)`!${par(x)}`;
    }
    exports.not = not;
    var andCode = mappend(exports.operators.AND);
    function and(...args) {
      return args.reduce(andCode);
    }
    exports.and = and;
    var orCode = mappend(exports.operators.OR);
    function or(...args) {
      return args.reduce(orCode);
    }
    exports.or = or;
    function mappend(op) {
      return (x, y) => x === code_1.nil ? y : y === code_1.nil ? x : (0, code_1._)`${par(x)} ${op} ${par(y)}`;
    }
    function par(x) {
      return x instanceof code_1.Name ? x : (0, code_1._)`(${x})`;
    }
  }
});

// node_modules/.pnpm/ajv@8.20.0/node_modules/ajv/dist/compile/util.js
var require_util = __commonJS({
  "node_modules/.pnpm/ajv@8.20.0/node_modules/ajv/dist/compile/util.js"(exports) {
    "use strict";
    Object.defineProperty(exports, "__esModule", { value: true });
    exports.checkStrictMode = exports.getErrorPath = exports.Type = exports.useFunc = exports.setEvaluated = exports.evaluatedPropsToName = exports.mergeEvaluated = exports.eachItem = exports.unescapeJsonPointer = exports.escapeJsonPointer = exports.escapeFragment = exports.unescapeFragment = exports.schemaRefOrVal = exports.schemaHasRulesButRef = exports.schemaHasRules = exports.checkUnknownRules = exports.alwaysValidSchema = exports.toHash = void 0;
    var codegen_1 = require_codegen();
    var code_1 = require_code();
    function toHash(arr) {
      const hash = {};
      for (const item of arr)
        hash[item] = true;
      return hash;
    }
    exports.toHash = toHash;
    function alwaysValidSchema(it, schema) {
      if (typeof schema == "boolean")
        return schema;
      if (Object.keys(schema).length === 0)
        return true;
      checkUnknownRules(it, schema);
      return !schemaHasRules(schema, it.self.RULES.all);
    }
    exports.alwaysValidSchema = alwaysValidSchema;
    function checkUnknownRules(it, schema = it.schema) {
      const { opts, self } = it;
      if (!opts.strictSchema)
        return;
      if (typeof schema === "boolean")
        return;
      const rules = self.RULES.keywords;
      for (const key in schema) {
        if (!rules[key])
          checkStrictMode(it, `unknown keyword: "${key}"`);
      }
    }
    exports.checkUnknownRules = checkUnknownRules;
    function schemaHasRules(schema, rules) {
      if (typeof schema == "boolean")
        return !schema;
      for (const key in schema)
        if (rules[key])
          return true;
      return false;
    }
    exports.schemaHasRules = schemaHasRules;
    function schemaHasRulesButRef(schema, RULES) {
      if (typeof schema == "boolean")
        return !schema;
      for (const key in schema)
        if (key !== "$ref" && RULES.all[key])
          return true;
      return false;
    }
    exports.schemaHasRulesButRef = schemaHasRulesButRef;
    function schemaRefOrVal({ topSchemaRef, schemaPath }, schema, keyword, $data) {
      if (!$data) {
        if (typeof schema == "number" || typeof schema == "boolean")
          return schema;
        if (typeof schema == "string")
          return (0, codegen_1._)`${schema}`;
      }
      return (0, codegen_1._)`${topSchemaRef}${schemaPath}${(0, codegen_1.getProperty)(keyword)}`;
    }
    exports.schemaRefOrVal = schemaRefOrVal;
    function unescapeFragment(str) {
      return unescapeJsonPointer(decodeURIComponent(str));
    }
    exports.unescapeFragment = unescapeFragment;
    function escapeFragment(str) {
      return encodeURIComponent(escapeJsonPointer(str));
    }
    exports.escapeFragment = escapeFragment;
    function escapeJsonPointer(str) {
      if (typeof str == "number")
        return `${str}`;
      return str.replace(/~/g, "~0").replace(/\//g, "~1");
    }
    exports.escapeJsonPointer = escapeJsonPointer;
    function unescapeJsonPointer(str) {
      return str.replace(/~1/g, "/").replace(/~0/g, "~");
    }
    exports.unescapeJsonPointer = unescapeJsonPointer;
    function eachItem(xs, f) {
      if (Array.isArray(xs)) {
        for (const x of xs)
          f(x);
      } else {
        f(xs);
      }
    }
    exports.eachItem = eachItem;
    function makeMergeEvaluated({ mergeNames, mergeToName, mergeValues, resultToName }) {
      return (gen, from, to, toName) => {
        const res = to === void 0 ? from : to instanceof codegen_1.Name ? (from instanceof codegen_1.Name ? mergeNames(gen, from, to) : mergeToName(gen, from, to), to) : from instanceof codegen_1.Name ? (mergeToName(gen, to, from), from) : mergeValues(from, to);
        return toName === codegen_1.Name && !(res instanceof codegen_1.Name) ? resultToName(gen, res) : res;
      };
    }
    exports.mergeEvaluated = {
      props: makeMergeEvaluated({
        mergeNames: (gen, from, to) => gen.if((0, codegen_1._)`${to} !== true && ${from} !== undefined`, () => {
          gen.if((0, codegen_1._)`${from} === true`, () => gen.assign(to, true), () => gen.assign(to, (0, codegen_1._)`${to} || {}`).code((0, codegen_1._)`Object.assign(${to}, ${from})`));
        }),
        mergeToName: (gen, from, to) => gen.if((0, codegen_1._)`${to} !== true`, () => {
          if (from === true) {
            gen.assign(to, true);
          } else {
            gen.assign(to, (0, codegen_1._)`${to} || {}`);
            setEvaluated(gen, to, from);
          }
        }),
        mergeValues: (from, to) => from === true ? true : { ...from, ...to },
        resultToName: evaluatedPropsToName
      }),
      items: makeMergeEvaluated({
        mergeNames: (gen, from, to) => gen.if((0, codegen_1._)`${to} !== true && ${from} !== undefined`, () => gen.assign(to, (0, codegen_1._)`${from} === true ? true : ${to} > ${from} ? ${to} : ${from}`)),
        mergeToName: (gen, from, to) => gen.if((0, codegen_1._)`${to} !== true`, () => gen.assign(to, from === true ? true : (0, codegen_1._)`${to} > ${from} ? ${to} : ${from}`)),
        mergeValues: (from, to) => from === true ? true : Math.max(from, to),
        resultToName: (gen, items) => gen.var("items", items)
      })
    };
    function evaluatedPropsToName(gen, ps) {
      if (ps === true)
        return gen.var("props", true);
      const props = gen.var("props", (0, codegen_1._)`{}`);
      if (ps !== void 0)
        setEvaluated(gen, props, ps);
      return props;
    }
    exports.evaluatedPropsToName = evaluatedPropsToName;
    function setEvaluated(gen, props, ps) {
      Object.keys(ps).forEach((p) => gen.assign((0, codegen_1._)`${props}${(0, codegen_1.getProperty)(p)}`, true));
    }
    exports.setEvaluated = setEvaluated;
    var snippets = {};
    function useFunc(gen, f) {
      return gen.scopeValue("func", {
        ref: f,
        code: snippets[f.code] || (snippets[f.code] = new code_1._Code(f.code))
      });
    }
    exports.useFunc = useFunc;
    var Type;
    (function(Type2) {
      Type2[Type2["Num"] = 0] = "Num";
      Type2[Type2["Str"] = 1] = "Str";
    })(Type || (exports.Type = Type = {}));
    function getErrorPath(dataProp, dataPropType, jsPropertySyntax) {
      if (dataProp instanceof codegen_1.Name) {
        const isNumber = dataPropType === Type.Num;
        return jsPropertySyntax ? isNumber ? (0, codegen_1._)`"[" + ${dataProp} + "]"` : (0, codegen_1._)`"['" + ${dataProp} + "']"` : isNumber ? (0, codegen_1._)`"/" + ${dataProp}` : (0, codegen_1._)`"/" + ${dataProp}.replace(/~/g, "~0").replace(/\\//g, "~1")`;
      }
      return jsPropertySyntax ? (0, codegen_1.getProperty)(dataProp).toString() : "/" + escapeJsonPointer(dataProp);
    }
    exports.getErrorPath = getErrorPath;
    function checkStrictMode(it, msg, mode = it.opts.strictSchema) {
      if (!mode)
        return;
      msg = `strict mode: ${msg}`;
      if (mode === true)
        throw new Error(msg);
      it.self.logger.warn(msg);
    }
    exports.checkStrictMode = checkStrictMode;
  }
});

// node_modules/.pnpm/ajv@8.20.0/node_modules/ajv/dist/compile/names.js
var require_names = __commonJS({
  "node_modules/.pnpm/ajv@8.20.0/node_modules/ajv/dist/compile/names.js"(exports) {
    "use strict";
    Object.defineProperty(exports, "__esModule", { value: true });
    var codegen_1 = require_codegen();
    var names = {
      // validation function arguments
      data: new codegen_1.Name("data"),
      // data passed to validation function
      // args passed from referencing schema
      valCxt: new codegen_1.Name("valCxt"),
      // validation/data context - should not be used directly, it is destructured to the names below
      instancePath: new codegen_1.Name("instancePath"),
      parentData: new codegen_1.Name("parentData"),
      parentDataProperty: new codegen_1.Name("parentDataProperty"),
      rootData: new codegen_1.Name("rootData"),
      // root data - same as the data passed to the first/top validation function
      dynamicAnchors: new codegen_1.Name("dynamicAnchors"),
      // used to support recursiveRef and dynamicRef
      // function scoped variables
      vErrors: new codegen_1.Name("vErrors"),
      // null or array of validation errors
      errors: new codegen_1.Name("errors"),
      // counter of validation errors
      this: new codegen_1.Name("this"),
      // "globals"
      self: new codegen_1.Name("self"),
      scope: new codegen_1.Name("scope"),
      // JTD serialize/parse name for JSON string and position
      json: new codegen_1.Name("json"),
      jsonPos: new codegen_1.Name("jsonPos"),
      jsonLen: new codegen_1.Name("jsonLen"),
      jsonPart: new codegen_1.Name("jsonPart")
    };
    exports.default = names;
  }
});

// node_modules/.pnpm/ajv@8.20.0/node_modules/ajv/dist/compile/errors.js
var require_errors = __commonJS({
  "node_modules/.pnpm/ajv@8.20.0/node_modules/ajv/dist/compile/errors.js"(exports) {
    "use strict";
    Object.defineProperty(exports, "__esModule", { value: true });
    exports.extendErrors = exports.resetErrorsCount = exports.reportExtraError = exports.reportError = exports.keyword$DataError = exports.keywordError = void 0;
    var codegen_1 = require_codegen();
    var util_1 = require_util();
    var names_1 = require_names();
    exports.keywordError = {
      message: ({ keyword }) => (0, codegen_1.str)`must pass "${keyword}" keyword validation`
    };
    exports.keyword$DataError = {
      message: ({ keyword, schemaType }) => schemaType ? (0, codegen_1.str)`"${keyword}" keyword must be ${schemaType} ($data)` : (0, codegen_1.str)`"${keyword}" keyword is invalid ($data)`
    };
    function reportError(cxt, error = exports.keywordError, errorPaths, overrideAllErrors) {
      const { it } = cxt;
      const { gen, compositeRule, allErrors } = it;
      const errObj = errorObjectCode(cxt, error, errorPaths);
      if (overrideAllErrors !== null && overrideAllErrors !== void 0 ? overrideAllErrors : compositeRule || allErrors) {
        addError(gen, errObj);
      } else {
        returnErrors(it, (0, codegen_1._)`[${errObj}]`);
      }
    }
    exports.reportError = reportError;
    function reportExtraError(cxt, error = exports.keywordError, errorPaths) {
      const { it } = cxt;
      const { gen, compositeRule, allErrors } = it;
      const errObj = errorObjectCode(cxt, error, errorPaths);
      addError(gen, errObj);
      if (!(compositeRule || allErrors)) {
        returnErrors(it, names_1.default.vErrors);
      }
    }
    exports.reportExtraError = reportExtraError;
    function resetErrorsCount(gen, errsCount) {
      gen.assign(names_1.default.errors, errsCount);
      gen.if((0, codegen_1._)`${names_1.default.vErrors} !== null`, () => gen.if(errsCount, () => gen.assign((0, codegen_1._)`${names_1.default.vErrors}.length`, errsCount), () => gen.assign(names_1.default.vErrors, null)));
    }
    exports.resetErrorsCount = resetErrorsCount;
    function extendErrors({ gen, keyword, schemaValue, data, errsCount, it }) {
      if (errsCount === void 0)
        throw new Error("ajv implementation error");
      const err = gen.name("err");
      gen.forRange("i", errsCount, names_1.default.errors, (i) => {
        gen.const(err, (0, codegen_1._)`${names_1.default.vErrors}[${i}]`);
        gen.if((0, codegen_1._)`${err}.instancePath === undefined`, () => gen.assign((0, codegen_1._)`${err}.instancePath`, (0, codegen_1.strConcat)(names_1.default.instancePath, it.errorPath)));
        gen.assign((0, codegen_1._)`${err}.schemaPath`, (0, codegen_1.str)`${it.errSchemaPath}/${keyword}`);
        if (it.opts.verbose) {
          gen.assign((0, codegen_1._)`${err}.schema`, schemaValue);
          gen.assign((0, codegen_1._)`${err}.data`, data);
        }
      });
    }
    exports.extendErrors = extendErrors;
    function addError(gen, errObj) {
      const err = gen.const("err", errObj);
      gen.if((0, codegen_1._)`${names_1.default.vErrors} === null`, () => gen.assign(names_1.default.vErrors, (0, codegen_1._)`[${err}]`), (0, codegen_1._)`${names_1.default.vErrors}.push(${err})`);
      gen.code((0, codegen_1._)`${names_1.default.errors}++`);
    }
    function returnErrors(it, errs) {
      const { gen, validateName, schemaEnv } = it;
      if (schemaEnv.$async) {
        gen.throw((0, codegen_1._)`new ${it.ValidationError}(${errs})`);
      } else {
        gen.assign((0, codegen_1._)`${validateName}.errors`, errs);
        gen.return(false);
      }
    }
    var E = {
      keyword: new codegen_1.Name("keyword"),
      schemaPath: new codegen_1.Name("schemaPath"),
      // also used in JTD errors
      params: new codegen_1.Name("params"),
      propertyName: new codegen_1.Name("propertyName"),
      message: new codegen_1.Name("message"),
      schema: new codegen_1.Name("schema"),
      parentSchema: new codegen_1.Name("parentSchema")
    };
    function errorObjectCode(cxt, error, errorPaths) {
      const { createErrors } = cxt.it;
      if (createErrors === false)
        return (0, codegen_1._)`{}`;
      return errorObject(cxt, error, errorPaths);
    }
    function errorObject(cxt, error, errorPaths = {}) {
      const { gen, it } = cxt;
      const keyValues = [
        errorInstancePath(it, errorPaths),
        errorSchemaPath(cxt, errorPaths)
      ];
      extraErrorProps(cxt, error, keyValues);
      return gen.object(...keyValues);
    }
    function errorInstancePath({ errorPath }, { instancePath }) {
      const instPath = instancePath ? (0, codegen_1.str)`${errorPath}${(0, util_1.getErrorPath)(instancePath, util_1.Type.Str)}` : errorPath;
      return [names_1.default.instancePath, (0, codegen_1.strConcat)(names_1.default.instancePath, instPath)];
    }
    function errorSchemaPath({ keyword, it: { errSchemaPath } }, { schemaPath, parentSchema }) {
      let schPath = parentSchema ? errSchemaPath : (0, codegen_1.str)`${errSchemaPath}/${keyword}`;
      if (schemaPath) {
        schPath = (0, codegen_1.str)`${schPath}${(0, util_1.getErrorPath)(schemaPath, util_1.Type.Str)}`;
      }
      return [E.schemaPath, schPath];
    }
    function extraErrorProps(cxt, { params, message }, keyValues) {
      const { keyword, data, schemaValue, it } = cxt;
      const { opts, propertyName, topSchemaRef, schemaPath } = it;
      keyValues.push([E.keyword, keyword], [E.params, typeof params == "function" ? params(cxt) : params || (0, codegen_1._)`{}`]);
      if (opts.messages) {
        keyValues.push([E.message, typeof message == "function" ? message(cxt) : message]);
      }
      if (opts.verbose) {
        keyValues.push([E.schema, schemaValue], [E.parentSchema, (0, codegen_1._)`${topSchemaRef}${schemaPath}`], [names_1.default.data, data]);
      }
      if (propertyName)
        keyValues.push([E.propertyName, propertyName]);
    }
  }
});

// node_modules/.pnpm/ajv@8.20.0/node_modules/ajv/dist/compile/validate/boolSchema.js
var require_boolSchema = __commonJS({
  "node_modules/.pnpm/ajv@8.20.0/node_modules/ajv/dist/compile/validate/boolSchema.js"(exports) {
    "use strict";
    Object.defineProperty(exports, "__esModule", { value: true });
    exports.boolOrEmptySchema = exports.topBoolOrEmptySchema = void 0;
    var errors_1 = require_errors();
    var codegen_1 = require_codegen();
    var names_1 = require_names();
    var boolError = {
      message: "boolean schema is false"
    };
    function topBoolOrEmptySchema(it) {
      const { gen, schema, validateName } = it;
      if (schema === false) {
        falseSchemaError(it, false);
      } else if (typeof schema == "object" && schema.$async === true) {
        gen.return(names_1.default.data);
      } else {
        gen.assign((0, codegen_1._)`${validateName}.errors`, null);
        gen.return(true);
      }
    }
    exports.topBoolOrEmptySchema = topBoolOrEmptySchema;
    function boolOrEmptySchema(it, valid) {
      const { gen, schema } = it;
      if (schema === false) {
        gen.var(valid, false);
        falseSchemaError(it);
      } else {
        gen.var(valid, true);
      }
    }
    exports.boolOrEmptySchema = boolOrEmptySchema;
    function falseSchemaError(it, overrideAllErrors) {
      const { gen, data } = it;
      const cxt = {
        gen,
        keyword: "false schema",
        data,
        schema: false,
        schemaCode: false,
        schemaValue: false,
        params: {},
        it
      };
      (0, errors_1.reportError)(cxt, boolError, void 0, overrideAllErrors);
    }
  }
});

// node_modules/.pnpm/ajv@8.20.0/node_modules/ajv/dist/compile/rules.js
var require_rules = __commonJS({
  "node_modules/.pnpm/ajv@8.20.0/node_modules/ajv/dist/compile/rules.js"(exports) {
    "use strict";
    Object.defineProperty(exports, "__esModule", { value: true });
    exports.getRules = exports.isJSONType = void 0;
    var _jsonTypes = ["string", "number", "integer", "boolean", "null", "object", "array"];
    var jsonTypes = new Set(_jsonTypes);
    function isJSONType(x) {
      return typeof x == "string" && jsonTypes.has(x);
    }
    exports.isJSONType = isJSONType;
    function getRules() {
      const groups = {
        number: { type: "number", rules: [] },
        string: { type: "string", rules: [] },
        array: { type: "array", rules: [] },
        object: { type: "object", rules: [] }
      };
      return {
        types: { ...groups, integer: true, boolean: true, null: true },
        rules: [{ rules: [] }, groups.number, groups.string, groups.array, groups.object],
        post: { rules: [] },
        all: {},
        keywords: {}
      };
    }
    exports.getRules = getRules;
  }
});

// node_modules/.pnpm/ajv@8.20.0/node_modules/ajv/dist/compile/validate/applicability.js
var require_applicability = __commonJS({
  "node_modules/.pnpm/ajv@8.20.0/node_modules/ajv/dist/compile/validate/applicability.js"(exports) {
    "use strict";
    Object.defineProperty(exports, "__esModule", { value: true });
    exports.shouldUseRule = exports.shouldUseGroup = exports.schemaHasRulesForType = void 0;
    function schemaHasRulesForType({ schema, self }, type) {
      const group = self.RULES.types[type];
      return group && group !== true && shouldUseGroup(schema, group);
    }
    exports.schemaHasRulesForType = schemaHasRulesForType;
    function shouldUseGroup(schema, group) {
      return group.rules.some((rule) => shouldUseRule(schema, rule));
    }
    exports.shouldUseGroup = shouldUseGroup;
    function shouldUseRule(schema, rule) {
      var _a;
      return schema[rule.keyword] !== void 0 || ((_a = rule.definition.implements) === null || _a === void 0 ? void 0 : _a.some((kwd) => schema[kwd] !== void 0));
    }
    exports.shouldUseRule = shouldUseRule;
  }
});

// node_modules/.pnpm/ajv@8.20.0/node_modules/ajv/dist/compile/validate/dataType.js
var require_dataType = __commonJS({
  "node_modules/.pnpm/ajv@8.20.0/node_modules/ajv/dist/compile/validate/dataType.js"(exports) {
    "use strict";
    Object.defineProperty(exports, "__esModule", { value: true });
    exports.reportTypeError = exports.checkDataTypes = exports.checkDataType = exports.coerceAndCheckDataType = exports.getJSONTypes = exports.getSchemaTypes = exports.DataType = void 0;
    var rules_1 = require_rules();
    var applicability_1 = require_applicability();
    var errors_1 = require_errors();
    var codegen_1 = require_codegen();
    var util_1 = require_util();
    var DataType;
    (function(DataType2) {
      DataType2[DataType2["Correct"] = 0] = "Correct";
      DataType2[DataType2["Wrong"] = 1] = "Wrong";
    })(DataType || (exports.DataType = DataType = {}));
    function getSchemaTypes(schema) {
      const types = getJSONTypes(schema.type);
      const hasNull = types.includes("null");
      if (hasNull) {
        if (schema.nullable === false)
          throw new Error("type: null contradicts nullable: false");
      } else {
        if (!types.length && schema.nullable !== void 0) {
          throw new Error('"nullable" cannot be used without "type"');
        }
        if (schema.nullable === true)
          types.push("null");
      }
      return types;
    }
    exports.getSchemaTypes = getSchemaTypes;
    function getJSONTypes(ts) {
      const types = Array.isArray(ts) ? ts : ts ? [ts] : [];
      if (types.every(rules_1.isJSONType))
        return types;
      throw new Error("type must be JSONType or JSONType[]: " + types.join(","));
    }
    exports.getJSONTypes = getJSONTypes;
    function coerceAndCheckDataType(it, types) {
      const { gen, data, opts } = it;
      const coerceTo = coerceToTypes(types, opts.coerceTypes);
      const checkTypes = types.length > 0 && !(coerceTo.length === 0 && types.length === 1 && (0, applicability_1.schemaHasRulesForType)(it, types[0]));
      if (checkTypes) {
        const wrongType = checkDataTypes(types, data, opts.strictNumbers, DataType.Wrong);
        gen.if(wrongType, () => {
          if (coerceTo.length)
            coerceData(it, types, coerceTo);
          else
            reportTypeError(it);
        });
      }
      return checkTypes;
    }
    exports.coerceAndCheckDataType = coerceAndCheckDataType;
    var COERCIBLE = /* @__PURE__ */ new Set(["string", "number", "integer", "boolean", "null"]);
    function coerceToTypes(types, coerceTypes) {
      return coerceTypes ? types.filter((t) => COERCIBLE.has(t) || coerceTypes === "array" && t === "array") : [];
    }
    function coerceData(it, types, coerceTo) {
      const { gen, data, opts } = it;
      const dataType = gen.let("dataType", (0, codegen_1._)`typeof ${data}`);
      const coerced = gen.let("coerced", (0, codegen_1._)`undefined`);
      if (opts.coerceTypes === "array") {
        gen.if((0, codegen_1._)`${dataType} == 'object' && Array.isArray(${data}) && ${data}.length == 1`, () => gen.assign(data, (0, codegen_1._)`${data}[0]`).assign(dataType, (0, codegen_1._)`typeof ${data}`).if(checkDataTypes(types, data, opts.strictNumbers), () => gen.assign(coerced, data)));
      }
      gen.if((0, codegen_1._)`${coerced} !== undefined`);
      for (const t of coerceTo) {
        if (COERCIBLE.has(t) || t === "array" && opts.coerceTypes === "array") {
          coerceSpecificType(t);
        }
      }
      gen.else();
      reportTypeError(it);
      gen.endIf();
      gen.if((0, codegen_1._)`${coerced} !== undefined`, () => {
        gen.assign(data, coerced);
        assignParentData(it, coerced);
      });
      function coerceSpecificType(t) {
        switch (t) {
          case "string":
            gen.elseIf((0, codegen_1._)`${dataType} == "number" || ${dataType} == "boolean"`).assign(coerced, (0, codegen_1._)`"" + ${data}`).elseIf((0, codegen_1._)`${data} === null`).assign(coerced, (0, codegen_1._)`""`);
            return;
          case "number":
            gen.elseIf((0, codegen_1._)`${dataType} == "boolean" || ${data} === null
              || (${dataType} == "string" && ${data} && ${data} == +${data})`).assign(coerced, (0, codegen_1._)`+${data}`);
            return;
          case "integer":
            gen.elseIf((0, codegen_1._)`${dataType} === "boolean" || ${data} === null
              || (${dataType} === "string" && ${data} && ${data} == +${data} && !(${data} % 1))`).assign(coerced, (0, codegen_1._)`+${data}`);
            return;
          case "boolean":
            gen.elseIf((0, codegen_1._)`${data} === "false" || ${data} === 0 || ${data} === null`).assign(coerced, false).elseIf((0, codegen_1._)`${data} === "true" || ${data} === 1`).assign(coerced, true);
            return;
          case "null":
            gen.elseIf((0, codegen_1._)`${data} === "" || ${data} === 0 || ${data} === false`);
            gen.assign(coerced, null);
            return;
          case "array":
            gen.elseIf((0, codegen_1._)`${dataType} === "string" || ${dataType} === "number"
              || ${dataType} === "boolean" || ${data} === null`).assign(coerced, (0, codegen_1._)`[${data}]`);
        }
      }
    }
    function assignParentData({ gen, parentData, parentDataProperty }, expr) {
      gen.if((0, codegen_1._)`${parentData} !== undefined`, () => gen.assign((0, codegen_1._)`${parentData}[${parentDataProperty}]`, expr));
    }
    function checkDataType(dataType, data, strictNums, correct = DataType.Correct) {
      const EQ = correct === DataType.Correct ? codegen_1.operators.EQ : codegen_1.operators.NEQ;
      let cond;
      switch (dataType) {
        case "null":
          return (0, codegen_1._)`${data} ${EQ} null`;
        case "array":
          cond = (0, codegen_1._)`Array.isArray(${data})`;
          break;
        case "object":
          cond = (0, codegen_1._)`${data} && typeof ${data} == "object" && !Array.isArray(${data})`;
          break;
        case "integer":
          cond = numCond((0, codegen_1._)`!(${data} % 1) && !isNaN(${data})`);
          break;
        case "number":
          cond = numCond();
          break;
        default:
          return (0, codegen_1._)`typeof ${data} ${EQ} ${dataType}`;
      }
      return correct === DataType.Correct ? cond : (0, codegen_1.not)(cond);
      function numCond(_cond = codegen_1.nil) {
        return (0, codegen_1.and)((0, codegen_1._)`typeof ${data} == "number"`, _cond, strictNums ? (0, codegen_1._)`isFinite(${data})` : codegen_1.nil);
      }
    }
    exports.checkDataType = checkDataType;
    function checkDataTypes(dataTypes, data, strictNums, correct) {
      if (dataTypes.length === 1) {
        return checkDataType(dataTypes[0], data, strictNums, correct);
      }
      let cond;
      const types = (0, util_1.toHash)(dataTypes);
      if (types.array && types.object) {
        const notObj = (0, codegen_1._)`typeof ${data} != "object"`;
        cond = types.null ? notObj : (0, codegen_1._)`!${data} || ${notObj}`;
        delete types.null;
        delete types.array;
        delete types.object;
      } else {
        cond = codegen_1.nil;
      }
      if (types.number)
        delete types.integer;
      for (const t in types)
        cond = (0, codegen_1.and)(cond, checkDataType(t, data, strictNums, correct));
      return cond;
    }
    exports.checkDataTypes = checkDataTypes;
    var typeError = {
      message: ({ schema }) => `must be ${schema}`,
      params: ({ schema, schemaValue }) => typeof schema == "string" ? (0, codegen_1._)`{type: ${schema}}` : (0, codegen_1._)`{type: ${schemaValue}}`
    };
    function reportTypeError(it) {
      const cxt = getTypeErrorContext(it);
      (0, errors_1.reportError)(cxt, typeError);
    }
    exports.reportTypeError = reportTypeError;
    function getTypeErrorContext(it) {
      const { gen, data, schema } = it;
      const schemaCode = (0, util_1.schemaRefOrVal)(it, schema, "type");
      return {
        gen,
        keyword: "type",
        data,
        schema: schema.type,
        schemaCode,
        schemaValue: schemaCode,
        parentSchema: schema,
        params: {},
        it
      };
    }
  }
});

// node_modules/.pnpm/ajv@8.20.0/node_modules/ajv/dist/compile/validate/defaults.js
var require_defaults = __commonJS({
  "node_modules/.pnpm/ajv@8.20.0/node_modules/ajv/dist/compile/validate/defaults.js"(exports) {
    "use strict";
    Object.defineProperty(exports, "__esModule", { value: true });
    exports.assignDefaults = void 0;
    var codegen_1 = require_codegen();
    var util_1 = require_util();
    function assignDefaults(it, ty) {
      const { properties, items } = it.schema;
      if (ty === "object" && properties) {
        for (const key in properties) {
          assignDefault(it, key, properties[key].default);
        }
      } else if (ty === "array" && Array.isArray(items)) {
        items.forEach((sch, i) => assignDefault(it, i, sch.default));
      }
    }
    exports.assignDefaults = assignDefaults;
    function assignDefault(it, prop, defaultValue) {
      const { gen, compositeRule, data, opts } = it;
      if (defaultValue === void 0)
        return;
      const childData = (0, codegen_1._)`${data}${(0, codegen_1.getProperty)(prop)}`;
      if (compositeRule) {
        (0, util_1.checkStrictMode)(it, `default is ignored for: ${childData}`);
        return;
      }
      let condition = (0, codegen_1._)`${childData} === undefined`;
      if (opts.useDefaults === "empty") {
        condition = (0, codegen_1._)`${condition} || ${childData} === null || ${childData} === ""`;
      }
      gen.if(condition, (0, codegen_1._)`${childData} = ${(0, codegen_1.stringify)(defaultValue)}`);
    }
  }
});

// node_modules/.pnpm/ajv@8.20.0/node_modules/ajv/dist/vocabularies/code.js
var require_code2 = __commonJS({
  "node_modules/.pnpm/ajv@8.20.0/node_modules/ajv/dist/vocabularies/code.js"(exports) {
    "use strict";
    Object.defineProperty(exports, "__esModule", { value: true });
    exports.validateUnion = exports.validateArray = exports.usePattern = exports.callValidateCode = exports.schemaProperties = exports.allSchemaProperties = exports.noPropertyInData = exports.propertyInData = exports.isOwnProperty = exports.hasPropFunc = exports.reportMissingProp = exports.checkMissingProp = exports.checkReportMissingProp = void 0;
    var codegen_1 = require_codegen();
    var util_1 = require_util();
    var names_1 = require_names();
    var util_2 = require_util();
    function checkReportMissingProp(cxt, prop) {
      const { gen, data, it } = cxt;
      gen.if(noPropertyInData(gen, data, prop, it.opts.ownProperties), () => {
        cxt.setParams({ missingProperty: (0, codegen_1._)`${prop}` }, true);
        cxt.error();
      });
    }
    exports.checkReportMissingProp = checkReportMissingProp;
    function checkMissingProp({ gen, data, it: { opts } }, properties, missing) {
      return (0, codegen_1.or)(...properties.map((prop) => (0, codegen_1.and)(noPropertyInData(gen, data, prop, opts.ownProperties), (0, codegen_1._)`${missing} = ${prop}`)));
    }
    exports.checkMissingProp = checkMissingProp;
    function reportMissingProp(cxt, missing) {
      cxt.setParams({ missingProperty: missing }, true);
      cxt.error();
    }
    exports.reportMissingProp = reportMissingProp;
    function hasPropFunc(gen) {
      return gen.scopeValue("func", {
        // eslint-disable-next-line @typescript-eslint/unbound-method
        ref: Object.prototype.hasOwnProperty,
        code: (0, codegen_1._)`Object.prototype.hasOwnProperty`
      });
    }
    exports.hasPropFunc = hasPropFunc;
    function isOwnProperty(gen, data, property) {
      return (0, codegen_1._)`${hasPropFunc(gen)}.call(${data}, ${property})`;
    }
    exports.isOwnProperty = isOwnProperty;
    function propertyInData(gen, data, property, ownProperties) {
      const cond = (0, codegen_1._)`${data}${(0, codegen_1.getProperty)(property)} !== undefined`;
      return ownProperties ? (0, codegen_1._)`${cond} && ${isOwnProperty(gen, data, property)}` : cond;
    }
    exports.propertyInData = propertyInData;
    function noPropertyInData(gen, data, property, ownProperties) {
      const cond = (0, codegen_1._)`${data}${(0, codegen_1.getProperty)(property)} === undefined`;
      return ownProperties ? (0, codegen_1.or)(cond, (0, codegen_1.not)(isOwnProperty(gen, data, property))) : cond;
    }
    exports.noPropertyInData = noPropertyInData;
    function allSchemaProperties(schemaMap) {
      return schemaMap ? Object.keys(schemaMap).filter((p) => p !== "__proto__") : [];
    }
    exports.allSchemaProperties = allSchemaProperties;
    function schemaProperties(it, schemaMap) {
      return allSchemaProperties(schemaMap).filter((p) => !(0, util_1.alwaysValidSchema)(it, schemaMap[p]));
    }
    exports.schemaProperties = schemaProperties;
    function callValidateCode({ schemaCode, data, it: { gen, topSchemaRef, schemaPath, errorPath }, it }, func, context, passSchema) {
      const dataAndSchema = passSchema ? (0, codegen_1._)`${schemaCode}, ${data}, ${topSchemaRef}${schemaPath}` : data;
      const valCxt = [
        [names_1.default.instancePath, (0, codegen_1.strConcat)(names_1.default.instancePath, errorPath)],
        [names_1.default.parentData, it.parentData],
        [names_1.default.parentDataProperty, it.parentDataProperty],
        [names_1.default.rootData, names_1.default.rootData]
      ];
      if (it.opts.dynamicRef)
        valCxt.push([names_1.default.dynamicAnchors, names_1.default.dynamicAnchors]);
      const args = (0, codegen_1._)`${dataAndSchema}, ${gen.object(...valCxt)}`;
      return context !== codegen_1.nil ? (0, codegen_1._)`${func}.call(${context}, ${args})` : (0, codegen_1._)`${func}(${args})`;
    }
    exports.callValidateCode = callValidateCode;
    var newRegExp = (0, codegen_1._)`new RegExp`;
    function usePattern({ gen, it: { opts } }, pattern) {
      const u = opts.unicodeRegExp ? "u" : "";
      const { regExp } = opts.code;
      const rx = regExp(pattern, u);
      return gen.scopeValue("pattern", {
        key: rx.toString(),
        ref: rx,
        code: (0, codegen_1._)`${regExp.code === "new RegExp" ? newRegExp : (0, util_2.useFunc)(gen, regExp)}(${pattern}, ${u})`
      });
    }
    exports.usePattern = usePattern;
    function validateArray(cxt) {
      const { gen, data, keyword, it } = cxt;
      const valid = gen.name("valid");
      if (it.allErrors) {
        const validArr = gen.let("valid", true);
        validateItems(() => gen.assign(validArr, false));
        return validArr;
      }
      gen.var(valid, true);
      validateItems(() => gen.break());
      return valid;
      function validateItems(notValid) {
        const len = gen.const("len", (0, codegen_1._)`${data}.length`);
        gen.forRange("i", 0, len, (i) => {
          cxt.subschema({
            keyword,
            dataProp: i,
            dataPropType: util_1.Type.Num
          }, valid);
          gen.if((0, codegen_1.not)(valid), notValid);
        });
      }
    }
    exports.validateArray = validateArray;
    function validateUnion(cxt) {
      const { gen, schema, keyword, it } = cxt;
      if (!Array.isArray(schema))
        throw new Error("ajv implementation error");
      const alwaysValid = schema.some((sch) => (0, util_1.alwaysValidSchema)(it, sch));
      if (alwaysValid && !it.opts.unevaluated)
        return;
      const valid = gen.let("valid", false);
      const schValid = gen.name("_valid");
      gen.block(() => schema.forEach((_sch, i) => {
        const schCxt = cxt.subschema({
          keyword,
          schemaProp: i,
          compositeRule: true
        }, schValid);
        gen.assign(valid, (0, codegen_1._)`${valid} || ${schValid}`);
        const merged = cxt.mergeValidEvaluated(schCxt, schValid);
        if (!merged)
          gen.if((0, codegen_1.not)(valid));
      }));
      cxt.result(valid, () => cxt.reset(), () => cxt.error(true));
    }
    exports.validateUnion = validateUnion;
  }
});

// node_modules/.pnpm/ajv@8.20.0/node_modules/ajv/dist/compile/validate/keyword.js
var require_keyword = __commonJS({
  "node_modules/.pnpm/ajv@8.20.0/node_modules/ajv/dist/compile/validate/keyword.js"(exports) {
    "use strict";
    Object.defineProperty(exports, "__esModule", { value: true });
    exports.validateKeywordUsage = exports.validSchemaType = exports.funcKeywordCode = exports.macroKeywordCode = void 0;
    var codegen_1 = require_codegen();
    var names_1 = require_names();
    var code_1 = require_code2();
    var errors_1 = require_errors();
    function macroKeywordCode(cxt, def) {
      const { gen, keyword, schema, parentSchema, it } = cxt;
      const macroSchema = def.macro.call(it.self, schema, parentSchema, it);
      const schemaRef = useKeyword(gen, keyword, macroSchema);
      if (it.opts.validateSchema !== false)
        it.self.validateSchema(macroSchema, true);
      const valid = gen.name("valid");
      cxt.subschema({
        schema: macroSchema,
        schemaPath: codegen_1.nil,
        errSchemaPath: `${it.errSchemaPath}/${keyword}`,
        topSchemaRef: schemaRef,
        compositeRule: true
      }, valid);
      cxt.pass(valid, () => cxt.error(true));
    }
    exports.macroKeywordCode = macroKeywordCode;
    function funcKeywordCode(cxt, def) {
      var _a;
      const { gen, keyword, schema, parentSchema, $data, it } = cxt;
      checkAsyncKeyword(it, def);
      const validate = !$data && def.compile ? def.compile.call(it.self, schema, parentSchema, it) : def.validate;
      const validateRef = useKeyword(gen, keyword, validate);
      const valid = gen.let("valid");
      cxt.block$data(valid, validateKeyword);
      cxt.ok((_a = def.valid) !== null && _a !== void 0 ? _a : valid);
      function validateKeyword() {
        if (def.errors === false) {
          assignValid();
          if (def.modifying)
            modifyData(cxt);
          reportErrs(() => cxt.error());
        } else {
          const ruleErrs = def.async ? validateAsync() : validateSync();
          if (def.modifying)
            modifyData(cxt);
          reportErrs(() => addErrs(cxt, ruleErrs));
        }
      }
      function validateAsync() {
        const ruleErrs = gen.let("ruleErrs", null);
        gen.try(() => assignValid((0, codegen_1._)`await `), (e) => gen.assign(valid, false).if((0, codegen_1._)`${e} instanceof ${it.ValidationError}`, () => gen.assign(ruleErrs, (0, codegen_1._)`${e}.errors`), () => gen.throw(e)));
        return ruleErrs;
      }
      function validateSync() {
        const validateErrs = (0, codegen_1._)`${validateRef}.errors`;
        gen.assign(validateErrs, null);
        assignValid(codegen_1.nil);
        return validateErrs;
      }
      function assignValid(_await = def.async ? (0, codegen_1._)`await ` : codegen_1.nil) {
        const passCxt = it.opts.passContext ? names_1.default.this : names_1.default.self;
        const passSchema = !("compile" in def && !$data || def.schema === false);
        gen.assign(valid, (0, codegen_1._)`${_await}${(0, code_1.callValidateCode)(cxt, validateRef, passCxt, passSchema)}`, def.modifying);
      }
      function reportErrs(errors) {
        var _a2;
        gen.if((0, codegen_1.not)((_a2 = def.valid) !== null && _a2 !== void 0 ? _a2 : valid), errors);
      }
    }
    exports.funcKeywordCode = funcKeywordCode;
    function modifyData(cxt) {
      const { gen, data, it } = cxt;
      gen.if(it.parentData, () => gen.assign(data, (0, codegen_1._)`${it.parentData}[${it.parentDataProperty}]`));
    }
    function addErrs(cxt, errs) {
      const { gen } = cxt;
      gen.if((0, codegen_1._)`Array.isArray(${errs})`, () => {
        gen.assign(names_1.default.vErrors, (0, codegen_1._)`${names_1.default.vErrors} === null ? ${errs} : ${names_1.default.vErrors}.concat(${errs})`).assign(names_1.default.errors, (0, codegen_1._)`${names_1.default.vErrors}.length`);
        (0, errors_1.extendErrors)(cxt);
      }, () => cxt.error());
    }
    function checkAsyncKeyword({ schemaEnv }, def) {
      if (def.async && !schemaEnv.$async)
        throw new Error("async keyword in sync schema");
    }
    function useKeyword(gen, keyword, result) {
      if (result === void 0)
        throw new Error(`keyword "${keyword}" failed to compile`);
      return gen.scopeValue("keyword", typeof result == "function" ? { ref: result } : { ref: result, code: (0, codegen_1.stringify)(result) });
    }
    function validSchemaType(schema, schemaType, allowUndefined = false) {
      return !schemaType.length || schemaType.some((st) => st === "array" ? Array.isArray(schema) : st === "object" ? schema && typeof schema == "object" && !Array.isArray(schema) : typeof schema == st || allowUndefined && typeof schema == "undefined");
    }
    exports.validSchemaType = validSchemaType;
    function validateKeywordUsage({ schema, opts, self, errSchemaPath }, def, keyword) {
      if (Array.isArray(def.keyword) ? !def.keyword.includes(keyword) : def.keyword !== keyword) {
        throw new Error("ajv implementation error");
      }
      const deps = def.dependencies;
      if (deps === null || deps === void 0 ? void 0 : deps.some((kwd) => !Object.prototype.hasOwnProperty.call(schema, kwd))) {
        throw new Error(`parent schema must have dependencies of ${keyword}: ${deps.join(",")}`);
      }
      if (def.validateSchema) {
        const valid = def.validateSchema(schema[keyword]);
        if (!valid) {
          const msg = `keyword "${keyword}" value is invalid at path "${errSchemaPath}": ` + self.errorsText(def.validateSchema.errors);
          if (opts.validateSchema === "log")
            self.logger.error(msg);
          else
            throw new Error(msg);
        }
      }
    }
    exports.validateKeywordUsage = validateKeywordUsage;
  }
});

// node_modules/.pnpm/ajv@8.20.0/node_modules/ajv/dist/compile/validate/subschema.js
var require_subschema = __commonJS({
  "node_modules/.pnpm/ajv@8.20.0/node_modules/ajv/dist/compile/validate/subschema.js"(exports) {
    "use strict";
    Object.defineProperty(exports, "__esModule", { value: true });
    exports.extendSubschemaMode = exports.extendSubschemaData = exports.getSubschema = void 0;
    var codegen_1 = require_codegen();
    var util_1 = require_util();
    function getSubschema(it, { keyword, schemaProp, schema, schemaPath, errSchemaPath, topSchemaRef }) {
      if (keyword !== void 0 && schema !== void 0) {
        throw new Error('both "keyword" and "schema" passed, only one allowed');
      }
      if (keyword !== void 0) {
        const sch = it.schema[keyword];
        return schemaProp === void 0 ? {
          schema: sch,
          schemaPath: (0, codegen_1._)`${it.schemaPath}${(0, codegen_1.getProperty)(keyword)}`,
          errSchemaPath: `${it.errSchemaPath}/${keyword}`
        } : {
          schema: sch[schemaProp],
          schemaPath: (0, codegen_1._)`${it.schemaPath}${(0, codegen_1.getProperty)(keyword)}${(0, codegen_1.getProperty)(schemaProp)}`,
          errSchemaPath: `${it.errSchemaPath}/${keyword}/${(0, util_1.escapeFragment)(schemaProp)}`
        };
      }
      if (schema !== void 0) {
        if (schemaPath === void 0 || errSchemaPath === void 0 || topSchemaRef === void 0) {
          throw new Error('"schemaPath", "errSchemaPath" and "topSchemaRef" are required with "schema"');
        }
        return {
          schema,
          schemaPath,
          topSchemaRef,
          errSchemaPath
        };
      }
      throw new Error('either "keyword" or "schema" must be passed');
    }
    exports.getSubschema = getSubschema;
    function extendSubschemaData(subschema, it, { dataProp, dataPropType: dpType, data, dataTypes, propertyName }) {
      if (data !== void 0 && dataProp !== void 0) {
        throw new Error('both "data" and "dataProp" passed, only one allowed');
      }
      const { gen } = it;
      if (dataProp !== void 0) {
        const { errorPath, dataPathArr, opts } = it;
        const nextData = gen.let("data", (0, codegen_1._)`${it.data}${(0, codegen_1.getProperty)(dataProp)}`, true);
        dataContextProps(nextData);
        subschema.errorPath = (0, codegen_1.str)`${errorPath}${(0, util_1.getErrorPath)(dataProp, dpType, opts.jsPropertySyntax)}`;
        subschema.parentDataProperty = (0, codegen_1._)`${dataProp}`;
        subschema.dataPathArr = [...dataPathArr, subschema.parentDataProperty];
      }
      if (data !== void 0) {
        const nextData = data instanceof codegen_1.Name ? data : gen.let("data", data, true);
        dataContextProps(nextData);
        if (propertyName !== void 0)
          subschema.propertyName = propertyName;
      }
      if (dataTypes)
        subschema.dataTypes = dataTypes;
      function dataContextProps(_nextData) {
        subschema.data = _nextData;
        subschema.dataLevel = it.dataLevel + 1;
        subschema.dataTypes = [];
        it.definedProperties = /* @__PURE__ */ new Set();
        subschema.parentData = it.data;
        subschema.dataNames = [...it.dataNames, _nextData];
      }
    }
    exports.extendSubschemaData = extendSubschemaData;
    function extendSubschemaMode(subschema, { jtdDiscriminator, jtdMetadata, compositeRule, createErrors, allErrors }) {
      if (compositeRule !== void 0)
        subschema.compositeRule = compositeRule;
      if (createErrors !== void 0)
        subschema.createErrors = createErrors;
      if (allErrors !== void 0)
        subschema.allErrors = allErrors;
      subschema.jtdDiscriminator = jtdDiscriminator;
      subschema.jtdMetadata = jtdMetadata;
    }
    exports.extendSubschemaMode = extendSubschemaMode;
  }
});

// node_modules/.pnpm/fast-deep-equal@3.1.3/node_modules/fast-deep-equal/index.js
var require_fast_deep_equal = __commonJS({
  "node_modules/.pnpm/fast-deep-equal@3.1.3/node_modules/fast-deep-equal/index.js"(exports, module) {
    "use strict";
    module.exports = function equal(a, b) {
      if (a === b) return true;
      if (a && b && typeof a == "object" && typeof b == "object") {
        if (a.constructor !== b.constructor) return false;
        var length, i, keys;
        if (Array.isArray(a)) {
          length = a.length;
          if (length != b.length) return false;
          for (i = length; i-- !== 0; )
            if (!equal(a[i], b[i])) return false;
          return true;
        }
        if (a.constructor === RegExp) return a.source === b.source && a.flags === b.flags;
        if (a.valueOf !== Object.prototype.valueOf) return a.valueOf() === b.valueOf();
        if (a.toString !== Object.prototype.toString) return a.toString() === b.toString();
        keys = Object.keys(a);
        length = keys.length;
        if (length !== Object.keys(b).length) return false;
        for (i = length; i-- !== 0; )
          if (!Object.prototype.hasOwnProperty.call(b, keys[i])) return false;
        for (i = length; i-- !== 0; ) {
          var key = keys[i];
          if (!equal(a[key], b[key])) return false;
        }
        return true;
      }
      return a !== a && b !== b;
    };
  }
});

// node_modules/.pnpm/json-schema-traverse@1.0.0/node_modules/json-schema-traverse/index.js
var require_json_schema_traverse = __commonJS({
  "node_modules/.pnpm/json-schema-traverse@1.0.0/node_modules/json-schema-traverse/index.js"(exports, module) {
    "use strict";
    var traverse = module.exports = function(schema, opts, cb) {
      if (typeof opts == "function") {
        cb = opts;
        opts = {};
      }
      cb = opts.cb || cb;
      var pre = typeof cb == "function" ? cb : cb.pre || function() {
      };
      var post = cb.post || function() {
      };
      _traverse(opts, pre, post, schema, "", schema);
    };
    traverse.keywords = {
      additionalItems: true,
      items: true,
      contains: true,
      additionalProperties: true,
      propertyNames: true,
      not: true,
      if: true,
      then: true,
      else: true
    };
    traverse.arrayKeywords = {
      items: true,
      allOf: true,
      anyOf: true,
      oneOf: true
    };
    traverse.propsKeywords = {
      $defs: true,
      definitions: true,
      properties: true,
      patternProperties: true,
      dependencies: true
    };
    traverse.skipKeywords = {
      default: true,
      enum: true,
      const: true,
      required: true,
      maximum: true,
      minimum: true,
      exclusiveMaximum: true,
      exclusiveMinimum: true,
      multipleOf: true,
      maxLength: true,
      minLength: true,
      pattern: true,
      format: true,
      maxItems: true,
      minItems: true,
      uniqueItems: true,
      maxProperties: true,
      minProperties: true
    };
    function _traverse(opts, pre, post, schema, jsonPtr, rootSchema, parentJsonPtr, parentKeyword, parentSchema, keyIndex) {
      if (schema && typeof schema == "object" && !Array.isArray(schema)) {
        pre(schema, jsonPtr, rootSchema, parentJsonPtr, parentKeyword, parentSchema, keyIndex);
        for (var key in schema) {
          var sch = schema[key];
          if (Array.isArray(sch)) {
            if (key in traverse.arrayKeywords) {
              for (var i = 0; i < sch.length; i++)
                _traverse(opts, pre, post, sch[i], jsonPtr + "/" + key + "/" + i, rootSchema, jsonPtr, key, schema, i);
            }
          } else if (key in traverse.propsKeywords) {
            if (sch && typeof sch == "object") {
              for (var prop in sch)
                _traverse(opts, pre, post, sch[prop], jsonPtr + "/" + key + "/" + escapeJsonPtr(prop), rootSchema, jsonPtr, key, schema, prop);
            }
          } else if (key in traverse.keywords || opts.allKeys && !(key in traverse.skipKeywords)) {
            _traverse(opts, pre, post, sch, jsonPtr + "/" + key, rootSchema, jsonPtr, key, schema);
          }
        }
        post(schema, jsonPtr, rootSchema, parentJsonPtr, parentKeyword, parentSchema, keyIndex);
      }
    }
    function escapeJsonPtr(str) {
      return str.replace(/~/g, "~0").replace(/\//g, "~1");
    }
  }
});

// node_modules/.pnpm/ajv@8.20.0/node_modules/ajv/dist/compile/resolve.js
var require_resolve = __commonJS({
  "node_modules/.pnpm/ajv@8.20.0/node_modules/ajv/dist/compile/resolve.js"(exports) {
    "use strict";
    Object.defineProperty(exports, "__esModule", { value: true });
    exports.getSchemaRefs = exports.resolveUrl = exports.normalizeId = exports._getFullPath = exports.getFullPath = exports.inlineRef = void 0;
    var util_1 = require_util();
    var equal = require_fast_deep_equal();
    var traverse = require_json_schema_traverse();
    var SIMPLE_INLINED = /* @__PURE__ */ new Set([
      "type",
      "format",
      "pattern",
      "maxLength",
      "minLength",
      "maxProperties",
      "minProperties",
      "maxItems",
      "minItems",
      "maximum",
      "minimum",
      "uniqueItems",
      "multipleOf",
      "required",
      "enum",
      "const"
    ]);
    function inlineRef(schema, limit = true) {
      if (typeof schema == "boolean")
        return true;
      if (limit === true)
        return !hasRef(schema);
      if (!limit)
        return false;
      return countKeys(schema) <= limit;
    }
    exports.inlineRef = inlineRef;
    var REF_KEYWORDS = /* @__PURE__ */ new Set([
      "$ref",
      "$recursiveRef",
      "$recursiveAnchor",
      "$dynamicRef",
      "$dynamicAnchor"
    ]);
    function hasRef(schema) {
      for (const key in schema) {
        if (REF_KEYWORDS.has(key))
          return true;
        const sch = schema[key];
        if (Array.isArray(sch) && sch.some(hasRef))
          return true;
        if (typeof sch == "object" && hasRef(sch))
          return true;
      }
      return false;
    }
    function countKeys(schema) {
      let count = 0;
      for (const key in schema) {
        if (key === "$ref")
          return Infinity;
        count++;
        if (SIMPLE_INLINED.has(key))
          continue;
        if (typeof schema[key] == "object") {
          (0, util_1.eachItem)(schema[key], (sch) => count += countKeys(sch));
        }
        if (count === Infinity)
          return Infinity;
      }
      return count;
    }
    function getFullPath(resolver, id = "", normalize) {
      if (normalize !== false)
        id = normalizeId(id);
      const p = resolver.parse(id);
      return _getFullPath(resolver, p);
    }
    exports.getFullPath = getFullPath;
    function _getFullPath(resolver, p) {
      const serialized = resolver.serialize(p);
      return serialized.split("#")[0] + "#";
    }
    exports._getFullPath = _getFullPath;
    var TRAILING_SLASH_HASH = /#\/?$/;
    function normalizeId(id) {
      return id ? id.replace(TRAILING_SLASH_HASH, "") : "";
    }
    exports.normalizeId = normalizeId;
    function resolveUrl(resolver, baseId, id) {
      id = normalizeId(id);
      return resolver.resolve(baseId, id);
    }
    exports.resolveUrl = resolveUrl;
    var ANCHOR = /^[a-z_][-a-z0-9._]*$/i;
    function getSchemaRefs(schema, baseId) {
      if (typeof schema == "boolean")
        return {};
      const { schemaId, uriResolver } = this.opts;
      const schId = normalizeId(schema[schemaId] || baseId);
      const baseIds = { "": schId };
      const pathPrefix = getFullPath(uriResolver, schId, false);
      const localRefs = {};
      const schemaRefs = /* @__PURE__ */ new Set();
      traverse(schema, { allKeys: true }, (sch, jsonPtr, _, parentJsonPtr) => {
        if (parentJsonPtr === void 0)
          return;
        const fullPath = pathPrefix + jsonPtr;
        let innerBaseId = baseIds[parentJsonPtr];
        if (typeof sch[schemaId] == "string")
          innerBaseId = addRef.call(this, sch[schemaId]);
        addAnchor.call(this, sch.$anchor);
        addAnchor.call(this, sch.$dynamicAnchor);
        baseIds[jsonPtr] = innerBaseId;
        function addRef(ref) {
          const _resolve = this.opts.uriResolver.resolve;
          ref = normalizeId(innerBaseId ? _resolve(innerBaseId, ref) : ref);
          if (schemaRefs.has(ref))
            throw ambiguos(ref);
          schemaRefs.add(ref);
          let schOrRef = this.refs[ref];
          if (typeof schOrRef == "string")
            schOrRef = this.refs[schOrRef];
          if (typeof schOrRef == "object") {
            checkAmbiguosRef(sch, schOrRef.schema, ref);
          } else if (ref !== normalizeId(fullPath)) {
            if (ref[0] === "#") {
              checkAmbiguosRef(sch, localRefs[ref], ref);
              localRefs[ref] = sch;
            } else {
              this.refs[ref] = fullPath;
            }
          }
          return ref;
        }
        function addAnchor(anchor) {
          if (typeof anchor == "string") {
            if (!ANCHOR.test(anchor))
              throw new Error(`invalid anchor "${anchor}"`);
            addRef.call(this, `#${anchor}`);
          }
        }
      });
      return localRefs;
      function checkAmbiguosRef(sch1, sch2, ref) {
        if (sch2 !== void 0 && !equal(sch1, sch2))
          throw ambiguos(ref);
      }
      function ambiguos(ref) {
        return new Error(`reference "${ref}" resolves to more than one schema`);
      }
    }
    exports.getSchemaRefs = getSchemaRefs;
  }
});

// node_modules/.pnpm/ajv@8.20.0/node_modules/ajv/dist/compile/validate/index.js
var require_validate = __commonJS({
  "node_modules/.pnpm/ajv@8.20.0/node_modules/ajv/dist/compile/validate/index.js"(exports) {
    "use strict";
    Object.defineProperty(exports, "__esModule", { value: true });
    exports.getData = exports.KeywordCxt = exports.validateFunctionCode = void 0;
    var boolSchema_1 = require_boolSchema();
    var dataType_1 = require_dataType();
    var applicability_1 = require_applicability();
    var dataType_2 = require_dataType();
    var defaults_1 = require_defaults();
    var keyword_1 = require_keyword();
    var subschema_1 = require_subschema();
    var codegen_1 = require_codegen();
    var names_1 = require_names();
    var resolve_1 = require_resolve();
    var util_1 = require_util();
    var errors_1 = require_errors();
    function validateFunctionCode(it) {
      if (isSchemaObj(it)) {
        checkKeywords(it);
        if (schemaCxtHasRules(it)) {
          topSchemaObjCode(it);
          return;
        }
      }
      validateFunction(it, () => (0, boolSchema_1.topBoolOrEmptySchema)(it));
    }
    exports.validateFunctionCode = validateFunctionCode;
    function validateFunction({ gen, validateName, schema, schemaEnv, opts }, body) {
      if (opts.code.es5) {
        gen.func(validateName, (0, codegen_1._)`${names_1.default.data}, ${names_1.default.valCxt}`, schemaEnv.$async, () => {
          gen.code((0, codegen_1._)`"use strict"; ${funcSourceUrl(schema, opts)}`);
          destructureValCxtES5(gen, opts);
          gen.code(body);
        });
      } else {
        gen.func(validateName, (0, codegen_1._)`${names_1.default.data}, ${destructureValCxt(opts)}`, schemaEnv.$async, () => gen.code(funcSourceUrl(schema, opts)).code(body));
      }
    }
    function destructureValCxt(opts) {
      return (0, codegen_1._)`{${names_1.default.instancePath}="", ${names_1.default.parentData}, ${names_1.default.parentDataProperty}, ${names_1.default.rootData}=${names_1.default.data}${opts.dynamicRef ? (0, codegen_1._)`, ${names_1.default.dynamicAnchors}={}` : codegen_1.nil}}={}`;
    }
    function destructureValCxtES5(gen, opts) {
      gen.if(names_1.default.valCxt, () => {
        gen.var(names_1.default.instancePath, (0, codegen_1._)`${names_1.default.valCxt}.${names_1.default.instancePath}`);
        gen.var(names_1.default.parentData, (0, codegen_1._)`${names_1.default.valCxt}.${names_1.default.parentData}`);
        gen.var(names_1.default.parentDataProperty, (0, codegen_1._)`${names_1.default.valCxt}.${names_1.default.parentDataProperty}`);
        gen.var(names_1.default.rootData, (0, codegen_1._)`${names_1.default.valCxt}.${names_1.default.rootData}`);
        if (opts.dynamicRef)
          gen.var(names_1.default.dynamicAnchors, (0, codegen_1._)`${names_1.default.valCxt}.${names_1.default.dynamicAnchors}`);
      }, () => {
        gen.var(names_1.default.instancePath, (0, codegen_1._)`""`);
        gen.var(names_1.default.parentData, (0, codegen_1._)`undefined`);
        gen.var(names_1.default.parentDataProperty, (0, codegen_1._)`undefined`);
        gen.var(names_1.default.rootData, names_1.default.data);
        if (opts.dynamicRef)
          gen.var(names_1.default.dynamicAnchors, (0, codegen_1._)`{}`);
      });
    }
    function topSchemaObjCode(it) {
      const { schema, opts, gen } = it;
      validateFunction(it, () => {
        if (opts.$comment && schema.$comment)
          commentKeyword(it);
        checkNoDefault(it);
        gen.let(names_1.default.vErrors, null);
        gen.let(names_1.default.errors, 0);
        if (opts.unevaluated)
          resetEvaluated(it);
        typeAndKeywords(it);
        returnResults(it);
      });
      return;
    }
    function resetEvaluated(it) {
      const { gen, validateName } = it;
      it.evaluated = gen.const("evaluated", (0, codegen_1._)`${validateName}.evaluated`);
      gen.if((0, codegen_1._)`${it.evaluated}.dynamicProps`, () => gen.assign((0, codegen_1._)`${it.evaluated}.props`, (0, codegen_1._)`undefined`));
      gen.if((0, codegen_1._)`${it.evaluated}.dynamicItems`, () => gen.assign((0, codegen_1._)`${it.evaluated}.items`, (0, codegen_1._)`undefined`));
    }
    function funcSourceUrl(schema, opts) {
      const schId = typeof schema == "object" && schema[opts.schemaId];
      return schId && (opts.code.source || opts.code.process) ? (0, codegen_1._)`/*# sourceURL=${schId} */` : codegen_1.nil;
    }
    function subschemaCode(it, valid) {
      if (isSchemaObj(it)) {
        checkKeywords(it);
        if (schemaCxtHasRules(it)) {
          subSchemaObjCode(it, valid);
          return;
        }
      }
      (0, boolSchema_1.boolOrEmptySchema)(it, valid);
    }
    function schemaCxtHasRules({ schema, self }) {
      if (typeof schema == "boolean")
        return !schema;
      for (const key in schema)
        if (self.RULES.all[key])
          return true;
      return false;
    }
    function isSchemaObj(it) {
      return typeof it.schema != "boolean";
    }
    function subSchemaObjCode(it, valid) {
      const { schema, gen, opts } = it;
      if (opts.$comment && schema.$comment)
        commentKeyword(it);
      updateContext(it);
      checkAsyncSchema(it);
      const errsCount = gen.const("_errs", names_1.default.errors);
      typeAndKeywords(it, errsCount);
      gen.var(valid, (0, codegen_1._)`${errsCount} === ${names_1.default.errors}`);
    }
    function checkKeywords(it) {
      (0, util_1.checkUnknownRules)(it);
      checkRefsAndKeywords(it);
    }
    function typeAndKeywords(it, errsCount) {
      if (it.opts.jtd)
        return schemaKeywords(it, [], false, errsCount);
      const types = (0, dataType_1.getSchemaTypes)(it.schema);
      const checkedTypes = (0, dataType_1.coerceAndCheckDataType)(it, types);
      schemaKeywords(it, types, !checkedTypes, errsCount);
    }
    function checkRefsAndKeywords(it) {
      const { schema, errSchemaPath, opts, self } = it;
      if (schema.$ref && opts.ignoreKeywordsWithRef && (0, util_1.schemaHasRulesButRef)(schema, self.RULES)) {
        self.logger.warn(`$ref: keywords ignored in schema at path "${errSchemaPath}"`);
      }
    }
    function checkNoDefault(it) {
      const { schema, opts } = it;
      if (schema.default !== void 0 && opts.useDefaults && opts.strictSchema) {
        (0, util_1.checkStrictMode)(it, "default is ignored in the schema root");
      }
    }
    function updateContext(it) {
      const schId = it.schema[it.opts.schemaId];
      if (schId)
        it.baseId = (0, resolve_1.resolveUrl)(it.opts.uriResolver, it.baseId, schId);
    }
    function checkAsyncSchema(it) {
      if (it.schema.$async && !it.schemaEnv.$async)
        throw new Error("async schema in sync schema");
    }
    function commentKeyword({ gen, schemaEnv, schema, errSchemaPath, opts }) {
      const msg = schema.$comment;
      if (opts.$comment === true) {
        gen.code((0, codegen_1._)`${names_1.default.self}.logger.log(${msg})`);
      } else if (typeof opts.$comment == "function") {
        const schemaPath = (0, codegen_1.str)`${errSchemaPath}/$comment`;
        const rootName = gen.scopeValue("root", { ref: schemaEnv.root });
        gen.code((0, codegen_1._)`${names_1.default.self}.opts.$comment(${msg}, ${schemaPath}, ${rootName}.schema)`);
      }
    }
    function returnResults(it) {
      const { gen, schemaEnv, validateName, ValidationError, opts } = it;
      if (schemaEnv.$async) {
        gen.if((0, codegen_1._)`${names_1.default.errors} === 0`, () => gen.return(names_1.default.data), () => gen.throw((0, codegen_1._)`new ${ValidationError}(${names_1.default.vErrors})`));
      } else {
        gen.assign((0, codegen_1._)`${validateName}.errors`, names_1.default.vErrors);
        if (opts.unevaluated)
          assignEvaluated(it);
        gen.return((0, codegen_1._)`${names_1.default.errors} === 0`);
      }
    }
    function assignEvaluated({ gen, evaluated, props, items }) {
      if (props instanceof codegen_1.Name)
        gen.assign((0, codegen_1._)`${evaluated}.props`, props);
      if (items instanceof codegen_1.Name)
        gen.assign((0, codegen_1._)`${evaluated}.items`, items);
    }
    function schemaKeywords(it, types, typeErrors, errsCount) {
      const { gen, schema, data, allErrors, opts, self } = it;
      const { RULES } = self;
      if (schema.$ref && (opts.ignoreKeywordsWithRef || !(0, util_1.schemaHasRulesButRef)(schema, RULES))) {
        gen.block(() => keywordCode(it, "$ref", RULES.all.$ref.definition));
        return;
      }
      if (!opts.jtd)
        checkStrictTypes(it, types);
      gen.block(() => {
        for (const group of RULES.rules)
          groupKeywords(group);
        groupKeywords(RULES.post);
      });
      function groupKeywords(group) {
        if (!(0, applicability_1.shouldUseGroup)(schema, group))
          return;
        if (group.type) {
          gen.if((0, dataType_2.checkDataType)(group.type, data, opts.strictNumbers));
          iterateKeywords(it, group);
          if (types.length === 1 && types[0] === group.type && typeErrors) {
            gen.else();
            (0, dataType_2.reportTypeError)(it);
          }
          gen.endIf();
        } else {
          iterateKeywords(it, group);
        }
        if (!allErrors)
          gen.if((0, codegen_1._)`${names_1.default.errors} === ${errsCount || 0}`);
      }
    }
    function iterateKeywords(it, group) {
      const { gen, schema, opts: { useDefaults } } = it;
      if (useDefaults)
        (0, defaults_1.assignDefaults)(it, group.type);
      gen.block(() => {
        for (const rule of group.rules) {
          if ((0, applicability_1.shouldUseRule)(schema, rule)) {
            keywordCode(it, rule.keyword, rule.definition, group.type);
          }
        }
      });
    }
    function checkStrictTypes(it, types) {
      if (it.schemaEnv.meta || !it.opts.strictTypes)
        return;
      checkContextTypes(it, types);
      if (!it.opts.allowUnionTypes)
        checkMultipleTypes(it, types);
      checkKeywordTypes(it, it.dataTypes);
    }
    function checkContextTypes(it, types) {
      if (!types.length)
        return;
      if (!it.dataTypes.length) {
        it.dataTypes = types;
        return;
      }
      types.forEach((t) => {
        if (!includesType(it.dataTypes, t)) {
          strictTypesError(it, `type "${t}" not allowed by context "${it.dataTypes.join(",")}"`);
        }
      });
      narrowSchemaTypes(it, types);
    }
    function checkMultipleTypes(it, ts) {
      if (ts.length > 1 && !(ts.length === 2 && ts.includes("null"))) {
        strictTypesError(it, "use allowUnionTypes to allow union type keyword");
      }
    }
    function checkKeywordTypes(it, ts) {
      const rules = it.self.RULES.all;
      for (const keyword in rules) {
        const rule = rules[keyword];
        if (typeof rule == "object" && (0, applicability_1.shouldUseRule)(it.schema, rule)) {
          const { type } = rule.definition;
          if (type.length && !type.some((t) => hasApplicableType(ts, t))) {
            strictTypesError(it, `missing type "${type.join(",")}" for keyword "${keyword}"`);
          }
        }
      }
    }
    function hasApplicableType(schTs, kwdT) {
      return schTs.includes(kwdT) || kwdT === "number" && schTs.includes("integer");
    }
    function includesType(ts, t) {
      return ts.includes(t) || t === "integer" && ts.includes("number");
    }
    function narrowSchemaTypes(it, withTypes) {
      const ts = [];
      for (const t of it.dataTypes) {
        if (includesType(withTypes, t))
          ts.push(t);
        else if (withTypes.includes("integer") && t === "number")
          ts.push("integer");
      }
      it.dataTypes = ts;
    }
    function strictTypesError(it, msg) {
      const schemaPath = it.schemaEnv.baseId + it.errSchemaPath;
      msg += ` at "${schemaPath}" (strictTypes)`;
      (0, util_1.checkStrictMode)(it, msg, it.opts.strictTypes);
    }
    var KeywordCxt = class {
      constructor(it, def, keyword) {
        (0, keyword_1.validateKeywordUsage)(it, def, keyword);
        this.gen = it.gen;
        this.allErrors = it.allErrors;
        this.keyword = keyword;
        this.data = it.data;
        this.schema = it.schema[keyword];
        this.$data = def.$data && it.opts.$data && this.schema && this.schema.$data;
        this.schemaValue = (0, util_1.schemaRefOrVal)(it, this.schema, keyword, this.$data);
        this.schemaType = def.schemaType;
        this.parentSchema = it.schema;
        this.params = {};
        this.it = it;
        this.def = def;
        if (this.$data) {
          this.schemaCode = it.gen.const("vSchema", getData(this.$data, it));
        } else {
          this.schemaCode = this.schemaValue;
          if (!(0, keyword_1.validSchemaType)(this.schema, def.schemaType, def.allowUndefined)) {
            throw new Error(`${keyword} value must be ${JSON.stringify(def.schemaType)}`);
          }
        }
        if ("code" in def ? def.trackErrors : def.errors !== false) {
          this.errsCount = it.gen.const("_errs", names_1.default.errors);
        }
      }
      result(condition, successAction, failAction) {
        this.failResult((0, codegen_1.not)(condition), successAction, failAction);
      }
      failResult(condition, successAction, failAction) {
        this.gen.if(condition);
        if (failAction)
          failAction();
        else
          this.error();
        if (successAction) {
          this.gen.else();
          successAction();
          if (this.allErrors)
            this.gen.endIf();
        } else {
          if (this.allErrors)
            this.gen.endIf();
          else
            this.gen.else();
        }
      }
      pass(condition, failAction) {
        this.failResult((0, codegen_1.not)(condition), void 0, failAction);
      }
      fail(condition) {
        if (condition === void 0) {
          this.error();
          if (!this.allErrors)
            this.gen.if(false);
          return;
        }
        this.gen.if(condition);
        this.error();
        if (this.allErrors)
          this.gen.endIf();
        else
          this.gen.else();
      }
      fail$data(condition) {
        if (!this.$data)
          return this.fail(condition);
        const { schemaCode } = this;
        this.fail((0, codegen_1._)`${schemaCode} !== undefined && (${(0, codegen_1.or)(this.invalid$data(), condition)})`);
      }
      error(append, errorParams, errorPaths) {
        if (errorParams) {
          this.setParams(errorParams);
          this._error(append, errorPaths);
          this.setParams({});
          return;
        }
        this._error(append, errorPaths);
      }
      _error(append, errorPaths) {
        ;
        (append ? errors_1.reportExtraError : errors_1.reportError)(this, this.def.error, errorPaths);
      }
      $dataError() {
        (0, errors_1.reportError)(this, this.def.$dataError || errors_1.keyword$DataError);
      }
      reset() {
        if (this.errsCount === void 0)
          throw new Error('add "trackErrors" to keyword definition');
        (0, errors_1.resetErrorsCount)(this.gen, this.errsCount);
      }
      ok(cond) {
        if (!this.allErrors)
          this.gen.if(cond);
      }
      setParams(obj, assign) {
        if (assign)
          Object.assign(this.params, obj);
        else
          this.params = obj;
      }
      block$data(valid, codeBlock, $dataValid = codegen_1.nil) {
        this.gen.block(() => {
          this.check$data(valid, $dataValid);
          codeBlock();
        });
      }
      check$data(valid = codegen_1.nil, $dataValid = codegen_1.nil) {
        if (!this.$data)
          return;
        const { gen, schemaCode, schemaType, def } = this;
        gen.if((0, codegen_1.or)((0, codegen_1._)`${schemaCode} === undefined`, $dataValid));
        if (valid !== codegen_1.nil)
          gen.assign(valid, true);
        if (schemaType.length || def.validateSchema) {
          gen.elseIf(this.invalid$data());
          this.$dataError();
          if (valid !== codegen_1.nil)
            gen.assign(valid, false);
        }
        gen.else();
      }
      invalid$data() {
        const { gen, schemaCode, schemaType, def, it } = this;
        return (0, codegen_1.or)(wrong$DataType(), invalid$DataSchema());
        function wrong$DataType() {
          if (schemaType.length) {
            if (!(schemaCode instanceof codegen_1.Name))
              throw new Error("ajv implementation error");
            const st = Array.isArray(schemaType) ? schemaType : [schemaType];
            return (0, codegen_1._)`${(0, dataType_2.checkDataTypes)(st, schemaCode, it.opts.strictNumbers, dataType_2.DataType.Wrong)}`;
          }
          return codegen_1.nil;
        }
        function invalid$DataSchema() {
          if (def.validateSchema) {
            const validateSchemaRef = gen.scopeValue("validate$data", { ref: def.validateSchema });
            return (0, codegen_1._)`!${validateSchemaRef}(${schemaCode})`;
          }
          return codegen_1.nil;
        }
      }
      subschema(appl, valid) {
        const subschema = (0, subschema_1.getSubschema)(this.it, appl);
        (0, subschema_1.extendSubschemaData)(subschema, this.it, appl);
        (0, subschema_1.extendSubschemaMode)(subschema, appl);
        const nextContext = { ...this.it, ...subschema, items: void 0, props: void 0 };
        subschemaCode(nextContext, valid);
        return nextContext;
      }
      mergeEvaluated(schemaCxt, toName) {
        const { it, gen } = this;
        if (!it.opts.unevaluated)
          return;
        if (it.props !== true && schemaCxt.props !== void 0) {
          it.props = util_1.mergeEvaluated.props(gen, schemaCxt.props, it.props, toName);
        }
        if (it.items !== true && schemaCxt.items !== void 0) {
          it.items = util_1.mergeEvaluated.items(gen, schemaCxt.items, it.items, toName);
        }
      }
      mergeValidEvaluated(schemaCxt, valid) {
        const { it, gen } = this;
        if (it.opts.unevaluated && (it.props !== true || it.items !== true)) {
          gen.if(valid, () => this.mergeEvaluated(schemaCxt, codegen_1.Name));
          return true;
        }
      }
    };
    exports.KeywordCxt = KeywordCxt;
    function keywordCode(it, keyword, def, ruleType) {
      const cxt = new KeywordCxt(it, def, keyword);
      if ("code" in def) {
        def.code(cxt, ruleType);
      } else if (cxt.$data && def.validate) {
        (0, keyword_1.funcKeywordCode)(cxt, def);
      } else if ("macro" in def) {
        (0, keyword_1.macroKeywordCode)(cxt, def);
      } else if (def.compile || def.validate) {
        (0, keyword_1.funcKeywordCode)(cxt, def);
      }
    }
    var JSON_POINTER = /^\/(?:[^~]|~0|~1)*$/;
    var RELATIVE_JSON_POINTER = /^([0-9]+)(#|\/(?:[^~]|~0|~1)*)?$/;
    function getData($data, { dataLevel, dataNames, dataPathArr }) {
      let jsonPointer;
      let data;
      if ($data === "")
        return names_1.default.rootData;
      if ($data[0] === "/") {
        if (!JSON_POINTER.test($data))
          throw new Error(`Invalid JSON-pointer: ${$data}`);
        jsonPointer = $data;
        data = names_1.default.rootData;
      } else {
        const matches = RELATIVE_JSON_POINTER.exec($data);
        if (!matches)
          throw new Error(`Invalid JSON-pointer: ${$data}`);
        const up = +matches[1];
        jsonPointer = matches[2];
        if (jsonPointer === "#") {
          if (up >= dataLevel)
            throw new Error(errorMsg("property/index", up));
          return dataPathArr[dataLevel - up];
        }
        if (up > dataLevel)
          throw new Error(errorMsg("data", up));
        data = dataNames[dataLevel - up];
        if (!jsonPointer)
          return data;
      }
      let expr = data;
      const segments = jsonPointer.split("/");
      for (const segment of segments) {
        if (segment) {
          data = (0, codegen_1._)`${data}${(0, codegen_1.getProperty)((0, util_1.unescapeJsonPointer)(segment))}`;
          expr = (0, codegen_1._)`${expr} && ${data}`;
        }
      }
      return expr;
      function errorMsg(pointerType, up) {
        return `Cannot access ${pointerType} ${up} levels up, current level is ${dataLevel}`;
      }
    }
    exports.getData = getData;
  }
});

// node_modules/.pnpm/ajv@8.20.0/node_modules/ajv/dist/runtime/validation_error.js
var require_validation_error = __commonJS({
  "node_modules/.pnpm/ajv@8.20.0/node_modules/ajv/dist/runtime/validation_error.js"(exports) {
    "use strict";
    Object.defineProperty(exports, "__esModule", { value: true });
    var ValidationError = class extends Error {
      constructor(errors) {
        super("validation failed");
        this.errors = errors;
        this.ajv = this.validation = true;
      }
    };
    exports.default = ValidationError;
  }
});

// node_modules/.pnpm/ajv@8.20.0/node_modules/ajv/dist/compile/ref_error.js
var require_ref_error = __commonJS({
  "node_modules/.pnpm/ajv@8.20.0/node_modules/ajv/dist/compile/ref_error.js"(exports) {
    "use strict";
    Object.defineProperty(exports, "__esModule", { value: true });
    var resolve_1 = require_resolve();
    var MissingRefError = class extends Error {
      constructor(resolver, baseId, ref, msg) {
        super(msg || `can't resolve reference ${ref} from id ${baseId}`);
        this.missingRef = (0, resolve_1.resolveUrl)(resolver, baseId, ref);
        this.missingSchema = (0, resolve_1.normalizeId)((0, resolve_1.getFullPath)(resolver, this.missingRef));
      }
    };
    exports.default = MissingRefError;
  }
});

// node_modules/.pnpm/ajv@8.20.0/node_modules/ajv/dist/compile/index.js
var require_compile = __commonJS({
  "node_modules/.pnpm/ajv@8.20.0/node_modules/ajv/dist/compile/index.js"(exports) {
    "use strict";
    Object.defineProperty(exports, "__esModule", { value: true });
    exports.resolveSchema = exports.getCompilingSchema = exports.resolveRef = exports.compileSchema = exports.SchemaEnv = void 0;
    var codegen_1 = require_codegen();
    var validation_error_1 = require_validation_error();
    var names_1 = require_names();
    var resolve_1 = require_resolve();
    var util_1 = require_util();
    var validate_1 = require_validate();
    var SchemaEnv = class {
      constructor(env) {
        var _a;
        this.refs = {};
        this.dynamicAnchors = {};
        let schema;
        if (typeof env.schema == "object")
          schema = env.schema;
        this.schema = env.schema;
        this.schemaId = env.schemaId;
        this.root = env.root || this;
        this.baseId = (_a = env.baseId) !== null && _a !== void 0 ? _a : (0, resolve_1.normalizeId)(schema === null || schema === void 0 ? void 0 : schema[env.schemaId || "$id"]);
        this.schemaPath = env.schemaPath;
        this.localRefs = env.localRefs;
        this.meta = env.meta;
        this.$async = schema === null || schema === void 0 ? void 0 : schema.$async;
        this.refs = {};
      }
    };
    exports.SchemaEnv = SchemaEnv;
    function compileSchema(sch) {
      const _sch = getCompilingSchema.call(this, sch);
      if (_sch)
        return _sch;
      const rootId = (0, resolve_1.getFullPath)(this.opts.uriResolver, sch.root.baseId);
      const { es5, lines } = this.opts.code;
      const { ownProperties } = this.opts;
      const gen = new codegen_1.CodeGen(this.scope, { es5, lines, ownProperties });
      let _ValidationError;
      if (sch.$async) {
        _ValidationError = gen.scopeValue("Error", {
          ref: validation_error_1.default,
          code: (0, codegen_1._)`require("ajv/dist/runtime/validation_error").default`
        });
      }
      const validateName = gen.scopeName("validate");
      sch.validateName = validateName;
      const schemaCxt = {
        gen,
        allErrors: this.opts.allErrors,
        data: names_1.default.data,
        parentData: names_1.default.parentData,
        parentDataProperty: names_1.default.parentDataProperty,
        dataNames: [names_1.default.data],
        dataPathArr: [codegen_1.nil],
        // TODO can its length be used as dataLevel if nil is removed?
        dataLevel: 0,
        dataTypes: [],
        definedProperties: /* @__PURE__ */ new Set(),
        topSchemaRef: gen.scopeValue("schema", this.opts.code.source === true ? { ref: sch.schema, code: (0, codegen_1.stringify)(sch.schema) } : { ref: sch.schema }),
        validateName,
        ValidationError: _ValidationError,
        schema: sch.schema,
        schemaEnv: sch,
        rootId,
        baseId: sch.baseId || rootId,
        schemaPath: codegen_1.nil,
        errSchemaPath: sch.schemaPath || (this.opts.jtd ? "" : "#"),
        errorPath: (0, codegen_1._)`""`,
        opts: this.opts,
        self: this
      };
      let sourceCode;
      try {
        this._compilations.add(sch);
        (0, validate_1.validateFunctionCode)(schemaCxt);
        gen.optimize(this.opts.code.optimize);
        const validateCode = gen.toString();
        sourceCode = `${gen.scopeRefs(names_1.default.scope)}return ${validateCode}`;
        if (this.opts.code.process)
          sourceCode = this.opts.code.process(sourceCode, sch);
        const makeValidate = new Function(`${names_1.default.self}`, `${names_1.default.scope}`, sourceCode);
        const validate = makeValidate(this, this.scope.get());
        this.scope.value(validateName, { ref: validate });
        validate.errors = null;
        validate.schema = sch.schema;
        validate.schemaEnv = sch;
        if (sch.$async)
          validate.$async = true;
        if (this.opts.code.source === true) {
          validate.source = { validateName, validateCode, scopeValues: gen._values };
        }
        if (this.opts.unevaluated) {
          const { props, items } = schemaCxt;
          validate.evaluated = {
            props: props instanceof codegen_1.Name ? void 0 : props,
            items: items instanceof codegen_1.Name ? void 0 : items,
            dynamicProps: props instanceof codegen_1.Name,
            dynamicItems: items instanceof codegen_1.Name
          };
          if (validate.source)
            validate.source.evaluated = (0, codegen_1.stringify)(validate.evaluated);
        }
        sch.validate = validate;
        return sch;
      } catch (e) {
        delete sch.validate;
        delete sch.validateName;
        if (sourceCode)
          this.logger.error("Error compiling schema, function code:", sourceCode);
        throw e;
      } finally {
        this._compilations.delete(sch);
      }
    }
    exports.compileSchema = compileSchema;
    function resolveRef(root, baseId, ref) {
      var _a;
      ref = (0, resolve_1.resolveUrl)(this.opts.uriResolver, baseId, ref);
      const schOrFunc = root.refs[ref];
      if (schOrFunc)
        return schOrFunc;
      let _sch = resolve.call(this, root, ref);
      if (_sch === void 0) {
        const schema = (_a = root.localRefs) === null || _a === void 0 ? void 0 : _a[ref];
        const { schemaId } = this.opts;
        if (schema)
          _sch = new SchemaEnv({ schema, schemaId, root, baseId });
      }
      if (_sch === void 0)
        return;
      return root.refs[ref] = inlineOrCompile.call(this, _sch);
    }
    exports.resolveRef = resolveRef;
    function inlineOrCompile(sch) {
      if ((0, resolve_1.inlineRef)(sch.schema, this.opts.inlineRefs))
        return sch.schema;
      return sch.validate ? sch : compileSchema.call(this, sch);
    }
    function getCompilingSchema(schEnv) {
      for (const sch of this._compilations) {
        if (sameSchemaEnv(sch, schEnv))
          return sch;
      }
    }
    exports.getCompilingSchema = getCompilingSchema;
    function sameSchemaEnv(s1, s2) {
      return s1.schema === s2.schema && s1.root === s2.root && s1.baseId === s2.baseId;
    }
    function resolve(root, ref) {
      let sch;
      while (typeof (sch = this.refs[ref]) == "string")
        ref = sch;
      return sch || this.schemas[ref] || resolveSchema.call(this, root, ref);
    }
    function resolveSchema(root, ref) {
      const p = this.opts.uriResolver.parse(ref);
      const refPath = (0, resolve_1._getFullPath)(this.opts.uriResolver, p);
      let baseId = (0, resolve_1.getFullPath)(this.opts.uriResolver, root.baseId, void 0);
      if (Object.keys(root.schema).length > 0 && refPath === baseId) {
        return getJsonPointer.call(this, p, root);
      }
      const id = (0, resolve_1.normalizeId)(refPath);
      const schOrRef = this.refs[id] || this.schemas[id];
      if (typeof schOrRef == "string") {
        const sch = resolveSchema.call(this, root, schOrRef);
        if (typeof (sch === null || sch === void 0 ? void 0 : sch.schema) !== "object")
          return;
        return getJsonPointer.call(this, p, sch);
      }
      if (typeof (schOrRef === null || schOrRef === void 0 ? void 0 : schOrRef.schema) !== "object")
        return;
      if (!schOrRef.validate)
        compileSchema.call(this, schOrRef);
      if (id === (0, resolve_1.normalizeId)(ref)) {
        const { schema } = schOrRef;
        const { schemaId } = this.opts;
        const schId = schema[schemaId];
        if (schId)
          baseId = (0, resolve_1.resolveUrl)(this.opts.uriResolver, baseId, schId);
        return new SchemaEnv({ schema, schemaId, root, baseId });
      }
      return getJsonPointer.call(this, p, schOrRef);
    }
    exports.resolveSchema = resolveSchema;
    var PREVENT_SCOPE_CHANGE = /* @__PURE__ */ new Set([
      "properties",
      "patternProperties",
      "enum",
      "dependencies",
      "definitions"
    ]);
    function getJsonPointer(parsedRef, { baseId, schema, root }) {
      var _a;
      if (((_a = parsedRef.fragment) === null || _a === void 0 ? void 0 : _a[0]) !== "/")
        return;
      for (const part of parsedRef.fragment.slice(1).split("/")) {
        if (typeof schema === "boolean")
          return;
        const partSchema = schema[(0, util_1.unescapeFragment)(part)];
        if (partSchema === void 0)
          return;
        schema = partSchema;
        const schId = typeof schema === "object" && schema[this.opts.schemaId];
        if (!PREVENT_SCOPE_CHANGE.has(part) && schId) {
          baseId = (0, resolve_1.resolveUrl)(this.opts.uriResolver, baseId, schId);
        }
      }
      let env;
      if (typeof schema != "boolean" && schema.$ref && !(0, util_1.schemaHasRulesButRef)(schema, this.RULES)) {
        const $ref = (0, resolve_1.resolveUrl)(this.opts.uriResolver, baseId, schema.$ref);
        env = resolveSchema.call(this, root, $ref);
      }
      const { schemaId } = this.opts;
      env = env || new SchemaEnv({ schema, schemaId, root, baseId });
      if (env.schema !== env.root.schema)
        return env;
      return void 0;
    }
  }
});

// node_modules/.pnpm/ajv@8.20.0/node_modules/ajv/dist/refs/data.json
var require_data = __commonJS({
  "node_modules/.pnpm/ajv@8.20.0/node_modules/ajv/dist/refs/data.json"(exports, module) {
    module.exports = {
      $id: "https://raw.githubusercontent.com/ajv-validator/ajv/master/lib/refs/data.json#",
      description: "Meta-schema for $data reference (JSON AnySchema extension proposal)",
      type: "object",
      required: ["$data"],
      properties: {
        $data: {
          type: "string",
          anyOf: [{ format: "relative-json-pointer" }, { format: "json-pointer" }]
        }
      },
      additionalProperties: false
    };
  }
});

// node_modules/.pnpm/fast-uri@3.1.2/node_modules/fast-uri/lib/utils.js
var require_utils = __commonJS({
  "node_modules/.pnpm/fast-uri@3.1.2/node_modules/fast-uri/lib/utils.js"(exports, module) {
    "use strict";
    var isUUID = RegExp.prototype.test.bind(/^[\da-f]{8}-[\da-f]{4}-[\da-f]{4}-[\da-f]{4}-[\da-f]{12}$/iu);
    var isIPv4 = RegExp.prototype.test.bind(/^(?:(?:25[0-5]|2[0-4]\d|1\d{2}|[1-9]\d|\d)\.){3}(?:25[0-5]|2[0-4]\d|1\d{2}|[1-9]\d|\d)$/u);
    var isHexPair = RegExp.prototype.test.bind(/^[\da-f]{2}$/iu);
    var isUnreserved = RegExp.prototype.test.bind(/^[\da-z\-._~]$/iu);
    var isPathCharacter = RegExp.prototype.test.bind(/^[\da-z\-._~!$&'()*+,;=:@/]$/iu);
    function stringArrayToHexStripped(input) {
      let acc = "";
      let code = 0;
      let i = 0;
      for (i = 0; i < input.length; i++) {
        code = input[i].charCodeAt(0);
        if (code === 48) {
          continue;
        }
        if (!(code >= 48 && code <= 57 || code >= 65 && code <= 70 || code >= 97 && code <= 102)) {
          return "";
        }
        acc += input[i];
        break;
      }
      for (i += 1; i < input.length; i++) {
        code = input[i].charCodeAt(0);
        if (!(code >= 48 && code <= 57 || code >= 65 && code <= 70 || code >= 97 && code <= 102)) {
          return "";
        }
        acc += input[i];
      }
      return acc;
    }
    var nonSimpleDomain = RegExp.prototype.test.bind(/[^!"$&'()*+,\-.;=_`a-z{}~]/u);
    function consumeIsZone(buffer) {
      buffer.length = 0;
      return true;
    }
    function consumeHextets(buffer, address, output) {
      if (buffer.length) {
        const hex = stringArrayToHexStripped(buffer);
        if (hex !== "") {
          address.push(hex);
        } else {
          output.error = true;
          return false;
        }
        buffer.length = 0;
      }
      return true;
    }
    function getIPV6(input) {
      let tokenCount = 0;
      const output = { error: false, address: "", zone: "" };
      const address = [];
      const buffer = [];
      let endipv6Encountered = false;
      let endIpv6 = false;
      let consume = consumeHextets;
      for (let i = 0; i < input.length; i++) {
        const cursor = input[i];
        if (cursor === "[" || cursor === "]") {
          continue;
        }
        if (cursor === ":") {
          if (endipv6Encountered === true) {
            endIpv6 = true;
          }
          if (!consume(buffer, address, output)) {
            break;
          }
          if (++tokenCount > 7) {
            output.error = true;
            break;
          }
          if (i > 0 && input[i - 1] === ":") {
            endipv6Encountered = true;
          }
          address.push(":");
          continue;
        } else if (cursor === "%") {
          if (!consume(buffer, address, output)) {
            break;
          }
          consume = consumeIsZone;
        } else {
          buffer.push(cursor);
          continue;
        }
      }
      if (buffer.length) {
        if (consume === consumeIsZone) {
          output.zone = buffer.join("");
        } else if (endIpv6) {
          address.push(buffer.join(""));
        } else {
          address.push(stringArrayToHexStripped(buffer));
        }
      }
      output.address = address.join("");
      return output;
    }
    function normalizeIPv6(host) {
      if (findToken(host, ":") < 2) {
        return { host, isIPV6: false };
      }
      const ipv6 = getIPV6(host);
      if (!ipv6.error) {
        let newHost = ipv6.address;
        let escapedHost = ipv6.address;
        if (ipv6.zone) {
          newHost += "%" + ipv6.zone;
          escapedHost += "%25" + ipv6.zone;
        }
        return { host: newHost, isIPV6: true, escapedHost };
      } else {
        return { host, isIPV6: false };
      }
    }
    function findToken(str, token) {
      let ind = 0;
      for (let i = 0; i < str.length; i++) {
        if (str[i] === token) ind++;
      }
      return ind;
    }
    function removeDotSegments(path7) {
      let input = path7;
      const output = [];
      let nextSlash = -1;
      let len = 0;
      while (len = input.length) {
        if (len === 1) {
          if (input === ".") {
            break;
          } else if (input === "/") {
            output.push("/");
            break;
          } else {
            output.push(input);
            break;
          }
        } else if (len === 2) {
          if (input[0] === ".") {
            if (input[1] === ".") {
              break;
            } else if (input[1] === "/") {
              input = input.slice(2);
              continue;
            }
          } else if (input[0] === "/") {
            if (input[1] === "." || input[1] === "/") {
              output.push("/");
              break;
            }
          }
        } else if (len === 3) {
          if (input === "/..") {
            if (output.length !== 0) {
              output.pop();
            }
            output.push("/");
            break;
          }
        }
        if (input[0] === ".") {
          if (input[1] === ".") {
            if (input[2] === "/") {
              input = input.slice(3);
              continue;
            }
          } else if (input[1] === "/") {
            input = input.slice(2);
            continue;
          }
        } else if (input[0] === "/") {
          if (input[1] === ".") {
            if (input[2] === "/") {
              input = input.slice(2);
              continue;
            } else if (input[2] === ".") {
              if (input[3] === "/") {
                input = input.slice(3);
                if (output.length !== 0) {
                  output.pop();
                }
                continue;
              }
            }
          }
        }
        if ((nextSlash = input.indexOf("/", 1)) === -1) {
          output.push(input);
          break;
        } else {
          output.push(input.slice(0, nextSlash));
          input = input.slice(nextSlash);
        }
      }
      return output.join("");
    }
    var HOST_DELIMS = { "@": "%40", "/": "%2F", "?": "%3F", "#": "%23", ":": "%3A" };
    var HOST_DELIM_RE = /[@/?#:]/g;
    var HOST_DELIM_NO_COLON_RE = /[@/?#]/g;
    function reescapeHostDelimiters(host, isIP) {
      const re = isIP ? HOST_DELIM_NO_COLON_RE : HOST_DELIM_RE;
      re.lastIndex = 0;
      return host.replace(re, (ch) => HOST_DELIMS[ch]);
    }
    function normalizePercentEncoding(input, decodeUnreserved = false) {
      if (input.indexOf("%") === -1) {
        return input;
      }
      let output = "";
      for (let i = 0; i < input.length; i++) {
        if (input[i] === "%" && i + 2 < input.length) {
          const hex = input.slice(i + 1, i + 3);
          if (isHexPair(hex)) {
            const normalizedHex = hex.toUpperCase();
            const decoded = String.fromCharCode(parseInt(normalizedHex, 16));
            if (decodeUnreserved && isUnreserved(decoded)) {
              output += decoded;
            } else {
              output += "%" + normalizedHex;
            }
            i += 2;
            continue;
          }
        }
        output += input[i];
      }
      return output;
    }
    function normalizePathEncoding(input) {
      let output = "";
      for (let i = 0; i < input.length; i++) {
        if (input[i] === "%" && i + 2 < input.length) {
          const hex = input.slice(i + 1, i + 3);
          if (isHexPair(hex)) {
            const normalizedHex = hex.toUpperCase();
            const decoded = String.fromCharCode(parseInt(normalizedHex, 16));
            if (decoded !== "." && isUnreserved(decoded)) {
              output += decoded;
            } else {
              output += "%" + normalizedHex;
            }
            i += 2;
            continue;
          }
        }
        if (isPathCharacter(input[i])) {
          output += input[i];
        } else {
          output += escape(input[i]);
        }
      }
      return output;
    }
    function escapePreservingEscapes(input) {
      let output = "";
      for (let i = 0; i < input.length; i++) {
        if (input[i] === "%" && i + 2 < input.length) {
          const hex = input.slice(i + 1, i + 3);
          if (isHexPair(hex)) {
            output += "%" + hex.toUpperCase();
            i += 2;
            continue;
          }
        }
        output += escape(input[i]);
      }
      return output;
    }
    function recomposeAuthority(component) {
      const uriTokens = [];
      if (component.userinfo !== void 0) {
        uriTokens.push(component.userinfo);
        uriTokens.push("@");
      }
      if (component.host !== void 0) {
        let host = unescape(component.host);
        if (!isIPv4(host)) {
          const ipV6res = normalizeIPv6(host);
          if (ipV6res.isIPV6 === true) {
            host = `[${ipV6res.escapedHost}]`;
          } else {
            host = reescapeHostDelimiters(host, false);
          }
        }
        uriTokens.push(host);
      }
      if (typeof component.port === "number" || typeof component.port === "string") {
        uriTokens.push(":");
        uriTokens.push(String(component.port));
      }
      return uriTokens.length ? uriTokens.join("") : void 0;
    }
    module.exports = {
      nonSimpleDomain,
      recomposeAuthority,
      reescapeHostDelimiters,
      normalizePercentEncoding,
      normalizePathEncoding,
      escapePreservingEscapes,
      removeDotSegments,
      isIPv4,
      isUUID,
      normalizeIPv6,
      stringArrayToHexStripped
    };
  }
});

// node_modules/.pnpm/fast-uri@3.1.2/node_modules/fast-uri/lib/schemes.js
var require_schemes = __commonJS({
  "node_modules/.pnpm/fast-uri@3.1.2/node_modules/fast-uri/lib/schemes.js"(exports, module) {
    "use strict";
    var { isUUID } = require_utils();
    var URN_REG = /([\da-z][\d\-a-z]{0,31}):((?:[\w!$'()*+,\-.:;=@]|%[\da-f]{2})+)/iu;
    var supportedSchemeNames = (
      /** @type {const} */
      [
        "http",
        "https",
        "ws",
        "wss",
        "urn",
        "urn:uuid"
      ]
    );
    function isValidSchemeName(name) {
      return supportedSchemeNames.indexOf(
        /** @type {*} */
        name
      ) !== -1;
    }
    function wsIsSecure(wsComponent) {
      if (wsComponent.secure === true) {
        return true;
      } else if (wsComponent.secure === false) {
        return false;
      } else if (wsComponent.scheme) {
        return wsComponent.scheme.length === 3 && (wsComponent.scheme[0] === "w" || wsComponent.scheme[0] === "W") && (wsComponent.scheme[1] === "s" || wsComponent.scheme[1] === "S") && (wsComponent.scheme[2] === "s" || wsComponent.scheme[2] === "S");
      } else {
        return false;
      }
    }
    function httpParse(component) {
      if (!component.host) {
        component.error = component.error || "HTTP URIs must have a host.";
      }
      return component;
    }
    function httpSerialize(component) {
      const secure = String(component.scheme).toLowerCase() === "https";
      if (component.port === (secure ? 443 : 80) || component.port === "") {
        component.port = void 0;
      }
      if (!component.path) {
        component.path = "/";
      }
      return component;
    }
    function wsParse(wsComponent) {
      wsComponent.secure = wsIsSecure(wsComponent);
      wsComponent.resourceName = (wsComponent.path || "/") + (wsComponent.query ? "?" + wsComponent.query : "");
      wsComponent.path = void 0;
      wsComponent.query = void 0;
      return wsComponent;
    }
    function wsSerialize(wsComponent) {
      if (wsComponent.port === (wsIsSecure(wsComponent) ? 443 : 80) || wsComponent.port === "") {
        wsComponent.port = void 0;
      }
      if (typeof wsComponent.secure === "boolean") {
        wsComponent.scheme = wsComponent.secure ? "wss" : "ws";
        wsComponent.secure = void 0;
      }
      if (wsComponent.resourceName) {
        const [path7, query] = wsComponent.resourceName.split("?");
        wsComponent.path = path7 && path7 !== "/" ? path7 : void 0;
        wsComponent.query = query;
        wsComponent.resourceName = void 0;
      }
      wsComponent.fragment = void 0;
      return wsComponent;
    }
    function urnParse(urnComponent, options) {
      if (!urnComponent.path) {
        urnComponent.error = "URN can not be parsed";
        return urnComponent;
      }
      const matches = urnComponent.path.match(URN_REG);
      if (matches) {
        const scheme = options.scheme || urnComponent.scheme || "urn";
        urnComponent.nid = matches[1].toLowerCase();
        urnComponent.nss = matches[2];
        const urnScheme = `${scheme}:${options.nid || urnComponent.nid}`;
        const schemeHandler = getSchemeHandler(urnScheme);
        urnComponent.path = void 0;
        if (schemeHandler) {
          urnComponent = schemeHandler.parse(urnComponent, options);
        }
      } else {
        urnComponent.error = urnComponent.error || "URN can not be parsed.";
      }
      return urnComponent;
    }
    function urnSerialize(urnComponent, options) {
      if (urnComponent.nid === void 0) {
        throw new Error("URN without nid cannot be serialized");
      }
      const scheme = options.scheme || urnComponent.scheme || "urn";
      const nid = urnComponent.nid.toLowerCase();
      const urnScheme = `${scheme}:${options.nid || nid}`;
      const schemeHandler = getSchemeHandler(urnScheme);
      if (schemeHandler) {
        urnComponent = schemeHandler.serialize(urnComponent, options);
      }
      const uriComponent = urnComponent;
      const nss = urnComponent.nss;
      uriComponent.path = `${nid || options.nid}:${nss}`;
      options.skipEscape = true;
      return uriComponent;
    }
    function urnuuidParse(urnComponent, options) {
      const uuidComponent = urnComponent;
      uuidComponent.uuid = uuidComponent.nss;
      uuidComponent.nss = void 0;
      if (!options.tolerant && (!uuidComponent.uuid || !isUUID(uuidComponent.uuid))) {
        uuidComponent.error = uuidComponent.error || "UUID is not valid.";
      }
      return uuidComponent;
    }
    function urnuuidSerialize(uuidComponent) {
      const urnComponent = uuidComponent;
      urnComponent.nss = (uuidComponent.uuid || "").toLowerCase();
      return urnComponent;
    }
    var http = (
      /** @type {SchemeHandler} */
      {
        scheme: "http",
        domainHost: true,
        parse: httpParse,
        serialize: httpSerialize
      }
    );
    var https = (
      /** @type {SchemeHandler} */
      {
        scheme: "https",
        domainHost: http.domainHost,
        parse: httpParse,
        serialize: httpSerialize
      }
    );
    var ws = (
      /** @type {SchemeHandler} */
      {
        scheme: "ws",
        domainHost: true,
        parse: wsParse,
        serialize: wsSerialize
      }
    );
    var wss = (
      /** @type {SchemeHandler} */
      {
        scheme: "wss",
        domainHost: ws.domainHost,
        parse: ws.parse,
        serialize: ws.serialize
      }
    );
    var urn = (
      /** @type {SchemeHandler} */
      {
        scheme: "urn",
        parse: urnParse,
        serialize: urnSerialize,
        skipNormalize: true
      }
    );
    var urnuuid = (
      /** @type {SchemeHandler} */
      {
        scheme: "urn:uuid",
        parse: urnuuidParse,
        serialize: urnuuidSerialize,
        skipNormalize: true
      }
    );
    var SCHEMES = (
      /** @type {Record<SchemeName, SchemeHandler>} */
      {
        http,
        https,
        ws,
        wss,
        urn,
        "urn:uuid": urnuuid
      }
    );
    Object.setPrototypeOf(SCHEMES, null);
    function getSchemeHandler(scheme) {
      return scheme && (SCHEMES[
        /** @type {SchemeName} */
        scheme
      ] || SCHEMES[
        /** @type {SchemeName} */
        scheme.toLowerCase()
      ]) || void 0;
    }
    module.exports = {
      wsIsSecure,
      SCHEMES,
      isValidSchemeName,
      getSchemeHandler
    };
  }
});

// node_modules/.pnpm/fast-uri@3.1.2/node_modules/fast-uri/index.js
var require_fast_uri = __commonJS({
  "node_modules/.pnpm/fast-uri@3.1.2/node_modules/fast-uri/index.js"(exports, module) {
    "use strict";
    var { normalizeIPv6, removeDotSegments, recomposeAuthority, normalizePercentEncoding, normalizePathEncoding, escapePreservingEscapes, reescapeHostDelimiters, isIPv4, nonSimpleDomain } = require_utils();
    var { SCHEMES, getSchemeHandler } = require_schemes();
    function normalize(uri, options) {
      if (typeof uri === "string") {
        uri = /** @type {T} */
        normalizeString(uri, options);
      } else if (typeof uri === "object") {
        uri = /** @type {T} */
        parse(serialize(uri, options), options);
      }
      return uri;
    }
    function resolve(baseURI, relativeURI, options) {
      const schemelessOptions = options ? Object.assign({ scheme: "null" }, options) : { scheme: "null" };
      const resolved = resolveComponent(parse(baseURI, schemelessOptions), parse(relativeURI, schemelessOptions), schemelessOptions, true);
      schemelessOptions.skipEscape = true;
      return serialize(resolved, schemelessOptions);
    }
    function resolveComponent(base, relative, options, skipNormalization) {
      const target = {};
      if (!skipNormalization) {
        base = parse(serialize(base, options), options);
        relative = parse(serialize(relative, options), options);
      }
      options = options || {};
      if (!options.tolerant && relative.scheme) {
        target.scheme = relative.scheme;
        target.userinfo = relative.userinfo;
        target.host = relative.host;
        target.port = relative.port;
        target.path = removeDotSegments(relative.path || "");
        target.query = relative.query;
      } else {
        if (relative.userinfo !== void 0 || relative.host !== void 0 || relative.port !== void 0) {
          target.userinfo = relative.userinfo;
          target.host = relative.host;
          target.port = relative.port;
          target.path = removeDotSegments(relative.path || "");
          target.query = relative.query;
        } else {
          if (!relative.path) {
            target.path = base.path;
            if (relative.query !== void 0) {
              target.query = relative.query;
            } else {
              target.query = base.query;
            }
          } else {
            if (relative.path[0] === "/") {
              target.path = removeDotSegments(relative.path);
            } else {
              if ((base.userinfo !== void 0 || base.host !== void 0 || base.port !== void 0) && !base.path) {
                target.path = "/" + relative.path;
              } else if (!base.path) {
                target.path = relative.path;
              } else {
                target.path = base.path.slice(0, base.path.lastIndexOf("/") + 1) + relative.path;
              }
              target.path = removeDotSegments(target.path);
            }
            target.query = relative.query;
          }
          target.userinfo = base.userinfo;
          target.host = base.host;
          target.port = base.port;
        }
        target.scheme = base.scheme;
      }
      target.fragment = relative.fragment;
      return target;
    }
    function equal(uriA, uriB, options) {
      const normalizedA = normalizeComparableURI(uriA, options);
      const normalizedB = normalizeComparableURI(uriB, options);
      return normalizedA !== void 0 && normalizedB !== void 0 && normalizedA.toLowerCase() === normalizedB.toLowerCase();
    }
    function serialize(cmpts, opts) {
      const component = {
        host: cmpts.host,
        scheme: cmpts.scheme,
        userinfo: cmpts.userinfo,
        port: cmpts.port,
        path: cmpts.path,
        query: cmpts.query,
        nid: cmpts.nid,
        nss: cmpts.nss,
        uuid: cmpts.uuid,
        fragment: cmpts.fragment,
        reference: cmpts.reference,
        resourceName: cmpts.resourceName,
        secure: cmpts.secure,
        error: ""
      };
      const options = Object.assign({}, opts);
      const uriTokens = [];
      const schemeHandler = getSchemeHandler(options.scheme || component.scheme);
      if (schemeHandler && schemeHandler.serialize) schemeHandler.serialize(component, options);
      if (component.path !== void 0) {
        if (!options.skipEscape) {
          component.path = escapePreservingEscapes(component.path);
          if (component.scheme !== void 0) {
            component.path = component.path.split("%3A").join(":");
          }
        } else {
          component.path = normalizePercentEncoding(component.path);
        }
      }
      if (options.reference !== "suffix" && component.scheme) {
        uriTokens.push(component.scheme, ":");
      }
      const authority = recomposeAuthority(component);
      if (authority !== void 0) {
        if (options.reference !== "suffix") {
          uriTokens.push("//");
        }
        uriTokens.push(authority);
        if (component.path && component.path[0] !== "/") {
          uriTokens.push("/");
        }
      }
      if (component.path !== void 0) {
        let s = component.path;
        if (!options.absolutePath && (!schemeHandler || !schemeHandler.absolutePath)) {
          s = removeDotSegments(s);
        }
        if (authority === void 0 && s[0] === "/" && s[1] === "/") {
          s = "/%2F" + s.slice(2);
        }
        uriTokens.push(s);
      }
      if (component.query !== void 0) {
        uriTokens.push("?", component.query);
      }
      if (component.fragment !== void 0) {
        uriTokens.push("#", component.fragment);
      }
      return uriTokens.join("");
    }
    var URI_PARSE = /^(?:([^#/:?]+):)?(?:\/\/((?:([^#/?@]*)@)?(\[[^#/?\]]+\]|[^#/:?]*)(?::(\d*))?))?([^#?]*)(?:\?([^#]*))?(?:#((?:.|[\n\r])*))?/u;
    function getParseError(parsed, matches) {
      if (matches[2] !== void 0 && parsed.path && parsed.path[0] !== "/") {
        return 'URI path must start with "/" when authority is present.';
      }
      if (typeof parsed.port === "number" && (parsed.port < 0 || parsed.port > 65535)) {
        return "URI port is malformed.";
      }
      return void 0;
    }
    function parseWithStatus(uri, opts) {
      const options = Object.assign({}, opts);
      const parsed = {
        scheme: void 0,
        userinfo: void 0,
        host: "",
        port: void 0,
        path: "",
        query: void 0,
        fragment: void 0
      };
      let malformedAuthorityOrPort = false;
      let isIP = false;
      if (options.reference === "suffix") {
        if (options.scheme) {
          uri = options.scheme + ":" + uri;
        } else {
          uri = "//" + uri;
        }
      }
      const matches = uri.match(URI_PARSE);
      if (matches) {
        parsed.scheme = matches[1];
        parsed.userinfo = matches[3];
        parsed.host = matches[4];
        parsed.port = parseInt(matches[5], 10);
        parsed.path = matches[6] || "";
        parsed.query = matches[7];
        parsed.fragment = matches[8];
        if (isNaN(parsed.port)) {
          parsed.port = matches[5];
        }
        const parseError = getParseError(parsed, matches);
        if (parseError !== void 0) {
          parsed.error = parsed.error || parseError;
          malformedAuthorityOrPort = true;
        }
        if (parsed.host) {
          const ipv4result = isIPv4(parsed.host);
          if (ipv4result === false) {
            const ipv6result = normalizeIPv6(parsed.host);
            parsed.host = ipv6result.host.toLowerCase();
            isIP = ipv6result.isIPV6;
          } else {
            isIP = true;
          }
        }
        if (parsed.scheme === void 0 && parsed.userinfo === void 0 && parsed.host === void 0 && parsed.port === void 0 && parsed.query === void 0 && !parsed.path) {
          parsed.reference = "same-document";
        } else if (parsed.scheme === void 0) {
          parsed.reference = "relative";
        } else if (parsed.fragment === void 0) {
          parsed.reference = "absolute";
        } else {
          parsed.reference = "uri";
        }
        if (options.reference && options.reference !== "suffix" && options.reference !== parsed.reference) {
          parsed.error = parsed.error || "URI is not a " + options.reference + " reference.";
        }
        const schemeHandler = getSchemeHandler(options.scheme || parsed.scheme);
        if (!options.unicodeSupport && (!schemeHandler || !schemeHandler.unicodeSupport)) {
          if (parsed.host && (options.domainHost || schemeHandler && schemeHandler.domainHost) && isIP === false && nonSimpleDomain(parsed.host)) {
            try {
              parsed.host = URL.domainToASCII(parsed.host.toLowerCase());
            } catch (e) {
              parsed.error = parsed.error || "Host's domain name can not be converted to ASCII: " + e;
            }
          }
        }
        if (!schemeHandler || schemeHandler && !schemeHandler.skipNormalize) {
          if (uri.indexOf("%") !== -1) {
            if (parsed.scheme !== void 0) {
              parsed.scheme = unescape(parsed.scheme);
            }
            if (parsed.host !== void 0) {
              parsed.host = reescapeHostDelimiters(unescape(parsed.host), isIP);
            }
          }
          if (parsed.path) {
            parsed.path = normalizePathEncoding(parsed.path);
          }
          if (parsed.fragment) {
            try {
              parsed.fragment = encodeURI(decodeURIComponent(parsed.fragment));
            } catch {
              parsed.error = parsed.error || "URI malformed";
            }
          }
        }
        if (schemeHandler && schemeHandler.parse) {
          schemeHandler.parse(parsed, options);
        }
      } else {
        parsed.error = parsed.error || "URI can not be parsed.";
      }
      return { parsed, malformedAuthorityOrPort };
    }
    function parse(uri, opts) {
      return parseWithStatus(uri, opts).parsed;
    }
    function normalizeString(uri, opts) {
      return normalizeStringWithStatus(uri, opts).normalized;
    }
    function normalizeStringWithStatus(uri, opts) {
      const { parsed, malformedAuthorityOrPort } = parseWithStatus(uri, opts);
      return {
        normalized: malformedAuthorityOrPort ? uri : serialize(parsed, opts),
        malformedAuthorityOrPort
      };
    }
    function normalizeComparableURI(uri, opts) {
      if (typeof uri === "string") {
        const { normalized, malformedAuthorityOrPort } = normalizeStringWithStatus(uri, opts);
        return malformedAuthorityOrPort ? void 0 : normalized;
      }
      if (typeof uri === "object") {
        return serialize(uri, opts);
      }
    }
    var fastUri = {
      SCHEMES,
      normalize,
      resolve,
      resolveComponent,
      equal,
      serialize,
      parse
    };
    module.exports = fastUri;
    module.exports.default = fastUri;
    module.exports.fastUri = fastUri;
  }
});

// node_modules/.pnpm/ajv@8.20.0/node_modules/ajv/dist/runtime/uri.js
var require_uri = __commonJS({
  "node_modules/.pnpm/ajv@8.20.0/node_modules/ajv/dist/runtime/uri.js"(exports) {
    "use strict";
    Object.defineProperty(exports, "__esModule", { value: true });
    var uri = require_fast_uri();
    uri.code = 'require("ajv/dist/runtime/uri").default';
    exports.default = uri;
  }
});

// node_modules/.pnpm/ajv@8.20.0/node_modules/ajv/dist/core.js
var require_core = __commonJS({
  "node_modules/.pnpm/ajv@8.20.0/node_modules/ajv/dist/core.js"(exports) {
    "use strict";
    Object.defineProperty(exports, "__esModule", { value: true });
    exports.CodeGen = exports.Name = exports.nil = exports.stringify = exports.str = exports._ = exports.KeywordCxt = void 0;
    var validate_1 = require_validate();
    Object.defineProperty(exports, "KeywordCxt", { enumerable: true, get: function() {
      return validate_1.KeywordCxt;
    } });
    var codegen_1 = require_codegen();
    Object.defineProperty(exports, "_", { enumerable: true, get: function() {
      return codegen_1._;
    } });
    Object.defineProperty(exports, "str", { enumerable: true, get: function() {
      return codegen_1.str;
    } });
    Object.defineProperty(exports, "stringify", { enumerable: true, get: function() {
      return codegen_1.stringify;
    } });
    Object.defineProperty(exports, "nil", { enumerable: true, get: function() {
      return codegen_1.nil;
    } });
    Object.defineProperty(exports, "Name", { enumerable: true, get: function() {
      return codegen_1.Name;
    } });
    Object.defineProperty(exports, "CodeGen", { enumerable: true, get: function() {
      return codegen_1.CodeGen;
    } });
    var validation_error_1 = require_validation_error();
    var ref_error_1 = require_ref_error();
    var rules_1 = require_rules();
    var compile_1 = require_compile();
    var codegen_2 = require_codegen();
    var resolve_1 = require_resolve();
    var dataType_1 = require_dataType();
    var util_1 = require_util();
    var $dataRefSchema = require_data();
    var uri_1 = require_uri();
    var defaultRegExp = (str, flags) => new RegExp(str, flags);
    defaultRegExp.code = "new RegExp";
    var META_IGNORE_OPTIONS = ["removeAdditional", "useDefaults", "coerceTypes"];
    var EXT_SCOPE_NAMES = /* @__PURE__ */ new Set([
      "validate",
      "serialize",
      "parse",
      "wrapper",
      "root",
      "schema",
      "keyword",
      "pattern",
      "formats",
      "validate$data",
      "func",
      "obj",
      "Error"
    ]);
    var removedOptions = {
      errorDataPath: "",
      format: "`validateFormats: false` can be used instead.",
      nullable: '"nullable" keyword is supported by default.',
      jsonPointers: "Deprecated jsPropertySyntax can be used instead.",
      extendRefs: "Deprecated ignoreKeywordsWithRef can be used instead.",
      missingRefs: "Pass empty schema with $id that should be ignored to ajv.addSchema.",
      processCode: "Use option `code: {process: (code, schemaEnv: object) => string}`",
      sourceCode: "Use option `code: {source: true}`",
      strictDefaults: "It is default now, see option `strict`.",
      strictKeywords: "It is default now, see option `strict`.",
      uniqueItems: '"uniqueItems" keyword is always validated.',
      unknownFormats: "Disable strict mode or pass `true` to `ajv.addFormat` (or `formats` option).",
      cache: "Map is used as cache, schema object as key.",
      serialize: "Map is used as cache, schema object as key.",
      ajvErrors: "It is default now."
    };
    var deprecatedOptions = {
      ignoreKeywordsWithRef: "",
      jsPropertySyntax: "",
      unicode: '"minLength"/"maxLength" account for unicode characters by default.'
    };
    var MAX_EXPRESSION = 200;
    function requiredOptions(o) {
      var _a, _b, _c, _d, _e, _f, _g, _h, _j, _k, _l, _m, _o, _p, _q, _r, _s, _t, _u, _v, _w, _x, _y, _z, _0;
      const s = o.strict;
      const _optz = (_a = o.code) === null || _a === void 0 ? void 0 : _a.optimize;
      const optimize = _optz === true || _optz === void 0 ? 1 : _optz || 0;
      const regExp = (_c = (_b = o.code) === null || _b === void 0 ? void 0 : _b.regExp) !== null && _c !== void 0 ? _c : defaultRegExp;
      const uriResolver = (_d = o.uriResolver) !== null && _d !== void 0 ? _d : uri_1.default;
      return {
        strictSchema: (_f = (_e = o.strictSchema) !== null && _e !== void 0 ? _e : s) !== null && _f !== void 0 ? _f : true,
        strictNumbers: (_h = (_g = o.strictNumbers) !== null && _g !== void 0 ? _g : s) !== null && _h !== void 0 ? _h : true,
        strictTypes: (_k = (_j = o.strictTypes) !== null && _j !== void 0 ? _j : s) !== null && _k !== void 0 ? _k : "log",
        strictTuples: (_m = (_l = o.strictTuples) !== null && _l !== void 0 ? _l : s) !== null && _m !== void 0 ? _m : "log",
        strictRequired: (_p = (_o = o.strictRequired) !== null && _o !== void 0 ? _o : s) !== null && _p !== void 0 ? _p : false,
        code: o.code ? { ...o.code, optimize, regExp } : { optimize, regExp },
        loopRequired: (_q = o.loopRequired) !== null && _q !== void 0 ? _q : MAX_EXPRESSION,
        loopEnum: (_r = o.loopEnum) !== null && _r !== void 0 ? _r : MAX_EXPRESSION,
        meta: (_s = o.meta) !== null && _s !== void 0 ? _s : true,
        messages: (_t = o.messages) !== null && _t !== void 0 ? _t : true,
        inlineRefs: (_u = o.inlineRefs) !== null && _u !== void 0 ? _u : true,
        schemaId: (_v = o.schemaId) !== null && _v !== void 0 ? _v : "$id",
        addUsedSchema: (_w = o.addUsedSchema) !== null && _w !== void 0 ? _w : true,
        validateSchema: (_x = o.validateSchema) !== null && _x !== void 0 ? _x : true,
        validateFormats: (_y = o.validateFormats) !== null && _y !== void 0 ? _y : true,
        unicodeRegExp: (_z = o.unicodeRegExp) !== null && _z !== void 0 ? _z : true,
        int32range: (_0 = o.int32range) !== null && _0 !== void 0 ? _0 : true,
        uriResolver
      };
    }
    var Ajv = class {
      constructor(opts = {}) {
        this.schemas = {};
        this.refs = {};
        this.formats = /* @__PURE__ */ Object.create(null);
        this._compilations = /* @__PURE__ */ new Set();
        this._loading = {};
        this._cache = /* @__PURE__ */ new Map();
        opts = this.opts = { ...opts, ...requiredOptions(opts) };
        const { es5, lines } = this.opts.code;
        this.scope = new codegen_2.ValueScope({ scope: {}, prefixes: EXT_SCOPE_NAMES, es5, lines });
        this.logger = getLogger(opts.logger);
        const formatOpt = opts.validateFormats;
        opts.validateFormats = false;
        this.RULES = (0, rules_1.getRules)();
        checkOptions.call(this, removedOptions, opts, "NOT SUPPORTED");
        checkOptions.call(this, deprecatedOptions, opts, "DEPRECATED", "warn");
        this._metaOpts = getMetaSchemaOptions.call(this);
        if (opts.formats)
          addInitialFormats.call(this);
        this._addVocabularies();
        this._addDefaultMetaSchema();
        if (opts.keywords)
          addInitialKeywords.call(this, opts.keywords);
        if (typeof opts.meta == "object")
          this.addMetaSchema(opts.meta);
        addInitialSchemas.call(this);
        opts.validateFormats = formatOpt;
      }
      _addVocabularies() {
        this.addKeyword("$async");
      }
      _addDefaultMetaSchema() {
        const { $data, meta, schemaId } = this.opts;
        let _dataRefSchema = $dataRefSchema;
        if (schemaId === "id") {
          _dataRefSchema = { ...$dataRefSchema };
          _dataRefSchema.id = _dataRefSchema.$id;
          delete _dataRefSchema.$id;
        }
        if (meta && $data)
          this.addMetaSchema(_dataRefSchema, _dataRefSchema[schemaId], false);
      }
      defaultMeta() {
        const { meta, schemaId } = this.opts;
        return this.opts.defaultMeta = typeof meta == "object" ? meta[schemaId] || meta : void 0;
      }
      validate(schemaKeyRef, data) {
        let v;
        if (typeof schemaKeyRef == "string") {
          v = this.getSchema(schemaKeyRef);
          if (!v)
            throw new Error(`no schema with key or ref "${schemaKeyRef}"`);
        } else {
          v = this.compile(schemaKeyRef);
        }
        const valid = v(data);
        if (!("$async" in v))
          this.errors = v.errors;
        return valid;
      }
      compile(schema, _meta) {
        const sch = this._addSchema(schema, _meta);
        return sch.validate || this._compileSchemaEnv(sch);
      }
      compileAsync(schema, meta) {
        if (typeof this.opts.loadSchema != "function") {
          throw new Error("options.loadSchema should be a function");
        }
        const { loadSchema } = this.opts;
        return runCompileAsync.call(this, schema, meta);
        async function runCompileAsync(_schema, _meta) {
          await loadMetaSchema.call(this, _schema.$schema);
          const sch = this._addSchema(_schema, _meta);
          return sch.validate || _compileAsync.call(this, sch);
        }
        async function loadMetaSchema($ref) {
          if ($ref && !this.getSchema($ref)) {
            await runCompileAsync.call(this, { $ref }, true);
          }
        }
        async function _compileAsync(sch) {
          try {
            return this._compileSchemaEnv(sch);
          } catch (e) {
            if (!(e instanceof ref_error_1.default))
              throw e;
            checkLoaded.call(this, e);
            await loadMissingSchema.call(this, e.missingSchema);
            return _compileAsync.call(this, sch);
          }
        }
        function checkLoaded({ missingSchema: ref, missingRef }) {
          if (this.refs[ref]) {
            throw new Error(`AnySchema ${ref} is loaded but ${missingRef} cannot be resolved`);
          }
        }
        async function loadMissingSchema(ref) {
          const _schema = await _loadSchema.call(this, ref);
          if (!this.refs[ref])
            await loadMetaSchema.call(this, _schema.$schema);
          if (!this.refs[ref])
            this.addSchema(_schema, ref, meta);
        }
        async function _loadSchema(ref) {
          const p = this._loading[ref];
          if (p)
            return p;
          try {
            return await (this._loading[ref] = loadSchema(ref));
          } finally {
            delete this._loading[ref];
          }
        }
      }
      // Adds schema to the instance
      addSchema(schema, key, _meta, _validateSchema = this.opts.validateSchema) {
        if (Array.isArray(schema)) {
          for (const sch of schema)
            this.addSchema(sch, void 0, _meta, _validateSchema);
          return this;
        }
        let id;
        if (typeof schema === "object") {
          const { schemaId } = this.opts;
          id = schema[schemaId];
          if (id !== void 0 && typeof id != "string") {
            throw new Error(`schema ${schemaId} must be string`);
          }
        }
        key = (0, resolve_1.normalizeId)(key || id);
        this._checkUnique(key);
        this.schemas[key] = this._addSchema(schema, _meta, key, _validateSchema, true);
        return this;
      }
      // Add schema that will be used to validate other schemas
      // options in META_IGNORE_OPTIONS are alway set to false
      addMetaSchema(schema, key, _validateSchema = this.opts.validateSchema) {
        this.addSchema(schema, key, true, _validateSchema);
        return this;
      }
      //  Validate schema against its meta-schema
      validateSchema(schema, throwOrLogError) {
        if (typeof schema == "boolean")
          return true;
        let $schema;
        $schema = schema.$schema;
        if ($schema !== void 0 && typeof $schema != "string") {
          throw new Error("$schema must be a string");
        }
        $schema = $schema || this.opts.defaultMeta || this.defaultMeta();
        if (!$schema) {
          this.logger.warn("meta-schema not available");
          this.errors = null;
          return true;
        }
        const valid = this.validate($schema, schema);
        if (!valid && throwOrLogError) {
          const message = "schema is invalid: " + this.errorsText();
          if (this.opts.validateSchema === "log")
            this.logger.error(message);
          else
            throw new Error(message);
        }
        return valid;
      }
      // Get compiled schema by `key` or `ref`.
      // (`key` that was passed to `addSchema` or full schema reference - `schema.$id` or resolved id)
      getSchema(keyRef) {
        let sch;
        while (typeof (sch = getSchEnv.call(this, keyRef)) == "string")
          keyRef = sch;
        if (sch === void 0) {
          const { schemaId } = this.opts;
          const root = new compile_1.SchemaEnv({ schema: {}, schemaId });
          sch = compile_1.resolveSchema.call(this, root, keyRef);
          if (!sch)
            return;
          this.refs[keyRef] = sch;
        }
        return sch.validate || this._compileSchemaEnv(sch);
      }
      // Remove cached schema(s).
      // If no parameter is passed all schemas but meta-schemas are removed.
      // If RegExp is passed all schemas with key/id matching pattern but meta-schemas are removed.
      // Even if schema is referenced by other schemas it still can be removed as other schemas have local references.
      removeSchema(schemaKeyRef) {
        if (schemaKeyRef instanceof RegExp) {
          this._removeAllSchemas(this.schemas, schemaKeyRef);
          this._removeAllSchemas(this.refs, schemaKeyRef);
          return this;
        }
        switch (typeof schemaKeyRef) {
          case "undefined":
            this._removeAllSchemas(this.schemas);
            this._removeAllSchemas(this.refs);
            this._cache.clear();
            return this;
          case "string": {
            const sch = getSchEnv.call(this, schemaKeyRef);
            if (typeof sch == "object")
              this._cache.delete(sch.schema);
            delete this.schemas[schemaKeyRef];
            delete this.refs[schemaKeyRef];
            return this;
          }
          case "object": {
            const cacheKey = schemaKeyRef;
            this._cache.delete(cacheKey);
            let id = schemaKeyRef[this.opts.schemaId];
            if (id) {
              id = (0, resolve_1.normalizeId)(id);
              delete this.schemas[id];
              delete this.refs[id];
            }
            return this;
          }
          default:
            throw new Error("ajv.removeSchema: invalid parameter");
        }
      }
      // add "vocabulary" - a collection of keywords
      addVocabulary(definitions) {
        for (const def of definitions)
          this.addKeyword(def);
        return this;
      }
      addKeyword(kwdOrDef, def) {
        let keyword;
        if (typeof kwdOrDef == "string") {
          keyword = kwdOrDef;
          if (typeof def == "object") {
            this.logger.warn("these parameters are deprecated, see docs for addKeyword");
            def.keyword = keyword;
          }
        } else if (typeof kwdOrDef == "object" && def === void 0) {
          def = kwdOrDef;
          keyword = def.keyword;
          if (Array.isArray(keyword) && !keyword.length) {
            throw new Error("addKeywords: keyword must be string or non-empty array");
          }
        } else {
          throw new Error("invalid addKeywords parameters");
        }
        checkKeyword.call(this, keyword, def);
        if (!def) {
          (0, util_1.eachItem)(keyword, (kwd) => addRule.call(this, kwd));
          return this;
        }
        keywordMetaschema.call(this, def);
        const definition = {
          ...def,
          type: (0, dataType_1.getJSONTypes)(def.type),
          schemaType: (0, dataType_1.getJSONTypes)(def.schemaType)
        };
        (0, util_1.eachItem)(keyword, definition.type.length === 0 ? (k) => addRule.call(this, k, definition) : (k) => definition.type.forEach((t) => addRule.call(this, k, definition, t)));
        return this;
      }
      getKeyword(keyword) {
        const rule = this.RULES.all[keyword];
        return typeof rule == "object" ? rule.definition : !!rule;
      }
      // Remove keyword
      removeKeyword(keyword) {
        const { RULES } = this;
        delete RULES.keywords[keyword];
        delete RULES.all[keyword];
        for (const group of RULES.rules) {
          const i = group.rules.findIndex((rule) => rule.keyword === keyword);
          if (i >= 0)
            group.rules.splice(i, 1);
        }
        return this;
      }
      // Add format
      addFormat(name, format) {
        if (typeof format == "string")
          format = new RegExp(format);
        this.formats[name] = format;
        return this;
      }
      errorsText(errors = this.errors, { separator = ", ", dataVar = "data" } = {}) {
        if (!errors || errors.length === 0)
          return "No errors";
        return errors.map((e) => `${dataVar}${e.instancePath} ${e.message}`).reduce((text, msg) => text + separator + msg);
      }
      $dataMetaSchema(metaSchema, keywordsJsonPointers) {
        const rules = this.RULES.all;
        metaSchema = JSON.parse(JSON.stringify(metaSchema));
        for (const jsonPointer of keywordsJsonPointers) {
          const segments = jsonPointer.split("/").slice(1);
          let keywords = metaSchema;
          for (const seg of segments)
            keywords = keywords[seg];
          for (const key in rules) {
            const rule = rules[key];
            if (typeof rule != "object")
              continue;
            const { $data } = rule.definition;
            const schema = keywords[key];
            if ($data && schema)
              keywords[key] = schemaOrData(schema);
          }
        }
        return metaSchema;
      }
      _removeAllSchemas(schemas, regex) {
        for (const keyRef in schemas) {
          const sch = schemas[keyRef];
          if (!regex || regex.test(keyRef)) {
            if (typeof sch == "string") {
              delete schemas[keyRef];
            } else if (sch && !sch.meta) {
              this._cache.delete(sch.schema);
              delete schemas[keyRef];
            }
          }
        }
      }
      _addSchema(schema, meta, baseId, validateSchema = this.opts.validateSchema, addSchema = this.opts.addUsedSchema) {
        let id;
        const { schemaId } = this.opts;
        if (typeof schema == "object") {
          id = schema[schemaId];
        } else {
          if (this.opts.jtd)
            throw new Error("schema must be object");
          else if (typeof schema != "boolean")
            throw new Error("schema must be object or boolean");
        }
        let sch = this._cache.get(schema);
        if (sch !== void 0)
          return sch;
        baseId = (0, resolve_1.normalizeId)(id || baseId);
        const localRefs = resolve_1.getSchemaRefs.call(this, schema, baseId);
        sch = new compile_1.SchemaEnv({ schema, schemaId, meta, baseId, localRefs });
        this._cache.set(sch.schema, sch);
        if (addSchema && !baseId.startsWith("#")) {
          if (baseId)
            this._checkUnique(baseId);
          this.refs[baseId] = sch;
        }
        if (validateSchema)
          this.validateSchema(schema, true);
        return sch;
      }
      _checkUnique(id) {
        if (this.schemas[id] || this.refs[id]) {
          throw new Error(`schema with key or id "${id}" already exists`);
        }
      }
      _compileSchemaEnv(sch) {
        if (sch.meta)
          this._compileMetaSchema(sch);
        else
          compile_1.compileSchema.call(this, sch);
        if (!sch.validate)
          throw new Error("ajv implementation error");
        return sch.validate;
      }
      _compileMetaSchema(sch) {
        const currentOpts = this.opts;
        this.opts = this._metaOpts;
        try {
          compile_1.compileSchema.call(this, sch);
        } finally {
          this.opts = currentOpts;
        }
      }
    };
    Ajv.ValidationError = validation_error_1.default;
    Ajv.MissingRefError = ref_error_1.default;
    exports.default = Ajv;
    function checkOptions(checkOpts, options, msg, log = "error") {
      for (const key in checkOpts) {
        const opt = key;
        if (opt in options)
          this.logger[log](`${msg}: option ${key}. ${checkOpts[opt]}`);
      }
    }
    function getSchEnv(keyRef) {
      keyRef = (0, resolve_1.normalizeId)(keyRef);
      return this.schemas[keyRef] || this.refs[keyRef];
    }
    function addInitialSchemas() {
      const optsSchemas = this.opts.schemas;
      if (!optsSchemas)
        return;
      if (Array.isArray(optsSchemas))
        this.addSchema(optsSchemas);
      else
        for (const key in optsSchemas)
          this.addSchema(optsSchemas[key], key);
    }
    function addInitialFormats() {
      for (const name in this.opts.formats) {
        const format = this.opts.formats[name];
        if (format)
          this.addFormat(name, format);
      }
    }
    function addInitialKeywords(defs) {
      if (Array.isArray(defs)) {
        this.addVocabulary(defs);
        return;
      }
      this.logger.warn("keywords option as map is deprecated, pass array");
      for (const keyword in defs) {
        const def = defs[keyword];
        if (!def.keyword)
          def.keyword = keyword;
        this.addKeyword(def);
      }
    }
    function getMetaSchemaOptions() {
      const metaOpts = { ...this.opts };
      for (const opt of META_IGNORE_OPTIONS)
        delete metaOpts[opt];
      return metaOpts;
    }
    var noLogs = { log() {
    }, warn() {
    }, error() {
    } };
    function getLogger(logger) {
      if (logger === false)
        return noLogs;
      if (logger === void 0)
        return console;
      if (logger.log && logger.warn && logger.error)
        return logger;
      throw new Error("logger must implement log, warn and error methods");
    }
    var KEYWORD_NAME = /^[a-z_$][a-z0-9_$:-]*$/i;
    function checkKeyword(keyword, def) {
      const { RULES } = this;
      (0, util_1.eachItem)(keyword, (kwd) => {
        if (RULES.keywords[kwd])
          throw new Error(`Keyword ${kwd} is already defined`);
        if (!KEYWORD_NAME.test(kwd))
          throw new Error(`Keyword ${kwd} has invalid name`);
      });
      if (!def)
        return;
      if (def.$data && !("code" in def || "validate" in def)) {
        throw new Error('$data keyword must have "code" or "validate" function');
      }
    }
    function addRule(keyword, definition, dataType) {
      var _a;
      const post = definition === null || definition === void 0 ? void 0 : definition.post;
      if (dataType && post)
        throw new Error('keyword with "post" flag cannot have "type"');
      const { RULES } = this;
      let ruleGroup = post ? RULES.post : RULES.rules.find(({ type: t }) => t === dataType);
      if (!ruleGroup) {
        ruleGroup = { type: dataType, rules: [] };
        RULES.rules.push(ruleGroup);
      }
      RULES.keywords[keyword] = true;
      if (!definition)
        return;
      const rule = {
        keyword,
        definition: {
          ...definition,
          type: (0, dataType_1.getJSONTypes)(definition.type),
          schemaType: (0, dataType_1.getJSONTypes)(definition.schemaType)
        }
      };
      if (definition.before)
        addBeforeRule.call(this, ruleGroup, rule, definition.before);
      else
        ruleGroup.rules.push(rule);
      RULES.all[keyword] = rule;
      (_a = definition.implements) === null || _a === void 0 ? void 0 : _a.forEach((kwd) => this.addKeyword(kwd));
    }
    function addBeforeRule(ruleGroup, rule, before) {
      const i = ruleGroup.rules.findIndex((_rule) => _rule.keyword === before);
      if (i >= 0) {
        ruleGroup.rules.splice(i, 0, rule);
      } else {
        ruleGroup.rules.push(rule);
        this.logger.warn(`rule ${before} is not defined`);
      }
    }
    function keywordMetaschema(def) {
      let { metaSchema } = def;
      if (metaSchema === void 0)
        return;
      if (def.$data && this.opts.$data)
        metaSchema = schemaOrData(metaSchema);
      def.validateSchema = this.compile(metaSchema, true);
    }
    var $dataRef = {
      $ref: "https://raw.githubusercontent.com/ajv-validator/ajv/master/lib/refs/data.json#"
    };
    function schemaOrData(schema) {
      return { anyOf: [schema, $dataRef] };
    }
  }
});

// node_modules/.pnpm/ajv@8.20.0/node_modules/ajv/dist/vocabularies/core/id.js
var require_id = __commonJS({
  "node_modules/.pnpm/ajv@8.20.0/node_modules/ajv/dist/vocabularies/core/id.js"(exports) {
    "use strict";
    Object.defineProperty(exports, "__esModule", { value: true });
    var def = {
      keyword: "id",
      code() {
        throw new Error('NOT SUPPORTED: keyword "id", use "$id" for schema ID');
      }
    };
    exports.default = def;
  }
});

// node_modules/.pnpm/ajv@8.20.0/node_modules/ajv/dist/vocabularies/core/ref.js
var require_ref = __commonJS({
  "node_modules/.pnpm/ajv@8.20.0/node_modules/ajv/dist/vocabularies/core/ref.js"(exports) {
    "use strict";
    Object.defineProperty(exports, "__esModule", { value: true });
    exports.callRef = exports.getValidate = void 0;
    var ref_error_1 = require_ref_error();
    var code_1 = require_code2();
    var codegen_1 = require_codegen();
    var names_1 = require_names();
    var compile_1 = require_compile();
    var util_1 = require_util();
    var def = {
      keyword: "$ref",
      schemaType: "string",
      code(cxt) {
        const { gen, schema: $ref, it } = cxt;
        const { baseId, schemaEnv: env, validateName, opts, self } = it;
        const { root } = env;
        if (($ref === "#" || $ref === "#/") && baseId === root.baseId)
          return callRootRef();
        const schOrEnv = compile_1.resolveRef.call(self, root, baseId, $ref);
        if (schOrEnv === void 0)
          throw new ref_error_1.default(it.opts.uriResolver, baseId, $ref);
        if (schOrEnv instanceof compile_1.SchemaEnv)
          return callValidate(schOrEnv);
        return inlineRefSchema(schOrEnv);
        function callRootRef() {
          if (env === root)
            return callRef(cxt, validateName, env, env.$async);
          const rootName = gen.scopeValue("root", { ref: root });
          return callRef(cxt, (0, codegen_1._)`${rootName}.validate`, root, root.$async);
        }
        function callValidate(sch) {
          const v = getValidate(cxt, sch);
          callRef(cxt, v, sch, sch.$async);
        }
        function inlineRefSchema(sch) {
          const schName = gen.scopeValue("schema", opts.code.source === true ? { ref: sch, code: (0, codegen_1.stringify)(sch) } : { ref: sch });
          const valid = gen.name("valid");
          const schCxt = cxt.subschema({
            schema: sch,
            dataTypes: [],
            schemaPath: codegen_1.nil,
            topSchemaRef: schName,
            errSchemaPath: $ref
          }, valid);
          cxt.mergeEvaluated(schCxt);
          cxt.ok(valid);
        }
      }
    };
    function getValidate(cxt, sch) {
      const { gen } = cxt;
      return sch.validate ? gen.scopeValue("validate", { ref: sch.validate }) : (0, codegen_1._)`${gen.scopeValue("wrapper", { ref: sch })}.validate`;
    }
    exports.getValidate = getValidate;
    function callRef(cxt, v, sch, $async) {
      const { gen, it } = cxt;
      const { allErrors, schemaEnv: env, opts } = it;
      const passCxt = opts.passContext ? names_1.default.this : codegen_1.nil;
      if ($async)
        callAsyncRef();
      else
        callSyncRef();
      function callAsyncRef() {
        if (!env.$async)
          throw new Error("async schema referenced by sync schema");
        const valid = gen.let("valid");
        gen.try(() => {
          gen.code((0, codegen_1._)`await ${(0, code_1.callValidateCode)(cxt, v, passCxt)}`);
          addEvaluatedFrom(v);
          if (!allErrors)
            gen.assign(valid, true);
        }, (e) => {
          gen.if((0, codegen_1._)`!(${e} instanceof ${it.ValidationError})`, () => gen.throw(e));
          addErrorsFrom(e);
          if (!allErrors)
            gen.assign(valid, false);
        });
        cxt.ok(valid);
      }
      function callSyncRef() {
        cxt.result((0, code_1.callValidateCode)(cxt, v, passCxt), () => addEvaluatedFrom(v), () => addErrorsFrom(v));
      }
      function addErrorsFrom(source) {
        const errs = (0, codegen_1._)`${source}.errors`;
        gen.assign(names_1.default.vErrors, (0, codegen_1._)`${names_1.default.vErrors} === null ? ${errs} : ${names_1.default.vErrors}.concat(${errs})`);
        gen.assign(names_1.default.errors, (0, codegen_1._)`${names_1.default.vErrors}.length`);
      }
      function addEvaluatedFrom(source) {
        var _a;
        if (!it.opts.unevaluated)
          return;
        const schEvaluated = (_a = sch === null || sch === void 0 ? void 0 : sch.validate) === null || _a === void 0 ? void 0 : _a.evaluated;
        if (it.props !== true) {
          if (schEvaluated && !schEvaluated.dynamicProps) {
            if (schEvaluated.props !== void 0) {
              it.props = util_1.mergeEvaluated.props(gen, schEvaluated.props, it.props);
            }
          } else {
            const props = gen.var("props", (0, codegen_1._)`${source}.evaluated.props`);
            it.props = util_1.mergeEvaluated.props(gen, props, it.props, codegen_1.Name);
          }
        }
        if (it.items !== true) {
          if (schEvaluated && !schEvaluated.dynamicItems) {
            if (schEvaluated.items !== void 0) {
              it.items = util_1.mergeEvaluated.items(gen, schEvaluated.items, it.items);
            }
          } else {
            const items = gen.var("items", (0, codegen_1._)`${source}.evaluated.items`);
            it.items = util_1.mergeEvaluated.items(gen, items, it.items, codegen_1.Name);
          }
        }
      }
    }
    exports.callRef = callRef;
    exports.default = def;
  }
});

// node_modules/.pnpm/ajv@8.20.0/node_modules/ajv/dist/vocabularies/core/index.js
var require_core2 = __commonJS({
  "node_modules/.pnpm/ajv@8.20.0/node_modules/ajv/dist/vocabularies/core/index.js"(exports) {
    "use strict";
    Object.defineProperty(exports, "__esModule", { value: true });
    var id_1 = require_id();
    var ref_1 = require_ref();
    var core = [
      "$schema",
      "$id",
      "$defs",
      "$vocabulary",
      { keyword: "$comment" },
      "definitions",
      id_1.default,
      ref_1.default
    ];
    exports.default = core;
  }
});

// node_modules/.pnpm/ajv@8.20.0/node_modules/ajv/dist/vocabularies/validation/limitNumber.js
var require_limitNumber = __commonJS({
  "node_modules/.pnpm/ajv@8.20.0/node_modules/ajv/dist/vocabularies/validation/limitNumber.js"(exports) {
    "use strict";
    Object.defineProperty(exports, "__esModule", { value: true });
    var codegen_1 = require_codegen();
    var ops = codegen_1.operators;
    var KWDs = {
      maximum: { okStr: "<=", ok: ops.LTE, fail: ops.GT },
      minimum: { okStr: ">=", ok: ops.GTE, fail: ops.LT },
      exclusiveMaximum: { okStr: "<", ok: ops.LT, fail: ops.GTE },
      exclusiveMinimum: { okStr: ">", ok: ops.GT, fail: ops.LTE }
    };
    var error = {
      message: ({ keyword, schemaCode }) => (0, codegen_1.str)`must be ${KWDs[keyword].okStr} ${schemaCode}`,
      params: ({ keyword, schemaCode }) => (0, codegen_1._)`{comparison: ${KWDs[keyword].okStr}, limit: ${schemaCode}}`
    };
    var def = {
      keyword: Object.keys(KWDs),
      type: "number",
      schemaType: "number",
      $data: true,
      error,
      code(cxt) {
        const { keyword, data, schemaCode } = cxt;
        cxt.fail$data((0, codegen_1._)`${data} ${KWDs[keyword].fail} ${schemaCode} || isNaN(${data})`);
      }
    };
    exports.default = def;
  }
});

// node_modules/.pnpm/ajv@8.20.0/node_modules/ajv/dist/vocabularies/validation/multipleOf.js
var require_multipleOf = __commonJS({
  "node_modules/.pnpm/ajv@8.20.0/node_modules/ajv/dist/vocabularies/validation/multipleOf.js"(exports) {
    "use strict";
    Object.defineProperty(exports, "__esModule", { value: true });
    var codegen_1 = require_codegen();
    var error = {
      message: ({ schemaCode }) => (0, codegen_1.str)`must be multiple of ${schemaCode}`,
      params: ({ schemaCode }) => (0, codegen_1._)`{multipleOf: ${schemaCode}}`
    };
    var def = {
      keyword: "multipleOf",
      type: "number",
      schemaType: "number",
      $data: true,
      error,
      code(cxt) {
        const { gen, data, schemaCode, it } = cxt;
        const prec = it.opts.multipleOfPrecision;
        const res = gen.let("res");
        const invalid = prec ? (0, codegen_1._)`Math.abs(Math.round(${res}) - ${res}) > 1e-${prec}` : (0, codegen_1._)`${res} !== parseInt(${res})`;
        cxt.fail$data((0, codegen_1._)`(${schemaCode} === 0 || (${res} = ${data}/${schemaCode}, ${invalid}))`);
      }
    };
    exports.default = def;
  }
});

// node_modules/.pnpm/ajv@8.20.0/node_modules/ajv/dist/runtime/ucs2length.js
var require_ucs2length = __commonJS({
  "node_modules/.pnpm/ajv@8.20.0/node_modules/ajv/dist/runtime/ucs2length.js"(exports) {
    "use strict";
    Object.defineProperty(exports, "__esModule", { value: true });
    function ucs2length(str) {
      const len = str.length;
      let length = 0;
      let pos = 0;
      let value;
      while (pos < len) {
        length++;
        value = str.charCodeAt(pos++);
        if (value >= 55296 && value <= 56319 && pos < len) {
          value = str.charCodeAt(pos);
          if ((value & 64512) === 56320)
            pos++;
        }
      }
      return length;
    }
    exports.default = ucs2length;
    ucs2length.code = 'require("ajv/dist/runtime/ucs2length").default';
  }
});

// node_modules/.pnpm/ajv@8.20.0/node_modules/ajv/dist/vocabularies/validation/limitLength.js
var require_limitLength = __commonJS({
  "node_modules/.pnpm/ajv@8.20.0/node_modules/ajv/dist/vocabularies/validation/limitLength.js"(exports) {
    "use strict";
    Object.defineProperty(exports, "__esModule", { value: true });
    var codegen_1 = require_codegen();
    var util_1 = require_util();
    var ucs2length_1 = require_ucs2length();
    var error = {
      message({ keyword, schemaCode }) {
        const comp = keyword === "maxLength" ? "more" : "fewer";
        return (0, codegen_1.str)`must NOT have ${comp} than ${schemaCode} characters`;
      },
      params: ({ schemaCode }) => (0, codegen_1._)`{limit: ${schemaCode}}`
    };
    var def = {
      keyword: ["maxLength", "minLength"],
      type: "string",
      schemaType: "number",
      $data: true,
      error,
      code(cxt) {
        const { keyword, data, schemaCode, it } = cxt;
        const op = keyword === "maxLength" ? codegen_1.operators.GT : codegen_1.operators.LT;
        const len = it.opts.unicode === false ? (0, codegen_1._)`${data}.length` : (0, codegen_1._)`${(0, util_1.useFunc)(cxt.gen, ucs2length_1.default)}(${data})`;
        cxt.fail$data((0, codegen_1._)`${len} ${op} ${schemaCode}`);
      }
    };
    exports.default = def;
  }
});

// node_modules/.pnpm/ajv@8.20.0/node_modules/ajv/dist/vocabularies/validation/pattern.js
var require_pattern = __commonJS({
  "node_modules/.pnpm/ajv@8.20.0/node_modules/ajv/dist/vocabularies/validation/pattern.js"(exports) {
    "use strict";
    Object.defineProperty(exports, "__esModule", { value: true });
    var code_1 = require_code2();
    var util_1 = require_util();
    var codegen_1 = require_codegen();
    var error = {
      message: ({ schemaCode }) => (0, codegen_1.str)`must match pattern "${schemaCode}"`,
      params: ({ schemaCode }) => (0, codegen_1._)`{pattern: ${schemaCode}}`
    };
    var def = {
      keyword: "pattern",
      type: "string",
      schemaType: "string",
      $data: true,
      error,
      code(cxt) {
        const { gen, data, $data, schema, schemaCode, it } = cxt;
        const u = it.opts.unicodeRegExp ? "u" : "";
        if ($data) {
          const { regExp } = it.opts.code;
          const regExpCode = regExp.code === "new RegExp" ? (0, codegen_1._)`new RegExp` : (0, util_1.useFunc)(gen, regExp);
          const valid = gen.let("valid");
          gen.try(() => gen.assign(valid, (0, codegen_1._)`${regExpCode}(${schemaCode}, ${u}).test(${data})`), () => gen.assign(valid, false));
          cxt.fail$data((0, codegen_1._)`!${valid}`);
        } else {
          const regExp = (0, code_1.usePattern)(cxt, schema);
          cxt.fail$data((0, codegen_1._)`!${regExp}.test(${data})`);
        }
      }
    };
    exports.default = def;
  }
});

// node_modules/.pnpm/ajv@8.20.0/node_modules/ajv/dist/vocabularies/validation/limitProperties.js
var require_limitProperties = __commonJS({
  "node_modules/.pnpm/ajv@8.20.0/node_modules/ajv/dist/vocabularies/validation/limitProperties.js"(exports) {
    "use strict";
    Object.defineProperty(exports, "__esModule", { value: true });
    var codegen_1 = require_codegen();
    var error = {
      message({ keyword, schemaCode }) {
        const comp = keyword === "maxProperties" ? "more" : "fewer";
        return (0, codegen_1.str)`must NOT have ${comp} than ${schemaCode} properties`;
      },
      params: ({ schemaCode }) => (0, codegen_1._)`{limit: ${schemaCode}}`
    };
    var def = {
      keyword: ["maxProperties", "minProperties"],
      type: "object",
      schemaType: "number",
      $data: true,
      error,
      code(cxt) {
        const { keyword, data, schemaCode } = cxt;
        const op = keyword === "maxProperties" ? codegen_1.operators.GT : codegen_1.operators.LT;
        cxt.fail$data((0, codegen_1._)`Object.keys(${data}).length ${op} ${schemaCode}`);
      }
    };
    exports.default = def;
  }
});

// node_modules/.pnpm/ajv@8.20.0/node_modules/ajv/dist/vocabularies/validation/required.js
var require_required = __commonJS({
  "node_modules/.pnpm/ajv@8.20.0/node_modules/ajv/dist/vocabularies/validation/required.js"(exports) {
    "use strict";
    Object.defineProperty(exports, "__esModule", { value: true });
    var code_1 = require_code2();
    var codegen_1 = require_codegen();
    var util_1 = require_util();
    var error = {
      message: ({ params: { missingProperty } }) => (0, codegen_1.str)`must have required property '${missingProperty}'`,
      params: ({ params: { missingProperty } }) => (0, codegen_1._)`{missingProperty: ${missingProperty}}`
    };
    var def = {
      keyword: "required",
      type: "object",
      schemaType: "array",
      $data: true,
      error,
      code(cxt) {
        const { gen, schema, schemaCode, data, $data, it } = cxt;
        const { opts } = it;
        if (!$data && schema.length === 0)
          return;
        const useLoop = schema.length >= opts.loopRequired;
        if (it.allErrors)
          allErrorsMode();
        else
          exitOnErrorMode();
        if (opts.strictRequired) {
          const props = cxt.parentSchema.properties;
          const { definedProperties } = cxt.it;
          for (const requiredKey of schema) {
            if ((props === null || props === void 0 ? void 0 : props[requiredKey]) === void 0 && !definedProperties.has(requiredKey)) {
              const schemaPath = it.schemaEnv.baseId + it.errSchemaPath;
              const msg = `required property "${requiredKey}" is not defined at "${schemaPath}" (strictRequired)`;
              (0, util_1.checkStrictMode)(it, msg, it.opts.strictRequired);
            }
          }
        }
        function allErrorsMode() {
          if (useLoop || $data) {
            cxt.block$data(codegen_1.nil, loopAllRequired);
          } else {
            for (const prop of schema) {
              (0, code_1.checkReportMissingProp)(cxt, prop);
            }
          }
        }
        function exitOnErrorMode() {
          const missing = gen.let("missing");
          if (useLoop || $data) {
            const valid = gen.let("valid", true);
            cxt.block$data(valid, () => loopUntilMissing(missing, valid));
            cxt.ok(valid);
          } else {
            gen.if((0, code_1.checkMissingProp)(cxt, schema, missing));
            (0, code_1.reportMissingProp)(cxt, missing);
            gen.else();
          }
        }
        function loopAllRequired() {
          gen.forOf("prop", schemaCode, (prop) => {
            cxt.setParams({ missingProperty: prop });
            gen.if((0, code_1.noPropertyInData)(gen, data, prop, opts.ownProperties), () => cxt.error());
          });
        }
        function loopUntilMissing(missing, valid) {
          cxt.setParams({ missingProperty: missing });
          gen.forOf(missing, schemaCode, () => {
            gen.assign(valid, (0, code_1.propertyInData)(gen, data, missing, opts.ownProperties));
            gen.if((0, codegen_1.not)(valid), () => {
              cxt.error();
              gen.break();
            });
          }, codegen_1.nil);
        }
      }
    };
    exports.default = def;
  }
});

// node_modules/.pnpm/ajv@8.20.0/node_modules/ajv/dist/vocabularies/validation/limitItems.js
var require_limitItems = __commonJS({
  "node_modules/.pnpm/ajv@8.20.0/node_modules/ajv/dist/vocabularies/validation/limitItems.js"(exports) {
    "use strict";
    Object.defineProperty(exports, "__esModule", { value: true });
    var codegen_1 = require_codegen();
    var error = {
      message({ keyword, schemaCode }) {
        const comp = keyword === "maxItems" ? "more" : "fewer";
        return (0, codegen_1.str)`must NOT have ${comp} than ${schemaCode} items`;
      },
      params: ({ schemaCode }) => (0, codegen_1._)`{limit: ${schemaCode}}`
    };
    var def = {
      keyword: ["maxItems", "minItems"],
      type: "array",
      schemaType: "number",
      $data: true,
      error,
      code(cxt) {
        const { keyword, data, schemaCode } = cxt;
        const op = keyword === "maxItems" ? codegen_1.operators.GT : codegen_1.operators.LT;
        cxt.fail$data((0, codegen_1._)`${data}.length ${op} ${schemaCode}`);
      }
    };
    exports.default = def;
  }
});

// node_modules/.pnpm/ajv@8.20.0/node_modules/ajv/dist/runtime/equal.js
var require_equal = __commonJS({
  "node_modules/.pnpm/ajv@8.20.0/node_modules/ajv/dist/runtime/equal.js"(exports) {
    "use strict";
    Object.defineProperty(exports, "__esModule", { value: true });
    var equal = require_fast_deep_equal();
    equal.code = 'require("ajv/dist/runtime/equal").default';
    exports.default = equal;
  }
});

// node_modules/.pnpm/ajv@8.20.0/node_modules/ajv/dist/vocabularies/validation/uniqueItems.js
var require_uniqueItems = __commonJS({
  "node_modules/.pnpm/ajv@8.20.0/node_modules/ajv/dist/vocabularies/validation/uniqueItems.js"(exports) {
    "use strict";
    Object.defineProperty(exports, "__esModule", { value: true });
    var dataType_1 = require_dataType();
    var codegen_1 = require_codegen();
    var util_1 = require_util();
    var equal_1 = require_equal();
    var error = {
      message: ({ params: { i, j } }) => (0, codegen_1.str)`must NOT have duplicate items (items ## ${j} and ${i} are identical)`,
      params: ({ params: { i, j } }) => (0, codegen_1._)`{i: ${i}, j: ${j}}`
    };
    var def = {
      keyword: "uniqueItems",
      type: "array",
      schemaType: "boolean",
      $data: true,
      error,
      code(cxt) {
        const { gen, data, $data, schema, parentSchema, schemaCode, it } = cxt;
        if (!$data && !schema)
          return;
        const valid = gen.let("valid");
        const itemTypes = parentSchema.items ? (0, dataType_1.getSchemaTypes)(parentSchema.items) : [];
        cxt.block$data(valid, validateUniqueItems, (0, codegen_1._)`${schemaCode} === false`);
        cxt.ok(valid);
        function validateUniqueItems() {
          const i = gen.let("i", (0, codegen_1._)`${data}.length`);
          const j = gen.let("j");
          cxt.setParams({ i, j });
          gen.assign(valid, true);
          gen.if((0, codegen_1._)`${i} > 1`, () => (canOptimize() ? loopN : loopN2)(i, j));
        }
        function canOptimize() {
          return itemTypes.length > 0 && !itemTypes.some((t) => t === "object" || t === "array");
        }
        function loopN(i, j) {
          const item = gen.name("item");
          const wrongType = (0, dataType_1.checkDataTypes)(itemTypes, item, it.opts.strictNumbers, dataType_1.DataType.Wrong);
          const indices = gen.const("indices", (0, codegen_1._)`{}`);
          gen.for((0, codegen_1._)`;${i}--;`, () => {
            gen.let(item, (0, codegen_1._)`${data}[${i}]`);
            gen.if(wrongType, (0, codegen_1._)`continue`);
            if (itemTypes.length > 1)
              gen.if((0, codegen_1._)`typeof ${item} == "string"`, (0, codegen_1._)`${item} += "_"`);
            gen.if((0, codegen_1._)`typeof ${indices}[${item}] == "number"`, () => {
              gen.assign(j, (0, codegen_1._)`${indices}[${item}]`);
              cxt.error();
              gen.assign(valid, false).break();
            }).code((0, codegen_1._)`${indices}[${item}] = ${i}`);
          });
        }
        function loopN2(i, j) {
          const eql = (0, util_1.useFunc)(gen, equal_1.default);
          const outer = gen.name("outer");
          gen.label(outer).for((0, codegen_1._)`;${i}--;`, () => gen.for((0, codegen_1._)`${j} = ${i}; ${j}--;`, () => gen.if((0, codegen_1._)`${eql}(${data}[${i}], ${data}[${j}])`, () => {
            cxt.error();
            gen.assign(valid, false).break(outer);
          })));
        }
      }
    };
    exports.default = def;
  }
});

// node_modules/.pnpm/ajv@8.20.0/node_modules/ajv/dist/vocabularies/validation/const.js
var require_const = __commonJS({
  "node_modules/.pnpm/ajv@8.20.0/node_modules/ajv/dist/vocabularies/validation/const.js"(exports) {
    "use strict";
    Object.defineProperty(exports, "__esModule", { value: true });
    var codegen_1 = require_codegen();
    var util_1 = require_util();
    var equal_1 = require_equal();
    var error = {
      message: "must be equal to constant",
      params: ({ schemaCode }) => (0, codegen_1._)`{allowedValue: ${schemaCode}}`
    };
    var def = {
      keyword: "const",
      $data: true,
      error,
      code(cxt) {
        const { gen, data, $data, schemaCode, schema } = cxt;
        if ($data || schema && typeof schema == "object") {
          cxt.fail$data((0, codegen_1._)`!${(0, util_1.useFunc)(gen, equal_1.default)}(${data}, ${schemaCode})`);
        } else {
          cxt.fail((0, codegen_1._)`${schema} !== ${data}`);
        }
      }
    };
    exports.default = def;
  }
});

// node_modules/.pnpm/ajv@8.20.0/node_modules/ajv/dist/vocabularies/validation/enum.js
var require_enum = __commonJS({
  "node_modules/.pnpm/ajv@8.20.0/node_modules/ajv/dist/vocabularies/validation/enum.js"(exports) {
    "use strict";
    Object.defineProperty(exports, "__esModule", { value: true });
    var codegen_1 = require_codegen();
    var util_1 = require_util();
    var equal_1 = require_equal();
    var error = {
      message: "must be equal to one of the allowed values",
      params: ({ schemaCode }) => (0, codegen_1._)`{allowedValues: ${schemaCode}}`
    };
    var def = {
      keyword: "enum",
      schemaType: "array",
      $data: true,
      error,
      code(cxt) {
        const { gen, data, $data, schema, schemaCode, it } = cxt;
        if (!$data && schema.length === 0)
          throw new Error("enum must have non-empty array");
        const useLoop = schema.length >= it.opts.loopEnum;
        let eql;
        const getEql = () => eql !== null && eql !== void 0 ? eql : eql = (0, util_1.useFunc)(gen, equal_1.default);
        let valid;
        if (useLoop || $data) {
          valid = gen.let("valid");
          cxt.block$data(valid, loopEnum);
        } else {
          if (!Array.isArray(schema))
            throw new Error("ajv implementation error");
          const vSchema = gen.const("vSchema", schemaCode);
          valid = (0, codegen_1.or)(...schema.map((_x, i) => equalCode(vSchema, i)));
        }
        cxt.pass(valid);
        function loopEnum() {
          gen.assign(valid, false);
          gen.forOf("v", schemaCode, (v) => gen.if((0, codegen_1._)`${getEql()}(${data}, ${v})`, () => gen.assign(valid, true).break()));
        }
        function equalCode(vSchema, i) {
          const sch = schema[i];
          return typeof sch === "object" && sch !== null ? (0, codegen_1._)`${getEql()}(${data}, ${vSchema}[${i}])` : (0, codegen_1._)`${data} === ${sch}`;
        }
      }
    };
    exports.default = def;
  }
});

// node_modules/.pnpm/ajv@8.20.0/node_modules/ajv/dist/vocabularies/validation/index.js
var require_validation = __commonJS({
  "node_modules/.pnpm/ajv@8.20.0/node_modules/ajv/dist/vocabularies/validation/index.js"(exports) {
    "use strict";
    Object.defineProperty(exports, "__esModule", { value: true });
    var limitNumber_1 = require_limitNumber();
    var multipleOf_1 = require_multipleOf();
    var limitLength_1 = require_limitLength();
    var pattern_1 = require_pattern();
    var limitProperties_1 = require_limitProperties();
    var required_1 = require_required();
    var limitItems_1 = require_limitItems();
    var uniqueItems_1 = require_uniqueItems();
    var const_1 = require_const();
    var enum_1 = require_enum();
    var validation = [
      // number
      limitNumber_1.default,
      multipleOf_1.default,
      // string
      limitLength_1.default,
      pattern_1.default,
      // object
      limitProperties_1.default,
      required_1.default,
      // array
      limitItems_1.default,
      uniqueItems_1.default,
      // any
      { keyword: "type", schemaType: ["string", "array"] },
      { keyword: "nullable", schemaType: "boolean" },
      const_1.default,
      enum_1.default
    ];
    exports.default = validation;
  }
});

// node_modules/.pnpm/ajv@8.20.0/node_modules/ajv/dist/vocabularies/applicator/additionalItems.js
var require_additionalItems = __commonJS({
  "node_modules/.pnpm/ajv@8.20.0/node_modules/ajv/dist/vocabularies/applicator/additionalItems.js"(exports) {
    "use strict";
    Object.defineProperty(exports, "__esModule", { value: true });
    exports.validateAdditionalItems = void 0;
    var codegen_1 = require_codegen();
    var util_1 = require_util();
    var error = {
      message: ({ params: { len } }) => (0, codegen_1.str)`must NOT have more than ${len} items`,
      params: ({ params: { len } }) => (0, codegen_1._)`{limit: ${len}}`
    };
    var def = {
      keyword: "additionalItems",
      type: "array",
      schemaType: ["boolean", "object"],
      before: "uniqueItems",
      error,
      code(cxt) {
        const { parentSchema, it } = cxt;
        const { items } = parentSchema;
        if (!Array.isArray(items)) {
          (0, util_1.checkStrictMode)(it, '"additionalItems" is ignored when "items" is not an array of schemas');
          return;
        }
        validateAdditionalItems(cxt, items);
      }
    };
    function validateAdditionalItems(cxt, items) {
      const { gen, schema, data, keyword, it } = cxt;
      it.items = true;
      const len = gen.const("len", (0, codegen_1._)`${data}.length`);
      if (schema === false) {
        cxt.setParams({ len: items.length });
        cxt.pass((0, codegen_1._)`${len} <= ${items.length}`);
      } else if (typeof schema == "object" && !(0, util_1.alwaysValidSchema)(it, schema)) {
        const valid = gen.var("valid", (0, codegen_1._)`${len} <= ${items.length}`);
        gen.if((0, codegen_1.not)(valid), () => validateItems(valid));
        cxt.ok(valid);
      }
      function validateItems(valid) {
        gen.forRange("i", items.length, len, (i) => {
          cxt.subschema({ keyword, dataProp: i, dataPropType: util_1.Type.Num }, valid);
          if (!it.allErrors)
            gen.if((0, codegen_1.not)(valid), () => gen.break());
        });
      }
    }
    exports.validateAdditionalItems = validateAdditionalItems;
    exports.default = def;
  }
});

// node_modules/.pnpm/ajv@8.20.0/node_modules/ajv/dist/vocabularies/applicator/items.js
var require_items = __commonJS({
  "node_modules/.pnpm/ajv@8.20.0/node_modules/ajv/dist/vocabularies/applicator/items.js"(exports) {
    "use strict";
    Object.defineProperty(exports, "__esModule", { value: true });
    exports.validateTuple = void 0;
    var codegen_1 = require_codegen();
    var util_1 = require_util();
    var code_1 = require_code2();
    var def = {
      keyword: "items",
      type: "array",
      schemaType: ["object", "array", "boolean"],
      before: "uniqueItems",
      code(cxt) {
        const { schema, it } = cxt;
        if (Array.isArray(schema))
          return validateTuple(cxt, "additionalItems", schema);
        it.items = true;
        if ((0, util_1.alwaysValidSchema)(it, schema))
          return;
        cxt.ok((0, code_1.validateArray)(cxt));
      }
    };
    function validateTuple(cxt, extraItems, schArr = cxt.schema) {
      const { gen, parentSchema, data, keyword, it } = cxt;
      checkStrictTuple(parentSchema);
      if (it.opts.unevaluated && schArr.length && it.items !== true) {
        it.items = util_1.mergeEvaluated.items(gen, schArr.length, it.items);
      }
      const valid = gen.name("valid");
      const len = gen.const("len", (0, codegen_1._)`${data}.length`);
      schArr.forEach((sch, i) => {
        if ((0, util_1.alwaysValidSchema)(it, sch))
          return;
        gen.if((0, codegen_1._)`${len} > ${i}`, () => cxt.subschema({
          keyword,
          schemaProp: i,
          dataProp: i
        }, valid));
        cxt.ok(valid);
      });
      function checkStrictTuple(sch) {
        const { opts, errSchemaPath } = it;
        const l = schArr.length;
        const fullTuple = l === sch.minItems && (l === sch.maxItems || sch[extraItems] === false);
        if (opts.strictTuples && !fullTuple) {
          const msg = `"${keyword}" is ${l}-tuple, but minItems or maxItems/${extraItems} are not specified or different at path "${errSchemaPath}"`;
          (0, util_1.checkStrictMode)(it, msg, opts.strictTuples);
        }
      }
    }
    exports.validateTuple = validateTuple;
    exports.default = def;
  }
});

// node_modules/.pnpm/ajv@8.20.0/node_modules/ajv/dist/vocabularies/applicator/prefixItems.js
var require_prefixItems = __commonJS({
  "node_modules/.pnpm/ajv@8.20.0/node_modules/ajv/dist/vocabularies/applicator/prefixItems.js"(exports) {
    "use strict";
    Object.defineProperty(exports, "__esModule", { value: true });
    var items_1 = require_items();
    var def = {
      keyword: "prefixItems",
      type: "array",
      schemaType: ["array"],
      before: "uniqueItems",
      code: (cxt) => (0, items_1.validateTuple)(cxt, "items")
    };
    exports.default = def;
  }
});

// node_modules/.pnpm/ajv@8.20.0/node_modules/ajv/dist/vocabularies/applicator/items2020.js
var require_items2020 = __commonJS({
  "node_modules/.pnpm/ajv@8.20.0/node_modules/ajv/dist/vocabularies/applicator/items2020.js"(exports) {
    "use strict";
    Object.defineProperty(exports, "__esModule", { value: true });
    var codegen_1 = require_codegen();
    var util_1 = require_util();
    var code_1 = require_code2();
    var additionalItems_1 = require_additionalItems();
    var error = {
      message: ({ params: { len } }) => (0, codegen_1.str)`must NOT have more than ${len} items`,
      params: ({ params: { len } }) => (0, codegen_1._)`{limit: ${len}}`
    };
    var def = {
      keyword: "items",
      type: "array",
      schemaType: ["object", "boolean"],
      before: "uniqueItems",
      error,
      code(cxt) {
        const { schema, parentSchema, it } = cxt;
        const { prefixItems } = parentSchema;
        it.items = true;
        if ((0, util_1.alwaysValidSchema)(it, schema))
          return;
        if (prefixItems)
          (0, additionalItems_1.validateAdditionalItems)(cxt, prefixItems);
        else
          cxt.ok((0, code_1.validateArray)(cxt));
      }
    };
    exports.default = def;
  }
});

// node_modules/.pnpm/ajv@8.20.0/node_modules/ajv/dist/vocabularies/applicator/contains.js
var require_contains = __commonJS({
  "node_modules/.pnpm/ajv@8.20.0/node_modules/ajv/dist/vocabularies/applicator/contains.js"(exports) {
    "use strict";
    Object.defineProperty(exports, "__esModule", { value: true });
    var codegen_1 = require_codegen();
    var util_1 = require_util();
    var error = {
      message: ({ params: { min, max } }) => max === void 0 ? (0, codegen_1.str)`must contain at least ${min} valid item(s)` : (0, codegen_1.str)`must contain at least ${min} and no more than ${max} valid item(s)`,
      params: ({ params: { min, max } }) => max === void 0 ? (0, codegen_1._)`{minContains: ${min}}` : (0, codegen_1._)`{minContains: ${min}, maxContains: ${max}}`
    };
    var def = {
      keyword: "contains",
      type: "array",
      schemaType: ["object", "boolean"],
      before: "uniqueItems",
      trackErrors: true,
      error,
      code(cxt) {
        const { gen, schema, parentSchema, data, it } = cxt;
        let min;
        let max;
        const { minContains, maxContains } = parentSchema;
        if (it.opts.next) {
          min = minContains === void 0 ? 1 : minContains;
          max = maxContains;
        } else {
          min = 1;
        }
        const len = gen.const("len", (0, codegen_1._)`${data}.length`);
        cxt.setParams({ min, max });
        if (max === void 0 && min === 0) {
          (0, util_1.checkStrictMode)(it, `"minContains" == 0 without "maxContains": "contains" keyword ignored`);
          return;
        }
        if (max !== void 0 && min > max) {
          (0, util_1.checkStrictMode)(it, `"minContains" > "maxContains" is always invalid`);
          cxt.fail();
          return;
        }
        if ((0, util_1.alwaysValidSchema)(it, schema)) {
          let cond = (0, codegen_1._)`${len} >= ${min}`;
          if (max !== void 0)
            cond = (0, codegen_1._)`${cond} && ${len} <= ${max}`;
          cxt.pass(cond);
          return;
        }
        it.items = true;
        const valid = gen.name("valid");
        if (max === void 0 && min === 1) {
          validateItems(valid, () => gen.if(valid, () => gen.break()));
        } else if (min === 0) {
          gen.let(valid, true);
          if (max !== void 0)
            gen.if((0, codegen_1._)`${data}.length > 0`, validateItemsWithCount);
        } else {
          gen.let(valid, false);
          validateItemsWithCount();
        }
        cxt.result(valid, () => cxt.reset());
        function validateItemsWithCount() {
          const schValid = gen.name("_valid");
          const count = gen.let("count", 0);
          validateItems(schValid, () => gen.if(schValid, () => checkLimits(count)));
        }
        function validateItems(_valid, block) {
          gen.forRange("i", 0, len, (i) => {
            cxt.subschema({
              keyword: "contains",
              dataProp: i,
              dataPropType: util_1.Type.Num,
              compositeRule: true
            }, _valid);
            block();
          });
        }
        function checkLimits(count) {
          gen.code((0, codegen_1._)`${count}++`);
          if (max === void 0) {
            gen.if((0, codegen_1._)`${count} >= ${min}`, () => gen.assign(valid, true).break());
          } else {
            gen.if((0, codegen_1._)`${count} > ${max}`, () => gen.assign(valid, false).break());
            if (min === 1)
              gen.assign(valid, true);
            else
              gen.if((0, codegen_1._)`${count} >= ${min}`, () => gen.assign(valid, true));
          }
        }
      }
    };
    exports.default = def;
  }
});

// node_modules/.pnpm/ajv@8.20.0/node_modules/ajv/dist/vocabularies/applicator/dependencies.js
var require_dependencies = __commonJS({
  "node_modules/.pnpm/ajv@8.20.0/node_modules/ajv/dist/vocabularies/applicator/dependencies.js"(exports) {
    "use strict";
    Object.defineProperty(exports, "__esModule", { value: true });
    exports.validateSchemaDeps = exports.validatePropertyDeps = exports.error = void 0;
    var codegen_1 = require_codegen();
    var util_1 = require_util();
    var code_1 = require_code2();
    exports.error = {
      message: ({ params: { property, depsCount, deps } }) => {
        const property_ies = depsCount === 1 ? "property" : "properties";
        return (0, codegen_1.str)`must have ${property_ies} ${deps} when property ${property} is present`;
      },
      params: ({ params: { property, depsCount, deps, missingProperty } }) => (0, codegen_1._)`{property: ${property},
    missingProperty: ${missingProperty},
    depsCount: ${depsCount},
    deps: ${deps}}`
      // TODO change to reference
    };
    var def = {
      keyword: "dependencies",
      type: "object",
      schemaType: "object",
      error: exports.error,
      code(cxt) {
        const [propDeps, schDeps] = splitDependencies(cxt);
        validatePropertyDeps(cxt, propDeps);
        validateSchemaDeps(cxt, schDeps);
      }
    };
    function splitDependencies({ schema }) {
      const propertyDeps = {};
      const schemaDeps = {};
      for (const key in schema) {
        if (key === "__proto__")
          continue;
        const deps = Array.isArray(schema[key]) ? propertyDeps : schemaDeps;
        deps[key] = schema[key];
      }
      return [propertyDeps, schemaDeps];
    }
    function validatePropertyDeps(cxt, propertyDeps = cxt.schema) {
      const { gen, data, it } = cxt;
      if (Object.keys(propertyDeps).length === 0)
        return;
      const missing = gen.let("missing");
      for (const prop in propertyDeps) {
        const deps = propertyDeps[prop];
        if (deps.length === 0)
          continue;
        const hasProperty = (0, code_1.propertyInData)(gen, data, prop, it.opts.ownProperties);
        cxt.setParams({
          property: prop,
          depsCount: deps.length,
          deps: deps.join(", ")
        });
        if (it.allErrors) {
          gen.if(hasProperty, () => {
            for (const depProp of deps) {
              (0, code_1.checkReportMissingProp)(cxt, depProp);
            }
          });
        } else {
          gen.if((0, codegen_1._)`${hasProperty} && (${(0, code_1.checkMissingProp)(cxt, deps, missing)})`);
          (0, code_1.reportMissingProp)(cxt, missing);
          gen.else();
        }
      }
    }
    exports.validatePropertyDeps = validatePropertyDeps;
    function validateSchemaDeps(cxt, schemaDeps = cxt.schema) {
      const { gen, data, keyword, it } = cxt;
      const valid = gen.name("valid");
      for (const prop in schemaDeps) {
        if ((0, util_1.alwaysValidSchema)(it, schemaDeps[prop]))
          continue;
        gen.if(
          (0, code_1.propertyInData)(gen, data, prop, it.opts.ownProperties),
          () => {
            const schCxt = cxt.subschema({ keyword, schemaProp: prop }, valid);
            cxt.mergeValidEvaluated(schCxt, valid);
          },
          () => gen.var(valid, true)
          // TODO var
        );
        cxt.ok(valid);
      }
    }
    exports.validateSchemaDeps = validateSchemaDeps;
    exports.default = def;
  }
});

// node_modules/.pnpm/ajv@8.20.0/node_modules/ajv/dist/vocabularies/applicator/propertyNames.js
var require_propertyNames = __commonJS({
  "node_modules/.pnpm/ajv@8.20.0/node_modules/ajv/dist/vocabularies/applicator/propertyNames.js"(exports) {
    "use strict";
    Object.defineProperty(exports, "__esModule", { value: true });
    var codegen_1 = require_codegen();
    var util_1 = require_util();
    var error = {
      message: "property name must be valid",
      params: ({ params }) => (0, codegen_1._)`{propertyName: ${params.propertyName}}`
    };
    var def = {
      keyword: "propertyNames",
      type: "object",
      schemaType: ["object", "boolean"],
      error,
      code(cxt) {
        const { gen, schema, data, it } = cxt;
        if ((0, util_1.alwaysValidSchema)(it, schema))
          return;
        const valid = gen.name("valid");
        gen.forIn("key", data, (key) => {
          cxt.setParams({ propertyName: key });
          cxt.subschema({
            keyword: "propertyNames",
            data: key,
            dataTypes: ["string"],
            propertyName: key,
            compositeRule: true
          }, valid);
          gen.if((0, codegen_1.not)(valid), () => {
            cxt.error(true);
            if (!it.allErrors)
              gen.break();
          });
        });
        cxt.ok(valid);
      }
    };
    exports.default = def;
  }
});

// node_modules/.pnpm/ajv@8.20.0/node_modules/ajv/dist/vocabularies/applicator/additionalProperties.js
var require_additionalProperties = __commonJS({
  "node_modules/.pnpm/ajv@8.20.0/node_modules/ajv/dist/vocabularies/applicator/additionalProperties.js"(exports) {
    "use strict";
    Object.defineProperty(exports, "__esModule", { value: true });
    var code_1 = require_code2();
    var codegen_1 = require_codegen();
    var names_1 = require_names();
    var util_1 = require_util();
    var error = {
      message: "must NOT have additional properties",
      params: ({ params }) => (0, codegen_1._)`{additionalProperty: ${params.additionalProperty}}`
    };
    var def = {
      keyword: "additionalProperties",
      type: ["object"],
      schemaType: ["boolean", "object"],
      allowUndefined: true,
      trackErrors: true,
      error,
      code(cxt) {
        const { gen, schema, parentSchema, data, errsCount, it } = cxt;
        if (!errsCount)
          throw new Error("ajv implementation error");
        const { allErrors, opts } = it;
        it.props = true;
        if (opts.removeAdditional !== "all" && (0, util_1.alwaysValidSchema)(it, schema))
          return;
        const props = (0, code_1.allSchemaProperties)(parentSchema.properties);
        const patProps = (0, code_1.allSchemaProperties)(parentSchema.patternProperties);
        checkAdditionalProperties();
        cxt.ok((0, codegen_1._)`${errsCount} === ${names_1.default.errors}`);
        function checkAdditionalProperties() {
          gen.forIn("key", data, (key) => {
            if (!props.length && !patProps.length)
              additionalPropertyCode(key);
            else
              gen.if(isAdditional(key), () => additionalPropertyCode(key));
          });
        }
        function isAdditional(key) {
          let definedProp;
          if (props.length > 8) {
            const propsSchema = (0, util_1.schemaRefOrVal)(it, parentSchema.properties, "properties");
            definedProp = (0, code_1.isOwnProperty)(gen, propsSchema, key);
          } else if (props.length) {
            definedProp = (0, codegen_1.or)(...props.map((p) => (0, codegen_1._)`${key} === ${p}`));
          } else {
            definedProp = codegen_1.nil;
          }
          if (patProps.length) {
            definedProp = (0, codegen_1.or)(definedProp, ...patProps.map((p) => (0, codegen_1._)`${(0, code_1.usePattern)(cxt, p)}.test(${key})`));
          }
          return (0, codegen_1.not)(definedProp);
        }
        function deleteAdditional(key) {
          gen.code((0, codegen_1._)`delete ${data}[${key}]`);
        }
        function additionalPropertyCode(key) {
          if (opts.removeAdditional === "all" || opts.removeAdditional && schema === false) {
            deleteAdditional(key);
            return;
          }
          if (schema === false) {
            cxt.setParams({ additionalProperty: key });
            cxt.error();
            if (!allErrors)
              gen.break();
            return;
          }
          if (typeof schema == "object" && !(0, util_1.alwaysValidSchema)(it, schema)) {
            const valid = gen.name("valid");
            if (opts.removeAdditional === "failing") {
              applyAdditionalSchema(key, valid, false);
              gen.if((0, codegen_1.not)(valid), () => {
                cxt.reset();
                deleteAdditional(key);
              });
            } else {
              applyAdditionalSchema(key, valid);
              if (!allErrors)
                gen.if((0, codegen_1.not)(valid), () => gen.break());
            }
          }
        }
        function applyAdditionalSchema(key, valid, errors) {
          const subschema = {
            keyword: "additionalProperties",
            dataProp: key,
            dataPropType: util_1.Type.Str
          };
          if (errors === false) {
            Object.assign(subschema, {
              compositeRule: true,
              createErrors: false,
              allErrors: false
            });
          }
          cxt.subschema(subschema, valid);
        }
      }
    };
    exports.default = def;
  }
});

// node_modules/.pnpm/ajv@8.20.0/node_modules/ajv/dist/vocabularies/applicator/properties.js
var require_properties = __commonJS({
  "node_modules/.pnpm/ajv@8.20.0/node_modules/ajv/dist/vocabularies/applicator/properties.js"(exports) {
    "use strict";
    Object.defineProperty(exports, "__esModule", { value: true });
    var validate_1 = require_validate();
    var code_1 = require_code2();
    var util_1 = require_util();
    var additionalProperties_1 = require_additionalProperties();
    var def = {
      keyword: "properties",
      type: "object",
      schemaType: "object",
      code(cxt) {
        const { gen, schema, parentSchema, data, it } = cxt;
        if (it.opts.removeAdditional === "all" && parentSchema.additionalProperties === void 0) {
          additionalProperties_1.default.code(new validate_1.KeywordCxt(it, additionalProperties_1.default, "additionalProperties"));
        }
        const allProps = (0, code_1.allSchemaProperties)(schema);
        for (const prop of allProps) {
          it.definedProperties.add(prop);
        }
        if (it.opts.unevaluated && allProps.length && it.props !== true) {
          it.props = util_1.mergeEvaluated.props(gen, (0, util_1.toHash)(allProps), it.props);
        }
        const properties = allProps.filter((p) => !(0, util_1.alwaysValidSchema)(it, schema[p]));
        if (properties.length === 0)
          return;
        const valid = gen.name("valid");
        for (const prop of properties) {
          if (hasDefault(prop)) {
            applyPropertySchema(prop);
          } else {
            gen.if((0, code_1.propertyInData)(gen, data, prop, it.opts.ownProperties));
            applyPropertySchema(prop);
            if (!it.allErrors)
              gen.else().var(valid, true);
            gen.endIf();
          }
          cxt.it.definedProperties.add(prop);
          cxt.ok(valid);
        }
        function hasDefault(prop) {
          return it.opts.useDefaults && !it.compositeRule && schema[prop].default !== void 0;
        }
        function applyPropertySchema(prop) {
          cxt.subschema({
            keyword: "properties",
            schemaProp: prop,
            dataProp: prop
          }, valid);
        }
      }
    };
    exports.default = def;
  }
});

// node_modules/.pnpm/ajv@8.20.0/node_modules/ajv/dist/vocabularies/applicator/patternProperties.js
var require_patternProperties = __commonJS({
  "node_modules/.pnpm/ajv@8.20.0/node_modules/ajv/dist/vocabularies/applicator/patternProperties.js"(exports) {
    "use strict";
    Object.defineProperty(exports, "__esModule", { value: true });
    var code_1 = require_code2();
    var codegen_1 = require_codegen();
    var util_1 = require_util();
    var util_2 = require_util();
    var def = {
      keyword: "patternProperties",
      type: "object",
      schemaType: "object",
      code(cxt) {
        const { gen, schema, data, parentSchema, it } = cxt;
        const { opts } = it;
        const patterns = (0, code_1.allSchemaProperties)(schema);
        const alwaysValidPatterns = patterns.filter((p) => (0, util_1.alwaysValidSchema)(it, schema[p]));
        if (patterns.length === 0 || alwaysValidPatterns.length === patterns.length && (!it.opts.unevaluated || it.props === true)) {
          return;
        }
        const checkProperties = opts.strictSchema && !opts.allowMatchingProperties && parentSchema.properties;
        const valid = gen.name("valid");
        if (it.props !== true && !(it.props instanceof codegen_1.Name)) {
          it.props = (0, util_2.evaluatedPropsToName)(gen, it.props);
        }
        const { props } = it;
        validatePatternProperties();
        function validatePatternProperties() {
          for (const pat of patterns) {
            if (checkProperties)
              checkMatchingProperties(pat);
            if (it.allErrors) {
              validateProperties(pat);
            } else {
              gen.var(valid, true);
              validateProperties(pat);
              gen.if(valid);
            }
          }
        }
        function checkMatchingProperties(pat) {
          for (const prop in checkProperties) {
            if (new RegExp(pat).test(prop)) {
              (0, util_1.checkStrictMode)(it, `property ${prop} matches pattern ${pat} (use allowMatchingProperties)`);
            }
          }
        }
        function validateProperties(pat) {
          gen.forIn("key", data, (key) => {
            gen.if((0, codegen_1._)`${(0, code_1.usePattern)(cxt, pat)}.test(${key})`, () => {
              const alwaysValid = alwaysValidPatterns.includes(pat);
              if (!alwaysValid) {
                cxt.subschema({
                  keyword: "patternProperties",
                  schemaProp: pat,
                  dataProp: key,
                  dataPropType: util_2.Type.Str
                }, valid);
              }
              if (it.opts.unevaluated && props !== true) {
                gen.assign((0, codegen_1._)`${props}[${key}]`, true);
              } else if (!alwaysValid && !it.allErrors) {
                gen.if((0, codegen_1.not)(valid), () => gen.break());
              }
            });
          });
        }
      }
    };
    exports.default = def;
  }
});

// node_modules/.pnpm/ajv@8.20.0/node_modules/ajv/dist/vocabularies/applicator/not.js
var require_not = __commonJS({
  "node_modules/.pnpm/ajv@8.20.0/node_modules/ajv/dist/vocabularies/applicator/not.js"(exports) {
    "use strict";
    Object.defineProperty(exports, "__esModule", { value: true });
    var util_1 = require_util();
    var def = {
      keyword: "not",
      schemaType: ["object", "boolean"],
      trackErrors: true,
      code(cxt) {
        const { gen, schema, it } = cxt;
        if ((0, util_1.alwaysValidSchema)(it, schema)) {
          cxt.fail();
          return;
        }
        const valid = gen.name("valid");
        cxt.subschema({
          keyword: "not",
          compositeRule: true,
          createErrors: false,
          allErrors: false
        }, valid);
        cxt.failResult(valid, () => cxt.reset(), () => cxt.error());
      },
      error: { message: "must NOT be valid" }
    };
    exports.default = def;
  }
});

// node_modules/.pnpm/ajv@8.20.0/node_modules/ajv/dist/vocabularies/applicator/anyOf.js
var require_anyOf = __commonJS({
  "node_modules/.pnpm/ajv@8.20.0/node_modules/ajv/dist/vocabularies/applicator/anyOf.js"(exports) {
    "use strict";
    Object.defineProperty(exports, "__esModule", { value: true });
    var code_1 = require_code2();
    var def = {
      keyword: "anyOf",
      schemaType: "array",
      trackErrors: true,
      code: code_1.validateUnion,
      error: { message: "must match a schema in anyOf" }
    };
    exports.default = def;
  }
});

// node_modules/.pnpm/ajv@8.20.0/node_modules/ajv/dist/vocabularies/applicator/oneOf.js
var require_oneOf = __commonJS({
  "node_modules/.pnpm/ajv@8.20.0/node_modules/ajv/dist/vocabularies/applicator/oneOf.js"(exports) {
    "use strict";
    Object.defineProperty(exports, "__esModule", { value: true });
    var codegen_1 = require_codegen();
    var util_1 = require_util();
    var error = {
      message: "must match exactly one schema in oneOf",
      params: ({ params }) => (0, codegen_1._)`{passingSchemas: ${params.passing}}`
    };
    var def = {
      keyword: "oneOf",
      schemaType: "array",
      trackErrors: true,
      error,
      code(cxt) {
        const { gen, schema, parentSchema, it } = cxt;
        if (!Array.isArray(schema))
          throw new Error("ajv implementation error");
        if (it.opts.discriminator && parentSchema.discriminator)
          return;
        const schArr = schema;
        const valid = gen.let("valid", false);
        const passing = gen.let("passing", null);
        const schValid = gen.name("_valid");
        cxt.setParams({ passing });
        gen.block(validateOneOf);
        cxt.result(valid, () => cxt.reset(), () => cxt.error(true));
        function validateOneOf() {
          schArr.forEach((sch, i) => {
            let schCxt;
            if ((0, util_1.alwaysValidSchema)(it, sch)) {
              gen.var(schValid, true);
            } else {
              schCxt = cxt.subschema({
                keyword: "oneOf",
                schemaProp: i,
                compositeRule: true
              }, schValid);
            }
            if (i > 0) {
              gen.if((0, codegen_1._)`${schValid} && ${valid}`).assign(valid, false).assign(passing, (0, codegen_1._)`[${passing}, ${i}]`).else();
            }
            gen.if(schValid, () => {
              gen.assign(valid, true);
              gen.assign(passing, i);
              if (schCxt)
                cxt.mergeEvaluated(schCxt, codegen_1.Name);
            });
          });
        }
      }
    };
    exports.default = def;
  }
});

// node_modules/.pnpm/ajv@8.20.0/node_modules/ajv/dist/vocabularies/applicator/allOf.js
var require_allOf = __commonJS({
  "node_modules/.pnpm/ajv@8.20.0/node_modules/ajv/dist/vocabularies/applicator/allOf.js"(exports) {
    "use strict";
    Object.defineProperty(exports, "__esModule", { value: true });
    var util_1 = require_util();
    var def = {
      keyword: "allOf",
      schemaType: "array",
      code(cxt) {
        const { gen, schema, it } = cxt;
        if (!Array.isArray(schema))
          throw new Error("ajv implementation error");
        const valid = gen.name("valid");
        schema.forEach((sch, i) => {
          if ((0, util_1.alwaysValidSchema)(it, sch))
            return;
          const schCxt = cxt.subschema({ keyword: "allOf", schemaProp: i }, valid);
          cxt.ok(valid);
          cxt.mergeEvaluated(schCxt);
        });
      }
    };
    exports.default = def;
  }
});

// node_modules/.pnpm/ajv@8.20.0/node_modules/ajv/dist/vocabularies/applicator/if.js
var require_if = __commonJS({
  "node_modules/.pnpm/ajv@8.20.0/node_modules/ajv/dist/vocabularies/applicator/if.js"(exports) {
    "use strict";
    Object.defineProperty(exports, "__esModule", { value: true });
    var codegen_1 = require_codegen();
    var util_1 = require_util();
    var error = {
      message: ({ params }) => (0, codegen_1.str)`must match "${params.ifClause}" schema`,
      params: ({ params }) => (0, codegen_1._)`{failingKeyword: ${params.ifClause}}`
    };
    var def = {
      keyword: "if",
      schemaType: ["object", "boolean"],
      trackErrors: true,
      error,
      code(cxt) {
        const { gen, parentSchema, it } = cxt;
        if (parentSchema.then === void 0 && parentSchema.else === void 0) {
          (0, util_1.checkStrictMode)(it, '"if" without "then" and "else" is ignored');
        }
        const hasThen = hasSchema(it, "then");
        const hasElse = hasSchema(it, "else");
        if (!hasThen && !hasElse)
          return;
        const valid = gen.let("valid", true);
        const schValid = gen.name("_valid");
        validateIf();
        cxt.reset();
        if (hasThen && hasElse) {
          const ifClause = gen.let("ifClause");
          cxt.setParams({ ifClause });
          gen.if(schValid, validateClause("then", ifClause), validateClause("else", ifClause));
        } else if (hasThen) {
          gen.if(schValid, validateClause("then"));
        } else {
          gen.if((0, codegen_1.not)(schValid), validateClause("else"));
        }
        cxt.pass(valid, () => cxt.error(true));
        function validateIf() {
          const schCxt = cxt.subschema({
            keyword: "if",
            compositeRule: true,
            createErrors: false,
            allErrors: false
          }, schValid);
          cxt.mergeEvaluated(schCxt);
        }
        function validateClause(keyword, ifClause) {
          return () => {
            const schCxt = cxt.subschema({ keyword }, schValid);
            gen.assign(valid, schValid);
            cxt.mergeValidEvaluated(schCxt, valid);
            if (ifClause)
              gen.assign(ifClause, (0, codegen_1._)`${keyword}`);
            else
              cxt.setParams({ ifClause: keyword });
          };
        }
      }
    };
    function hasSchema(it, keyword) {
      const schema = it.schema[keyword];
      return schema !== void 0 && !(0, util_1.alwaysValidSchema)(it, schema);
    }
    exports.default = def;
  }
});

// node_modules/.pnpm/ajv@8.20.0/node_modules/ajv/dist/vocabularies/applicator/thenElse.js
var require_thenElse = __commonJS({
  "node_modules/.pnpm/ajv@8.20.0/node_modules/ajv/dist/vocabularies/applicator/thenElse.js"(exports) {
    "use strict";
    Object.defineProperty(exports, "__esModule", { value: true });
    var util_1 = require_util();
    var def = {
      keyword: ["then", "else"],
      schemaType: ["object", "boolean"],
      code({ keyword, parentSchema, it }) {
        if (parentSchema.if === void 0)
          (0, util_1.checkStrictMode)(it, `"${keyword}" without "if" is ignored`);
      }
    };
    exports.default = def;
  }
});

// node_modules/.pnpm/ajv@8.20.0/node_modules/ajv/dist/vocabularies/applicator/index.js
var require_applicator = __commonJS({
  "node_modules/.pnpm/ajv@8.20.0/node_modules/ajv/dist/vocabularies/applicator/index.js"(exports) {
    "use strict";
    Object.defineProperty(exports, "__esModule", { value: true });
    var additionalItems_1 = require_additionalItems();
    var prefixItems_1 = require_prefixItems();
    var items_1 = require_items();
    var items2020_1 = require_items2020();
    var contains_1 = require_contains();
    var dependencies_1 = require_dependencies();
    var propertyNames_1 = require_propertyNames();
    var additionalProperties_1 = require_additionalProperties();
    var properties_1 = require_properties();
    var patternProperties_1 = require_patternProperties();
    var not_1 = require_not();
    var anyOf_1 = require_anyOf();
    var oneOf_1 = require_oneOf();
    var allOf_1 = require_allOf();
    var if_1 = require_if();
    var thenElse_1 = require_thenElse();
    function getApplicator(draft2020 = false) {
      const applicator = [
        // any
        not_1.default,
        anyOf_1.default,
        oneOf_1.default,
        allOf_1.default,
        if_1.default,
        thenElse_1.default,
        // object
        propertyNames_1.default,
        additionalProperties_1.default,
        dependencies_1.default,
        properties_1.default,
        patternProperties_1.default
      ];
      if (draft2020)
        applicator.push(prefixItems_1.default, items2020_1.default);
      else
        applicator.push(additionalItems_1.default, items_1.default);
      applicator.push(contains_1.default);
      return applicator;
    }
    exports.default = getApplicator;
  }
});

// node_modules/.pnpm/ajv@8.20.0/node_modules/ajv/dist/vocabularies/dynamic/dynamicAnchor.js
var require_dynamicAnchor = __commonJS({
  "node_modules/.pnpm/ajv@8.20.0/node_modules/ajv/dist/vocabularies/dynamic/dynamicAnchor.js"(exports) {
    "use strict";
    Object.defineProperty(exports, "__esModule", { value: true });
    exports.dynamicAnchor = void 0;
    var codegen_1 = require_codegen();
    var names_1 = require_names();
    var compile_1 = require_compile();
    var ref_1 = require_ref();
    var def = {
      keyword: "$dynamicAnchor",
      schemaType: "string",
      code: (cxt) => dynamicAnchor(cxt, cxt.schema)
    };
    function dynamicAnchor(cxt, anchor) {
      const { gen, it } = cxt;
      it.schemaEnv.root.dynamicAnchors[anchor] = true;
      const v = (0, codegen_1._)`${names_1.default.dynamicAnchors}${(0, codegen_1.getProperty)(anchor)}`;
      const validate = it.errSchemaPath === "#" ? it.validateName : _getValidate(cxt);
      gen.if((0, codegen_1._)`!${v}`, () => gen.assign(v, validate));
    }
    exports.dynamicAnchor = dynamicAnchor;
    function _getValidate(cxt) {
      const { schemaEnv, schema, self } = cxt.it;
      const { root, baseId, localRefs, meta } = schemaEnv.root;
      const { schemaId } = self.opts;
      const sch = new compile_1.SchemaEnv({ schema, schemaId, root, baseId, localRefs, meta });
      compile_1.compileSchema.call(self, sch);
      return (0, ref_1.getValidate)(cxt, sch);
    }
    exports.default = def;
  }
});

// node_modules/.pnpm/ajv@8.20.0/node_modules/ajv/dist/vocabularies/dynamic/dynamicRef.js
var require_dynamicRef = __commonJS({
  "node_modules/.pnpm/ajv@8.20.0/node_modules/ajv/dist/vocabularies/dynamic/dynamicRef.js"(exports) {
    "use strict";
    Object.defineProperty(exports, "__esModule", { value: true });
    exports.dynamicRef = void 0;
    var codegen_1 = require_codegen();
    var names_1 = require_names();
    var ref_1 = require_ref();
    var def = {
      keyword: "$dynamicRef",
      schemaType: "string",
      code: (cxt) => dynamicRef(cxt, cxt.schema)
    };
    function dynamicRef(cxt, ref) {
      const { gen, keyword, it } = cxt;
      if (ref[0] !== "#")
        throw new Error(`"${keyword}" only supports hash fragment reference`);
      const anchor = ref.slice(1);
      if (it.allErrors) {
        _dynamicRef();
      } else {
        const valid = gen.let("valid", false);
        _dynamicRef(valid);
        cxt.ok(valid);
      }
      function _dynamicRef(valid) {
        if (it.schemaEnv.root.dynamicAnchors[anchor]) {
          const v = gen.let("_v", (0, codegen_1._)`${names_1.default.dynamicAnchors}${(0, codegen_1.getProperty)(anchor)}`);
          gen.if(v, _callRef(v, valid), _callRef(it.validateName, valid));
        } else {
          _callRef(it.validateName, valid)();
        }
      }
      function _callRef(validate, valid) {
        return valid ? () => gen.block(() => {
          (0, ref_1.callRef)(cxt, validate);
          gen.let(valid, true);
        }) : () => (0, ref_1.callRef)(cxt, validate);
      }
    }
    exports.dynamicRef = dynamicRef;
    exports.default = def;
  }
});

// node_modules/.pnpm/ajv@8.20.0/node_modules/ajv/dist/vocabularies/dynamic/recursiveAnchor.js
var require_recursiveAnchor = __commonJS({
  "node_modules/.pnpm/ajv@8.20.0/node_modules/ajv/dist/vocabularies/dynamic/recursiveAnchor.js"(exports) {
    "use strict";
    Object.defineProperty(exports, "__esModule", { value: true });
    var dynamicAnchor_1 = require_dynamicAnchor();
    var util_1 = require_util();
    var def = {
      keyword: "$recursiveAnchor",
      schemaType: "boolean",
      code(cxt) {
        if (cxt.schema)
          (0, dynamicAnchor_1.dynamicAnchor)(cxt, "");
        else
          (0, util_1.checkStrictMode)(cxt.it, "$recursiveAnchor: false is ignored");
      }
    };
    exports.default = def;
  }
});

// node_modules/.pnpm/ajv@8.20.0/node_modules/ajv/dist/vocabularies/dynamic/recursiveRef.js
var require_recursiveRef = __commonJS({
  "node_modules/.pnpm/ajv@8.20.0/node_modules/ajv/dist/vocabularies/dynamic/recursiveRef.js"(exports) {
    "use strict";
    Object.defineProperty(exports, "__esModule", { value: true });
    var dynamicRef_1 = require_dynamicRef();
    var def = {
      keyword: "$recursiveRef",
      schemaType: "string",
      code: (cxt) => (0, dynamicRef_1.dynamicRef)(cxt, cxt.schema)
    };
    exports.default = def;
  }
});

// node_modules/.pnpm/ajv@8.20.0/node_modules/ajv/dist/vocabularies/dynamic/index.js
var require_dynamic = __commonJS({
  "node_modules/.pnpm/ajv@8.20.0/node_modules/ajv/dist/vocabularies/dynamic/index.js"(exports) {
    "use strict";
    Object.defineProperty(exports, "__esModule", { value: true });
    var dynamicAnchor_1 = require_dynamicAnchor();
    var dynamicRef_1 = require_dynamicRef();
    var recursiveAnchor_1 = require_recursiveAnchor();
    var recursiveRef_1 = require_recursiveRef();
    var dynamic = [dynamicAnchor_1.default, dynamicRef_1.default, recursiveAnchor_1.default, recursiveRef_1.default];
    exports.default = dynamic;
  }
});

// node_modules/.pnpm/ajv@8.20.0/node_modules/ajv/dist/vocabularies/validation/dependentRequired.js
var require_dependentRequired = __commonJS({
  "node_modules/.pnpm/ajv@8.20.0/node_modules/ajv/dist/vocabularies/validation/dependentRequired.js"(exports) {
    "use strict";
    Object.defineProperty(exports, "__esModule", { value: true });
    var dependencies_1 = require_dependencies();
    var def = {
      keyword: "dependentRequired",
      type: "object",
      schemaType: "object",
      error: dependencies_1.error,
      code: (cxt) => (0, dependencies_1.validatePropertyDeps)(cxt)
    };
    exports.default = def;
  }
});

// node_modules/.pnpm/ajv@8.20.0/node_modules/ajv/dist/vocabularies/applicator/dependentSchemas.js
var require_dependentSchemas = __commonJS({
  "node_modules/.pnpm/ajv@8.20.0/node_modules/ajv/dist/vocabularies/applicator/dependentSchemas.js"(exports) {
    "use strict";
    Object.defineProperty(exports, "__esModule", { value: true });
    var dependencies_1 = require_dependencies();
    var def = {
      keyword: "dependentSchemas",
      type: "object",
      schemaType: "object",
      code: (cxt) => (0, dependencies_1.validateSchemaDeps)(cxt)
    };
    exports.default = def;
  }
});

// node_modules/.pnpm/ajv@8.20.0/node_modules/ajv/dist/vocabularies/validation/limitContains.js
var require_limitContains = __commonJS({
  "node_modules/.pnpm/ajv@8.20.0/node_modules/ajv/dist/vocabularies/validation/limitContains.js"(exports) {
    "use strict";
    Object.defineProperty(exports, "__esModule", { value: true });
    var util_1 = require_util();
    var def = {
      keyword: ["maxContains", "minContains"],
      type: "array",
      schemaType: "number",
      code({ keyword, parentSchema, it }) {
        if (parentSchema.contains === void 0) {
          (0, util_1.checkStrictMode)(it, `"${keyword}" without "contains" is ignored`);
        }
      }
    };
    exports.default = def;
  }
});

// node_modules/.pnpm/ajv@8.20.0/node_modules/ajv/dist/vocabularies/next.js
var require_next = __commonJS({
  "node_modules/.pnpm/ajv@8.20.0/node_modules/ajv/dist/vocabularies/next.js"(exports) {
    "use strict";
    Object.defineProperty(exports, "__esModule", { value: true });
    var dependentRequired_1 = require_dependentRequired();
    var dependentSchemas_1 = require_dependentSchemas();
    var limitContains_1 = require_limitContains();
    var next = [dependentRequired_1.default, dependentSchemas_1.default, limitContains_1.default];
    exports.default = next;
  }
});

// node_modules/.pnpm/ajv@8.20.0/node_modules/ajv/dist/vocabularies/unevaluated/unevaluatedProperties.js
var require_unevaluatedProperties = __commonJS({
  "node_modules/.pnpm/ajv@8.20.0/node_modules/ajv/dist/vocabularies/unevaluated/unevaluatedProperties.js"(exports) {
    "use strict";
    Object.defineProperty(exports, "__esModule", { value: true });
    var codegen_1 = require_codegen();
    var util_1 = require_util();
    var names_1 = require_names();
    var error = {
      message: "must NOT have unevaluated properties",
      params: ({ params }) => (0, codegen_1._)`{unevaluatedProperty: ${params.unevaluatedProperty}}`
    };
    var def = {
      keyword: "unevaluatedProperties",
      type: "object",
      schemaType: ["boolean", "object"],
      trackErrors: true,
      error,
      code(cxt) {
        const { gen, schema, data, errsCount, it } = cxt;
        if (!errsCount)
          throw new Error("ajv implementation error");
        const { allErrors, props } = it;
        if (props instanceof codegen_1.Name) {
          gen.if((0, codegen_1._)`${props} !== true`, () => gen.forIn("key", data, (key) => gen.if(unevaluatedDynamic(props, key), () => unevaluatedPropCode(key))));
        } else if (props !== true) {
          gen.forIn("key", data, (key) => props === void 0 ? unevaluatedPropCode(key) : gen.if(unevaluatedStatic(props, key), () => unevaluatedPropCode(key)));
        }
        it.props = true;
        cxt.ok((0, codegen_1._)`${errsCount} === ${names_1.default.errors}`);
        function unevaluatedPropCode(key) {
          if (schema === false) {
            cxt.setParams({ unevaluatedProperty: key });
            cxt.error();
            if (!allErrors)
              gen.break();
            return;
          }
          if (!(0, util_1.alwaysValidSchema)(it, schema)) {
            const valid = gen.name("valid");
            cxt.subschema({
              keyword: "unevaluatedProperties",
              dataProp: key,
              dataPropType: util_1.Type.Str
            }, valid);
            if (!allErrors)
              gen.if((0, codegen_1.not)(valid), () => gen.break());
          }
        }
        function unevaluatedDynamic(evaluatedProps, key) {
          return (0, codegen_1._)`!${evaluatedProps} || !${evaluatedProps}[${key}]`;
        }
        function unevaluatedStatic(evaluatedProps, key) {
          const ps = [];
          for (const p in evaluatedProps) {
            if (evaluatedProps[p] === true)
              ps.push((0, codegen_1._)`${key} !== ${p}`);
          }
          return (0, codegen_1.and)(...ps);
        }
      }
    };
    exports.default = def;
  }
});

// node_modules/.pnpm/ajv@8.20.0/node_modules/ajv/dist/vocabularies/unevaluated/unevaluatedItems.js
var require_unevaluatedItems = __commonJS({
  "node_modules/.pnpm/ajv@8.20.0/node_modules/ajv/dist/vocabularies/unevaluated/unevaluatedItems.js"(exports) {
    "use strict";
    Object.defineProperty(exports, "__esModule", { value: true });
    var codegen_1 = require_codegen();
    var util_1 = require_util();
    var error = {
      message: ({ params: { len } }) => (0, codegen_1.str)`must NOT have more than ${len} items`,
      params: ({ params: { len } }) => (0, codegen_1._)`{limit: ${len}}`
    };
    var def = {
      keyword: "unevaluatedItems",
      type: "array",
      schemaType: ["boolean", "object"],
      error,
      code(cxt) {
        const { gen, schema, data, it } = cxt;
        const items = it.items || 0;
        if (items === true)
          return;
        const len = gen.const("len", (0, codegen_1._)`${data}.length`);
        if (schema === false) {
          cxt.setParams({ len: items });
          cxt.fail((0, codegen_1._)`${len} > ${items}`);
        } else if (typeof schema == "object" && !(0, util_1.alwaysValidSchema)(it, schema)) {
          const valid = gen.var("valid", (0, codegen_1._)`${len} <= ${items}`);
          gen.if((0, codegen_1.not)(valid), () => validateItems(valid, items));
          cxt.ok(valid);
        }
        it.items = true;
        function validateItems(valid, from) {
          gen.forRange("i", from, len, (i) => {
            cxt.subschema({ keyword: "unevaluatedItems", dataProp: i, dataPropType: util_1.Type.Num }, valid);
            if (!it.allErrors)
              gen.if((0, codegen_1.not)(valid), () => gen.break());
          });
        }
      }
    };
    exports.default = def;
  }
});

// node_modules/.pnpm/ajv@8.20.0/node_modules/ajv/dist/vocabularies/unevaluated/index.js
var require_unevaluated = __commonJS({
  "node_modules/.pnpm/ajv@8.20.0/node_modules/ajv/dist/vocabularies/unevaluated/index.js"(exports) {
    "use strict";
    Object.defineProperty(exports, "__esModule", { value: true });
    var unevaluatedProperties_1 = require_unevaluatedProperties();
    var unevaluatedItems_1 = require_unevaluatedItems();
    var unevaluated = [unevaluatedProperties_1.default, unevaluatedItems_1.default];
    exports.default = unevaluated;
  }
});

// node_modules/.pnpm/ajv@8.20.0/node_modules/ajv/dist/vocabularies/format/format.js
var require_format = __commonJS({
  "node_modules/.pnpm/ajv@8.20.0/node_modules/ajv/dist/vocabularies/format/format.js"(exports) {
    "use strict";
    Object.defineProperty(exports, "__esModule", { value: true });
    var codegen_1 = require_codegen();
    var error = {
      message: ({ schemaCode }) => (0, codegen_1.str)`must match format "${schemaCode}"`,
      params: ({ schemaCode }) => (0, codegen_1._)`{format: ${schemaCode}}`
    };
    var def = {
      keyword: "format",
      type: ["number", "string"],
      schemaType: "string",
      $data: true,
      error,
      code(cxt, ruleType) {
        const { gen, data, $data, schema, schemaCode, it } = cxt;
        const { opts, errSchemaPath, schemaEnv, self } = it;
        if (!opts.validateFormats)
          return;
        if ($data)
          validate$DataFormat();
        else
          validateFormat();
        function validate$DataFormat() {
          const fmts = gen.scopeValue("formats", {
            ref: self.formats,
            code: opts.code.formats
          });
          const fDef = gen.const("fDef", (0, codegen_1._)`${fmts}[${schemaCode}]`);
          const fType = gen.let("fType");
          const format = gen.let("format");
          gen.if((0, codegen_1._)`typeof ${fDef} == "object" && !(${fDef} instanceof RegExp)`, () => gen.assign(fType, (0, codegen_1._)`${fDef}.type || "string"`).assign(format, (0, codegen_1._)`${fDef}.validate`), () => gen.assign(fType, (0, codegen_1._)`"string"`).assign(format, fDef));
          cxt.fail$data((0, codegen_1.or)(unknownFmt(), invalidFmt()));
          function unknownFmt() {
            if (opts.strictSchema === false)
              return codegen_1.nil;
            return (0, codegen_1._)`${schemaCode} && !${format}`;
          }
          function invalidFmt() {
            const callFormat = schemaEnv.$async ? (0, codegen_1._)`(${fDef}.async ? await ${format}(${data}) : ${format}(${data}))` : (0, codegen_1._)`${format}(${data})`;
            const validData = (0, codegen_1._)`(typeof ${format} == "function" ? ${callFormat} : ${format}.test(${data}))`;
            return (0, codegen_1._)`${format} && ${format} !== true && ${fType} === ${ruleType} && !${validData}`;
          }
        }
        function validateFormat() {
          const formatDef = self.formats[schema];
          if (!formatDef) {
            unknownFormat();
            return;
          }
          if (formatDef === true)
            return;
          const [fmtType, format, fmtRef] = getFormat(formatDef);
          if (fmtType === ruleType)
            cxt.pass(validCondition());
          function unknownFormat() {
            if (opts.strictSchema === false) {
              self.logger.warn(unknownMsg());
              return;
            }
            throw new Error(unknownMsg());
            function unknownMsg() {
              return `unknown format "${schema}" ignored in schema at path "${errSchemaPath}"`;
            }
          }
          function getFormat(fmtDef) {
            const code = fmtDef instanceof RegExp ? (0, codegen_1.regexpCode)(fmtDef) : opts.code.formats ? (0, codegen_1._)`${opts.code.formats}${(0, codegen_1.getProperty)(schema)}` : void 0;
            const fmt = gen.scopeValue("formats", { key: schema, ref: fmtDef, code });
            if (typeof fmtDef == "object" && !(fmtDef instanceof RegExp)) {
              return [fmtDef.type || "string", fmtDef.validate, (0, codegen_1._)`${fmt}.validate`];
            }
            return ["string", fmtDef, fmt];
          }
          function validCondition() {
            if (typeof formatDef == "object" && !(formatDef instanceof RegExp) && formatDef.async) {
              if (!schemaEnv.$async)
                throw new Error("async format in sync schema");
              return (0, codegen_1._)`await ${fmtRef}(${data})`;
            }
            return typeof format == "function" ? (0, codegen_1._)`${fmtRef}(${data})` : (0, codegen_1._)`${fmtRef}.test(${data})`;
          }
        }
      }
    };
    exports.default = def;
  }
});

// node_modules/.pnpm/ajv@8.20.0/node_modules/ajv/dist/vocabularies/format/index.js
var require_format2 = __commonJS({
  "node_modules/.pnpm/ajv@8.20.0/node_modules/ajv/dist/vocabularies/format/index.js"(exports) {
    "use strict";
    Object.defineProperty(exports, "__esModule", { value: true });
    var format_1 = require_format();
    var format = [format_1.default];
    exports.default = format;
  }
});

// node_modules/.pnpm/ajv@8.20.0/node_modules/ajv/dist/vocabularies/metadata.js
var require_metadata = __commonJS({
  "node_modules/.pnpm/ajv@8.20.0/node_modules/ajv/dist/vocabularies/metadata.js"(exports) {
    "use strict";
    Object.defineProperty(exports, "__esModule", { value: true });
    exports.contentVocabulary = exports.metadataVocabulary = void 0;
    exports.metadataVocabulary = [
      "title",
      "description",
      "default",
      "deprecated",
      "readOnly",
      "writeOnly",
      "examples"
    ];
    exports.contentVocabulary = [
      "contentMediaType",
      "contentEncoding",
      "contentSchema"
    ];
  }
});

// node_modules/.pnpm/ajv@8.20.0/node_modules/ajv/dist/vocabularies/draft2020.js
var require_draft2020 = __commonJS({
  "node_modules/.pnpm/ajv@8.20.0/node_modules/ajv/dist/vocabularies/draft2020.js"(exports) {
    "use strict";
    Object.defineProperty(exports, "__esModule", { value: true });
    var core_1 = require_core2();
    var validation_1 = require_validation();
    var applicator_1 = require_applicator();
    var dynamic_1 = require_dynamic();
    var next_1 = require_next();
    var unevaluated_1 = require_unevaluated();
    var format_1 = require_format2();
    var metadata_1 = require_metadata();
    var draft2020Vocabularies = [
      dynamic_1.default,
      core_1.default,
      validation_1.default,
      (0, applicator_1.default)(true),
      format_1.default,
      metadata_1.metadataVocabulary,
      metadata_1.contentVocabulary,
      next_1.default,
      unevaluated_1.default
    ];
    exports.default = draft2020Vocabularies;
  }
});

// node_modules/.pnpm/ajv@8.20.0/node_modules/ajv/dist/vocabularies/discriminator/types.js
var require_types = __commonJS({
  "node_modules/.pnpm/ajv@8.20.0/node_modules/ajv/dist/vocabularies/discriminator/types.js"(exports) {
    "use strict";
    Object.defineProperty(exports, "__esModule", { value: true });
    exports.DiscrError = void 0;
    var DiscrError;
    (function(DiscrError2) {
      DiscrError2["Tag"] = "tag";
      DiscrError2["Mapping"] = "mapping";
    })(DiscrError || (exports.DiscrError = DiscrError = {}));
  }
});

// node_modules/.pnpm/ajv@8.20.0/node_modules/ajv/dist/vocabularies/discriminator/index.js
var require_discriminator = __commonJS({
  "node_modules/.pnpm/ajv@8.20.0/node_modules/ajv/dist/vocabularies/discriminator/index.js"(exports) {
    "use strict";
    Object.defineProperty(exports, "__esModule", { value: true });
    var codegen_1 = require_codegen();
    var types_1 = require_types();
    var compile_1 = require_compile();
    var ref_error_1 = require_ref_error();
    var util_1 = require_util();
    var error = {
      message: ({ params: { discrError, tagName } }) => discrError === types_1.DiscrError.Tag ? `tag "${tagName}" must be string` : `value of tag "${tagName}" must be in oneOf`,
      params: ({ params: { discrError, tag, tagName } }) => (0, codegen_1._)`{error: ${discrError}, tag: ${tagName}, tagValue: ${tag}}`
    };
    var def = {
      keyword: "discriminator",
      type: "object",
      schemaType: "object",
      error,
      code(cxt) {
        const { gen, data, schema, parentSchema, it } = cxt;
        const { oneOf } = parentSchema;
        if (!it.opts.discriminator) {
          throw new Error("discriminator: requires discriminator option");
        }
        const tagName = schema.propertyName;
        if (typeof tagName != "string")
          throw new Error("discriminator: requires propertyName");
        if (schema.mapping)
          throw new Error("discriminator: mapping is not supported");
        if (!oneOf)
          throw new Error("discriminator: requires oneOf keyword");
        const valid = gen.let("valid", false);
        const tag = gen.const("tag", (0, codegen_1._)`${data}${(0, codegen_1.getProperty)(tagName)}`);
        gen.if((0, codegen_1._)`typeof ${tag} == "string"`, () => validateMapping(), () => cxt.error(false, { discrError: types_1.DiscrError.Tag, tag, tagName }));
        cxt.ok(valid);
        function validateMapping() {
          const mapping = getMapping();
          gen.if(false);
          for (const tagValue in mapping) {
            gen.elseIf((0, codegen_1._)`${tag} === ${tagValue}`);
            gen.assign(valid, applyTagSchema(mapping[tagValue]));
          }
          gen.else();
          cxt.error(false, { discrError: types_1.DiscrError.Mapping, tag, tagName });
          gen.endIf();
        }
        function applyTagSchema(schemaProp) {
          const _valid = gen.name("valid");
          const schCxt = cxt.subschema({ keyword: "oneOf", schemaProp }, _valid);
          cxt.mergeEvaluated(schCxt, codegen_1.Name);
          return _valid;
        }
        function getMapping() {
          var _a;
          const oneOfMapping = {};
          const topRequired = hasRequired(parentSchema);
          let tagRequired = true;
          for (let i = 0; i < oneOf.length; i++) {
            let sch = oneOf[i];
            if ((sch === null || sch === void 0 ? void 0 : sch.$ref) && !(0, util_1.schemaHasRulesButRef)(sch, it.self.RULES)) {
              const ref = sch.$ref;
              sch = compile_1.resolveRef.call(it.self, it.schemaEnv.root, it.baseId, ref);
              if (sch instanceof compile_1.SchemaEnv)
                sch = sch.schema;
              if (sch === void 0)
                throw new ref_error_1.default(it.opts.uriResolver, it.baseId, ref);
            }
            const propSch = (_a = sch === null || sch === void 0 ? void 0 : sch.properties) === null || _a === void 0 ? void 0 : _a[tagName];
            if (typeof propSch != "object") {
              throw new Error(`discriminator: oneOf subschemas (or referenced schemas) must have "properties/${tagName}"`);
            }
            tagRequired = tagRequired && (topRequired || hasRequired(sch));
            addMappings(propSch, i);
          }
          if (!tagRequired)
            throw new Error(`discriminator: "${tagName}" must be required`);
          return oneOfMapping;
          function hasRequired({ required }) {
            return Array.isArray(required) && required.includes(tagName);
          }
          function addMappings(sch, i) {
            if (sch.const) {
              addMapping(sch.const, i);
            } else if (sch.enum) {
              for (const tagValue of sch.enum) {
                addMapping(tagValue, i);
              }
            } else {
              throw new Error(`discriminator: "properties/${tagName}" must have "const" or "enum"`);
            }
          }
          function addMapping(tagValue, i) {
            if (typeof tagValue != "string" || tagValue in oneOfMapping) {
              throw new Error(`discriminator: "${tagName}" values must be unique strings`);
            }
            oneOfMapping[tagValue] = i;
          }
        }
      }
    };
    exports.default = def;
  }
});

// node_modules/.pnpm/ajv@8.20.0/node_modules/ajv/dist/refs/json-schema-2020-12/schema.json
var require_schema = __commonJS({
  "node_modules/.pnpm/ajv@8.20.0/node_modules/ajv/dist/refs/json-schema-2020-12/schema.json"(exports, module) {
    module.exports = {
      $schema: "https://json-schema.org/draft/2020-12/schema",
      $id: "https://json-schema.org/draft/2020-12/schema",
      $vocabulary: {
        "https://json-schema.org/draft/2020-12/vocab/core": true,
        "https://json-schema.org/draft/2020-12/vocab/applicator": true,
        "https://json-schema.org/draft/2020-12/vocab/unevaluated": true,
        "https://json-schema.org/draft/2020-12/vocab/validation": true,
        "https://json-schema.org/draft/2020-12/vocab/meta-data": true,
        "https://json-schema.org/draft/2020-12/vocab/format-annotation": true,
        "https://json-schema.org/draft/2020-12/vocab/content": true
      },
      $dynamicAnchor: "meta",
      title: "Core and Validation specifications meta-schema",
      allOf: [
        { $ref: "meta/core" },
        { $ref: "meta/applicator" },
        { $ref: "meta/unevaluated" },
        { $ref: "meta/validation" },
        { $ref: "meta/meta-data" },
        { $ref: "meta/format-annotation" },
        { $ref: "meta/content" }
      ],
      type: ["object", "boolean"],
      $comment: "This meta-schema also defines keywords that have appeared in previous drafts in order to prevent incompatible extensions as they remain in common use.",
      properties: {
        definitions: {
          $comment: '"definitions" has been replaced by "$defs".',
          type: "object",
          additionalProperties: { $dynamicRef: "#meta" },
          deprecated: true,
          default: {}
        },
        dependencies: {
          $comment: '"dependencies" has been split and replaced by "dependentSchemas" and "dependentRequired" in order to serve their differing semantics.',
          type: "object",
          additionalProperties: {
            anyOf: [{ $dynamicRef: "#meta" }, { $ref: "meta/validation#/$defs/stringArray" }]
          },
          deprecated: true,
          default: {}
        },
        $recursiveAnchor: {
          $comment: '"$recursiveAnchor" has been replaced by "$dynamicAnchor".',
          $ref: "meta/core#/$defs/anchorString",
          deprecated: true
        },
        $recursiveRef: {
          $comment: '"$recursiveRef" has been replaced by "$dynamicRef".',
          $ref: "meta/core#/$defs/uriReferenceString",
          deprecated: true
        }
      }
    };
  }
});

// node_modules/.pnpm/ajv@8.20.0/node_modules/ajv/dist/refs/json-schema-2020-12/meta/applicator.json
var require_applicator2 = __commonJS({
  "node_modules/.pnpm/ajv@8.20.0/node_modules/ajv/dist/refs/json-schema-2020-12/meta/applicator.json"(exports, module) {
    module.exports = {
      $schema: "https://json-schema.org/draft/2020-12/schema",
      $id: "https://json-schema.org/draft/2020-12/meta/applicator",
      $vocabulary: {
        "https://json-schema.org/draft/2020-12/vocab/applicator": true
      },
      $dynamicAnchor: "meta",
      title: "Applicator vocabulary meta-schema",
      type: ["object", "boolean"],
      properties: {
        prefixItems: { $ref: "#/$defs/schemaArray" },
        items: { $dynamicRef: "#meta" },
        contains: { $dynamicRef: "#meta" },
        additionalProperties: { $dynamicRef: "#meta" },
        properties: {
          type: "object",
          additionalProperties: { $dynamicRef: "#meta" },
          default: {}
        },
        patternProperties: {
          type: "object",
          additionalProperties: { $dynamicRef: "#meta" },
          propertyNames: { format: "regex" },
          default: {}
        },
        dependentSchemas: {
          type: "object",
          additionalProperties: { $dynamicRef: "#meta" },
          default: {}
        },
        propertyNames: { $dynamicRef: "#meta" },
        if: { $dynamicRef: "#meta" },
        then: { $dynamicRef: "#meta" },
        else: { $dynamicRef: "#meta" },
        allOf: { $ref: "#/$defs/schemaArray" },
        anyOf: { $ref: "#/$defs/schemaArray" },
        oneOf: { $ref: "#/$defs/schemaArray" },
        not: { $dynamicRef: "#meta" }
      },
      $defs: {
        schemaArray: {
          type: "array",
          minItems: 1,
          items: { $dynamicRef: "#meta" }
        }
      }
    };
  }
});

// node_modules/.pnpm/ajv@8.20.0/node_modules/ajv/dist/refs/json-schema-2020-12/meta/unevaluated.json
var require_unevaluated2 = __commonJS({
  "node_modules/.pnpm/ajv@8.20.0/node_modules/ajv/dist/refs/json-schema-2020-12/meta/unevaluated.json"(exports, module) {
    module.exports = {
      $schema: "https://json-schema.org/draft/2020-12/schema",
      $id: "https://json-schema.org/draft/2020-12/meta/unevaluated",
      $vocabulary: {
        "https://json-schema.org/draft/2020-12/vocab/unevaluated": true
      },
      $dynamicAnchor: "meta",
      title: "Unevaluated applicator vocabulary meta-schema",
      type: ["object", "boolean"],
      properties: {
        unevaluatedItems: { $dynamicRef: "#meta" },
        unevaluatedProperties: { $dynamicRef: "#meta" }
      }
    };
  }
});

// node_modules/.pnpm/ajv@8.20.0/node_modules/ajv/dist/refs/json-schema-2020-12/meta/content.json
var require_content = __commonJS({
  "node_modules/.pnpm/ajv@8.20.0/node_modules/ajv/dist/refs/json-schema-2020-12/meta/content.json"(exports, module) {
    module.exports = {
      $schema: "https://json-schema.org/draft/2020-12/schema",
      $id: "https://json-schema.org/draft/2020-12/meta/content",
      $vocabulary: {
        "https://json-schema.org/draft/2020-12/vocab/content": true
      },
      $dynamicAnchor: "meta",
      title: "Content vocabulary meta-schema",
      type: ["object", "boolean"],
      properties: {
        contentEncoding: { type: "string" },
        contentMediaType: { type: "string" },
        contentSchema: { $dynamicRef: "#meta" }
      }
    };
  }
});

// node_modules/.pnpm/ajv@8.20.0/node_modules/ajv/dist/refs/json-schema-2020-12/meta/core.json
var require_core3 = __commonJS({
  "node_modules/.pnpm/ajv@8.20.0/node_modules/ajv/dist/refs/json-schema-2020-12/meta/core.json"(exports, module) {
    module.exports = {
      $schema: "https://json-schema.org/draft/2020-12/schema",
      $id: "https://json-schema.org/draft/2020-12/meta/core",
      $vocabulary: {
        "https://json-schema.org/draft/2020-12/vocab/core": true
      },
      $dynamicAnchor: "meta",
      title: "Core vocabulary meta-schema",
      type: ["object", "boolean"],
      properties: {
        $id: {
          $ref: "#/$defs/uriReferenceString",
          $comment: "Non-empty fragments not allowed.",
          pattern: "^[^#]*#?$"
        },
        $schema: { $ref: "#/$defs/uriString" },
        $ref: { $ref: "#/$defs/uriReferenceString" },
        $anchor: { $ref: "#/$defs/anchorString" },
        $dynamicRef: { $ref: "#/$defs/uriReferenceString" },
        $dynamicAnchor: { $ref: "#/$defs/anchorString" },
        $vocabulary: {
          type: "object",
          propertyNames: { $ref: "#/$defs/uriString" },
          additionalProperties: {
            type: "boolean"
          }
        },
        $comment: {
          type: "string"
        },
        $defs: {
          type: "object",
          additionalProperties: { $dynamicRef: "#meta" }
        }
      },
      $defs: {
        anchorString: {
          type: "string",
          pattern: "^[A-Za-z_][-A-Za-z0-9._]*$"
        },
        uriString: {
          type: "string",
          format: "uri"
        },
        uriReferenceString: {
          type: "string",
          format: "uri-reference"
        }
      }
    };
  }
});

// node_modules/.pnpm/ajv@8.20.0/node_modules/ajv/dist/refs/json-schema-2020-12/meta/format-annotation.json
var require_format_annotation = __commonJS({
  "node_modules/.pnpm/ajv@8.20.0/node_modules/ajv/dist/refs/json-schema-2020-12/meta/format-annotation.json"(exports, module) {
    module.exports = {
      $schema: "https://json-schema.org/draft/2020-12/schema",
      $id: "https://json-schema.org/draft/2020-12/meta/format-annotation",
      $vocabulary: {
        "https://json-schema.org/draft/2020-12/vocab/format-annotation": true
      },
      $dynamicAnchor: "meta",
      title: "Format vocabulary meta-schema for annotation results",
      type: ["object", "boolean"],
      properties: {
        format: { type: "string" }
      }
    };
  }
});

// node_modules/.pnpm/ajv@8.20.0/node_modules/ajv/dist/refs/json-schema-2020-12/meta/meta-data.json
var require_meta_data = __commonJS({
  "node_modules/.pnpm/ajv@8.20.0/node_modules/ajv/dist/refs/json-schema-2020-12/meta/meta-data.json"(exports, module) {
    module.exports = {
      $schema: "https://json-schema.org/draft/2020-12/schema",
      $id: "https://json-schema.org/draft/2020-12/meta/meta-data",
      $vocabulary: {
        "https://json-schema.org/draft/2020-12/vocab/meta-data": true
      },
      $dynamicAnchor: "meta",
      title: "Meta-data vocabulary meta-schema",
      type: ["object", "boolean"],
      properties: {
        title: {
          type: "string"
        },
        description: {
          type: "string"
        },
        default: true,
        deprecated: {
          type: "boolean",
          default: false
        },
        readOnly: {
          type: "boolean",
          default: false
        },
        writeOnly: {
          type: "boolean",
          default: false
        },
        examples: {
          type: "array",
          items: true
        }
      }
    };
  }
});

// node_modules/.pnpm/ajv@8.20.0/node_modules/ajv/dist/refs/json-schema-2020-12/meta/validation.json
var require_validation2 = __commonJS({
  "node_modules/.pnpm/ajv@8.20.0/node_modules/ajv/dist/refs/json-schema-2020-12/meta/validation.json"(exports, module) {
    module.exports = {
      $schema: "https://json-schema.org/draft/2020-12/schema",
      $id: "https://json-schema.org/draft/2020-12/meta/validation",
      $vocabulary: {
        "https://json-schema.org/draft/2020-12/vocab/validation": true
      },
      $dynamicAnchor: "meta",
      title: "Validation vocabulary meta-schema",
      type: ["object", "boolean"],
      properties: {
        type: {
          anyOf: [
            { $ref: "#/$defs/simpleTypes" },
            {
              type: "array",
              items: { $ref: "#/$defs/simpleTypes" },
              minItems: 1,
              uniqueItems: true
            }
          ]
        },
        const: true,
        enum: {
          type: "array",
          items: true
        },
        multipleOf: {
          type: "number",
          exclusiveMinimum: 0
        },
        maximum: {
          type: "number"
        },
        exclusiveMaximum: {
          type: "number"
        },
        minimum: {
          type: "number"
        },
        exclusiveMinimum: {
          type: "number"
        },
        maxLength: { $ref: "#/$defs/nonNegativeInteger" },
        minLength: { $ref: "#/$defs/nonNegativeIntegerDefault0" },
        pattern: {
          type: "string",
          format: "regex"
        },
        maxItems: { $ref: "#/$defs/nonNegativeInteger" },
        minItems: { $ref: "#/$defs/nonNegativeIntegerDefault0" },
        uniqueItems: {
          type: "boolean",
          default: false
        },
        maxContains: { $ref: "#/$defs/nonNegativeInteger" },
        minContains: {
          $ref: "#/$defs/nonNegativeInteger",
          default: 1
        },
        maxProperties: { $ref: "#/$defs/nonNegativeInteger" },
        minProperties: { $ref: "#/$defs/nonNegativeIntegerDefault0" },
        required: { $ref: "#/$defs/stringArray" },
        dependentRequired: {
          type: "object",
          additionalProperties: {
            $ref: "#/$defs/stringArray"
          }
        }
      },
      $defs: {
        nonNegativeInteger: {
          type: "integer",
          minimum: 0
        },
        nonNegativeIntegerDefault0: {
          $ref: "#/$defs/nonNegativeInteger",
          default: 0
        },
        simpleTypes: {
          enum: ["array", "boolean", "integer", "null", "number", "object", "string"]
        },
        stringArray: {
          type: "array",
          items: { type: "string" },
          uniqueItems: true,
          default: []
        }
      }
    };
  }
});

// node_modules/.pnpm/ajv@8.20.0/node_modules/ajv/dist/refs/json-schema-2020-12/index.js
var require_json_schema_2020_12 = __commonJS({
  "node_modules/.pnpm/ajv@8.20.0/node_modules/ajv/dist/refs/json-schema-2020-12/index.js"(exports) {
    "use strict";
    Object.defineProperty(exports, "__esModule", { value: true });
    var metaSchema = require_schema();
    var applicator = require_applicator2();
    var unevaluated = require_unevaluated2();
    var content = require_content();
    var core = require_core3();
    var format = require_format_annotation();
    var metadata = require_meta_data();
    var validation = require_validation2();
    var META_SUPPORT_DATA = ["/properties"];
    function addMetaSchema2020($data) {
      ;
      [
        metaSchema,
        applicator,
        unevaluated,
        content,
        core,
        with$data(this, format),
        metadata,
        with$data(this, validation)
      ].forEach((sch) => this.addMetaSchema(sch, void 0, false));
      return this;
      function with$data(ajv, sch) {
        return $data ? ajv.$dataMetaSchema(sch, META_SUPPORT_DATA) : sch;
      }
    }
    exports.default = addMetaSchema2020;
  }
});

// node_modules/.pnpm/ajv@8.20.0/node_modules/ajv/dist/2020.js
var require__ = __commonJS({
  "node_modules/.pnpm/ajv@8.20.0/node_modules/ajv/dist/2020.js"(exports, module) {
    "use strict";
    Object.defineProperty(exports, "__esModule", { value: true });
    exports.MissingRefError = exports.ValidationError = exports.CodeGen = exports.Name = exports.nil = exports.stringify = exports.str = exports._ = exports.KeywordCxt = exports.Ajv2020 = void 0;
    var core_1 = require_core();
    var draft2020_1 = require_draft2020();
    var discriminator_1 = require_discriminator();
    var json_schema_2020_12_1 = require_json_schema_2020_12();
    var META_SCHEMA_ID = "https://json-schema.org/draft/2020-12/schema";
    var Ajv20202 = class extends core_1.default {
      constructor(opts = {}) {
        super({
          ...opts,
          dynamicRef: true,
          next: true,
          unevaluated: true
        });
      }
      _addVocabularies() {
        super._addVocabularies();
        draft2020_1.default.forEach((v) => this.addVocabulary(v));
        if (this.opts.discriminator)
          this.addKeyword(discriminator_1.default);
      }
      _addDefaultMetaSchema() {
        super._addDefaultMetaSchema();
        const { $data, meta } = this.opts;
        if (!meta)
          return;
        json_schema_2020_12_1.default.call(this, $data);
        this.refs["http://json-schema.org/schema"] = META_SCHEMA_ID;
      }
      defaultMeta() {
        return this.opts.defaultMeta = super.defaultMeta() || (this.getSchema(META_SCHEMA_ID) ? META_SCHEMA_ID : void 0);
      }
    };
    exports.Ajv2020 = Ajv20202;
    module.exports = exports = Ajv20202;
    module.exports.Ajv2020 = Ajv20202;
    Object.defineProperty(exports, "__esModule", { value: true });
    exports.default = Ajv20202;
    var validate_1 = require_validate();
    Object.defineProperty(exports, "KeywordCxt", { enumerable: true, get: function() {
      return validate_1.KeywordCxt;
    } });
    var codegen_1 = require_codegen();
    Object.defineProperty(exports, "_", { enumerable: true, get: function() {
      return codegen_1._;
    } });
    Object.defineProperty(exports, "str", { enumerable: true, get: function() {
      return codegen_1.str;
    } });
    Object.defineProperty(exports, "stringify", { enumerable: true, get: function() {
      return codegen_1.stringify;
    } });
    Object.defineProperty(exports, "nil", { enumerable: true, get: function() {
      return codegen_1.nil;
    } });
    Object.defineProperty(exports, "Name", { enumerable: true, get: function() {
      return codegen_1.Name;
    } });
    Object.defineProperty(exports, "CodeGen", { enumerable: true, get: function() {
      return codegen_1.CodeGen;
    } });
    var validation_error_1 = require_validation_error();
    Object.defineProperty(exports, "ValidationError", { enumerable: true, get: function() {
      return validation_error_1.default;
    } });
    var ref_error_1 = require_ref_error();
    Object.defineProperty(exports, "MissingRefError", { enumerable: true, get: function() {
      return ref_error_1.default;
    } });
  }
});

// scripts/distribution-homebrew-render-entry.mjs
import process5 from "node:process";
import path6 from "node:path";
import { pathToFileURL as pathToFileURL5 } from "node:url";

// scripts/distribution-homebrew.mjs
import { createHash as createHash5, createPublicKey as createPublicKey2, verify as verifySignature } from "node:crypto";
import { mkdir as mkdir4, readFile as readFile5, writeFile as writeFile4 } from "node:fs/promises";
import path5 from "node:path";
import process4 from "node:process";
import { fileURLToPath as fileURLToPath4, pathToFileURL as pathToFileURL4 } from "node:url";

// scripts/distribution-release.mjs
import {
  createHash as createHash4,
  createPrivateKey,
  createPublicKey,
  sign as signEd25519,
  verify as verifyEd25519
} from "node:crypto";
import { spawn as spawn2 } from "node:child_process";
import {
  chmod as chmod3,
  copyFile as copyFile2,
  cp,
  lstat as lstat4,
  mkdir as mkdir3,
  mkdtemp as mkdtemp2,
  open as open2,
  readFile as readFile4,
  readdir as readdir3,
  rm as rm3,
  stat as stat3,
  writeFile as writeFile3
} from "node:fs/promises";
import { createReadStream as createReadStream4 } from "node:fs";
import path4 from "node:path";
import os2 from "node:os";
import process3 from "node:process";
import { fileURLToPath as fileURLToPath3, pathToFileURL as pathToFileURL3 } from "node:url";

// scripts/distribution-build.mjs
import { createHash as createHash3 } from "node:crypto";
import { createReadStream as createReadStream3, createWriteStream } from "node:fs";
import {
  chmod as chmod2,
  copyFile,
  lstat as lstat3,
  mkdir as mkdir2,
  mkdtemp,
  open,
  readFile as readFile3,
  readdir as readdir2,
  readlink as readlink3,
  realpath as realpath3,
  rename,
  rm as rm2,
  stat as stat2,
  symlink as symlink2,
  writeFile as writeFile2
} from "node:fs/promises";
import os from "node:os";
import path3 from "node:path";
import process2 from "node:process";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { Readable } from "node:stream";
import { finished, pipeline } from "node:stream/promises";
import { createDeflateRaw, createGzip } from "node:zlib";
import { fileURLToPath as fileURLToPath2, pathToFileURL as pathToFileURL2 } from "node:url";

// scripts/distribution-manifest.mjs
var import__ = __toESM(require__(), 1);
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { lstat, readFile, readdir, readlink, realpath, stat } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { fileURLToPath, pathToFileURL } from "node:url";
var SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
var REPO_ROOT = path.resolve(SCRIPT_DIR, "..");
var CLASSIFICATIONS = /* @__PURE__ */ new Set([
  "core-runtime",
  "optional-capability",
  "provider-pack",
  "developer-only"
]);
var REDISTRIBUTION_MODES = /* @__PURE__ */ new Set(["bundle", "official-download", "exclude"]);
var MANIFEST_CLASSIFICATIONS = /* @__PURE__ */ new Set([
  "core-runtime",
  "optional-capability",
  "provider-pack"
]);
var RELEASE_CHANNELS = /* @__PURE__ */ new Set(["local", "prerelease", "stable"]);
var SHA256_PATTERN = /^[a-f0-9]{64}$/;
var ID_PATTERN = /^[a-z0-9][a-z0-9-]{1,63}$/;
var VERSION_PATTERN = /^[0-9]+\.[0-9]+\.[0-9]+(?:[-+][0-9A-Za-z.-]+)?$/;
var PLATFORM_ID_PATTERN = /^[a-z0-9]+-[a-z0-9_]+$/;
var OS_VERSION_PATTERN = /^[0-9]+(?:\.[0-9]+){1,2}$/;
var SAFE_FILE_MODES = /* @__PURE__ */ new Set(["0644", "0755"]);
var EXPECTED_LOCK_INPUTS = /* @__PURE__ */ new Map([
  ["better-sqlite3-node22-prebuild", "better-sqlite3-native"],
  ["node-runtime-archive", "node-runtime"],
  ["python-runtime-archive", "python-runtime"],
  ["temporal-runtime-archive", "temporal-runtime"],
  ["chromium-core-headless-archive", "chromium-core"],
  ["playwright-mcp-archive", "playwright-mcp"]
]);
var EXPECTED_CAPABILITY_POLICY = /* @__PURE__ */ new Map([
  ["core-browser", { defaultEnabled: true, componentIds: ["chromium-core", "playwright-python"] }],
  ["auto-apply-browser", { defaultEnabled: false, componentIds: ["jobctrl-worker", "playwright-mcp"] }],
  ["authenticated-linkedin-browser", { defaultEnabled: false, componentIds: ["jobctrl-worker"] }]
]);
var EXPECTED_PYTHON_LICENSE_EVIDENCE = /* @__PURE__ */ new Map([
  ["opentelemetry-util-http@0.62b1", { license: "Apache-2.0" }],
  ["publicsuffix2@2.20191221", { license: "MIT AND MPL-2.0" }]
]);
var EXPECTED_NODE_LICENSE_EVIDENCE = /* @__PURE__ */ new Map([
  ["@napi-rs/canvas-darwin-arm64@0.1.100", { license: "MIT", evidenceKind: "license-text" }],
  ["@radix-ui/number@1.1.1", { license: "MIT", evidenceKind: "license-text" }],
  ["@radix-ui/react-use-escape-keydown@1.1.1", { license: "MIT", evidenceKind: "license-text" }],
  ["@radix-ui/react-use-previous@1.1.1", { license: "MIT", evidenceKind: "license-text" }],
  ["@radix-ui/react-use-rect@1.1.1", { license: "MIT", evidenceKind: "license-text" }],
  ["@radix-ui/react-use-size@1.1.1", { license: "MIT", evidenceKind: "license-text" }],
  ["@radix-ui/rect@1.1.1", { license: "MIT", evidenceKind: "license-text" }],
  ["@udecode/react-hotkeys@52.0.11", { license: "MIT", evidenceKind: "license-text" }],
  ["abstract-logging@2.0.1", { license: "MIT", evidenceKind: "package-metadata-plus-canonical-text" }],
  ["data-uri-to-buffer@4.0.1", { license: "MIT", evidenceKind: "package-metadata-plus-canonical-text" }],
  ["jotai-x@2.3.4", { license: "MIT", evidenceKind: "license-text" }],
  ["react-compiler-runtime@1.0.0", { license: "MIT", evidenceKind: "license-text" }],
  ["react-remove-scroll-bar@2.3.8", { license: "MIT", evidenceKind: "license-text" }],
  ["slate@0.124.1", { license: "MIT", evidenceKind: "license-text" }],
  ["slate-dom@0.124.1", { license: "MIT", evidenceKind: "license-text" }],
  ["slate-hyperscript@0.125.0", { license: "MIT", evidenceKind: "license-text" }],
  ["slate-react@0.124.2", { license: "MIT", evidenceKind: "license-text" }],
  ["zustand-x@6.2.1", { license: "MIT", evidenceKind: "license-text" }]
]);
function invariant(condition, message) {
  if (!condition) throw new Error(message);
}
function assertObject(value, label) {
  invariant(value !== null && typeof value === "object" && !Array.isArray(value), `${label} must be an object`);
  return value;
}
function assertString(value, label) {
  invariant(typeof value === "string" && value.trim().length > 0, `${label} must be a non-empty string`);
  return value;
}
function assertBoolean(value, label) {
  invariant(typeof value === "boolean", `${label} must be a boolean`);
  return value;
}
function assertInteger(value, label, minimum = 0) {
  invariant(Number.isInteger(value) && value >= minimum, `${label} must be an integer >= ${minimum}`);
  return value;
}
function assertUnique(values, label) {
  invariant(new Set(values).size === values.length, `${label} must be unique`);
}
function bytewiseCompare(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}
function assertExactKeys(value, allowedKeys, label) {
  const object = assertObject(value, label);
  const actual = Object.keys(object).sort(bytewiseCompare);
  const expected = [...allowedKeys].sort(bytewiseCompare);
  invariant(
    JSON.stringify(actual) === JSON.stringify(expected),
    `${label} fields must be exactly [${expected.join(", ")}]; received [${actual.join(", ")}]`
  );
  return object;
}
function assertAllowedKeys(value, allowedKeys, label) {
  const object = assertObject(value, label);
  const unexpected = Object.keys(object).filter((key) => !allowedKeys.includes(key)).sort(bytewiseCompare);
  invariant(unexpected.length === 0, `${label} contains unexpected fields: ${unexpected.join(", ")}`);
  return object;
}
function assertSafeRelativePath(value, label = "path") {
  assertString(value, label);
  invariant(!value.includes("\0"), `${label} must not contain NUL`);
  invariant(!/[\u0000-\u001f\u007f]/.test(value), `${label} must not contain control characters`);
  invariant(/^[\x20-\x7e]+$/.test(value), `${label} must contain printable ASCII only`);
  invariant(!value.includes("\\"), `${label} must use POSIX separators`);
  invariant(!path.posix.isAbsolute(value), `${label} must be relative`);
  const normalized = path.posix.normalize(value);
  invariant(normalized === value, `${label} must be normalized`);
  invariant(value !== "." && value !== ".." && !value.startsWith("../"), `${label} escapes the payload root`);
  return value;
}
function resolveSafeSymlinkTarget(targetValue, linkPathValue) {
  const target = assertString(targetValue, "symlink target");
  const linkPath = assertSafeRelativePath(linkPathValue, "symlink path");
  invariant(!target.includes("\\"), `${linkPath}: symlink target must use POSIX separators`);
  invariant(!/[\u0000-\u001f\u007f]/.test(target), `${linkPath}: symlink target must not contain control characters`);
  invariant(/^[\x20-\x7e]+$/.test(target), `${linkPath}: symlink target must contain printable ASCII only`);
  invariant(!path.posix.isAbsolute(target), `${linkPath}: symlink target must be relative`);
  invariant(path.posix.normalize(target) === target, `${linkPath}: symlink target must be normalized`);
  invariant(target !== "." && target.length > 0, `${linkPath}: symlink target is invalid`);
  const resolved = path.posix.normalize(path.posix.join(path.posix.dirname(linkPath), target));
  assertSafeRelativePath(resolved, `${linkPath}: resolved symlink target`);
  return resolved;
}
async function loadJson(filePath) {
  return JSON.parse(await readFile(filePath, "utf8"));
}
async function loadDistributionContracts(root = REPO_ROOT) {
  const distributionDir = path.join(root, "packaging", "distribution");
  const [schema, inventory, platforms, componentLocks, providerPackLocks, pythonLicenseEvidenceLocks, nodeLicenseEvidenceLocks, capabilityPolicy, sourceBaseline, signingPolicy] = await Promise.all([
    loadJson(path.join(distributionDir, "manifest.schema.json")),
    loadJson(path.join(distributionDir, "component-inventory.json")),
    loadJson(path.join(distributionDir, "platforms.json")),
    loadJson(path.join(distributionDir, "components.lock.json")),
    loadJson(path.join(distributionDir, "provider-packs.lock.json")),
    loadJson(path.join(distributionDir, "license-evidence.lock.json")),
    loadJson(path.join(distributionDir, "node-license-evidence.lock.json")),
    loadJson(path.join(distributionDir, "capability-policy.json")),
    loadJson(path.join(distributionDir, "source-baseline.json")),
    loadJson(path.join(distributionDir, "signing-policy.json"))
  ]);
  return {
    schema,
    inventory,
    platforms,
    componentLocks,
    providerPackLocks,
    pythonLicenseEvidenceLocks,
    nodeLicenseEvidenceLocks,
    capabilityPolicy,
    sourceBaseline,
    signingPolicy
  };
}
function assertImmutableRawGitHubUrl(value, label) {
  const url = assertString(value, label);
  invariant(
    /^https:\/\/raw\.githubusercontent\.com\/[^/]+\/[^/]+\/[a-f0-9]{40}\/[^?#]+$/.test(url),
    `${label} must be an immutable raw.githubusercontent.com URL pinned to a full commit SHA`
  );
  return url;
}
function uvLockContainsPackageVersion(contents, packageName, version) {
  return contents.split(/\n(?=\[\[package\]\])/).some((block) => block.match(/^name\s*=\s*"([^"]+)"/m)?.[1] === packageName && block.match(/^version\s*=\s*"([^"]+)"/m)?.[1] === version);
}
function pnpmLockContainsPackageVersion(contents, packageName, version) {
  const escape2 = (value) => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`^  ['"]?${escape2(packageName)}@${escape2(version)}(?:\\([^\\n]+\\))?['"]?:$`, "m").test(contents);
}
function validateLicenseEvidenceEnvelope(lockValue, expectedSubjects, label) {
  const lock = assertExactKeys(lockValue, ["schemaVersion", "inputs"], label);
  invariant(lock.schemaVersion === 1, `${label} schemaVersion must be 1`);
  invariant(Array.isArray(lock.inputs), `${label}.inputs must be an array`);
  const subjects = lock.inputs.map((input) => `${input?.package}@${input?.version}`);
  assertUnique(subjects, `${label} subjects`);
  invariant(
    JSON.stringify([...subjects].sort(bytewiseCompare)) === JSON.stringify([...expectedSubjects.keys()].sort(bytewiseCompare)),
    `${label} must contain the exact required subject set`
  );
  invariant(
    JSON.stringify(subjects) === JSON.stringify([...subjects].sort(bytewiseCompare)),
    `${label} subjects must be bytewise sorted`
  );
  return lock;
}
function validateLicenseEvidenceInput(inputValue, expected, label, allowedKeys) {
  const input = assertExactKeys(inputValue, allowedKeys, label);
  assertString(input.package, `${label}.package`);
  assertString(input.version, `${label}.version`);
  invariant(input.license === expected.license, `${label}.license must be the required valid SPDX expression ${expected.license}`);
  if (expected.evidenceKind !== void 0) {
    invariant(input.evidenceKind === expected.evidenceKind, `${label}.evidenceKind does not match the required evidence type`);
  }
  assertImmutableRawGitHubUrl(input.url, `${label}.url`);
  invariant(SHA256_PATTERN.test(input.sha256), `${label}.sha256 must be lowercase SHA-256`);
  assertInteger(input.sizeBytes, `${label}.sizeBytes`, 1);
  return input;
}
function validatePythonLicenseEvidenceLocks(lockValue, uvLockContents) {
  const lock = validateLicenseEvidenceEnvelope(lockValue, EXPECTED_PYTHON_LICENSE_EVIDENCE, "Python license-evidence lock");
  for (const inputValue of lock.inputs) {
    const subject = `${inputValue.package}@${inputValue.version}`;
    const input = validateLicenseEvidenceInput(
      inputValue,
      EXPECTED_PYTHON_LICENSE_EVIDENCE.get(subject),
      `Python license evidence ${subject}`,
      ["package", "version", "license", "url", "sha256", "sizeBytes"]
    );
    invariant(
      uvLockContainsPackageVersion(uvLockContents, input.package, input.version),
      `${subject}: Python license evidence subject is not exactly pinned in uv.lock`
    );
  }
  return lock;
}
function validateNodeLicenseEvidenceLocks(lockValue, pnpmLockContents) {
  const lock = validateLicenseEvidenceEnvelope(lockValue, EXPECTED_NODE_LICENSE_EVIDENCE, "Node license-evidence lock");
  for (const inputValue of lock.inputs) {
    const subject = `${inputValue.package}@${inputValue.version}`;
    const input = validateLicenseEvidenceInput(
      inputValue,
      EXPECTED_NODE_LICENSE_EVIDENCE.get(subject),
      `Node license evidence ${subject}`,
      ["package", "version", "license", "evidenceKind", "url", "sha256", "sizeBytes"]
    );
    invariant(
      pnpmLockContainsPackageVersion(pnpmLockContents, input.package, input.version),
      `${subject}: Node license evidence subject is not exactly pinned in the pnpm lock closure`
    );
  }
  return lock;
}
function validateProviderPackLocks(lockValue, inventoryById, versions, uvLockContents) {
  const locks = assertExactKeys(lockValue, ["schemaVersion", "platform", "python", "coreSelector", "packs"], "provider-pack lock");
  invariant(locks.schemaVersion === 1, "provider-pack lock schemaVersion must be 1");
  invariant(locks.platform === "darwin-arm64", "provider-pack lock must target darwin-arm64");
  invariant(locks.python === "cpython-3.12", "provider-pack lock must target CPython 3.12");
  assertString(locks.coreSelector, "provider-pack coreSelector");
  invariant(Array.isArray(locks.packs) && locks.packs.length === 3, "provider-pack lock must contain exactly three packs");
  const expectedPackages = /* @__PURE__ */ new Map([
    ["claude-agent-sdk", ["claude-agent-sdk"]],
    ["codex-provider-runtime", ["openai-codex", "openai-codex-cli-bin"]],
    ["antigravity-provider-runtime", ["google-antigravity"]]
  ]);
  const packIds = locks.packs.map((pack) => pack.id);
  assertUnique(packIds, "provider-pack lock ids");
  invariant(
    JSON.stringify([...packIds].sort(bytewiseCompare)) === JSON.stringify([...expectedPackages.keys()].sort(bytewiseCompare)),
    "provider-pack lock does not contain the exact provider inventory"
  );
  for (const packValue of locks.packs) {
    const pack = assertExactKeys(
      packValue,
      ["id", "version", "owner", "source", "license", "redistribution", "isolation", "exactPackages", "wheels"],
      "provider-pack entry"
    );
    const inventory = inventoryById.get(pack.id);
    invariant(inventory?.classification === "provider-pack", `${pack.id}: provider lock id is not a provider pack`);
    invariant(pack.owner === inventory.owner, `${pack.id}: provider lock owner does not match inventory`);
    invariant(pack.source === inventory.source, `${pack.id}: provider lock source does not match inventory`);
    invariant(pack.license === inventory.license, `${pack.id}: provider lock license does not match inventory`);
    invariant(inventory.redistribution === "official-download", `${pack.id}: provider lock must remain official-download`);
    invariant(pack.redistribution === "official-download", `${pack.id}: provider lock cannot authorize redistribution`);
    invariant(pack.isolation === "independent-site-packages", `${pack.id}: provider pack must be independently isolated`);
    invariant(pack.version === versions[pack.id], `${pack.id}: provider lock version does not match inventory`);
    invariant(Array.isArray(pack.wheels) && pack.wheels.length > 0, `${pack.id}: provider lock wheels must not be empty`);
    invariant(Array.isArray(pack.exactPackages) && pack.exactPackages.length > 0, `${pack.id}: exactPackages must not be empty`);
    assertUnique(pack.exactPackages, `${pack.id}.exactPackages`);
    const packageNames = pack.wheels.map((wheel) => wheel.package);
    assertUnique(packageNames, `${pack.id}.wheels.package`);
    const sortedPackageNames = [...packageNames].sort(bytewiseCompare);
    invariant(
      JSON.stringify(pack.exactPackages) === JSON.stringify([...pack.exactPackages].sort(bytewiseCompare)),
      `${pack.id}: exactPackages must be bytewise sorted`
    );
    invariant(
      JSON.stringify(sortedPackageNames) === JSON.stringify(pack.exactPackages),
      `${pack.id}: exactPackages must exactly match wheels`
    );
    invariant(
      expectedPackages.get(pack.id).every((name) => pack.exactPackages.includes(name)),
      `${pack.id}: provider wheel closure omits a required top-level package`
    );
    for (const wheelValue of pack.wheels) {
      const wheel = assertExactKeys(wheelValue, ["package", "version", "url", "sha256", "sizeBytes"], "provider wheel");
      assertString(wheel.package, `${pack.id}.wheel.package`);
      assertString(wheel.version, `${pack.id}.wheel.version`);
      invariant(wheel.url.startsWith("https://files.pythonhosted.org/"), `${pack.id}: provider wheel must use the official PyPI file host`);
      invariant(wheel.url.endsWith(".whl"), `${pack.id}: provider artifact must be a wheel`);
      invariant(SHA256_PATTERN.test(wheel.sha256), `${pack.id}: invalid provider wheel SHA-256`);
      assertInteger(wheel.sizeBytes, `${pack.id}.wheel.sizeBytes`, 1);
      invariant(/macosx_[^/]*arm64\.whl$|py3-none-any\.whl$/.test(wheel.url), `${pack.id}: provider wheel is not darwin-arm64 compatible`);
      const uvNeedle = `{ url = "${wheel.url}", hash = "sha256:${wheel.sha256}", size = ${wheel.sizeBytes},`;
      invariant(uvLockContents.includes(uvNeedle), `${pack.id}: provider wheel is not exactly pinned in uv.lock`);
    }
  }
  return locks;
}
function compileManifestSchema(schema) {
  assertObject(schema, "manifest schema");
  invariant(schema.$schema === "https://json-schema.org/draft/2020-12/schema", "manifest schema must use JSON Schema 2020-12");
  invariant(schema.type === "object" && schema.additionalProperties === false, "manifest schema must be a closed object");
  invariant(Array.isArray(schema.required), "manifest schema.required must be an array");
  for (const key of [
    "schemaVersion",
    "appVersion",
    "buildId",
    "releaseChannel",
    "sourceDateEpoch",
    "platform",
    "launcherCompatibility",
    "components",
    "capabilities",
    "files",
    "signing"
  ]) {
    invariant(schema.required.includes(key), `manifest schema is missing required field ${key}`);
  }
  const ajv = new import__.default({ allErrors: true, strict: true });
  return ajv.compile(schema);
}
function schemaErrors(validator) {
  return (validator.errors ?? []).map((error) => `${error.instancePath || "/"} ${error.message}`).join("; ");
}
function validateComponentInventory(inventory) {
  assertExactKeys(inventory, ["schemaVersion", "components"], "component inventory");
  invariant(inventory.schemaVersion === 1, "component inventory schemaVersion must be 1");
  invariant(Array.isArray(inventory.components) && inventory.components.length > 0, "component inventory must not be empty");
  const ids = inventory.components.map((component) => component.id);
  assertUnique(ids, "component inventory ids");
  for (const componentValue of inventory.components) {
    const component = assertAllowedKeys(
      componentValue,
      ["id", "classification", "owner", "version", "versionSource", "source", "license", "redistribution", "requiredInCore", "embeddedIn", "notes"],
      "component inventory entry"
    );
    const id = assertString(component.id, "component id");
    invariant(ID_PATTERN.test(id), `component id is invalid: ${id}`);
    invariant(CLASSIFICATIONS.has(component.classification), `${id}: unknown classification ${component.classification}`);
    assertString(component.owner, `${id}.owner`);
    assertString(component.source, `${id}.source`);
    invariant(component.source.startsWith("https://"), `${id}.source must use HTTPS`);
    assertString(component.license, `${id}.license`);
    invariant(REDISTRIBUTION_MODES.has(component.redistribution), `${id}: unknown redistribution mode ${component.redistribution}`);
    assertBoolean(component.requiredInCore, `${id}.requiredInCore`);
    const versionFields = [component.version, component.versionSource].filter(
      (value) => typeof value === "string" && value.length > 0
    );
    invariant(versionFields.length === 1, `${id}: define exactly one of version or versionSource`);
    if (component.notes !== void 0) assertString(component.notes, `${id}.notes`);
    if (component.requiredInCore) {
      invariant(component.classification === "core-runtime", `${id}: required core component must be core-runtime`);
      invariant(component.redistribution === "bundle", `${id}: required core component must be approved for bundling`);
    }
    if (component.classification === "developer-only") {
      invariant(component.redistribution === "exclude", `${id}: developer-only component must be excluded`);
      invariant(component.requiredInCore === false, `${id}: developer-only component cannot be required`);
    }
    if (component.redistribution === "official-download") {
      invariant(component.requiredInCore === false, `${id}: official-download component cannot be required in the core artifact`);
    }
  }
  const inventoryById = new Map(inventory.components.map((component) => [component.id, component]));
  for (const component of inventory.components) {
    if (component.embeddedIn === void 0) continue;
    const parentId = assertString(component.embeddedIn, `${component.id}.embeddedIn`);
    const parent = inventoryById.get(parentId);
    invariant(parent, `${component.id}: embeddedIn references unknown component ${parentId}`);
    invariant(parentId !== component.id, `${component.id}: component cannot embed itself`);
    invariant(component.redistribution === "bundle", `${component.id}: embedded component must be approved for bundling`);
    invariant(parent.redistribution === "bundle", `${component.id}: embeddedIn target must be approved for bundling`);
    invariant(parent.classification !== "developer-only", `${component.id}: embeddedIn target cannot be developer-only`);
    invariant(parent.embeddedIn === void 0, `${component.id}: embedded component chains are not supported`);
    invariant(component.requiredInCore === false, `${component.id}: embedded component cannot be a top-level required component`);
  }
  return inventoryById;
}
function validateCapabilityPolicy(policyValue, inventoryById) {
  const policy = assertExactKeys(policyValue, ["schemaVersion", "capabilities"], "capability policy");
  invariant(policy.schemaVersion === 1, "capability policy schemaVersion must be 1");
  invariant(Array.isArray(policy.capabilities), "capability policy capabilities must be an array");
  const ids = policy.capabilities.map((capability) => capability.id);
  assertUnique(ids, "capability policy ids");
  invariant(ids.length === EXPECTED_CAPABILITY_POLICY.size, "capability policy must contain the complete required capability set");
  const capabilitiesById = /* @__PURE__ */ new Map();
  for (const capabilityValue of policy.capabilities) {
    const capability = assertExactKeys(
      capabilityValue,
      ["id", "defaultEnabled", "componentIds"],
      "capability policy entry"
    );
    const id = assertString(capability.id, "capability policy id");
    invariant(ID_PATTERN.test(id), `invalid capability policy id ${id}`);
    const expected = EXPECTED_CAPABILITY_POLICY.get(id);
    invariant(expected, `capability policy contains unknown capability ${id}`);
    assertBoolean(capability.defaultEnabled, `${id}.defaultEnabled`);
    invariant(capability.defaultEnabled === expected.defaultEnabled, `${id}: unsafe defaultEnabled value`);
    invariant(Array.isArray(capability.componentIds) && capability.componentIds.length > 0, `${id}.componentIds must not be empty`);
    assertUnique(capability.componentIds, `${id}.componentIds`);
    const componentIds = [...capability.componentIds].sort(bytewiseCompare);
    const expectedIds = [...expected.componentIds].sort(bytewiseCompare);
    invariant(JSON.stringify(componentIds) === JSON.stringify(expectedIds), `${id}: component closure does not match the required policy`);
    for (const componentId of componentIds) {
      const component = inventoryById.get(componentId);
      invariant(component, `${id}: unknown component ${componentId}`);
      invariant(component.redistribution === "bundle", `${id}: ${componentId} is not approved for bundling`);
      invariant(component.embeddedIn === void 0, `${id}: embedded component ${componentId} cannot be a capability root`);
    }
    capabilitiesById.set(id, { ...capability, componentIds });
  }
  return capabilitiesById;
}
function validatePlatforms(platformsValue, inventoryById) {
  const platforms = assertExactKeys(platformsValue, ["schemaVersion", "platforms"], "platform contract");
  invariant(platforms.schemaVersion === 1, "platform contract schemaVersion must be 1");
  invariant(Array.isArray(platforms.platforms) && platforms.platforms.length > 0, "platform list must not be empty");
  const ids = platforms.platforms.map((platform) => platform.id);
  assertUnique(ids, "platform ids");
  for (const platformValue of platforms.platforms) {
    const platform = assertExactKeys(
      platformValue,
      ["id", "os", "arch", "minimumOsVersion", "status", "launcherCompatibility", "signing", "minimumOsEvidence", "requiredComponents"],
      "platform"
    );
    invariant(PLATFORM_ID_PATTERN.test(assertString(platform.id, "platform.id")), `invalid platform id ${platform.id}`);
    invariant(["darwin", "linux", "windows"].includes(platform.os), `${platform.id}: unsupported os ${platform.os}`);
    invariant(["arm64", "amd64"].includes(platform.arch), `${platform.id}: unsupported arch ${platform.arch}`);
    invariant(OS_VERSION_PATTERN.test(platform.minimumOsVersion), `${platform.id}: invalid minimumOsVersion`);
    assertString(platform.status, `${platform.id}.status`);
    const compatibility = assertExactKeys(
      platform.launcherCompatibility,
      ["minimum", "maximum"],
      `${platform.id}.launcherCompatibility`
    );
    assertInteger(compatibility.minimum, `${platform.id}.launcherCompatibility.minimum`, 1);
    assertInteger(compatibility.maximum, `${platform.id}.launcherCompatibility.maximum`, 1);
    invariant(compatibility.maximum >= compatibility.minimum, `${platform.id}: launcher compatibility range is inverted`);
    const signing = assertExactKeys(platform.signing, ["identity", "notarization"], `${platform.id}.signing`);
    assertString(signing.identity, `${platform.id}.signing.identity`);
    assertString(signing.notarization, `${platform.id}.signing.notarization`);
    invariant(Array.isArray(platform.minimumOsEvidence) && platform.minimumOsEvidence.length > 0, `${platform.id}: minimumOsEvidence must not be empty`);
    let highestObservedMinimum = "0.0";
    for (const evidenceValue of platform.minimumOsEvidence) {
      const evidence = assertExactKeys(
        evidenceValue,
        ["componentId", "observedMinimum", "observedPath", "method"],
        `${platform.id}.minimumOsEvidence`
      );
      invariant(inventoryById.has(evidence.componentId), `${platform.id}: minimum-OS evidence references unknown component ${evidence.componentId}`);
      invariant(OS_VERSION_PATTERN.test(evidence.observedMinimum), `${platform.id}: invalid observedMinimum`);
      assertSafeRelativePath(evidence.observedPath, `${platform.id}.minimumOsEvidence.observedPath`);
      assertString(evidence.method, `${platform.id}.minimumOsEvidence.method`);
      const current = evidence.observedMinimum.split(".").map(Number);
      const highest2 = highestObservedMinimum.split(".").map(Number);
      if (current[0] > highest2[0] || current[0] === highest2[0] && current[1] > highest2[1]) {
        highestObservedMinimum = evidence.observedMinimum;
      }
    }
    const declared = platform.minimumOsVersion.split(".").map(Number);
    const highest = highestObservedMinimum.split(".").map(Number);
    invariant(
      declared[0] > highest[0] || declared[0] === highest[0] && declared[1] >= highest[1],
      `${platform.id}: minimumOsVersion is lower than observed Mach-O evidence ${highestObservedMinimum}`
    );
    invariant(Array.isArray(platform.requiredComponents) && platform.requiredComponents.length > 0, `${platform.id}: requiredComponents must not be empty`);
    assertUnique(platform.requiredComponents, `${platform.id}.requiredComponents`);
    for (const componentId of platform.requiredComponents) {
      const component = inventoryById.get(componentId);
      invariant(component, `${platform.id}: unknown required component ${componentId}`);
      invariant(component.requiredInCore === true, `${platform.id}: ${componentId} is not marked requiredInCore`);
      invariant(component.redistribution === "bundle", `${platform.id}: ${componentId} is not approved for bundling`);
      invariant(component.embeddedIn === void 0, `${platform.id}: embedded component ${componentId} cannot be a top-level required component`);
    }
    const expectedRequired = [...inventoryById.values()].filter((component) => component.requiredInCore && component.embeddedIn === void 0).map((component) => component.id).sort(bytewiseCompare);
    const actualRequired = [...platform.requiredComponents].sort(bytewiseCompare);
    invariant(
      JSON.stringify(actualRequired) === JSON.stringify(expectedRequired),
      `${platform.id}: requiredComponents does not equal the classified core closure`
    );
  }
  return new Map(platforms.platforms.map((platform) => [platform.id, platform]));
}
function validateComponentLocks(lockValue, inventoryById) {
  const locks = assertExactKeys(lockValue, ["schemaVersion", "platform", "inputs"], "component lock");
  invariant(locks.schemaVersion === 1, "component lock schemaVersion must be 1");
  invariant(PLATFORM_ID_PATTERN.test(assertString(locks.platform, "component lock platform")), "component lock platform is invalid");
  invariant(Array.isArray(locks.inputs) && locks.inputs.length > 0, "component lock inputs must not be empty");
  const lockIds = locks.inputs.map((input) => input.id);
  assertUnique(lockIds, "component lock ids");
  invariant(
    JSON.stringify([...lockIds].sort(bytewiseCompare)) === JSON.stringify([...EXPECTED_LOCK_INPUTS.keys()].sort(bytewiseCompare)),
    "component lock does not contain the exact required external input set"
  );
  for (const inputValue of locks.inputs) {
    const input = assertExactKeys(
      inputValue,
      ["id", "componentId", "version", "url", "sha256", "archiveType", "license"],
      "component lock input"
    );
    const id = assertString(input.id, "component lock id");
    invariant(ID_PATTERN.test(id), `${id}: invalid component lock id`);
    invariant(input.componentId === EXPECTED_LOCK_INPUTS.get(id), `${id}: componentId does not match the required external input contract`);
    const component = inventoryById.get(assertString(input.componentId, `${id}.componentId`));
    invariant(component, `${id}: unknown component ${input.componentId}`);
    invariant(component.redistribution === "bundle", `${id}: locked input is not approved for bundling`);
    assertString(input.version, `${id}.version`);
    assertString(input.url, `${id}.url`);
    invariant(input.url.startsWith("https://"), `${id}.url must use HTTPS`);
    invariant(SHA256_PATTERN.test(input.sha256), `${id}.sha256 must be lowercase SHA-256`);
    invariant(["tar.gz", "zip"].includes(input.archiveType), `${id}: unsupported archiveType`);
    assertString(input.license, `${id}.license`);
    invariant(input.license === component.license, `${id}: license does not match component inventory`);
  }
  return locks;
}
function validateSigningPolicy(policyValue) {
  const policy = assertExactKeys(
    policyValue,
    ["schemaVersion", "stableReleaseStatus", "manifestSigning", "appleSigning", "channelRequirements", "promotionRequirements"],
    "signing policy"
  );
  invariant(policy.schemaVersion === 1, "signing policy schemaVersion must be 1");
  invariant(["blocked-awaiting-credentials", "ready"].includes(policy.stableReleaseStatus), "invalid stable release signing status");
  const manifestSigning = assertExactKeys(
    policy.manifestSigning,
    ["algorithm", "keyId", "publicKeyStatus", "privateKeySecret"],
    "manifest signing policy"
  );
  invariant(manifestSigning.algorithm === "ed25519", "manifest signing must use Ed25519");
  assertString(manifestSigning.keyId, "manifest signing keyId");
  invariant(["unprovisioned", "provisioned"].includes(manifestSigning.publicKeyStatus), "invalid manifest public-key status");
  invariant(
    /^JOBCTRL_[A-Z0-9_]+$/.test(assertString(manifestSigning.privateKeySecret, "manifest private-key secret name")),
    "manifest private-key secret name is invalid"
  );
  const appleSigning = assertExactKeys(
    policy.appleSigning,
    ["identityType", "teamIdStatus", "certificateSecret", "certificatePasswordSecret", "notaryProfileSecret"],
    "Apple signing policy"
  );
  invariant(appleSigning.identityType === "Developer ID Application", "Apple signing identity must be Developer ID Application");
  invariant(["unprovisioned", "provisioned"].includes(appleSigning.teamIdStatus), "invalid Apple team-id status");
  for (const secretName of [
    appleSigning.certificateSecret,
    appleSigning.certificatePasswordSecret,
    appleSigning.notaryProfileSecret
  ]) {
    invariant(/^JOBCTRL_[A-Z0-9_]+$/.test(assertString(secretName, "signing secret name")), "signing policy contains an invalid secret name");
  }
  const channelRequirements = assertExactKeys(
    policy.channelRequirements,
    ["local", "prerelease", "stable"],
    "signing channel requirements"
  );
  for (const channel of ["local", "prerelease", "stable"]) {
    const requirements = assertExactKeys(
      channelRequirements[channel],
      ["manifestKey", "codeSigning", "notarized"],
      `${channel} signing requirements`
    );
    invariant(["local-development", "release"].includes(requirements.manifestKey), `${channel}: invalid manifest key policy`);
    invariant(["unsigned-local", "developer-id"].includes(requirements.codeSigning), `${channel}: invalid code-signing policy`);
    assertBoolean(requirements.notarized, `${channel}.notarized`);
  }
  invariant(channelRequirements.local.manifestKey === "local-development", "local manifests must use the local-development key id");
  invariant(channelRequirements.local.codeSigning === "unsigned-local" && channelRequirements.local.notarized === false, "local artifacts must remain explicitly unsigned and unnotarized");
  for (const channel of ["prerelease", "stable"]) {
    invariant(channelRequirements[channel].manifestKey === "release", `${channel} manifests must use the configured release key`);
    invariant(channelRequirements[channel].codeSigning === "developer-id", `${channel} artifacts must use Developer ID signing`);
    invariant(channelRequirements[channel].notarized === true, `${channel} artifacts must be notarized`);
  }
  invariant(Array.isArray(policy.promotionRequirements) && policy.promotionRequirements.length > 0, "signing promotion requirements must not be empty");
  for (const requirement of policy.promotionRequirements) assertString(requirement, "signing promotion requirement");
  if (policy.stableReleaseStatus === "ready") {
    invariant(manifestSigning.publicKeyStatus === "provisioned", "stable signing cannot be ready without a provisioned manifest public key");
    invariant(appleSigning.teamIdStatus === "provisioned", "stable signing cannot be ready without a provisioned Apple team id");
  }
  return policy;
}
function parseVersionSource(source, root) {
  const separator = source.indexOf("#");
  invariant(separator > 0, `versionSource must contain a # selector: ${source}`);
  const relativePath = source.slice(0, separator);
  const selector = source.slice(separator + 1);
  assertSafeRelativePath(relativePath, "versionSource path");
  return { filePath: path.join(root, relativePath), selector };
}
async function resolveJsonSelector(filePath, selector) {
  let value = await loadJson(filePath);
  for (const segment of selector.split(".")) value = value?.[segment];
  return assertString(value, `${path.relative(REPO_ROOT, filePath)}#${selector}`);
}
async function resolveTomlProjectVersion(filePath) {
  const contents = await readFile(filePath, "utf8");
  const projectBlock = contents.match(/\[project\]([\s\S]*?)(?:\n\[|$)/);
  invariant(projectBlock, `${filePath}: missing [project] block`);
  const version = projectBlock[1].match(/^\s*version\s*=\s*"([^"]+)"/m);
  invariant(version, `${filePath}: missing project.version`);
  return version[1];
}
async function resolveUvLockVersion(filePath, packageName) {
  const contents = await readFile(filePath, "utf8");
  for (const block of contents.split(/\n(?=\[\[package\]\])/)) {
    const name = block.match(/^name\s*=\s*"([^"]+)"/m)?.[1];
    if (name !== packageName) continue;
    const version = block.match(/^version\s*=\s*"([^"]+)"/m)?.[1];
    invariant(version, `${filePath}: ${packageName} has no version`);
    return version;
  }
  throw new Error(`${filePath}: package ${packageName} not found`);
}
async function resolvePnpmLockVersion(filePath, packageName) {
  const contents = await readFile(filePath, "utf8");
  const escapedName = packageName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = contents.match(new RegExp(`^  ['"]?${escapedName}@([^:'"(]+)(?:\\([^\\n]+\\))?['"]?:$`, "m"));
  invariant(match, `${filePath}: package ${packageName} not found`);
  return match[1];
}
async function resolveInventoryVersions(inventory, root = REPO_ROOT) {
  const resolved = {};
  for (const component of inventory.components) {
    if (component.version) {
      resolved[component.id] = component.version;
      continue;
    }
    const { filePath, selector } = parseVersionSource(component.versionSource, root);
    if (filePath.endsWith(".json")) {
      resolved[component.id] = await resolveJsonSelector(filePath, selector);
    } else if (filePath.endsWith("pyproject.toml") && selector === "project.version") {
      resolved[component.id] = await resolveTomlProjectVersion(filePath);
    } else if (filePath.endsWith("uv.lock")) {
      resolved[component.id] = await resolveUvLockVersion(filePath, selector);
    } else if (filePath.endsWith("pnpm-lock.yaml")) {
      resolved[component.id] = await resolvePnpmLockVersion(filePath, selector);
    } else {
      throw new Error(`${component.id}: unsupported versionSource ${component.versionSource}`);
    }
  }
  return resolved;
}
function validateLicenseReview(licenseReview, inventoryById) {
  assertString(licenseReview, "license review");
  const reviewedComponents = [...licenseReview.matchAll(/^\| `([^`]+)` \| `([^`]+)` \| `([^`]+)` \| `([^`]+)` \|/gm)].map((match) => ({ id: match[1], classification: match[2], license: match[3], redistribution: match[4] }));
  const reviewedComponentIds = reviewedComponents.map((component) => component.id).sort(bytewiseCompare);
  const inventoryComponentIds = [...inventoryById.keys()].sort(bytewiseCompare);
  invariant(
    JSON.stringify(reviewedComponentIds) === JSON.stringify(inventoryComponentIds),
    "license review component set does not match component-inventory.json"
  );
  for (const reviewed of reviewedComponents) {
    const component = inventoryById.get(reviewed.id);
    invariant(reviewed.classification === component.classification, `${reviewed.id}: license review classification does not match inventory`);
    invariant(reviewed.license === component.license, `${reviewed.id}: license review license does not match inventory`);
    invariant(reviewed.redistribution === component.redistribution, `${reviewed.id}: license review decision does not match inventory`);
  }
  return reviewedComponents;
}
async function auditDistributionContracts(root = REPO_ROOT) {
  const {
    schema,
    inventory,
    platforms,
    componentLocks,
    providerPackLocks,
    pythonLicenseEvidenceLocks,
    nodeLicenseEvidenceLocks,
    capabilityPolicy,
    sourceBaseline,
    signingPolicy
  } = await loadDistributionContracts(root);
  compileManifestSchema(schema);
  const inventoryById = validateComponentInventory(inventory);
  const platformsById = validatePlatforms(platforms, inventoryById);
  const locks = validateComponentLocks(componentLocks, inventoryById);
  const capabilitiesById = validateCapabilityPolicy(capabilityPolicy, inventoryById);
  const versions = await resolveInventoryVersions(inventory, root);
  const [uvLockContents, rootPnpmLockContents, mcpPnpmLockContents, apiNativePnpmLockContents] = await Promise.all([
    readFile(path.join(root, "workers", "automation", "uv.lock"), "utf8"),
    readFile(path.join(root, "pnpm-lock.yaml"), "utf8"),
    readFile(path.join(root, "packaging", "distribution", "playwright-mcp", "pnpm-lock.yaml"), "utf8"),
    readFile(path.join(root, "packaging", "distribution", "api-native", "pnpm-lock.yaml"), "utf8")
  ]);
  const providerLocks = validateProviderPackLocks(
    providerPackLocks,
    inventoryById,
    versions,
    uvLockContents
  );
  const pythonLicenseEvidence = validatePythonLicenseEvidenceLocks(pythonLicenseEvidenceLocks, uvLockContents);
  const nodeLicenseEvidence = validateNodeLicenseEvidenceLocks(
    nodeLicenseEvidenceLocks,
    [rootPnpmLockContents, mcpPnpmLockContents, apiNativePnpmLockContents].join("\n")
  );
  invariant(platformsById.has(locks.platform), `component locks target unsupported platform ${locks.platform}`);
  for (const input of locks.inputs) {
    invariant(
      input.version === versions[input.componentId],
      `${input.id}: locked version ${input.version} does not match inventory version ${versions[input.componentId]}`
    );
  }
  const licenseReview = await readFile(path.join(root, "packaging", "distribution", "LICENSE-REVIEW.md"), "utf8");
  validateLicenseReview(licenseReview, inventoryById);
  assertExactKeys(
    sourceBaseline,
    ["schemaVersion", "reproducibleCounts", "referenceFootprint"],
    "source baseline"
  );
  invariant(sourceBaseline.schemaVersion === 1, "source baseline schemaVersion must be 1");
  const referenceFootprint = assertExactKeys(
    sourceBaseline.referenceFootprint,
    ["status", "measurementContext", "logicalBytes", "observations", "notes"],
    "source baseline referenceFootprint"
  );
  invariant(referenceFootprint.status === "observational", "source footprint must be explicitly observational");
  assertExactKeys(
    referenceFootprint.measurementContext,
    ["referenceCommit", "recordedOn", "platform", "scope", "interpretation"],
    "source baseline measurementContext"
  );
  for (const [key, value] of Object.entries(referenceFootprint.measurementContext)) {
    assertString(value, `source baseline measurementContext.${key}`);
  }
  invariant(
    /^[a-f0-9]{40}$/.test(referenceFootprint.measurementContext.referenceCommit),
    "source footprint referenceCommit must be a full commit SHA"
  );
  assertExactKeys(referenceFootprint.logicalBytes, ["nodeModules", "pythonEnvironment"], "source baseline logicalBytes");
  assertInteger(referenceFootprint.logicalBytes.nodeModules, "source baseline nodeModules bytes");
  assertInteger(referenceFootprint.logicalBytes.pythonEnvironment, "source baseline Python environment bytes");
  invariant(Array.isArray(referenceFootprint.observations) && referenceFootprint.observations.length > 0, "source baseline observations must not be empty");
  const observationIds = [];
  for (const observationValue of referenceFootprint.observations) {
    const observation = assertAllowedKeys(
      observationValue,
      ["id", "value", "unit", "qualifier", "optional", "note"],
      "source baseline observation"
    );
    const id = assertString(observation.id, "source baseline observation id");
    observationIds.push(id);
    invariant(typeof observation.value === "number" && Number.isFinite(observation.value) && observation.value >= 0, `${id}.value must be a non-negative number`);
    assertString(observation.unit, `${id}.unit`);
    assertString(observation.qualifier, `${id}.qualifier`);
    if (observation.optional !== void 0) assertBoolean(observation.optional, `${id}.optional`);
    assertString(observation.note, `${id}.note`);
  }
  assertUnique(observationIds, "source baseline observation ids");
  invariant(Array.isArray(referenceFootprint.notes) && referenceFootprint.notes.length > 0, "source baseline notes must not be empty");
  for (const note of referenceFootprint.notes) assertString(note, "source baseline note");
  const [javascript, python, lockCounts] = await Promise.all([
    workspaceDependencyCounts(root),
    pythonDependencyCounts(root),
    lockRecordCounts(root)
  ]);
  const expectedCounts = {
    javascriptPackageFiles: javascript.packageFiles,
    javascriptUniqueDirect: javascript.uniqueDirect,
    javascriptUniqueRuntimeDirect: javascript.uniqueRuntimeDirect,
    javascriptUniqueDevelopmentDirect: javascript.uniqueDevelopmentDirect,
    pnpmPackageRecords: lockCounts.pnpmPackageRecords,
    pythonCoreRuntimeDirect: python.coreRuntimeDirect,
    pythonProviderRuntimeDirect: python.providerRuntimeDirect,
    pythonDevelopmentDirect: python.developmentDirect,
    uvPackageRecords: lockCounts.uvPackageRecords
  };
  assertExactKeys(sourceBaseline.reproducibleCounts, Object.keys(expectedCounts), "source baseline reproducibleCounts");
  invariant(
    JSON.stringify(sourceBaseline.reproducibleCounts) === JSON.stringify(expectedCounts),
    "source dependency counts drifted; run distribution:measure and update source-baseline.json intentionally"
  );
  validateSigningPolicy(signingPolicy);
  return {
    schemaVersion: 1,
    componentCount: inventory.components.length,
    bundledComponentCount: inventory.components.filter((component) => component.redistribution === "bundle").length,
    providerPackCount: inventory.components.filter((component) => component.classification === "provider-pack").length,
    providerPackWheelCount: providerLocks.packs.reduce((count, pack) => count + pack.wheels.length, 0),
    pythonLicenseEvidenceCount: pythonLicenseEvidence.inputs.length,
    nodeLicenseEvidenceCount: nodeLicenseEvidence.inputs.length,
    developerOnlyCount: inventory.components.filter((component) => component.classification === "developer-only").length,
    lockedInputCount: locks.inputs.length,
    capabilityCount: capabilitiesById.size,
    footprintReferenceCommit: referenceFootprint.measurementContext.referenceCommit,
    stableReleaseStatus: signingPolicy.stableReleaseStatus,
    platforms: [...platformsById.keys()],
    versions
  };
}
function validateManifestComponent(componentValue, contracts) {
  const component = assertExactKeys(
    componentValue,
    ["id", "classification", "version", "owner", "source", "license", "redistribution", "path", "sha256", "sizeBytes", "required"],
    "manifest component"
  );
  const id = assertString(component.id, "manifest component id");
  invariant(ID_PATTERN.test(id), `invalid manifest component id ${id}`);
  invariant(MANIFEST_CLASSIFICATIONS.has(component.classification), `${id}: invalid manifest classification`);
  const inventory = contracts.inventoryById.get(id);
  invariant(inventory, `${id}: component is not classified in component-inventory.json`);
  invariant(inventory.classification !== "developer-only", `${id}: developer-only component cannot enter a payload`);
  invariant(inventory.redistribution === "bundle", `${id}: component is not approved for bundling`);
  invariant(inventory.embeddedIn === void 0, `${id}: embedded component cannot own an overlapping manifest root`);
  invariant(component.classification === inventory.classification, `${id}: classification does not match inventory`);
  invariant(assertString(component.version, `${id}.version`) === contracts.versions[id], `${id}: version does not match resolved inventory version`);
  invariant(assertString(component.owner, `${id}.owner`) === inventory.owner, `${id}: owner does not match component inventory`);
  invariant(assertString(component.source, `${id}.source`) === inventory.source, `${id}: source does not match component inventory`);
  invariant(assertString(component.license, `${id}.license`) === inventory.license, `${id}: license does not match component inventory`);
  invariant(component.redistribution === "bundle", `${id}: manifest redistribution must be bundle`);
  assertSafeRelativePath(component.path, `${id}.path`);
  invariant(SHA256_PATTERN.test(component.sha256), `${id}.sha256 must be lowercase SHA-256`);
  assertInteger(component.sizeBytes, `${id}.sizeBytes`);
  assertBoolean(component.required, `${id}.required`);
  invariant(component.required === inventory.requiredInCore, `${id}.required does not match component inventory`);
  return component;
}
function pathIsWithinRoot(filePath, componentPath) {
  return filePath === componentPath || filePath.startsWith(`${componentPath}/`);
}
function summarizeComponentFiles(componentPath, files) {
  assertSafeRelativePath(componentPath, "component summary path");
  const ownedFiles = files.filter((file) => pathIsWithinRoot(file.path, componentPath)).sort((left, right) => bytewiseCompare(left.path, right.path));
  invariant(ownedFiles.length > 0, `no files are rooted at ${componentPath}`);
  const canonical = ownedFiles.map((file) => file.type === "symlink" ? `${file.path}\0symlink\0${file.target}\0${file.sizeBytes}
` : `${file.path}\0file\0${file.sha256}\0${file.sizeBytes}\0${file.mode}
`).join("");
  return {
    sha256: createHash("sha256").update(canonical).digest("hex"),
    sizeBytes: ownedFiles.reduce((total, file) => total + file.sizeBytes, 0),
    fileCount: ownedFiles.length
  };
}
function resolveManifestPathThroughSymlinks(candidatePath, symlinkByPath) {
  let current = candidatePath;
  const seen = /* @__PURE__ */ new Set();
  const links = [...symlinkByPath.keys()].sort((left, right) => right.length - left.length || bytewiseCompare(left, right));
  for (let step = 0; step <= links.length; step += 1) {
    invariant(!seen.has(current), `${candidatePath}: symlink cycle detected`);
    seen.add(current);
    const linkPath = links.find((entry) => current === entry || current.startsWith(`${entry}/`));
    if (!linkPath) return current;
    const link = symlinkByPath.get(linkPath);
    const resolvedTarget = resolveSafeSymlinkTarget(link.target, link.path);
    const suffix = current.slice(linkPath.length);
    current = path.posix.normalize(`${resolvedTarget}${suffix}`);
    assertSafeRelativePath(current, `${candidatePath}: resolved symlink path`);
  }
  throw new Error(`${candidatePath}: symlink resolution exceeded the manifest link count`);
}
function validateDistributionManifest(manifestValue, contracts, { stable = false } = {}) {
  invariant(contracts.schemaValidator(manifestValue), `manifest schema validation failed: ${schemaErrors(contracts.schemaValidator)}`);
  const manifest = assertExactKeys(
    manifestValue,
    ["schemaVersion", "appVersion", "buildId", "releaseChannel", "sourceDateEpoch", "platform", "launcherCompatibility", "components", "capabilities", "files", "signing"],
    "distribution manifest"
  );
  invariant(manifest.schemaVersion === 1, "manifest schemaVersion must be 1");
  invariant(VERSION_PATTERN.test(assertString(manifest.appVersion, "appVersion")), "appVersion must be semver");
  invariant(manifest.appVersion === contracts.versions["jobctrl-launcher"], "appVersion does not match the resolved JobCtrl version");
  invariant(/^[0-9A-Za-z][0-9A-Za-z._-]{7,127}$/.test(assertString(manifest.buildId, "buildId")), "buildId is invalid");
  invariant(RELEASE_CHANNELS.has(manifest.releaseChannel), "releaseChannel is invalid");
  assertInteger(manifest.sourceDateEpoch, "sourceDateEpoch");
  if (stable) invariant(manifest.releaseChannel === "stable", "stable validation requires the stable release channel");
  const platformValue = assertExactKeys(manifest.platform, ["id", "os", "arch", "minimumOsVersion"], "manifest.platform");
  const platform = contracts.platformsById.get(platformValue.id);
  invariant(platform, `manifest references unsupported platform ${platformValue.id}`);
  invariant(platformValue.os === platform.os, "manifest platform.os does not match platform contract");
  invariant(platformValue.arch === platform.arch, "manifest platform.arch does not match platform contract");
  invariant(platformValue.minimumOsVersion === platform.minimumOsVersion, "manifest minimum OS does not match platform contract");
  const compatibility = assertExactKeys(manifest.launcherCompatibility, ["minimum", "maximum"], "launcherCompatibility");
  assertInteger(compatibility.minimum, "launcherCompatibility.minimum", 1);
  assertInteger(compatibility.maximum, "launcherCompatibility.maximum", 1);
  invariant(compatibility.maximum >= compatibility.minimum, "launcherCompatibility range is inverted");
  invariant(compatibility.minimum === platform.launcherCompatibility.minimum, "launcherCompatibility.minimum does not match platform contract");
  invariant(compatibility.maximum === platform.launcherCompatibility.maximum, "launcherCompatibility.maximum does not match platform contract");
  invariant(Array.isArray(manifest.components) && manifest.components.length > 0, "manifest.components must not be empty");
  const components = manifest.components.map((component) => validateManifestComponent(component, contracts));
  const componentIds = components.map((component) => component.id);
  assertUnique(componentIds, "manifest component ids");
  invariant(
    JSON.stringify(componentIds) === JSON.stringify([...componentIds].sort(bytewiseCompare)),
    "manifest components must be bytewise sorted by id"
  );
  for (let leftIndex = 0; leftIndex < components.length; leftIndex += 1) {
    for (let rightIndex = leftIndex + 1; rightIndex < components.length; rightIndex += 1) {
      const left = components[leftIndex];
      const right = components[rightIndex];
      invariant(
        !pathIsWithinRoot(left.path, right.path) && !pathIsWithinRoot(right.path, left.path),
        `manifest component roots overlap: ${left.id} (${left.path}) and ${right.id} (${right.path})`
      );
    }
  }
  for (const requiredId of platform.requiredComponents) {
    invariant(componentIds.includes(requiredId), `manifest is missing required component ${requiredId}`);
  }
  invariant(Array.isArray(manifest.capabilities) && manifest.capabilities.length > 0, "manifest.capabilities must not be empty");
  const capabilityIds = [];
  for (const capabilityValue of manifest.capabilities) {
    const capability = assertExactKeys(capabilityValue, ["id", "defaultEnabled", "componentIds"], "capability");
    const id = assertString(capability.id, "capability.id");
    invariant(ID_PATTERN.test(id), `invalid capability id ${id}`);
    const policy = contracts.capabilitiesById.get(id);
    invariant(policy, `manifest contains unknown capability ${id}`);
    capabilityIds.push(id);
    assertBoolean(capability.defaultEnabled, `${id}.defaultEnabled`);
    invariant(capability.defaultEnabled === policy.defaultEnabled, `${id}: defaultEnabled does not match capability policy`);
    invariant(Array.isArray(capability.componentIds) && capability.componentIds.length > 0, `${id}.componentIds must not be empty`);
    assertUnique(capability.componentIds, `${id}.componentIds`);
    invariant(
      JSON.stringify(capability.componentIds) === JSON.stringify([...capability.componentIds].sort(bytewiseCompare)),
      `${id}.componentIds must be bytewise sorted`
    );
    invariant(JSON.stringify(capability.componentIds) === JSON.stringify(policy.componentIds), `${id}: componentIds do not match capability policy`);
    for (const componentId of capability.componentIds) {
      invariant(componentIds.includes(componentId), `${id}: unknown component ${componentId}`);
    }
  }
  assertUnique(capabilityIds, "capability ids");
  invariant(
    JSON.stringify(capabilityIds) === JSON.stringify([...capabilityIds].sort(bytewiseCompare)),
    "manifest capabilities must be bytewise sorted by id"
  );
  invariant(capabilityIds.length === contracts.capabilitiesById.size, "manifest does not contain the complete capability policy");
  invariant(Array.isArray(manifest.files) && manifest.files.length > 0, "manifest.files must not be empty");
  const filePaths = [];
  const files = [];
  for (const fileValue of manifest.files) {
    const fileObject = assertObject(fileValue, "manifest file");
    invariant(["file", "symlink"].includes(fileObject.type), "manifest file type must be file or symlink");
    const file = fileObject.type === "symlink" ? assertExactKeys(fileObject, ["type", "path", "target", "sizeBytes"], "manifest symlink") : assertExactKeys(fileObject, ["type", "path", "sha256", "sizeBytes", "mode"], "manifest file");
    const filePath = assertSafeRelativePath(file.path, "manifest file path");
    filePaths.push(filePath);
    if (file.type === "symlink") {
      resolveSafeSymlinkTarget(file.target, filePath);
      invariant(file.sizeBytes === Buffer.byteLength(file.target, "utf8"), `${filePath}: symlink size must equal its UTF-8 target length`);
    } else {
      invariant(SHA256_PATTERN.test(file.sha256), `${filePath}: invalid SHA-256`);
      assertInteger(file.sizeBytes, `${filePath}.sizeBytes`);
      invariant(SAFE_FILE_MODES.has(file.mode), `${filePath}: unsafe mode ${file.mode}; only 0644 and 0755 are allowed`);
    }
    const owners = components.filter((component) => pathIsWithinRoot(filePath, component.path));
    invariant(owners.length === 1, `${filePath}: manifest file must have exactly one component owner; found ${owners.length}`);
    files.push(file);
  }
  assertUnique(filePaths, "manifest file paths");
  invariant(
    JSON.stringify(filePaths) === JSON.stringify([...filePaths].sort(bytewiseCompare)),
    "manifest files must be bytewise sorted by path"
  );
  const symlinkByPath = new Map(files.filter((file) => file.type === "symlink").map((file) => [file.path, file]));
  for (const link of symlinkByPath.values()) {
    const directTarget = resolveSafeSymlinkTarget(link.target, link.path);
    invariant(directTarget !== link.path, `${link.path}: symlink cannot target itself`);
    const resolvedTarget = resolveManifestPathThroughSymlinks(directTarget, symlinkByPath);
    const targetExists = files.some((file) => file.path === resolvedTarget || file.path.startsWith(`${resolvedTarget}/`));
    invariant(targetExists, `${link.path}: symlink target is not represented by the manifest`);
    const linkOwner = components.find((component) => pathIsWithinRoot(link.path, component.path));
    const targetOwner = components.find((component) => pathIsWithinRoot(resolvedTarget, component.path));
    invariant(targetOwner?.id === linkOwner?.id, `${link.path}: symlink target crosses component ownership`);
  }
  for (const component of components) {
    const summary = summarizeComponentFiles(component.path, files);
    invariant(component.sha256 === summary.sha256, `${component.id}: component SHA-256 does not match its file inventory`);
    invariant(component.sizeBytes === summary.sizeBytes, `${component.id}: component size does not match its file inventory`);
  }
  const signing = assertExactKeys(manifest.signing, ["manifestAlgorithm", "manifestKeyId", "codeSigning", "notarized"], "manifest.signing");
  invariant(signing.manifestAlgorithm === contracts.signingPolicy.manifestSigning.algorithm, "manifest signing algorithm does not match signing policy");
  const channelPolicy = contracts.signingPolicy.channelRequirements[manifest.releaseChannel];
  invariant(channelPolicy, `signing policy has no requirements for ${manifest.releaseChannel}`);
  const expectedKeyId = channelPolicy.manifestKey === "release" ? contracts.signingPolicy.manifestSigning.keyId : channelPolicy.manifestKey;
  invariant(signing.manifestKeyId === expectedKeyId, `manifest key id does not match ${manifest.releaseChannel} signing policy`);
  invariant(signing.codeSigning === channelPolicy.codeSigning, `manifest code signing does not match ${manifest.releaseChannel} signing policy`);
  assertBoolean(signing.notarized, "manifest.signing.notarized");
  invariant(signing.notarized === channelPolicy.notarized, `manifest notarization does not match ${manifest.releaseChannel} signing policy`);
  if (manifest.releaseChannel === "stable") {
    invariant(contracts.signingPolicy.stableReleaseStatus === "ready", "stable manifest promotion is blocked until signing credentials are provisioned");
  }
  return manifest;
}
async function sha256File(filePath) {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(filePath)) hash.update(chunk);
  return hash.digest("hex");
}
async function buildFileInventory(root) {
  const rootStat = await stat(root);
  invariant(rootStat.isDirectory(), `artifact root is not a directory: ${root}`);
  const files = [];
  async function visit(directory, relativeDirectory = "") {
    const entries = await readdir(directory, { withFileTypes: true });
    entries.sort((left, right) => bytewiseCompare(left.name, right.name));
    for (const entry of entries) {
      const relativePath = relativeDirectory ? path.posix.join(relativeDirectory, entry.name) : entry.name;
      assertSafeRelativePath(relativePath, "artifact file path");
      const absolutePath = path.join(directory, entry.name);
      const fileStat = await lstat(absolutePath);
      if (fileStat.isSymbolicLink()) {
        const target = await readlink(absolutePath);
        resolveSafeSymlinkTarget(target, relativePath);
        files.push({
          type: "symlink",
          path: relativePath,
          target,
          sizeBytes: Buffer.byteLength(target, "utf8")
        });
        continue;
      }
      if (fileStat.isDirectory()) {
        await visit(absolutePath, relativePath);
        continue;
      }
      invariant(fileStat.isFile(), `artifact contains an unsupported file type: ${relativePath}`);
      const mode = (fileStat.mode & 4095).toString(8).padStart(4, "0");
      invariant(SAFE_FILE_MODES.has(mode), `${relativePath}: unsafe mode ${mode}; normalize artifact files to 0644 or 0755`);
      files.push({
        type: "file",
        path: relativePath,
        sha256: await sha256File(absolutePath),
        sizeBytes: fileStat.size,
        mode
      });
    }
  }
  await visit(root);
  files.sort((left, right) => bytewiseCompare(left.path, right.path));
  const realRoot = await realpath(root);
  for (const file of files) {
    if (file.type !== "symlink") continue;
    const resolvedTarget = resolveSafeSymlinkTarget(file.target, file.path);
    let realTarget;
    try {
      realTarget = await realpath(path.join(root, resolvedTarget));
    } catch (error) {
      if (error?.code === "ELOOP") throw new Error(`${file.path}: symlink cycle detected`);
      throw new Error(`${file.path}: symlink target does not resolve inside the artifact`);
    }
    invariant(
      realTarget === realRoot || realTarget.startsWith(`${realRoot}${path.sep}`),
      `${file.path}: symlink target escapes the artifact root`
    );
  }
  return files;
}
async function directorySize(root) {
  try {
    let total = 0;
    async function visit(directory) {
      const entries = await readdir(directory, { withFileTypes: true });
      for (const entry of entries) {
        const absolutePath = path.join(directory, entry.name);
        const fileStat = await lstat(absolutePath);
        if (fileStat.isSymbolicLink()) continue;
        if (fileStat.isDirectory()) {
          await visit(absolutePath);
        } else if (fileStat.isFile()) {
          total += fileStat.size;
        }
      }
    }
    await visit(root);
    return total;
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    throw error;
  }
}
async function workspaceDependencyCounts(root) {
  const packageFiles = [path.join(root, "package.json")];
  for (const parent of ["apps", "packages"]) {
    const directory = path.join(root, parent);
    let entries = [];
    try {
      entries = await readdir(directory, { withFileTypes: true });
    } catch (error) {
      if (error?.code === "ENOENT") continue;
      throw error;
    }
    for (const entry of entries) {
      if (entry.isDirectory()) packageFiles.push(path.join(directory, entry.name, "package.json"));
    }
  }
  const direct = /* @__PURE__ */ new Set();
  const runtime = /* @__PURE__ */ new Set();
  const development = /* @__PURE__ */ new Set();
  let readPackageFiles = 0;
  for (const packageFile of packageFiles) {
    let packageJson;
    try {
      packageJson = await loadJson(packageFile);
      readPackageFiles += 1;
    } catch (error) {
      if (error?.code === "ENOENT") continue;
      throw error;
    }
    for (const name of Object.keys(packageJson.dependencies ?? {})) {
      direct.add(name);
      runtime.add(name);
    }
    for (const name of Object.keys(packageJson.optionalDependencies ?? {})) {
      direct.add(name);
      runtime.add(name);
    }
    for (const name of Object.keys(packageJson.devDependencies ?? {})) {
      direct.add(name);
      development.add(name);
    }
  }
  return {
    packageFiles: readPackageFiles,
    uniqueDirect: direct.size,
    uniqueRuntimeDirect: runtime.size,
    uniqueDevelopmentDirect: development.size
  };
}
async function pythonDependencyCounts(root) {
  const contents = await readFile(path.join(root, "workers", "automation", "pyproject.toml"), "utf8");
  const runtimeBlock = contents.match(/^dependencies\s*=\s*\[([\s\S]*?)^\]/m)?.[1] ?? "";
  const runtime = [...runtimeBlock.matchAll(/^\s*"([^"]+)"/gm)].map((match) => match[1]);
  const providerBlock = contents.match(/^provider-runtime\s*=\s*\[([\s\S]*?)^\]/m)?.[1] ?? "";
  const providers = [...providerBlock.matchAll(/^\s*"([^"]+)"/gm)].map((match) => match[1]);
  const devLine = contents.match(/^dev\s*=\s*\[([^\]]*)\]/m)?.[1] ?? "";
  const development = [...devLine.matchAll(/"([^"]+)"/g)].map((match) => match[1]);
  return {
    coreRuntimeDirect: runtime.length,
    providerRuntimeDirect: new Set(providers.map((requirement) => requirement.match(/^[A-Za-z0-9_.-]+/)?.[0].toLowerCase().replace(/[_.]+/g, "-"))).size,
    developmentDirect: development.length
  };
}
async function lockRecordCounts(root) {
  const [pnpmLock, uvLock] = await Promise.all([
    readFile(path.join(root, "pnpm-lock.yaml"), "utf8"),
    readFile(path.join(root, "workers", "automation", "uv.lock"), "utf8")
  ]);
  const packageSection = pnpmLock.match(/\npackages:\n([\s\S]*?)\nsnapshots:\n/)?.[1] ?? "";
  const pnpmPackageRecords = [...packageSection.matchAll(/^  [^\s].*:\s*$/gm)].length;
  const uvPackageRecords = [...uvLock.matchAll(/^\[\[package\]\]$/gm)].length;
  return { pnpmPackageRecords, uvPackageRecords };
}
async function measureDistribution({ root = REPO_ROOT, artifact = null } = {}) {
  const [javascript, python, locks, nodeModulesBytes, pythonEnvironmentBytes] = await Promise.all([
    workspaceDependencyCounts(root),
    pythonDependencyCounts(root),
    lockRecordCounts(root),
    directorySize(path.join(root, "node_modules")),
    directorySize(path.join(root, "workers", "automation", ".venv"))
  ]);
  const report = {
    schemaVersion: 1,
    source: {
      javascript,
      python,
      locks,
      environmentPresence: {
        nodeModules: nodeModulesBytes === null ? "absent" : "present",
        pythonEnvironment: pythonEnvironmentBytes === null ? "absent" : "present"
      },
      logicalBytes: {
        nodeModules: nodeModulesBytes,
        pythonEnvironment: pythonEnvironmentBytes
      }
    }
  };
  if (artifact) {
    const files = await buildFileInventory(artifact);
    report.artifact = {
      root: path.resolve(artifact),
      fileCount: files.length,
      logicalBytes: files.reduce((total, file) => total + file.sizeBytes, 0),
      files
    };
  }
  return report;
}
async function loadManifestValidationContracts(root = REPO_ROOT) {
  const { schema, inventory, platforms, capabilityPolicy, signingPolicy } = await loadDistributionContracts(root);
  const schemaValidator = compileManifestSchema(schema);
  const inventoryById = validateComponentInventory(inventory);
  const platformsById = validatePlatforms(platforms, inventoryById);
  const capabilitiesById = validateCapabilityPolicy(capabilityPolicy, inventoryById);
  const versions = await resolveInventoryVersions(inventory, root);
  validateSigningPolicy(signingPolicy);
  return { schema, schemaValidator, inventoryById, platformsById, capabilitiesById, versions, signingPolicy };
}
async function main(argv = process.argv.slice(2)) {
  const command = argv[0] ?? "audit";
  if (command === "audit") {
    process.stdout.write(`${JSON.stringify(await auditDistributionContracts(), null, 2)}
`);
    return;
  }
  if (command === "measure") {
    let artifact = null;
    let root = REPO_ROOT;
    for (let index = 1; index < argv.length; index += 1) {
      if (argv[index] === "--artifact") {
        artifact = argv[index + 1];
        invariant(artifact, "--artifact requires a directory");
      } else if (argv[index] === "--root") {
        root = path.resolve(argv[index + 1] ?? "");
        invariant(argv[index + 1], "--root requires a checkout directory");
      } else {
        throw new Error(`unknown measure option: ${argv[index]}`);
      }
      index += 1;
    }
    process.stdout.write(`${JSON.stringify(await measureDistribution({ root, artifact }), null, 2)}
`);
    return;
  }
  throw new Error(`unknown distribution command: ${command}`);
}
var invokedPath = process.argv[1] ? pathToFileURL(path.resolve(process.argv[1])).href : "";
if (import.meta.url === invokedPath && path.basename(process.argv[1] ?? "") === "distribution-manifest.mjs") {
  main().catch((error) => {
    process.stderr.write(`distribution: ${error.message}
`);
    process.exitCode = 1;
  });
}

// scripts/distribution-archive.mjs
import { createHash as createHash2 } from "node:crypto";
import { createReadStream as createReadStream2 } from "node:fs";
import {
  chmod,
  lstat as lstat2,
  mkdir,
  readFile as readFile2,
  readlink as readlink2,
  realpath as realpath2,
  rm,
  symlink,
  writeFile
} from "node:fs/promises";
import path2 from "node:path";
import { gunzipSync, inflateRawSync } from "node:zlib";
var SHA256_PATTERN2 = /^[a-f0-9]{64}$/;
var TAR_BLOCK_SIZE = 512;
function invariant2(condition, message) {
  if (!condition) throw new Error(message);
}
function bytewiseCompare2(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}
function bufferString(buffer, start, length) {
  const end = buffer.indexOf(0, start);
  const boundedEnd = end === -1 || end > start + length ? start + length : end;
  return buffer.subarray(start, boundedEnd).toString("utf8");
}
function tarNumber(buffer, start, length, label) {
  const field = buffer.subarray(start, start + length);
  if ((field[0] & 128) !== 0) {
    invariant2((field[0] & 64) === 0, `${label}: negative tar numbers are not supported`);
    let result = BigInt(field[0] & 63);
    for (const value of field.subarray(1)) result = result << 8n | BigInt(value);
    invariant2(result <= BigInt(Number.MAX_SAFE_INTEGER), `${label}: tar number exceeds JavaScript's safe range`);
    return Number(result);
  }
  const text = field.toString("ascii").replace(/\0.*$/s, "").trim();
  if (text === "") return 0;
  invariant2(/^[0-7]+$/.test(text), `${label}: invalid tar octal number`);
  return Number.parseInt(text, 8);
}
function tarChecksum(buffer, offset) {
  let sum = 0;
  for (let index = 0; index < TAR_BLOCK_SIZE; index += 1) {
    sum += index >= 148 && index < 156 ? 32 : buffer[offset + index];
  }
  return sum;
}
function parsePax(contents) {
  const values = {};
  let offset = 0;
  while (offset < contents.length) {
    const space = contents.indexOf(32, offset);
    invariant2(space > offset, "invalid PAX record length");
    const lengthText = contents.subarray(offset, space).toString("ascii");
    invariant2(/^[0-9]+$/.test(lengthText), "invalid PAX record length");
    const length = Number.parseInt(lengthText, 10);
    invariant2(length > space - offset + 2 && offset + length <= contents.length, "truncated PAX record");
    const record = contents.subarray(space + 1, offset + length - 1).toString("utf8");
    const equals = record.indexOf("=");
    invariant2(equals > 0, "invalid PAX record");
    values[record.slice(0, equals)] = record.slice(equals + 1);
    offset += length;
  }
  return values;
}
function stripArchivePath(value, stripComponents, label) {
  invariant2(typeof value === "string" && value.length > 0, `${label}: empty archive path`);
  invariant2(!value.includes("\\"), `${label}: archive paths must use POSIX separators`);
  invariant2(!value.startsWith("/"), `${label}: absolute archive path is forbidden`);
  const withoutDot = value.startsWith("./") ? value.slice(2) : value;
  const normalized = path2.posix.normalize(withoutDot.replace(/\/$/, ""));
  invariant2(
    normalized !== "." && normalized !== ".." && !normalized.startsWith("../"),
    `${label}: archive path escapes the extraction root`
  );
  invariant2(normalized === withoutDot.replace(/\/$/, ""), `${label}: archive path must be normalized`);
  const segments = normalized.split("/");
  if (segments.length <= stripComponents) return null;
  const stripped = segments.slice(stripComponents).join("/");
  return assertSafeRelativePath(stripped, label);
}
async function sha256File2(filePath) {
  const hash = createHash2("sha256");
  for await (const chunk of createReadStream2(filePath)) hash.update(chunk);
  return hash.digest("hex");
}
async function verifyLockedArchive(archivePath, lock) {
  invariant2(lock && typeof lock === "object", "archive lock must be an object");
  invariant2(SHA256_PATTERN2.test(lock.sha256 ?? ""), `${lock.id ?? "archive"}: invalid locked SHA-256`);
  const archiveStat = await lstat2(archivePath);
  invariant2(archiveStat.isFile() && !archiveStat.isSymbolicLink(), `${lock.id}: archive cache entry must be a regular file`);
  const actual = await sha256File2(archivePath);
  invariant2(actual === lock.sha256, `${lock.id}: archive SHA-256 mismatch (expected ${lock.sha256}, received ${actual})`);
  return actual;
}
function parseTarGzArchive(archive, { stripComponents = 0, skipEntry = null } = {}) {
  invariant2(Number.isInteger(stripComponents) && stripComponents >= 0, "stripComponents must be non-negative");
  const tar = gunzipSync(archive);
  const entries = [];
  let offset = 0;
  let nextLongPath = null;
  let nextLongLink = null;
  let nextPax = {};
  while (offset + TAR_BLOCK_SIZE <= tar.length) {
    const header = tar.subarray(offset, offset + TAR_BLOCK_SIZE);
    if (header.every((value) => value === 0)) break;
    const storedChecksum = tarNumber(header, 148, 8, "tar checksum");
    invariant2(storedChecksum === tarChecksum(tar, offset), "tar header checksum mismatch");
    const size = tarNumber(header, 124, 12, "tar entry size");
    const mode = tarNumber(header, 100, 8, "tar entry mode");
    const type = String.fromCharCode(header[156] || 48);
    const prefix = bufferString(header, 345, 155);
    const rawName = bufferString(header, 0, 100);
    const rawPath = nextPax.path ?? nextLongPath ?? (prefix ? `${prefix}/${rawName}` : rawName);
    const rawLink = nextPax.linkpath ?? nextLongLink ?? bufferString(header, 157, 100);
    const contentsStart = offset + TAR_BLOCK_SIZE;
    const contentsEnd = contentsStart + size;
    invariant2(contentsEnd <= tar.length, `${rawPath || "tar entry"}: truncated tar contents`);
    const contents = tar.subarray(contentsStart, contentsEnd);
    offset = contentsStart + Math.ceil(size / TAR_BLOCK_SIZE) * TAR_BLOCK_SIZE;
    if (type === "x" || type === "g") {
      const values = parsePax(contents);
      if (type === "x") nextPax = values;
      continue;
    }
    if (type === "L") {
      nextLongPath = contents.toString("utf8").replace(/\0.*$/s, "");
      continue;
    }
    if (type === "K") {
      nextLongLink = contents.toString("utf8").replace(/\0.*$/s, "");
      continue;
    }
    if (skipEntry?.(rawPath, { type, rawLink })) {
      nextPax = {};
      nextLongPath = null;
      nextLongLink = null;
      continue;
    }
    const relativePath = stripArchivePath(rawPath, stripComponents, "tar entry path");
    nextPax = {};
    nextLongPath = null;
    nextLongLink = null;
    if (relativePath === null) continue;
    invariant2((mode & 3584) === 0, `${relativePath}: tar entry has unsafe special mode ${mode.toString(8)}`);
    if (type === "5") {
      entries.push({ type: "directory", path: relativePath, mode: "0755" });
    } else if (type === "0" || type === "\0" || type === "7") {
      entries.push({
        type: "file",
        path: relativePath,
        mode: (mode & 73) === 0 ? "0644" : "0755",
        contents: Buffer.from(contents)
      });
    } else if (type === "2") {
      entries.push({ type: "symlink", path: relativePath, target: rawLink });
    } else {
      throw new Error(`${relativePath}: unsupported tar entry type ${JSON.stringify(type)}`);
    }
  }
  invariant2(entries.length > 0, "archive contains no extractable entries");
  return validateArchiveEntries(entries);
}
function findZipEndOfCentralDirectory(archive) {
  const signature = 101010256;
  const minimum = Math.max(0, archive.length - 65535 - 22);
  for (let offset = archive.length - 22; offset >= minimum; offset -= 1) {
    if (archive.readUInt32LE(offset) === signature) return offset;
  }
  throw new Error("ZIP end-of-central-directory record was not found");
}
function parseZipArchive(archive, { stripComponents = 0 } = {}) {
  invariant2(Number.isInteger(stripComponents) && stripComponents >= 0, "stripComponents must be non-negative");
  const eocd = findZipEndOfCentralDirectory(archive);
  invariant2(archive.readUInt16LE(eocd + 4) === 0 && archive.readUInt16LE(eocd + 6) === 0, "multi-disk ZIP archives are forbidden");
  const entryCount = archive.readUInt16LE(eocd + 10);
  const centralSize = archive.readUInt32LE(eocd + 12);
  let offset = archive.readUInt32LE(eocd + 16);
  invariant2(offset + centralSize <= eocd, "invalid ZIP central directory bounds");
  const entries = [];
  for (let index = 0; index < entryCount; index += 1) {
    invariant2(archive.readUInt32LE(offset) === 33639248, "invalid ZIP central directory entry");
    const flags = archive.readUInt16LE(offset + 8);
    const method = archive.readUInt16LE(offset + 10);
    const compressedSize = archive.readUInt32LE(offset + 20);
    const uncompressedSize = archive.readUInt32LE(offset + 24);
    const nameLength = archive.readUInt16LE(offset + 28);
    const extraLength = archive.readUInt16LE(offset + 30);
    const commentLength = archive.readUInt16LE(offset + 32);
    const externalAttributes = archive.readUInt32LE(offset + 38);
    const localOffset = archive.readUInt32LE(offset + 42);
    invariant2((flags & 1) === 0, "encrypted ZIP entries are forbidden");
    invariant2(method === 0 || method === 8, "ZIP entry uses an unsupported compression method");
    const rawName = archive.subarray(offset + 46, offset + 46 + nameLength).toString("utf8");
    offset += 46 + nameLength + extraLength + commentLength;
    const relativePath = stripArchivePath(rawName, stripComponents, "ZIP entry path");
    if (relativePath === null) continue;
    invariant2(archive.readUInt32LE(localOffset) === 67324752, `${relativePath}: invalid ZIP local header`);
    const localNameLength = archive.readUInt16LE(localOffset + 26);
    const localExtraLength = archive.readUInt16LE(localOffset + 28);
    const dataStart = localOffset + 30 + localNameLength + localExtraLength;
    const compressed = archive.subarray(dataStart, dataStart + compressedSize);
    invariant2(compressed.length === compressedSize, `${relativePath}: truncated ZIP data`);
    const contents = method === 0 ? Buffer.from(compressed) : inflateRawSync(compressed);
    invariant2(contents.length === uncompressedSize, `${relativePath}: ZIP uncompressed size mismatch`);
    const unixMode = externalAttributes >>> 16;
    const fileType = unixMode & 61440;
    const directory = rawName.endsWith("/") || fileType === 16384;
    if (directory) {
      entries.push({ type: "directory", path: relativePath, mode: "0755" });
    } else if (fileType === 40960) {
      entries.push({ type: "symlink", path: relativePath, target: contents.toString("utf8") });
    } else {
      invariant2(fileType === 0 || fileType === 32768, `${relativePath}: unsupported ZIP entry type`);
      invariant2((unixMode & 3584) === 0, `${relativePath}: ZIP entry has unsafe special mode ${unixMode.toString(8)}`);
      entries.push({
        type: "file",
        path: relativePath,
        mode: (unixMode & 73) === 0 ? "0644" : "0755",
        contents
      });
    }
  }
  invariant2(offset <= eocd, "ZIP central directory overruns its declared bounds");
  invariant2(entries.length > 0, "archive contains no extractable entries");
  return validateArchiveEntries(entries);
}
function validateArchiveEntries(entries) {
  const paths = /* @__PURE__ */ new Set();
  const casefoldPaths = /* @__PURE__ */ new Map();
  const filePaths = /* @__PURE__ */ new Set();
  for (const entry of entries) {
    assertSafeRelativePath(entry.path, "archive entry path");
    invariant2(!paths.has(entry.path), `${entry.path}: duplicate archive entry`);
    const folded = entry.path.toLowerCase();
    invariant2(!casefoldPaths.has(folded), `${entry.path}: archive entry collides case-insensitively with ${casefoldPaths.get(folded)}`);
    paths.add(entry.path);
    casefoldPaths.set(folded, entry.path);
    if (entry.type !== "directory") filePaths.add(entry.path);
    if (entry.type === "symlink") resolveSafeSymlinkTarget(entry.target, entry.path);
  }
  for (const entry of entries) {
    const segments = entry.path.split("/");
    for (let index = 1; index < segments.length; index += 1) {
      const ancestor = segments.slice(0, index).join("/");
      invariant2(!filePaths.has(ancestor), `${entry.path}: archive entry is nested below non-directory ${ancestor}`);
    }
  }
  return entries.sort((left, right) => bytewiseCompare2(left.path, right.path));
}
async function validateExtractedSymlinks(destination, entries) {
  const realRoot = await realpath2(destination);
  for (const entry of entries) {
    if (entry.type !== "symlink") continue;
    const resolved = resolveSafeSymlinkTarget(entry.target, entry.path);
    let target;
    try {
      target = await realpath2(path2.join(destination, resolved));
    } catch (error) {
      if (error?.code === "ELOOP") throw new Error(`${entry.path}: archive symlink cycle detected`);
      throw new Error(`${entry.path}: archive symlink target is dangling`);
    }
    invariant2(target === realRoot || target.startsWith(`${realRoot}${path2.sep}`), `${entry.path}: archive symlink target escapes extraction root`);
  }
}
async function extractArchiveEntries(entries, destination) {
  await rm(destination, { recursive: true, force: true });
  await mkdir(destination, { recursive: true, mode: 493 });
  for (const entry of entries) {
    const targetPath = path2.join(destination, ...entry.path.split("/"));
    if (entry.type === "directory") {
      await mkdir(targetPath, { recursive: true, mode: 493 });
      await chmod(targetPath, 493);
      continue;
    }
    await mkdir(path2.dirname(targetPath), { recursive: true, mode: 493 });
    if (entry.type === "file") {
      await writeFile(targetPath, entry.contents, { mode: Number.parseInt(entry.mode, 8), flag: "wx" });
      await chmod(targetPath, Number.parseInt(entry.mode, 8));
    } else {
      await symlink(entry.target, targetPath);
    }
  }
  await validateExtractedSymlinks(destination, entries);
  return entries;
}
async function extractVerifiedArchive({ archivePath, lock, destination, stripComponents = 0, include = null, skipEntry = null }) {
  await verifyLockedArchive(archivePath, lock);
  const archive = await readFile2(archivePath);
  let entries;
  if (lock.archiveType === "tar.gz") {
    entries = parseTarGzArchive(archive, { stripComponents, skipEntry });
  } else if (lock.archiveType === "zip") {
    entries = parseZipArchive(archive, { stripComponents });
  } else {
    throw new Error(`${lock.id}: unsupported locked archive type ${lock.archiveType}`);
  }
  if (include) entries = entries.filter((entry) => include(entry.path, entry));
  invariant2(entries.length > 0, `${lock.id}: archive selection contains no entries`);
  await extractArchiveEntries(entries, destination);
  return entries.map(({ contents: _contents, ...entry }) => entry);
}
async function assertSymlinksPreserved(root, expectedEntries) {
  for (const entry of expectedEntries.filter((value) => value.type === "symlink")) {
    const actual = await readlink2(path2.join(root, ...entry.path.split("/")));
    invariant2(actual === entry.target, `${entry.path}: extracted symlink target changed`);
  }
}

// scripts/distribution-build.mjs
var SCRIPT_DIR2 = path3.dirname(fileURLToPath2(import.meta.url));
var DISTRIBUTION_DIR = path3.join(REPO_ROOT, "packaging", "distribution");
var ENVELOPE_FILES = /* @__PURE__ */ new Set(["manifest.json", "manifest.sig"]);
var RELEASE_CHANNELS2 = /* @__PURE__ */ new Set(["local", "prerelease", "stable"]);
var ZIP_UINT32_MAX = 4294967295;
var ZIP_EPOCH_FLOOR = 315532800;
var GO_TOOLCHAIN_VERSION = "go1.26.4";
var GO_TOOLCHAIN_LICENSE_SHA256 = "911f8f5782931320f5b8d1160a76365b83aea6447ee6c04fa6d5591467db9dad";
var GO_TOOLCHAIN_ARCHIVE_URL = "https://go.dev/dl/go1.26.4.darwin-arm64.tar.gz";
var GO_TOOLCHAIN_ARCHIVE_SHA256 = "b62ad2b6d7d2464f12a5bcad7ff47f19d08325773b5efd21610e445a05a9bf53";
var GO_TOOLCHAIN_ARCHIVE_SIZE_BYTES = 64723756;
var GO_TOOLCHAIN_OFFICIAL_METADATA_URL = "https://go.dev/dl/?mode=json&include=all";
var FORBIDDEN_PROVIDER_PATTERNS = [
  /(^|[/_.-])claude[-_]agent[-_]sdk([/_.-]|$)/i,
  /(^|[/_.-])openai[-_]codex([/_.-]|$)/i,
  /(^|[/_.-])openai[-_]codex[-_]cli[-_]bin([/_.-]|$)/i,
  /(^|[/_.-])google[-_]antigravity([/_.-]|$)/i
];
var FORBIDDEN_SEGMENTS = /* @__PURE__ */ new Set([
  ".git",
  ".github",
  ".bin",
  ".pnpm",
  ".playwright-mcp",
  ".pytest_cache",
  ".ruff_cache",
  "__pycache__",
  "coverage",
  "docs",
  "e2e",
  "storybook-static",
  "spikes",
  "test",
  "tests"
]);
var FORBIDDEN_TOOL_NAMES = /* @__PURE__ */ new Set([
  "corepack",
  "git",
  "go",
  "npm",
  "npx",
  "pip",
  "pip3",
  "pnpm",
  "pytest",
  "ruff",
  "storybook",
  "2to3",
  "tsc",
  "tsx",
  "uv",
  "vite",
  "vitest"
]);
var FORBIDDEN_TOOL_INVOCATION_NEEDLES = [
  "node_modules/.bin/",
  "/bin/corepack",
  "/bin/npm",
  "/bin/npx",
  "/bin/pip",
  "/bin/pip3",
  "/bin/pnpm",
  "/bin/uv"
];
var FORBIDDEN_BROWSER_REDISTRIBUTION_NEEDLES = ["WidevineCdm", "libwidevinecdm"];
var FORBIDDEN_PLAYWRIGHT_MCP_RUNTIME_PATHS = [
  "playwright-mcp/node_modules/playwright",
  "playwright-mcp/node_modules/playwright-core/lib/vite",
  "playwright-mcp/node_modules/playwright-core/lib/tools/cli-client/skill",
  "playwright-mcp/node_modules/playwright-core/lib/tools/trace/SKILL.md",
  "playwright-mcp/node_modules/@playwright/mcp/README.md",
  "playwright-mcp/node_modules/playwright-core/README.md",
  "playwright-mcp/node_modules/playwright-core/bin"
];
var TEMPORAL_BRIDGE_BUILD_SOURCE_PATHS = [
  "temporalio/bridge/sdk-core",
  "temporalio/bridge/src",
  "temporalio/bridge/Cargo.toml",
  "temporalio/bridge/Cargo.lock"
];
var PYTHON_RUNTIME_NON_RUNTIME_PATHS = /* @__PURE__ */ new Set([
  "email/architecture.rst",
  "google/protobuf/testdata",
  "numpy/ma/README.rst",
  "numpy/random/_examples",
  "opentelemetry/sdk/_configuration/README.md",
  "opentelemetry/sdk/metrics/_internal/exponential_histogram/mapping/ieee_754.md",
  "playwright/driver/README.md",
  "playwright/driver/package/README.md"
]);
function invariant3(condition, message) {
  if (!condition) throw new Error(message);
}
function bytewiseCompare3(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}
function canonicalPackageName(value) {
  return value.toLowerCase().replace(/[_.]+/g, "-");
}
function canonicalJson(value) {
  return `${JSON.stringify(value, null, 2)}
`;
}
function isTemporalBridgeBuildSourcePath(relativePath) {
  return TEMPORAL_BRIDGE_BUILD_SOURCE_PATHS.some((sourcePath) => relativePath === sourcePath || relativePath.startsWith(`${sourcePath}/`));
}
function isKnownPythonNonRuntimePath(relativePath) {
  return [...PYTHON_RUNTIME_NON_RUNTIME_PATHS].some(
    (nonRuntimePath) => relativePath === nonRuntimePath || relativePath.startsWith(`${nonRuntimePath}/`)
  ) || /^temporalio\/contrib\/.+\/README\.md$/.test(relativePath);
}
function pythonRuntimeRelativePath(payloadPath) {
  return payloadPath.replace(/^(?:worker|playwright-python)\/site-packages\//, "").replace(/^python\/lib\/python3\.12\//, "");
}
function isGitMetadataBasename(basename) {
  return basename.toLowerCase().startsWith(".git");
}
function isAllowedRuntimeDocumentationPath(relativePath) {
  const lowerPath = relativePath.toLowerCase();
  const segments = lowerPath.split("/");
  const basename = path3.posix.basename(lowerPath);
  return lowerPath.startsWith("release/licenses/") || segments.includes("licenses") || basename === "license.md" || lowerPath.endsWith("numpy/random/license.md") || /(?:^|\/)publicsuffix[^/]*\.dist-info\/authors\.rst$/.test(lowerPath);
}
async function writeJson(filePath, value, mode = 420) {
  await mkdir2(path3.dirname(filePath), { recursive: true, mode: 493 });
  await writeFile2(filePath, canonicalJson(value), { mode });
  await chmod2(filePath, mode);
}
async function exists(filePath) {
  try {
    await lstat3(filePath);
    return true;
  } catch (error) {
    if (error?.code === "ENOENT") return false;
    throw error;
  }
}
async function requireFile(filePath, label) {
  let fileStat;
  try {
    fileStat = await lstat3(filePath);
  } catch (error) {
    if (error?.code === "ENOENT") throw new Error(`${label} is missing: ${filePath}`);
    throw error;
  }
  invariant3(fileStat.isFile() && !fileStat.isSymbolicLink(), `${label} must be a regular file: ${filePath}`);
  return filePath;
}
async function requireDirectory(directory, label) {
  let directoryStat;
  try {
    directoryStat = await stat2(directory);
  } catch (error) {
    if (error?.code === "ENOENT") throw new Error(`${label} is missing: ${directory}`);
    throw error;
  }
  invariant3(directoryStat.isDirectory(), `${label} must be a directory: ${directory}`);
  return directory;
}
async function requireResolvedFileWithin(filePath, root, label) {
  const resolved = await realpath3(filePath).catch((error) => {
    if (error?.code === "ENOENT") throw new Error(`${label} is missing: ${filePath}`);
    throw error;
  });
  const resolvedRoot = await realpath3(root);
  invariant3(resolved === resolvedRoot || resolved.startsWith(`${resolvedRoot}${path3.sep}`), `${label} resolves outside its component root`);
  invariant3((await stat2(resolved)).isFile(), `${label} must resolve to a regular file`);
  return filePath;
}
function validatePayloadLayout(layout, contracts, platformId = "darwin-arm64") {
  invariant3(layout?.schemaVersion === 1, "payload layout schemaVersion must be 1");
  invariant3(layout.platform === platformId, `payload layout targets ${layout.platform}, not ${platformId}`);
  invariant3(Array.isArray(layout.components), "payload layout components must be an array");
  const platform = contracts.platformsById.get(platformId);
  invariant3(platform, `unknown payload platform ${platformId}`);
  const ids = layout.components.map((component) => component.id);
  invariant3(new Set(ids).size === ids.length, "payload layout component ids must be unique");
  const paths = layout.components.map((component) => assertSafeRelativePath(component.path, `${component.id}.path`));
  invariant3(new Set(paths).size === paths.length, "payload layout component paths must be unique");
  for (let left = 0; left < paths.length; left += 1) {
    for (let right = left + 1; right < paths.length; right += 1) {
      invariant3(
        !paths[left].startsWith(`${paths[right]}/`) && !paths[right].startsWith(`${paths[left]}/`),
        `payload layout component roots overlap: ${paths[left]} and ${paths[right]}`
      );
    }
  }
  const expected = [...platform.requiredComponents].sort(bytewiseCompare3);
  invariant3(JSON.stringify([...ids].sort(bytewiseCompare3)) === JSON.stringify(expected), "payload layout must contain the exact platform core closure");
  invariant3(layout.standardInputs && typeof layout.standardInputs === "object", "payload layout standardInputs are missing");
  invariant3(
    JSON.stringify(layout.envelopeExclusions) === JSON.stringify([...ENVELOPE_FILES].sort(bytewiseCompare3)),
    "payload layout envelope exclusions must be exactly manifest.json and manifest.sig"
  );
  return new Map(layout.components.map((component) => [component.id, component.path]));
}
function validateEmbeddedComponentLayout(layout, contracts) {
  invariant3(Array.isArray(layout.embeddedComponents), "payload layout embeddedComponents must be an array");
  const expected = [...contracts.inventoryById.values()].filter((component) => component.redistribution === "bundle" && component.embeddedIn !== void 0).map((component) => component.id).sort(bytewiseCompare3);
  const actual = layout.embeddedComponents.map((component) => component.id).sort(bytewiseCompare3);
  invariant3(JSON.stringify(actual) === JSON.stringify(expected), "payload layout must size-account for the exact embedded component closure");
  const specs = /* @__PURE__ */ new Map();
  for (const component of layout.embeddedComponents) {
    invariant3(
      JSON.stringify(Object.keys(component).sort(bytewiseCompare3)) === JSON.stringify(["id", "includedIn", ...component.paths === void 0 ? [] : ["paths"], ...component.prefixes === void 0 ? [] : ["prefixes"]].sort(bytewiseCompare3)),
      `${component.id}: embedded size contract has unknown fields`
    );
    const inventory = contracts.inventoryById.get(component.id);
    invariant3(inventory?.embeddedIn === component.includedIn, `${component.id}: embedded size parent does not match component inventory`);
    const paths = component.paths ?? [];
    const prefixes = component.prefixes ?? [];
    invariant3(Array.isArray(paths) && Array.isArray(prefixes) && paths.length + prefixes.length > 0, `${component.id}: embedded size contract has no selectors`);
    for (const selectedPath of [...paths, ...prefixes]) assertSafeRelativePath(selectedPath, `${component.id}: embedded size selector`);
    invariant3((/* @__PURE__ */ new Set([...paths, ...prefixes])).size === paths.length + prefixes.length, `${component.id}: embedded size selectors must be unique`);
    specs.set(component.id, { id: component.id, includedIn: component.includedIn, paths, prefixes });
  }
  return specs;
}
function validateSharedComponentLayout(layout, contracts) {
  invariant3(Array.isArray(layout.sharedComponentFiles), "payload layout sharedComponentFiles must be an array");
  const specs = /* @__PURE__ */ new Map();
  for (const component of layout.sharedComponentFiles) {
    invariant3(!specs.has(component.id), `${component.id}: shared size contract is duplicated`);
    invariant3(
      JSON.stringify(Object.keys(component).sort(bytewiseCompare3)) === JSON.stringify(["id", "includedIn", ...component.paths === void 0 ? [] : ["paths"], ...component.prefixes === void 0 ? [] : ["prefixes"]].sort(bytewiseCompare3)),
      `${component.id}: shared size contract has unknown fields`
    );
    const inventory = contracts.inventoryById.get(component.id);
    const parent = contracts.inventoryById.get(component.includedIn);
    invariant3(inventory?.redistribution === "bundle" && inventory.embeddedIn === void 0, `${component.id}: shared size component must be a top-level bundled component`);
    invariant3(parent?.redistribution === "bundle" && parent.embeddedIn === void 0, `${component.id}: shared size parent must be a top-level bundled component`);
    const paths = component.paths ?? [];
    const prefixes = component.prefixes ?? [];
    invariant3(Array.isArray(paths) && Array.isArray(prefixes) && paths.length + prefixes.length > 0, `${component.id}: shared size contract has no selectors`);
    for (const selectedPath of [...paths, ...prefixes]) assertSafeRelativePath(selectedPath, `${component.id}: shared size selector`);
    specs.set(component.id, { id: component.id, includedIn: component.includedIn, paths, prefixes });
  }
  return specs;
}
async function loadNativeLauncherToolchain(root = REPO_ROOT) {
  const toolchain = JSON.parse(await readFile3(path3.join(root, "launcher", "toolchain.json"), "utf8"));
  invariant3(
    JSON.stringify(Object.keys(toolchain).sort(bytewiseCompare3)) === JSON.stringify(["archive", "goVersion", "license", "licenseSha256", "licenseSource", "moduleClosure", "schemaVersion"]),
    "native launcher toolchain contract has unknown fields"
  );
  invariant3(toolchain.archive && typeof toolchain.archive === "object", "native launcher toolchain archive is missing");
  invariant3(
    JSON.stringify(Object.keys(toolchain.archive).sort(bytewiseCompare3)) === JSON.stringify(["officialMetadataUrl", "sha256", "sizeBytes", "type", "url"]),
    "native launcher toolchain archive has unknown fields"
  );
  invariant3(
    toolchain.schemaVersion === 1 && toolchain.goVersion === GO_TOOLCHAIN_VERSION && toolchain.moduleClosure === "standard-library-only" && toolchain.license === "BSD-3-Clause" && toolchain.licenseSource === "https://go.dev/LICENSE" && toolchain.licenseSha256 === GO_TOOLCHAIN_LICENSE_SHA256 && toolchain.archive.type === "tar.gz" && toolchain.archive.url === GO_TOOLCHAIN_ARCHIVE_URL && toolchain.archive.sha256 === GO_TOOLCHAIN_ARCHIVE_SHA256 && toolchain.archive.sizeBytes === GO_TOOLCHAIN_ARCHIVE_SIZE_BYTES && toolchain.archive.officialMetadataUrl === GO_TOOLCHAIN_OFFICIAL_METADATA_URL,
    "native launcher toolchain contract is invalid"
  );
  invariant3(await sha256File2(path3.join(root, "launcher", "GO-LICENSE")) === toolchain.licenseSha256, "native launcher Go license does not match the pinned Go toolchain license");
  return toolchain;
}
function nativeGoArchiveLock(toolchain) {
  return {
    id: "go-toolchain-darwin-arm64",
    componentId: "jobctrl-launcher",
    version: toolchain.goVersion,
    archiveType: toolchain.archive.type,
    url: toolchain.archive.url,
    sha256: toolchain.archive.sha256,
    sizeBytes: toolchain.archive.sizeBytes
  };
}
async function loadBuildContracts(root = REPO_ROOT, { signingPolicyOverride = null } = {}) {
  const [contracts, layout, locks, providerPackLocks, licenseEvidenceLocks, nodeLicenseEvidenceLocks, launcherToolchain] = await Promise.all([
    loadManifestValidationContracts(root),
    readFile3(path3.join(root, "packaging", "distribution", "payload-layout.json"), "utf8").then(JSON.parse),
    readFile3(path3.join(root, "packaging", "distribution", "components.lock.json"), "utf8").then(JSON.parse),
    readFile3(path3.join(root, "packaging", "distribution", "provider-packs.lock.json"), "utf8").then(JSON.parse),
    readFile3(path3.join(root, "packaging", "distribution", "license-evidence.lock.json"), "utf8").then(JSON.parse),
    readFile3(path3.join(root, "packaging", "distribution", "node-license-evidence.lock.json"), "utf8").then(JSON.parse),
    loadNativeLauncherToolchain(root)
  ]);
  const componentPaths = validatePayloadLayout(layout, contracts, locks.platform);
  const embeddedComponentSpecs = validateEmbeddedComponentLayout(layout, contracts);
  const sharedComponentSpecs = validateSharedComponentLayout(layout, contracts);
  invariant3(licenseEvidenceLocks.schemaVersion === 1 && Array.isArray(licenseEvidenceLocks.inputs), "license evidence lock is invalid");
  invariant3(nodeLicenseEvidenceLocks.schemaVersion === 1 && Array.isArray(nodeLicenseEvidenceLocks.inputs), "Node license evidence lock is invalid");
  return {
    ...contracts,
    // `signing-policy.json` is intentionally tracked in a blocked state. A
    // protected P6 runner may supply an in-memory provisioned policy after it
    // has checked its protected secrets; it never alters the checkout.
    signingPolicy: signingPolicyOverride ?? contracts.signingPolicy,
    layout,
    locks,
    providerPackLocks,
    licenseEvidenceLocks,
    nodeLicenseEvidenceLocks,
    launcherToolchain,
    componentPaths,
    embeddedComponentSpecs,
    sharedComponentSpecs,
    platform: contracts.platformsById.get(locks.platform)
  };
}
async function copyTree(source, destination, { exclude = () => false } = {}) {
  const sourceRoot = await realpath3(source);
  await mkdir2(destination, { recursive: true, mode: 493 });
  async function visit(sourceDirectory, destinationDirectory, relativeDirectory = "") {
    const entries = await readdir2(sourceDirectory, { withFileTypes: true });
    entries.sort((left, right) => bytewiseCompare3(left.name, right.name));
    for (const entry of entries) {
      const relativePath = relativeDirectory ? path3.posix.join(relativeDirectory, entry.name) : entry.name;
      assertSafeRelativePath(relativePath, "copied input path");
      if (exclude(relativePath, entry)) continue;
      const sourcePath = path3.join(sourceDirectory, entry.name);
      const destinationPath = path3.join(destinationDirectory, entry.name);
      const entryStat = await lstat3(sourcePath);
      if (entryStat.isDirectory()) {
        await mkdir2(destinationPath, { recursive: true, mode: 493 });
        await visit(sourcePath, destinationPath, relativePath);
      } else if (entryStat.isSymbolicLink()) {
        const target = await readlink3(sourcePath);
        invariant3(!path3.isAbsolute(target), `${relativePath}: absolute input symlink is forbidden`);
        const resolved = await realpath3(path3.resolve(path3.dirname(sourcePath), target));
        invariant3(resolved === sourceRoot || resolved.startsWith(`${sourceRoot}${path3.sep}`), `${relativePath}: input symlink escapes its source tree`);
        await symlink2(target, destinationPath);
      } else {
        invariant3(entryStat.isFile(), `${relativePath}: unsupported input file type`);
        const mode = (entryStat.mode & 73) === 0 ? 420 : 493;
        await copyFile(sourcePath, destinationPath);
        await chmod2(destinationPath, mode);
      }
    }
  }
  await visit(source, destination);
}
async function run(command, args, { cwd = REPO_ROOT, env = process2.env, stdin = null } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd, env, stdio: [stdin === null ? "ignore" : "pipe", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) resolve({ stdout, stderr });
      else reject(new Error(`${command} ${args.join(" ")} failed (${code}): ${stderr.trim() || stdout.trim()}`));
    });
    if (stdin !== null) child.stdin.end(stdin);
  });
}
async function downloadLockedArchive(lock, cacheDirectory) {
  await mkdir2(cacheDirectory, { recursive: true, mode: 493 });
  const suffix = lock.archiveType === "zip" ? ".zip" : ".tar.gz";
  const cached = path3.join(cacheDirectory, `${lock.id}-${lock.sha256}${suffix}`);
  if (await exists(cached)) {
    await verifyLockedArchive(cached, lock);
    if (lock.sizeBytes !== void 0) invariant3((await stat2(cached)).size === lock.sizeBytes, `${lock.id}: archive size mismatch`);
    return cached;
  }
  const partial = `${cached}.partial-${process2.pid}`;
  await rm2(partial, { force: true });
  const response = await fetch(lock.url, { redirect: "follow" });
  invariant3(response.ok && response.body, `${lock.id}: download failed with HTTP ${response.status}`);
  try {
    await pipeline(Readable.fromWeb(response.body), createWriteStream(partial, { mode: 420, flags: "wx" }));
    await verifyLockedArchive(partial, lock);
    if (lock.sizeBytes !== void 0) invariant3((await stat2(partial)).size === lock.sizeBytes, `${lock.id}: archive size mismatch`);
    await rename(partial, cached);
  } catch (error) {
    await rm2(partial, { force: true });
    throw error;
  }
  return cached;
}
async function downloadLockedLicenseEvidence(lock, cacheDirectory) {
  invariant3(/^https:\/\//.test(lock.url) && /^[a-f0-9]{64}$/.test(lock.sha256), `${lock.package}: invalid license evidence lock`);
  await mkdir2(cacheDirectory, { recursive: true, mode: 493 });
  const cached = path3.join(cacheDirectory, `license-${lock.sha256}.evidence`);
  if (!await exists(cached)) {
    const partial = `${cached}.partial-${process2.pid}`;
    const response = await fetch(lock.url, { redirect: "follow" });
    invariant3(response.ok && response.body, `${lock.package}: license evidence download failed with HTTP ${response.status}`);
    try {
      await pipeline(Readable.fromWeb(response.body), createWriteStream(partial, { mode: 420, flags: "wx" }));
      invariant3(await sha256File2(partial) === lock.sha256, `${lock.package}: license evidence SHA-256 mismatch`);
      invariant3((await stat2(partial)).size === lock.sizeBytes, `${lock.package}: license evidence size mismatch`);
      await rename(partial, cached);
    } catch (error) {
      await rm2(partial, { force: true });
      throw error;
    }
  }
  invariant3(await sha256File2(cached) === lock.sha256, `${lock.package}: cached license evidence SHA-256 mismatch`);
  invariant3((await stat2(cached)).size === lock.sizeBytes, `${lock.package}: cached license evidence size mismatch`);
  return cached;
}
function componentRoot(payloadRoot, contracts, componentId) {
  const relativePath = contracts.componentPaths.get(componentId);
  invariant3(relativePath, `payload layout has no component root for ${componentId}`);
  return path3.join(payloadRoot, relativePath);
}
async function writeFixtureComponents(payloadRoot, contracts) {
  for (const [componentId, relativeRoot] of contracts.componentPaths) {
    const root = path3.join(payloadRoot, relativeRoot);
    await mkdir2(root, { recursive: true, mode: 493 });
    if (componentId === "jobctrl-launcher") {
      for (const name of ["jobctrl", "jobctrl-installer"]) {
        await writeFile2(path3.join(root, name), `#!/bin/sh
echo fixture:${name}:${contracts.versions[componentId]}
`, { mode: 493 });
        await chmod2(path3.join(root, name), 493);
      }
      continue;
    }
    const executable = ["jobctrl-launcher", "node-runtime", "python-runtime", "temporal-runtime", "playwright-mcp"].includes(componentId);
    const filename = executable ? "bin" : "payload";
    await writeFile2(path3.join(root, filename), `fixture:${componentId}:${contracts.versions[componentId]}
`, { mode: executable ? 493 : 420 });
    await chmod2(path3.join(root, filename), executable ? 493 : 420);
  }
}
function shouldExcludeSourcePath(relativePath) {
  const segments = relativePath.split("/");
  return segments.some((segment) => FORBIDDEN_SEGMENTS.has(segment)) || segments.some((segment) => segment === ".DS_Store" || segment.endsWith(".pyc")) || relativePath.includes("node_modules/.cache/");
}
async function prunePlaywrightDevelopmentMetadata(root) {
  async function visit(directory) {
    for (const entry of await readdir2(directory, { withFileTypes: true })) {
      const entryPath = path3.join(directory, entry.name);
      if (isGitMetadataBasename(entry.name)) await rm2(entryPath, { recursive: true, force: true });
      else if (entry.isDirectory()) await visit(entryPath);
      else if (entry.name.endsWith(".d.ts") || entry.name === "api.json") await rm2(entryPath, { force: true });
    }
  }
  await visit(root);
}
async function prunePlaywrightMcpRuntime(mcpRoot) {
  for (const relativePath of FORBIDDEN_PLAYWRIGHT_MCP_RUNTIME_PATHS) {
    const source = relativePath.replace(/^playwright-mcp\//, "");
    await rm2(path3.join(mcpRoot, ...source.split("/")), { recursive: true, force: true });
  }
  const forbidden = FORBIDDEN_PLAYWRIGHT_MCP_RUNTIME_PATHS.map((relativePath) => relativePath.replace(/^playwright-mcp\//, ""));
  const markdown = (await buildFileInventory(mcpRoot)).filter((file) => file.type === "file" && file.path.toLowerCase().endsWith(".md"));
  for (const file of markdown) await rm2(path3.join(mcpRoot, ...file.path.split("/")), { force: true });
  const inventory = await buildFileInventory(mcpRoot);
  for (const file of inventory) {
    invariant3(
      !forbidden.some((prefix) => file.path === prefix || file.path.startsWith(`${prefix}/`)),
      `${file.path}: Playwright MCP development closure survived pruning`
    );
    invariant3(!file.path.toLowerCase().endsWith(".md"), `${file.path}: Playwright MCP documentation survived pruning`);
  }
}
async function pruneTlsClientForDarwinArm64(workerSite) {
  const dependencies = path3.join(workerSite, "tls_client", "dependencies");
  const retained = /* @__PURE__ */ new Set(["__init__.py", "tls-client-arm64.dylib"]);
  for (const entry of await readdir2(dependencies)) {
    if (!retained.has(entry)) await rm2(path3.join(dependencies, entry), { recursive: true, force: true });
  }
  const actual = (await readdir2(dependencies)).sort(bytewiseCompare3);
  invariant3(
    JSON.stringify(actual) === JSON.stringify([...retained].sort(bytewiseCompare3)),
    `tls-client target prune produced an unexpected dependency closure: ${actual.join(", ")}`
  );
}
async function pruneUnusedPythonRuntime(pythonRoot) {
  const libraryRoot = path3.join(pythonRoot, "lib");
  const dynamicModules = path3.join(libraryRoot, "python3.12", "lib-dynload");
  const removedPaths = [];
  for (const entry of await readdir2(libraryRoot, { withFileTypes: true })) {
    if (entry.isDirectory() && /^(?:tcl|tk|itcl|thread)[0-9]/.test(entry.name) || entry.isFile() && /^lib(?:tcl|tk)[0-9].*\.dylib$/.test(entry.name)) {
      await rm2(path3.join(libraryRoot, entry.name), { recursive: true, force: true });
      removedPaths.push(path3.posix.join("lib", entry.name));
    }
  }
  for (const entry of await readdir2(dynamicModules, { withFileTypes: true })) {
    if (entry.isFile() && /^_tkinter\..*\.so$/.test(entry.name)) {
      await rm2(path3.join(dynamicModules, entry.name), { force: true });
      removedPaths.push(path3.posix.join("lib", "python3.12", "lib-dynload", entry.name));
    }
  }
  const standardLibraryRoot = path3.join(libraryRoot, "python3.12");
  for (const directory of ["idlelib", "tkinter", "turtledemo"]) {
    const optionalGuiRoot = path3.join(standardLibraryRoot, directory);
    if (await exists(optionalGuiRoot)) {
      await rm2(optionalGuiRoot, { recursive: true, force: true });
      removedPaths.push(path3.posix.join("lib", "python3.12", directory));
    }
  }
  const turtlePath = path3.join(standardLibraryRoot, "turtle.py");
  if (await exists(turtlePath)) {
    await rm2(turtlePath, { force: true });
    removedPaths.push(path3.posix.join("lib", "python3.12", "turtle.py"));
  }
  removedPaths.sort(bytewiseCompare3);
  invariant3(removedPaths.length >= 8, `unused Tcl/Tk closure was incomplete: ${removedPaths.join(", ")}`);
  return { id: "python-tcl-tk-unused", status: "pruned", removedPaths };
}
function pythonRecordPath(line) {
  if (line.startsWith('"')) {
    let value = "";
    for (let index = 1; index < line.length; index += 1) {
      if (line[index] !== '"') {
        value += line[index];
        continue;
      }
      if (line[index + 1] === '"') {
        value += '"';
        index += 1;
        continue;
      }
      invariant3(line[index + 1] === ",", "invalid Python RECORD quoted path");
      return value;
    }
    throw new Error("unterminated Python RECORD quoted path");
  }
  const separator = line.indexOf(",");
  invariant3(separator > 0, "invalid Python RECORD row");
  return line.slice(0, separator);
}
async function normalizeInstalledPythonMetadata(sitePackagesRoots) {
  for (const sitePackages of sitePackagesRoots) {
    const distInfoDirectories = (await readdir2(sitePackages, { withFileTypes: true })).filter((entry) => entry.isDirectory() && entry.name.endsWith(".dist-info")).sort((left, right) => bytewiseCompare3(left.name, right.name));
    for (const distInfo of distInfoDirectories) {
      const distInfoRoot = path3.join(sitePackages, distInfo.name);
      await rm2(path3.join(distInfoRoot, "uv_cache.json"), { force: true });
      const recordPath = path3.join(distInfoRoot, "RECORD");
      if (!await exists(recordPath)) continue;
      const rows = (await readFile3(recordPath, "utf8")).split(/\r?\n/).filter(Boolean);
      const canonicalRows = rows.filter((row) => {
        const installedPath = pythonRecordPath(row);
        return !installedPath.startsWith("bin/") && !installedPath.endsWith("/direct_url.json") && !installedPath.endsWith("/uv_cache.json");
      });
      await writeFile2(recordPath, `${canonicalRows.join("\n")}
`, { mode: 420 });
      await chmod2(recordPath, 420);
    }
  }
}
async function writePlaywrightRevisionMarkers(revisionRoot) {
  for (const marker of ["DEPENDENCIES_VALIDATED", "INSTALLATION_COMPLETE"]) {
    await writeFile2(path3.join(revisionRoot, marker), "", { mode: 420 });
    await chmod2(path3.join(revisionRoot, marker), 420);
  }
}
async function prepareApiInputs(root, standardInputs, externalInputs) {
  const apiOutput = path3.join(root, "dist", "api");
  await rm2(apiOutput, { recursive: true, force: true });
  await mkdir2(apiOutput, { recursive: true, mode: 493 });
  await run("corepack", [
    "pnpm",
    "exec",
    "esbuild",
    "apps/api/src/production.ts",
    "--bundle",
    "--platform=node",
    "--format=esm",
    "--target=node22",
    "--external:better-sqlite3",
    "--banner:js=import { createRequire as __jobctrlCreateRequire } from 'node:module'; const require = __jobctrlCreateRequire(import.meta.url);",
    `--outfile=${standardInputs.apiBundle}`,
    `--metafile=${path3.join(apiOutput, "metafile.json")}`,
    "--log-level=warning"
  ], { cwd: root, env: { ...process2.env, SOURCE_DATE_EPOCH: process2.env.SOURCE_DATE_EPOCH ?? "0" } });
  const nativeRuntime = path3.join(root, standardInputs.apiNativeRuntime);
  await rm2(path3.join(nativeRuntime, "node_modules"), { recursive: true, force: true });
  await run("corepack", [
    "pnpm",
    "--dir",
    nativeRuntime,
    "install",
    "--frozen-lockfile",
    "--prod",
    "--ignore-workspace",
    "--ignore-scripts"
  ], {
    cwd: root,
    env: {
      ...process2.env,
      CI: "true",
      PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD: "1"
    }
  });
  const nativeNodeModules = path3.join(root, standardInputs.apiNativeModules, "node_modules");
  await mkdir2(nativeNodeModules, { recursive: true, mode: 493 });
  const runtimeAllowlist = {
    "better-sqlite3": ["LICENSE", "package.json", "lib", "build"],
    bindings: ["LICENSE.md", "bindings.js", "package.json"],
    "file-uri-to-path": ["LICENSE", "index.js", "package.json"]
  };
  let betterSqliteSource = await realpath3(path3.join(nativeRuntime, "node_modules", "better-sqlite3"));
  const packageSources = /* @__PURE__ */ new Map([["better-sqlite3", betterSqliteSource]]);
  const bindingsSource = await realpath3(path3.join(path3.dirname(betterSqliteSource), "bindings"));
  packageSources.set("bindings", bindingsSource);
  packageSources.set("file-uri-to-path", await realpath3(path3.join(path3.dirname(bindingsSource), "file-uri-to-path")));
  for (const packageName of ["better-sqlite3", "bindings", "file-uri-to-path"]) {
    const source = packageSources.get(packageName);
    const allowed = runtimeAllowlist[packageName];
    await copyTree(source, path3.join(nativeNodeModules, packageName), {
      exclude: (relativePath) => shouldExcludeSourcePath(relativePath) || !allowed.some((prefix) => relativePath === prefix || relativePath.startsWith(`${prefix}/`))
    });
  }
  const nativeDestination = path3.join(nativeNodeModules, "better-sqlite3", "build", "Release", "better_sqlite3.node");
  await mkdir2(path3.dirname(nativeDestination), { recursive: true, mode: 493 });
  await copyFile(path3.join(externalInputs.betterSqlitePrebuildRoot, "build", "Release", "better_sqlite3.node"), nativeDestination);
  await chmod2(nativeDestination, 493);
  await requireFile(path3.join(root, standardInputs.apiBundle), "production API bundle");
  await requireFile(path3.join(apiOutput, "metafile.json"), "production API esbuild metafile");
  const nativeModule = path3.join(nativeNodeModules, "better-sqlite3", "build", "Release", "better_sqlite3.node");
  await requireFile(nativeModule, "better-sqlite3 native module");
}
function webContributionBuildInvocation() {
  return {
    command: "corepack",
    args: ["pnpm", "--filter", "@jobctrl/web", "exec", "vite", "build", "--sourcemap", "hidden"]
  };
}
async function prepareWebInputs(root, standardInputs) {
  const invocation = webContributionBuildInvocation();
  await run(invocation.command, invocation.args, {
    cwd: root,
    env: { ...process2.env, SOURCE_DATE_EPOCH: process2.env.SOURCE_DATE_EPOCH ?? "0" }
  });
  await requireDirectory(path3.join(root, standardInputs.webAssets), "production web assets");
  await requireFile(path3.join(root, standardInputs.webAssets, "index.html"), "production web index");
}
async function prepareStandardProductionInputs(root, contracts, externalInputs) {
  await Promise.all([
    prepareApiInputs(root, contracts.layout.standardInputs, externalInputs),
    prepareWebInputs(root, contracts.layout.standardInputs)
  ]);
}
async function copyPreparedApplicationInputs(payloadRoot, root, contracts) {
  const inputs = contracts.layout.standardInputs;
  const apiRoot = componentRoot(payloadRoot, contracts, "jobctrl-api");
  await mkdir2(apiRoot, { recursive: true, mode: 493 });
  await copyFile(path3.join(root, inputs.apiBundle), path3.join(apiRoot, "server.mjs"));
  await chmod2(path3.join(apiRoot, "server.mjs"), 420);
  await copyTree(
    path3.join(root, inputs.apiNativeModules, "node_modules"),
    path3.join(apiRoot, "node_modules"),
    { exclude: shouldExcludeSourcePath }
  );
  const webSource = path3.join(root, inputs.webAssets);
  const webPayload = componentRoot(payloadRoot, contracts, "jobctrl-web");
  const excludeWebBuildInput = (relativePath) => shouldExcludeSourcePath(relativePath) || relativePath.endsWith(".map") || path3.posix.basename(relativePath) === "mockServiceWorker.js" || relativePath.includes("spikes.table-filters");
  await copyTree(webSource, webPayload, { exclude: excludeWebBuildInput });
  await assertCopiedWebRuntimeBytes(webSource, webPayload, excludeWebBuildInput);
}
async function assertCopiedWebRuntimeBytes(sourceRoot, payloadRoot, exclude) {
  const source = (await buildFileInventory(sourceRoot)).filter((file) => !exclude(file.path)).map((file) => ({ path: file.path, type: file.type, mode: file.mode, sizeBytes: file.sizeBytes, sha256: file.sha256, target: file.target ?? null }));
  const payload = (await buildFileInventory(payloadRoot)).map((file) => ({ path: file.path, type: file.type, mode: file.mode, sizeBytes: file.sizeBytes, sha256: file.sha256, target: file.target ?? null }));
  invariant3(
    JSON.stringify(payload) === JSON.stringify(source),
    "web payload runtime bytes differ from the prepared production build outside the explicit packaging exclusions"
  );
  return { status: "exact-runtime-byte-copy", fileCount: payload.length };
}
async function assembleExternalRuntimes(payloadRoot, contracts, cacheDirectory, scratchDirectory) {
  const lockById = new Map(contracts.locks.inputs.map((lock) => [lock.id, lock]));
  const archiveById = /* @__PURE__ */ new Map();
  for (const lock of contracts.locks.inputs) archiveById.set(lock.id, await downloadLockedArchive(lock, cacheDirectory));
  const betterSqlitePrebuildRoot = path3.join(scratchDirectory, "better-sqlite3-node22");
  await extractVerifiedArchive({
    archivePath: archiveById.get("better-sqlite3-node22-prebuild"),
    lock: lockById.get("better-sqlite3-node22-prebuild"),
    destination: betterSqlitePrebuildRoot,
    stripComponents: 0,
    include: (entryPath, entry) => entry.type === "file" && entryPath === "build/Release/better_sqlite3.node"
  });
  const extractedNode = path3.join(scratchDirectory, "node");
  const nodeEntries = await extractVerifiedArchive({
    archivePath: archiveById.get("node-runtime-archive"),
    lock: lockById.get("node-runtime-archive"),
    destination: extractedNode,
    stripComponents: 1,
    include: (entryPath, entry) => entry.type === "file" && (entryPath === "bin/node" || /^(LICENSE|LICENSE\.md|LICENSE\.txt)$/.test(entryPath))
  });
  await assertSymlinksPreserved(extractedNode, nodeEntries);
  const nodeRoot = componentRoot(payloadRoot, contracts, "node-runtime");
  await mkdir2(path3.join(nodeRoot, "bin"), { recursive: true, mode: 493 });
  await copyFile(path3.join(extractedNode, "bin", "node"), path3.join(nodeRoot, "bin", "node"));
  await chmod2(path3.join(nodeRoot, "bin", "node"), 493);
  for (const licenseName of ["LICENSE", "LICENSE.md", "LICENSE.txt"]) {
    if (await exists(path3.join(extractedNode, licenseName))) {
      await copyFile(path3.join(extractedNode, licenseName), path3.join(nodeRoot, licenseName));
      await chmod2(path3.join(nodeRoot, licenseName), 420);
    }
  }
  const pythonRoot = componentRoot(payloadRoot, contracts, "python-runtime");
  const pythonEntries = await extractVerifiedArchive({
    archivePath: archiveById.get("python-runtime-archive"),
    lock: lockById.get("python-runtime-archive"),
    destination: pythonRoot,
    stripComponents: 1
  });
  await assertSymlinksPreserved(pythonRoot, pythonEntries);
  await prunePythonRuntime(pythonRoot);
  await requireResolvedFileWithin(path3.join(pythonRoot, "bin", "python3"), pythonRoot, "bundled Python executable");
  const temporalRoot = componentRoot(payloadRoot, contracts, "temporal-runtime");
  const temporalEntries = await extractVerifiedArchive({
    archivePath: archiveById.get("temporal-runtime-archive"),
    lock: lockById.get("temporal-runtime-archive"),
    destination: temporalRoot,
    stripComponents: 0
  });
  await assertSymlinksPreserved(temporalRoot, temporalEntries);
  await requireFile(path3.join(temporalRoot, "temporal"), "bundled Temporal executable");
  await chmod2(path3.join(temporalRoot, "temporal"), 493);
  const chromiumRoot = componentRoot(payloadRoot, contracts, "chromium-core");
  const headlessRevisionRoot = path3.join(chromiumRoot, "chromium_headless_shell-1208");
  const headlessEntries = await extractVerifiedArchive({
    archivePath: archiveById.get("chromium-core-headless-archive"),
    lock: lockById.get("chromium-core-headless-archive"),
    destination: headlessRevisionRoot,
    stripComponents: 0
  });
  await assertSymlinksPreserved(headlessRevisionRoot, headlessEntries);
  await writePlaywrightRevisionMarkers(headlessRevisionRoot);
  return { lockById, archiveById, betterSqlitePrebuildRoot };
}
async function prunePythonRuntime(pythonRoot) {
  const originalExecutable = await realpath3(path3.join(pythonRoot, "bin", "python3"));
  const stagedExecutable = path3.join(pythonRoot, ".python3-runtime");
  await copyFile(originalExecutable, stagedExecutable);
  await chmod2(stagedExecutable, 493);
  await rm2(path3.join(pythonRoot, "bin"), { recursive: true, force: true });
  await mkdir2(path3.join(pythonRoot, "bin"), { recursive: true, mode: 493 });
  await rename(stagedExecutable, path3.join(pythonRoot, "bin", "python3"));
  for (const removable of [
    "include",
    "share",
    "lib/pkgconfig",
    "lib/python3.12/ensurepip",
    "lib/python3.12/idlelib",
    "lib/python3.12/lib2to3",
    "lib/python3.12/pydoc.py",
    "lib/python3.12/pydoc_data",
    "lib/python3.12/site-packages",
    "lib/python3.12/test",
    "lib/python3.12/tkinter",
    "lib/python3.12/turtledemo",
    "lib/python3.12/venv"
  ]) {
    await rm2(path3.join(pythonRoot, ...removable.split("/")), { recursive: true, force: true });
  }
  const stdlibRoot = path3.join(pythonRoot, "lib", "python3.12");
  for (const entry of await readdir2(stdlibRoot, { withFileTypes: true })) {
    if (entry.isDirectory() && (/^config-/.test(entry.name) || entry.name === "__pycache__")) {
      await rm2(path3.join(stdlibRoot, entry.name), { recursive: true, force: true });
    }
  }
  await pruneInstalledPythonTree(stdlibRoot);
  const binEntries = await readdir2(path3.join(pythonRoot, "bin"));
  invariant3(JSON.stringify(binEntries) === JSON.stringify(["python3"]), "pruned Python runtime must expose only bin/python3");
  const forbiddenNames = ["2to3", "ensurepip", "idle", "pip", "pip3", "pydoc", "setuptools", "wheel"];
  const inventory = await buildFileInventory(pythonRoot);
  for (const file of inventory) {
    const basename = path3.posix.basename(file.path).toLowerCase();
    invariant3(!forbiddenNames.some((name) => basename === name || basename.startsWith(`${name}-`) || basename.startsWith(`${name}.`)), `${file.path}: pruned Python runtime still contains ${basename}`);
  }
  const pythonExecutable = path3.join(pythonRoot, "bin", "python3");
  await run(pythonExecutable, ["-I", "-B", "-c", "import ctypes, hashlib, json, multiprocessing, sqlite3, ssl, urllib.request"], {
    cwd: pythonRoot,
    env: { HOME: pythonRoot, PATH: "/usr/bin:/bin:/usr/sbin:/sbin" }
  });
}
async function assemblePlaywrightMcp(payloadRoot, root, contracts, externalInputs) {
  const runtimeSource = path3.join(root, contracts.layout.standardInputs.playwrightMcpRuntime);
  await run("corepack", [
    "pnpm",
    "--dir",
    runtimeSource,
    "install",
    "--frozen-lockfile",
    "--prod",
    "--no-optional",
    "--ignore-workspace",
    "--ignore-scripts"
  ], { cwd: root, env: { ...process2.env, CI: "true", PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD: "1" } });
  const mcpRoot = componentRoot(payloadRoot, contracts, "playwright-mcp");
  const mcpPackageRoot = path3.join(mcpRoot, "node_modules", "@playwright", "mcp");
  const mcpEntries = await extractVerifiedArchive({
    archivePath: externalInputs.archiveById.get("playwright-mcp-archive"),
    lock: externalInputs.lockById.get("playwright-mcp-archive"),
    destination: mcpPackageRoot,
    stripComponents: 1
  });
  await assertSymlinksPreserved(mcpPackageRoot, mcpEntries);
  const installedNodeModules = path3.join(runtimeSource, "node_modules");
  const installedMcpPackage = await realpath3(path3.join(installedNodeModules, "@playwright", "mcp"));
  const mcpVirtualNodeModules = path3.resolve(installedMcpPackage, "..", "..");
  const coreSource = await realpath3(path3.join(mcpVirtualNodeModules, "playwright-core"));
  await copyTree(coreSource, path3.join(mcpRoot, "node_modules", "playwright-core"), { exclude: shouldExcludeSourcePath });
  const [mcpPackage, corePackage] = await Promise.all([
    readFile3(path3.join(mcpPackageRoot, "package.json"), "utf8").then(JSON.parse),
    readFile3(path3.join(mcpRoot, "node_modules", "playwright-core", "package.json"), "utf8").then(JSON.parse)
  ]);
  invariant3(mcpPackage.version === contracts.versions["playwright-mcp"], "Playwright MCP package version does not match inventory");
  invariant3(corePackage.version === mcpPackage.dependencies["playwright-core"], "Playwright MCP resolved playwright-core version drifted");
  await prunePlaywrightDevelopmentMetadata(mcpRoot);
  await prunePlaywrightMcpRuntime(mcpRoot);
  await mkdir2(path3.join(mcpRoot, "bin"), { recursive: true, mode: 493 });
  await writeFile2(
    path3.join(mcpRoot, "bin", "playwright-mcp"),
    '#!/bin/sh\nexec "$JOBCTRL_PAYLOAD_DIR/node/bin/node" "$JOBCTRL_PAYLOAD_DIR/playwright-mcp/node_modules/@playwright/mcp/cli.js" "$@"\n',
    { mode: 493 }
  );
  await chmod2(path3.join(mcpRoot, "bin", "playwright-mcp"), 493);
}
async function findWorkerWheel(root, version) {
  const wheelDirectory = path3.join(root, "dist");
  await mkdir2(wheelDirectory, { recursive: true, mode: 493 });
  await run("uv", ["build", "--wheel", "--out-dir", wheelDirectory, path3.join(root, "workers", "automation")], {
    cwd: root,
    env: { ...process2.env, SOURCE_DATE_EPOCH: process2.env.SOURCE_DATE_EPOCH ?? "0" }
  });
  const wheels = (await readdir2(wheelDirectory)).filter((name) => name === `jobctrl-${version}-py3-none-any.whl`).sort(bytewiseCompare3);
  invariant3(wheels.length === 1, `expected exactly one JobCtrl ${version} wheel in ${wheelDirectory}`);
  return path3.join(wheelDirectory, wheels[0]);
}
async function preparePythonWorker(payloadRoot, root, contracts, scratchDirectory) {
  const workerRoot = componentRoot(payloadRoot, contracts, "jobctrl-worker");
  const workerSite = path3.join(workerRoot, "site-packages");
  const playwrightRoot = componentRoot(payloadRoot, contracts, "playwright-python");
  const playwrightSite = path3.join(playwrightRoot, "site-packages");
  await Promise.all([
    mkdir2(workerSite, { recursive: true, mode: 493 }),
    mkdir2(playwrightSite, { recursive: true, mode: 493 })
  ]);
  const requirements = path3.join(scratchDirectory, "python-core-requirements.txt");
  const pythonSbom = path3.join(scratchDirectory, "python-core.sbom.cdx.json");
  const exportBase = [
    "export",
    "--project",
    path3.join(root, "workers", "automation"),
    "--frozen",
    "--no-dev",
    "--no-default-groups",
    "--no-emit-project",
    "--python",
    "3.12"
  ];
  await run("uv", [...exportBase, "--output-file", requirements], { cwd: root });
  await run("uv", [...exportBase, "--format", "cyclonedx1.5", "--output-file", pythonSbom], { cwd: root });
  const pythonExecutable = path3.join(componentRoot(payloadRoot, contracts, "python-runtime"), "bin", "python3");
  await run("uv", [
    "pip",
    "install",
    "--python",
    pythonExecutable,
    "--target",
    workerSite,
    "--requirements",
    requirements,
    "--require-hashes",
    "--no-build",
    "--no-deps",
    "--link-mode",
    "copy"
  ], { cwd: root, env: { ...process2.env, UV_NO_PROGRESS: "1" } });
  const wheel = await findWorkerWheel(root, contracts.versions["jobctrl-worker"]);
  await run("uv", [
    "pip",
    "install",
    "--python",
    pythonExecutable,
    "--target",
    workerSite,
    "--no-deps",
    "--link-mode",
    "copy",
    wheel
  ], { cwd: root, env: { ...process2.env, UV_NO_PROGRESS: "1" } });
  const entries = await readdir2(workerSite, { withFileTypes: true });
  for (const entry of entries) {
    if (entry.name === "playwright" || /^playwright-[^-]+\.dist-info$/.test(entry.name)) {
      await rename(path3.join(workerSite, entry.name), path3.join(playwrightSite, entry.name));
    }
  }
  for (const removable of [path3.join(workerRoot, "bin"), path3.join(workerSite, "bin")]) await rm2(removable, { recursive: true, force: true });
  async function removeDirectUrls(directory) {
    for (const entry of await readdir2(directory, { withFileTypes: true })) {
      const entryPath = path3.join(directory, entry.name);
      if (entry.isDirectory()) await removeDirectUrls(entryPath);
      else if (entry.name === "direct_url.json" || entry.name === ".lock" || entry.name.endsWith(".pyc")) await rm2(entryPath, { force: true });
    }
  }
  await Promise.all([removeDirectUrls(workerSite), removeDirectUrls(playwrightSite)]);
  await prunePlaywrightDevelopmentMetadata(playwrightSite);
  await pruneTlsClientForDarwinArm64(workerSite);
  await Promise.all([pruneInstalledPythonTree(workerSite), pruneInstalledPythonTree(playwrightSite)]);
  await normalizeInstalledPythonMetadata([workerSite, playwrightSite]);
  const systemSitePackages = path3.join(componentRoot(payloadRoot, contracts, "python-runtime"), "lib", "python3.12", "site-packages");
  await mkdir2(systemSitePackages, { recursive: true, mode: 493 });
  await writeFile2(
    path3.join(systemSitePackages, "jobctrl-payload.pth"),
    "../../../../worker/site-packages\n../../../../playwright-python/site-packages\n",
    { mode: 420 }
  );
  await run(pythonExecutable, ["-I", "-B", "-m", "jobctrl", "--help"], {
    cwd: payloadRoot,
    env: {
      HOME: path3.join(scratchDirectory, "isolated-home"),
      JOBCTRL_DIR: path3.join(scratchDirectory, "jobctrl-state"),
      JOBCTRL_PAYLOAD_DIR: payloadRoot,
      JOBCTRL_RUNTIME_MODE: "bundled",
      PLAYWRIGHT_BROWSERS_PATH: componentRoot(payloadRoot, contracts, "chromium-core")
    }
  });
  await run(pythonExecutable, [
    "-I",
    "-B",
    "-c",
    "import tls_client\nfrom tls_client.cffi import library\nassert library is not None"
  ], {
    cwd: payloadRoot,
    env: {
      HOME: path3.join(scratchDirectory, "isolated-home"),
      JOBCTRL_DIR: path3.join(scratchDirectory, "jobctrl-state"),
      JOBCTRL_PAYLOAD_DIR: payloadRoot,
      JOBCTRL_RUNTIME_MODE: "bundled",
      PLAYWRIGHT_BROWSERS_PATH: componentRoot(payloadRoot, contracts, "chromium-core")
    }
  });
  return pythonSbom;
}
async function measureProviderPackInstalledTrees(payloadRoot, root, contracts, scratchDirectory) {
  const pythonExecutable = path3.join(componentRoot(payloadRoot, contracts, "python-runtime"), "bin", "python3");
  const lockPath = path3.join(root, "packaging", "distribution", "provider-packs.lock.json");
  const measurementState = path3.join(scratchDirectory, "provider-pack-size-state");
  const script = [
    "import json",
    "from pathlib import Path",
    "from jobctrl.provider_packs import install_provider_pack, load_provider_pack_spec, provider_tree_stats",
    `lock_path = Path(${JSON.stringify(lockPath)})`,
    `state_root = Path(${JSON.stringify(measurementState)})`,
    "payload = json.loads(lock_path.read_text(encoding='utf-8'))",
    "packs = []",
    "for raw in sorted(payload['packs'], key=lambda value: value['id'].encode('utf-8')):",
    "    spec = load_provider_pack_spec(lock_path, pack_id=raw['id'])",
    "    installed = install_provider_pack(spec, app_dir=state_root)",
    "    stats = provider_tree_stats(installed / 'site-packages')",
    "    packs.append({'id': spec.pack_id, 'version': spec.version, 'installedBytes': stats.installed_bytes, 'fileCount': stats.file_count, 'treeSha256': stats.tree_sha256})",
    "print(json.dumps({'schemaVersion': 1, 'measurementStatus': 'exact-locked-wheel-extraction', 'packs': packs}, sort_keys=True))"
  ].join("\n");
  const result = await run(pythonExecutable, ["-I", "-B", "-c", script], {
    cwd: payloadRoot,
    env: {
      HOME: path3.join(scratchDirectory, "provider-pack-measurement-home"),
      JOBCTRL_DIR: measurementState,
      JOBCTRL_PAYLOAD_DIR: payloadRoot,
      JOBCTRL_RUNTIME_MODE: "bundled",
      PLAYWRIGHT_BROWSERS_PATH: componentRoot(payloadRoot, contracts, "chromium-core")
    }
  });
  const measurement = JSON.parse(result.stdout.trim());
  invariant3(measurement?.schemaVersion === 1 && measurement.measurementStatus === "exact-locked-wheel-extraction", "provider-pack installed-tree measurement is invalid");
  invariant3(Array.isArray(measurement.packs), "provider-pack installed-tree measurement has no packs");
  const expected = contracts.providerPackLocks.packs.map((pack) => `${pack.id}@${pack.version}`).sort(bytewiseCompare3);
  const actual = measurement.packs.map((pack) => {
    invariant3(
      typeof pack?.id === "string" && typeof pack.version === "string" && Number.isInteger(pack.installedBytes) && pack.installedBytes >= 0 && Number.isInteger(pack.fileCount) && pack.fileCount >= 0 && /^[a-f0-9]{64}$/.test(pack.treeSha256),
      "provider-pack installed-tree measurement entry is invalid"
    );
    return `${pack.id}@${pack.version}`;
  }).sort(bytewiseCompare3);
  invariant3(JSON.stringify(actual) === JSON.stringify(expected), `provider-pack installed-tree measurement closure drifted: ${actual.join(", ")}`);
  return measurement;
}
function validateReleaseBuildBinding(releaseChannel, releaseTrustKeyBase64) {
  invariant3(RELEASE_CHANNELS2.has(releaseChannel), "native release channel is invalid");
  invariant3(typeof releaseTrustKeyBase64 === "string", "native release trust key must be a string");
  if (releaseChannel === "local") {
    invariant3(releaseTrustKeyBase64 === "", "local native builds must not embed a release trust key");
    return;
  }
  let decoded;
  try {
    decoded = Buffer.from(releaseTrustKeyBase64, "base64");
  } catch {
    throw new Error("signed native builds require a base64 Ed25519 release trust key");
  }
  invariant3(decoded.length === 32 && decoded.toString("base64") === releaseTrustKeyBase64, "signed native builds require a base64 Ed25519 release trust key");
}
function createNativeLauncherBuildPlan({
  payloadRoot,
  root,
  platform,
  sourceDateEpoch,
  goExecutable,
  goRoot,
  binary = "jobctrl",
  releaseChannel = "local",
  releaseTrustKeyBase64 = ""
}) {
  invariant3(platform?.os === "darwin" && platform?.arch === "arm64", "native launcher build target must be darwin-arm64");
  invariant3(Number.isInteger(sourceDateEpoch) && sourceDateEpoch >= 0, "native launcher SOURCE_DATE_EPOCH must be non-negative");
  invariant3(typeof goExecutable === "string" && path3.isAbsolute(goExecutable), "native launcher compiler executable must be an absolute verified path");
  invariant3(typeof goRoot === "string" && path3.isAbsolute(goRoot), "native launcher GOROOT must be an absolute verified path");
  invariant3(["jobctrl", "jobctrl-installer"].includes(binary), "native binary must be jobctrl or jobctrl-installer");
  validateReleaseBuildBinding(releaseChannel, releaseTrustKeyBase64);
  const ldflags = [
    "-s",
    "-w",
    "-buildid=",
    `-X github.com/ebarti/jobctrl/launcher/internal/launcher.releaseChannel=${releaseChannel}`
  ];
  if (releaseTrustKeyBase64) {
    ldflags.push(`-X github.com/ebarti/jobctrl/launcher/internal/launcher.releaseTrustKeyBase64=${releaseTrustKeyBase64}`);
  }
  return {
    command: goExecutable,
    args: ["build", "-buildvcs=false", "-trimpath", `-ldflags=${ldflags.join(" ")}`, "-o", path3.join(payloadRoot, "launcher", binary), `./cmd/${binary}`],
    cwd: path3.join(root, "launcher"),
    environment: {
      CGO_ENABLED: "0",
      GOOS: "darwin",
      GOARCH: "arm64",
      // The extracted, checksum-verified official archive is the only GOROOT
      // accepted by the release builder. This blocks ambient Go installations,
      // user configuration, experiments, and architecture tuning from changing
      // launcher bytes.
      GOROOT: goRoot,
      GOENV: "off",
      GOFLAGS: "",
      GOWORK: "off",
      GOTOOLCHAIN: "local",
      GOEXPERIMENT: "",
      GOARM64: "v8.0",
      SOURCE_DATE_EPOCH: String(sourceDateEpoch)
    }
  };
}
async function prepareNativeGoToolchain(root, cacheDirectory, scratchDirectory, toolchain) {
  const lock = nativeGoArchiveLock(toolchain);
  const archivePath = await downloadLockedArchive(lock, cacheDirectory);
  const goRoot = path3.join(scratchDirectory, "go-toolchain");
  const entries = await extractVerifiedArchive({
    archivePath,
    lock,
    destination: goRoot,
    stripComponents: 1,
    // The official Go archive's `go/test` corpus is not needed to compile the
    // launcher. It contains upstream regression fixtures with non-ASCII names
    // that intentionally violate the portable payload path policy, so discard
    // only that fixed top-level test subtree before extraction.
    skipEntry: (rawPath) => rawPath.startsWith("go/test/")
  });
  await assertSymlinksPreserved(goRoot, entries);
  const goExecutable = await requireFile(path3.join(goRoot, "bin", "go"), "pinned Go compiler executable");
  await chmod2(goExecutable, 493);
  const licensePath = await requireFile(path3.join(goRoot, "LICENSE"), "pinned Go compiler license");
  invariant3(await sha256File2(licensePath) === toolchain.licenseSha256, "pinned Go compiler license does not match the toolchain contract");
  const environment = {
    ...process2.env,
    GOROOT: goRoot,
    GOENV: "off",
    GOFLAGS: "",
    GOWORK: "off",
    GOTOOLCHAIN: "local",
    GOEXPERIMENT: "",
    GOARM64: "v8.0"
  };
  const version = (await run(goExecutable, ["version"], { cwd: root, env: environment })).stdout.trim();
  invariant3(version === `go version ${toolchain.goVersion} darwin/arm64`, `pinned Go compiler version is ${version}, expected ${toolchain.goVersion} darwin/arm64`);
  return { archivePath, lock, goExecutable, goRoot, version };
}
async function writeGeneratedComponents(payloadRoot, root, contracts, sourceDateEpoch, nativeGoToolchain, releaseBuild = {}) {
  const launcherRoot = componentRoot(payloadRoot, contracts, "jobctrl-launcher");
  await mkdir2(launcherRoot, { recursive: true, mode: 493 });
  invariant3(nativeGoToolchain?.lock?.sha256 === contracts.launcherToolchain.archive.sha256, "native launcher compiler does not match the locked toolchain contract");
  for (const binary of ["jobctrl", "jobctrl-installer"]) {
    const plan = createNativeLauncherBuildPlan({
      payloadRoot,
      root,
      platform: contracts.platform,
      sourceDateEpoch,
      goExecutable: nativeGoToolchain.goExecutable,
      goRoot: nativeGoToolchain.goRoot,
      binary,
      ...releaseBuild
    });
    await run(plan.command, plan.args, { cwd: plan.cwd, env: { ...process2.env, ...plan.environment } });
  }
  await chmod2(path3.join(launcherRoot, "jobctrl"), 493);
  await chmod2(path3.join(launcherRoot, "jobctrl-installer"), 493);
  await copyFile(path3.join(root, "launcher", "runtime-manifest.json"), path3.join(launcherRoot, "runtime-manifest.json"));
  await chmod2(path3.join(launcherRoot, "runtime-manifest.json"), 420);
  const pdfjsRoot = componentRoot(payloadRoot, contracts, "pdfjs-renderer");
  await mkdir2(pdfjsRoot, { recursive: true, mode: 493 });
  await writeJson(path3.join(pdfjsRoot, "renderer.json"), {
    schemaVersion: 1,
    implementation: "pdfjs-dist",
    version: contracts.versions["pdfjs-renderer"],
    embeddedIn: contracts.componentPaths.get("jobctrl-web"),
    popplerRequired: false
  });
}
async function findLicenseFiles(packageRoot) {
  const candidates = [];
  async function visit(directory, depth) {
    if (depth > 2) return;
    const entries = await readdir2(directory, { withFileTypes: true });
    entries.sort((left, right) => bytewiseCompare3(left.name, right.name));
    for (const entry of entries) {
      const entryPath = path3.join(directory, entry.name);
      if (entry.isDirectory() && /^(licenses?|legal)$/i.test(entry.name)) await visit(entryPath, depth + 1);
      else if (entry.isFile() && /^(licen[cs]e|copying|notice|thirdpartynotices)([-.].*)?$/i.test(entry.name)) candidates.push(entryPath);
    }
  }
  await visit(packageRoot, 0);
  return candidates;
}
function npmPackageKey(name, version) {
  invariant3(typeof name === "string" && name.length > 0, "npm package name is required");
  invariant3(typeof version === "string" && version.length > 0, `${name}: npm package version is required`);
  return `${name}@${version}`;
}
function safeRelativePath(root, target, label) {
  const relative = path3.relative(root, target);
  invariant3(relative && !relative.startsWith(`..${path3.sep}`) && relative !== ".." && !path3.isAbsolute(relative), `${label} escapes its root`);
  return relative.split(path3.sep).join("/");
}
async function loadNpmPackageIdentity(packageRoot, contribution) {
  const packageJsonPath = path3.join(packageRoot, "package.json");
  const packageJson = JSON.parse(await readFile3(packageJsonPath, "utf8"));
  const name = packageJson.name;
  const version = packageJson.version;
  invariant3(typeof name === "string" && typeof version === "string", `${packageRoot}: package.json has no name/version`);
  invariant3(typeof packageJson.license === "string" && !/unknown|unlicensed|noassertion/i.test(packageJson.license), `${name}@${version}: unresolved npm runtime license`);
  return {
    key: npmPackageKey(name, version),
    name,
    version,
    license: packageJson.license,
    attribution: typeof packageJson.author === "string" ? packageJson.author : packageJson.author?.name ?? "See package source",
    source: typeof packageJson.homepage === "string" && packageJson.homepage ? packageJson.homepage : "See package.json",
    packageRoot,
    contribution
  };
}
async function npmIdentityForContributingSource(root, sourcePath, contribution) {
  const candidate = path3.resolve(root, sourcePath);
  const relative = path3.relative(root, candidate);
  if (relative.startsWith(`..${path3.sep}`) || relative === ".." || path3.isAbsolute(relative)) return null;
  const segments = relative.split(path3.sep);
  const nodeModulesIndex = segments.lastIndexOf("node_modules");
  if (nodeModulesIndex === -1 || nodeModulesIndex === segments.length - 1) return null;
  try {
    await stat2(candidate);
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    throw error;
  }
  const firstPackageSegment = segments[nodeModulesIndex + 1];
  const packageSegmentCount = firstPackageSegment.startsWith("@") ? 2 : 1;
  invariant3(
    nodeModulesIndex + packageSegmentCount < segments.length || !firstPackageSegment.startsWith("@"),
    `${sourcePath}: incomplete scoped npm package path`
  );
  const packageRoot = path3.join(root, ...segments.slice(0, nodeModulesIndex + 1 + packageSegmentCount));
  if (!await exists(path3.join(packageRoot, "package.json"))) return null;
  return loadNpmPackageIdentity(packageRoot, contribution);
}
function mergeNpmContributors(contributors) {
  const merged = /* @__PURE__ */ new Map();
  for (const contributor of contributors.filter(Boolean)) {
    const previous = merged.get(contributor.key);
    if (!previous) {
      merged.set(contributor.key, {
        ...contributor,
        packageRoots: /* @__PURE__ */ new Set([contributor.packageRoot]),
        contributions: /* @__PURE__ */ new Map([[JSON.stringify(contributor.contribution), { ...contributor.contribution, sourceCount: 1 }]])
      });
      continue;
    }
    invariant3(previous.license === contributor.license, `${contributor.key}: contributing package roots disagree on license`);
    previous.packageRoots.add(contributor.packageRoot);
    const contributionKey = JSON.stringify(contributor.contribution);
    const existing = previous.contributions.get(contributionKey);
    if (existing) existing.sourceCount += 1;
    else previous.contributions.set(contributionKey, { ...contributor.contribution, sourceCount: 1 });
  }
  return [...merged.values()].sort((left, right) => bytewiseCompare3(left.key, right.key));
}
async function collectApiBundleContributors(root, apiBundle) {
  const metafilePath = path3.join(path3.dirname(apiBundle), "metafile.json");
  const metafile = JSON.parse(await readFile3(metafilePath, "utf8"));
  const contributors = [];
  for (const sourcePath of Object.keys(metafile.inputs ?? {}).sort(bytewiseCompare3)) {
    const contributor = await npmIdentityForContributingSource(root, sourcePath, {
      kind: "api-esbuild-metafile",
      artifactPath: "api/server.mjs"
    });
    if (contributor) contributors.push(contributor);
  }
  return contributors;
}
async function collectWebBundleContributors(root, webAssets) {
  const maps = (await buildFileInventory(webAssets)).filter((file) => file.type === "file" && file.path.endsWith(".map")).sort((left, right) => bytewiseCompare3(left.path, right.path));
  invariant3(maps.length > 0, "production web build did not emit hidden source maps for contribution evidence");
  const contributors = [];
  try {
    for (const map of maps) {
      const mapPath = path3.join(webAssets, ...map.path.split("/"));
      const sourceMap = JSON.parse(await readFile3(mapPath, "utf8"));
      invariant3(Array.isArray(sourceMap.sources), `${map.path}: web source map has no sources`);
      invariant3(sourceMap.sourceRoot === void 0 || typeof sourceMap.sourceRoot === "string", `${map.path}: web source map has an invalid sourceRoot`);
      for (const sourcePath of sourceMap.sources) {
        if (typeof sourcePath !== "string" || sourcePath.startsWith("\0")) continue;
        const resolved = path3.resolve(path3.dirname(mapPath), sourceMap.sourceRoot ?? "", sourcePath);
        const contributor = await npmIdentityForContributingSource(root, resolved, {
          kind: "web-hidden-sourcemap",
          artifactPath: "web"
        });
        if (contributor) contributors.push(contributor);
      }
    }
  } finally {
    for (const map of maps) await rm2(path3.join(webAssets, ...map.path.split("/")), { force: true });
  }
  invariant3(!(await buildFileInventory(webAssets)).some((file) => file.path.endsWith(".map")), "web contribution source maps survived build evidence collection");
  return contributors;
}
async function collectPayloadNpmContributors(payloadRoot, nodeModules, { expectedKeys = null } = {}) {
  const contributors = [];
  const visitedNodeModules = /* @__PURE__ */ new Set();
  async function visitPackage(packageRoot) {
    const relativePath = safeRelativePath(payloadRoot, packageRoot, "payload npm package");
    contributors.push(await loadNpmPackageIdentity(packageRoot, {
      kind: "payload-npm-tree",
      artifactPath: relativePath
    }));
    async function visit(directory) {
      for (const entry of await readdir2(directory, { withFileTypes: true })) {
        if (!entry.isDirectory() || entry.isSymbolicLink()) continue;
        invariant3(entry.name !== ".pnpm", `${safeRelativePath(payloadRoot, directory, "payload npm package")}: pnpm virtual-store content is forbidden in the payload`);
        const entryPath = path3.join(directory, entry.name);
        if (entry.name === "node_modules") await visitNodeModules(entryPath);
        else await visit(entryPath);
      }
    }
    await visit(packageRoot);
  }
  async function visitNodeModules(directory) {
    const resolved = await realpath3(directory);
    if (visitedNodeModules.has(resolved)) return;
    visitedNodeModules.add(resolved);
    for (const entry of await readdir2(directory, { withFileTypes: true })) {
      if (!entry.isDirectory() || entry.isSymbolicLink()) continue;
      invariant3(entry.name !== ".pnpm", `${safeRelativePath(payloadRoot, directory, "payload npm node_modules")}: pnpm virtual-store content is forbidden in the payload`);
      if (entry.name.startsWith("@")) {
        for (const scoped of await readdir2(path3.join(directory, entry.name), { withFileTypes: true })) {
          if (scoped.isDirectory() && !scoped.isSymbolicLink()) await visitPackage(path3.join(directory, entry.name, scoped.name));
        }
      } else {
        await visitPackage(path3.join(directory, entry.name));
      }
    }
  }
  await visitNodeModules(nodeModules);
  const merged = mergeNpmContributors(contributors);
  if (expectedKeys !== null) {
    invariant3(
      JSON.stringify(merged.map((entry) => entry.key)) === JSON.stringify([...expectedKeys].sort(bytewiseCompare3)),
      `payload npm package closure drifted: ${merged.map((entry) => entry.key).join(", ")}`
    );
  }
  return merged;
}
async function collectMcpNodeContributors(payloadRoot, contracts) {
  const mcpRoot = componentRoot(payloadRoot, contracts, "playwright-mcp");
  return collectPayloadNpmContributors(payloadRoot, path3.join(mcpRoot, "node_modules"), {
    expectedKeys: /* @__PURE__ */ new Set([
      `@playwright/mcp@${contracts.versions["playwright-mcp"]}`,
      "playwright-core@1.62.0-alpha-2026-06-29"
    ])
  });
}
async function collectNodeContributors(payloadRoot, root, contracts) {
  const inputs = contracts.layout.standardInputs;
  const [apiBundle, webBundle, apiPayload, mcpPayload] = await Promise.all([
    collectApiBundleContributors(root, path3.join(root, inputs.apiBundle)),
    collectWebBundleContributors(root, path3.join(root, inputs.webAssets)),
    collectPayloadNpmContributors(payloadRoot, path3.join(componentRoot(payloadRoot, contracts, "jobctrl-api"), "node_modules")),
    collectMcpNodeContributors(payloadRoot, contracts)
  ]);
  return mergeNpmContributors([...apiBundle, ...webBundle, ...apiPayload, ...mcpPayload]);
}
function assertNodeAttributionClosure(contributors, nodeInventory) {
  const contributorKeys = new Set(contributors.map((entry) => entry.key ?? npmPackageKey(entry.name, entry.version)));
  const attributedKeys = /* @__PURE__ */ new Set();
  for (const entry of nodeInventory.packages ?? []) {
    invariant3(Array.isArray(entry.versions) && entry.versions.length === 1, `${entry.name}: Node SBOM package entry must have exactly one version`);
    invariant3(Array.isArray(entry.contributions) && entry.contributions.length > 0, `${entry.name}@${entry.versions[0]}: Node SBOM package lacks a concrete contribution reference`);
    attributedKeys.add(npmPackageKey(entry.name, entry.versions[0]));
  }
  const missing = [...contributorKeys].filter((key) => !attributedKeys.has(key)).sort(bytewiseCompare3);
  const extra = [...attributedKeys].filter((key) => !contributorKeys.has(key)).sort(bytewiseCompare3);
  invariant3(missing.length === 0 && extra.length === 0, `Node SBOM/license closure mismatch; missing=${missing.join(",")}; extra=${extra.join(",")}`);
  return true;
}
async function localMitMetadataEvidence(contributor) {
  if (contributor.license !== "MIT") return null;
  const metadataPaths = [...contributor.packageRoots].map((packageRoot) => path3.join(packageRoot, "package.json")).sort(bytewiseCompare3);
  for (const metadataPath of metadataPaths) {
    const metadata = JSON.parse(await readFile3(metadataPath, "utf8"));
    if (metadata.name === contributor.name && metadata.version === contributor.version && metadata.license === "MIT") {
      return [metadataPath, path3.join(DISTRIBUTION_DIR, "licenses", "MIT.txt")];
    }
  }
  return null;
}
async function collectNodeLicenseInventory(contracts, cacheDirectory, contributors) {
  const packages = [];
  const licenseSources = [];
  for (const contributor of contributors) {
    let evidence = [];
    for (const packageRoot of contributor.packageRoots) evidence.push(...await findLicenseFiles(packageRoot));
    if (evidence.length === 0) {
      const localMitEvidence = await localMitMetadataEvidence(contributor);
      if (localMitEvidence) evidence = localMitEvidence;
    }
    if (evidence.length === 0) {
      const lockedEvidence = contracts.nodeLicenseEvidenceLocks.inputs.find((input) => input.package === contributor.name && input.version === contributor.version);
      invariant3(lockedEvidence, `${contributor.key}: Node runtime package has no package license/notice or locked evidence`);
      invariant3(lockedEvidence.license === contributor.license, `${contributor.key}: Node locked license evidence expression does not match package metadata`);
      evidence = [await downloadLockedLicenseEvidence(lockedEvidence, cacheDirectory)];
      if (lockedEvidence.evidenceKind === "package-metadata-plus-canonical-text") evidence.push(path3.join(DISTRIBUTION_DIR, "licenses", "MIT.txt"));
      else invariant3(lockedEvidence.evidenceKind === "license-text", `${contributor.key}: unsupported Node license evidence kind`);
    }
    const contributions = [...contributor.contributions.values()].sort((left, right) => bytewiseCompare3(JSON.stringify(left), JSON.stringify(right)));
    packages.push({
      name: contributor.name,
      versions: [contributor.version],
      license: contributor.license,
      attribution: contributor.attribution,
      source: contributor.source,
      contributions
    });
    for (const source of [...new Set(evidence)].sort(bytewiseCompare3)) licenseSources.push({ subject: `npm:${contributor.key}`, source });
  }
  packages.sort((left, right) => bytewiseCompare3(`${left.name}@${left.versions[0]}`, `${right.name}@${right.versions[0]}`));
  const inventory = { schemaVersion: 1, status: "complete", packages };
  assertNodeAttributionClosure(contributors, inventory);
  return { inventory, licenseSources };
}
async function collectPythonLicenseEvidence(payloadRoot, contracts, cacheDirectory) {
  const roots = [
    path3.join(componentRoot(payloadRoot, contracts, "jobctrl-worker"), "site-packages"),
    path3.join(componentRoot(payloadRoot, contracts, "playwright-python"), "site-packages")
  ];
  const packages = [];
  const licenseSources = [];
  for (const sitePackages of roots) {
    for (const entry of (await readdir2(sitePackages, { withFileTypes: true })).sort((left, right) => bytewiseCompare3(left.name, right.name))) {
      if (!entry.isDirectory() || !entry.name.endsWith(".dist-info")) continue;
      const metadataPath = path3.join(sitePackages, entry.name, "METADATA");
      const metadata = await readFile3(metadataPath, "utf8");
      const name = metadata.match(/^Name: (.+)$/m)?.[1];
      const version = metadata.match(/^Version: (.+)$/m)?.[1];
      invariant3(name && version, `${entry.name}: Python METADATA is missing Name or Version`);
      let evidence = await findLicenseFiles(path3.join(sitePackages, entry.name));
      if (canonicalPackageName(name) === "jobctrl" && evidence.length === 0) evidence = [path3.join(REPO_ROOT, "LICENSE")];
      const license = await resolvePythonLicense(metadata, evidence);
      invariant3(license && !/unknown|noassertion/i.test(license), `${name}: Python package has unresolved license metadata`);
      if (evidence.length === 0) {
        const lockedEvidence = contracts.licenseEvidenceLocks.inputs.find((input) => input.package === canonicalPackageName(name) && input.version === version);
        invariant3(lockedEvidence, `${name}: Python production dependency has no wheel license/notice file or locked fallback`);
        invariant3(lockedEvidence.license === license, `${name}: locked license evidence expression does not match package metadata`);
        evidence = [await downloadLockedLicenseEvidence(lockedEvidence, cacheDirectory)];
      }
      packages.push({ name, version, license });
      for (const source of evidence) licenseSources.push({ subject: `pypi:${name}`, source });
    }
  }
  invariant3(packages.length > 0, "Python production closure contains no dist-info metadata");
  packages.sort((left, right) => bytewiseCompare3(left.name, right.name));
  return { packages, licenseSources };
}
async function resolvePythonLicense(metadata, evidence) {
  const expression = metadata.match(/^License-Expression: (.+)$/m)?.[1]?.trim();
  if (expression && !/unknown|noassertion/i.test(expression)) return normalizeSpdxExpression(expression);
  const declared = metadata.match(/^License: (.+)$/m)?.[1]?.trim();
  if (declared && !/unknown|noassertion/i.test(declared)) return normalizeSpdxExpression(declared);
  const classifiers = [...metadata.matchAll(/^Classifier: License :: OSI Approved :: (.+)$/gm)].map((match) => match[1]);
  const classifierMap = /* @__PURE__ */ new Map([
    ["MIT License", "MIT"],
    ["Apache Software License", "Apache-2.0"],
    ["Mozilla Public License 2.0 (MPL 2.0)", "MPL-2.0"],
    ["Python Software Foundation License", "PSF-2.0"],
    ["ISC License (ISCL)", "ISC"]
  ]);
  for (const classifier of classifiers) if (classifierMap.has(classifier)) return classifierMap.get(classifier);
  const combined = (await Promise.all(evidence.map((file) => readFile3(file, "utf8")))).join("\n").slice(0, 2e4);
  if (/Permission is hereby granted, free of charge, to any person obtaining a copy/i.test(combined)) return "MIT";
  if (/Licensed under the Apache License, Version 2\.0/i.test(combined)) return "Apache-2.0";
  if (/Redistribution and use in source and binary forms.*Neither the name/is.test(combined)) return "BSD-3-Clause";
  if (/Redistribution and use in source and binary forms/is.test(combined)) return "BSD-2-Clause";
  return null;
}
function normalizeSpdxExpression(value) {
  const legacy = /* @__PURE__ */ new Map([
    ["MIT License", "MIT"],
    ["Apache 2.0", "Apache-2.0"],
    ["Apache Software License", "Apache-2.0"],
    ["BSD 3-Clause License", "BSD-3-Clause"],
    ["3-Clause BSD License", "BSD-3-Clause"],
    ["ISC License", "ISC"],
    ["Dual License", "Apache-2.0 OR BSD-3-Clause"],
    ["Copyright (c) 2005-2023, NumPy Developers.", "BSD-3-Clause"]
  ]);
  if (legacy.has(value)) return legacy.get(value);
  const normalized = value.replace(/\s+and\s+/gi, " AND ").replace(/\s+or\s+/gi, " OR ").replace(/\s+with\s+/gi, " WITH ").trim();
  invariant3(
    /^[A-Za-z0-9.+-]+(?:\s+(?:AND|OR|WITH)\s+[A-Za-z0-9.+-]+)*$/.test(normalized),
    `invalid SPDX license expression ${JSON.stringify(value)}`
  );
  return normalized;
}
async function reconcilePythonSbom(pythonSbomPath, installedPackages, { sourceDateEpoch }) {
  invariant3(Number.isInteger(sourceDateEpoch) && sourceDateEpoch >= 0, "Python SBOM sourceDateEpoch must be a non-negative integer");
  const sbom = JSON.parse(await readFile3(pythonSbomPath, "utf8"));
  const sbomByKey = /* @__PURE__ */ new Map();
  for (const component of sbom.components ?? []) {
    const key = `${canonicalPackageName(component.name)}@${component.version}`;
    invariant3(!sbomByKey.has(key), `Python SBOM has duplicate component ${key}`);
    sbomByKey.set(key, component);
  }
  const installedByKey = new Map(installedPackages.map((entry) => [
    `${canonicalPackageName(entry.name)}@${entry.version}`,
    entry
  ]));
  const expectedKeys = [...installedByKey.keys()].filter((key) => !key.startsWith("jobctrl@")).sort(bytewiseCompare3);
  const missing = expectedKeys.filter((key) => !sbomByKey.has(key));
  invariant3(missing.length === 0, `Python SBOM is missing installed core packages: ${missing.join(", ")}`);
  sbom.components = (sbom.components ?? []).filter((component) => installedByKey.has(`${canonicalPackageName(component.name)}@${component.version}`));
  const actualKeys = sbom.components.map((component) => `${canonicalPackageName(component.name)}@${component.version}`).sort(bytewiseCompare3);
  invariant3(
    JSON.stringify(actualKeys) === JSON.stringify(expectedKeys),
    `target-filtered Python SBOM does not equal installed core closure (expected ${expectedKeys.length}, received ${actualKeys.length})`
  );
  for (const component of sbom.components) {
    const key = `${canonicalPackageName(component.name)}@${component.version}`;
    const installed = installedByKey.get(key);
    component.licenses = [{ expression: installed.license }];
  }
  sbom.metadata ??= {};
  const serialSeed = `jobctrl:python-core:darwin-arm64:${sourceDateEpoch}:${actualKeys.join(",")}`;
  sbom.serialNumber = `urn:uuid:${createHash3("sha256").update(serialSeed).digest("hex").replace(/^(.{8})(.{4})(.{4})(.{4})(.{12}).*$/, "$1-$2-$3-$4-$5")}`;
  sbom.metadata.timestamp = new Date(sourceDateEpoch * 1e3).toISOString();
  sbom.metadata.properties = [...sbom.metadata.properties ?? [], {
    name: "jobctrl:target-filter",
    value: "darwin-arm64-cpython-3.12-installed-core-closure"
  }];
  sbom.components.sort((left, right) => bytewiseCompare3(left.name, right.name));
  await writeJson(pythonSbomPath, sbom);
  return sbom;
}
async function firstExisting(paths, label) {
  for (const candidate of paths) if (await exists(candidate)) return candidate;
  throw new Error(`${label}: required license evidence is missing`);
}
async function collectTopLevelLicenseEvidence(payloadRoot, root, contracts) {
  const mcpRoot = componentRoot(payloadRoot, contracts, "playwright-mcp");
  const pythonRoot = componentRoot(payloadRoot, contracts, "python-runtime");
  const nodeRoot = componentRoot(payloadRoot, contracts, "node-runtime");
  const temporalRoot = componentRoot(payloadRoot, contracts, "temporal-runtime");
  const sources = [];
  const add = async (subject, candidates) => sources.push({ subject, source: await firstExisting(candidates, subject) });
  await add("jobctrl", [path3.join(root, "LICENSE")]);
  await add("go-standard-library", [path3.join(root, "launcher", "GO-LICENSE")]);
  await add("node-runtime", [path3.join(nodeRoot, "LICENSE"), path3.join(nodeRoot, "LICENSE.md"), path3.join(nodeRoot, "LICENSE.txt")]);
  await add("python-runtime", [
    path3.join(pythonRoot, "LICENSE.txt"),
    path3.join(pythonRoot, "LICENSE"),
    path3.join(pythonRoot, "lib", "python3.12", "LICENSE.txt")
  ]);
  await add("temporal-runtime", [path3.join(temporalRoot, "LICENSE"), path3.join(temporalRoot, "LICENSE.txt")]);
  await add("pdfjs-renderer", [
    path3.join(root, "apps", "web", "node_modules", "pdfjs-dist", "LICENSE"),
    path3.join(root, "node_modules", "pdfjs-dist", "LICENSE")
  ]);
  await add("font-jetbrains-mono", [
    path3.join(root, "apps", "web", "node_modules", "@fontsource-variable", "jetbrains-mono", "LICENSE"),
    path3.join(root, "node_modules", "@fontsource-variable", "jetbrains-mono", "LICENSE")
  ]);
  await add("font-plus-jakarta-sans", [
    path3.join(root, "apps", "web", "node_modules", "@fontsource-variable", "plus-jakarta-sans", "LICENSE"),
    path3.join(root, "node_modules", "@fontsource-variable", "plus-jakarta-sans", "LICENSE")
  ]);
  await add("playwright-mcp", [path3.join(mcpRoot, "node_modules", "@playwright", "mcp", "LICENSE")]);
  await add("playwright-core-node", [path3.join(mcpRoot, "node_modules", "playwright-core", "LICENSE")]);
  await add("chromium-core", [path3.join(root, "packaging", "distribution", "licenses", "Chromium-BSD-3-Clause.txt")]);
  return sources;
}
async function browserCreditsEvidence(payloadRoot, contracts) {
  const chromiumRoot = componentRoot(payloadRoot, contracts, "chromium-core");
  const inventory = await buildFileInventory(chromiumRoot);
  const credits = inventory.filter((file) => file.type === "file" && /(^|\/)(LICENSE\.headless_shell|credits|(?:headless_)?resources\.pak|third.?party)/i.test(file.path));
  invariant3(credits.length > 0, "Chromium headless-shell payload contains no license/notice resource");
  return credits.map((file) => ({
    subject: "chromium-core",
    payloadPath: path3.posix.join(contracts.componentPaths.get("chromium-core"), file.path),
    sha256: file.sha256,
    note: "The bundled Chromium headless shell ships this signed license/notice resource verbatim."
  }));
}
async function captureChromiumCredits(payloadRoot, contracts, scratchDirectory) {
  const source = path3.join(
    componentRoot(payloadRoot, contracts, "chromium-core"),
    "chromium_headless_shell-1208",
    "chrome-headless-shell-mac-arm64",
    "LICENSE.headless_shell"
  );
  await requireFile(source, "bundled Chromium headless-shell license/notice evidence");
  invariant3((await stat2(source)).size > 1e5, "bundled Chromium headless-shell license/notice evidence is unexpectedly small");
  return source;
}
async function materializeLicenseSources(releaseRoot, sources) {
  const records = [];
  const copied = /* @__PURE__ */ new Map();
  for (const entry of sources.sort((left, right) => bytewiseCompare3(`${left.subject}:${left.source}`, `${right.subject}:${right.source}`))) {
    const digest = await sha256File2(entry.source);
    const extension = path3.extname(entry.source).toLowerCase();
    const filename = `${digest}${extension && extension.length <= 8 ? extension : ".txt"}`;
    if (!copied.has(digest)) {
      const destination = path3.join(releaseRoot, "licenses", "texts", filename);
      await mkdir2(path3.dirname(destination), { recursive: true, mode: 493 });
      await copyFile(entry.source, destination);
      await chmod2(destination, 420);
      copied.set(digest, path3.posix.join("licenses", "texts", filename));
    }
    records.push({ subject: entry.subject, sha256: digest, path: copied.get(digest) });
  }
  return records;
}
async function pruneTemporalBridgeBuildSources(sitePackages) {
  const bridgeRoot = path3.join(sitePackages, "temporalio", "bridge");
  if (!await exists(bridgeRoot)) return { status: "temporal-bridge-not-installed", removedPaths: [] };
  const removedPaths = [];
  for (const relativePath of TEMPORAL_BRIDGE_BUILD_SOURCE_PATHS) {
    const candidate = path3.join(sitePackages, ...relativePath.split("/"));
    if (await exists(candidate)) removedPaths.push(relativePath);
  }
  if (removedPaths.length === 0) return { status: "temporal-bridge-build-sources-absent", removedPaths };
  const bridgeEntries = await readdir2(bridgeRoot, { withFileTypes: true });
  const nativeBridge = bridgeEntries.find((entry) => entry.isFile() && /^temporal_sdk_bridge(?:\.[A-Za-z0-9_+-]+)?\.so$/.test(entry.name));
  invariant3(nativeBridge, "Temporal bridge build sources cannot be pruned without the compiled temporal_sdk_bridge extension");
  await Promise.all(removedPaths.map((relativePath) => rm2(path3.join(sitePackages, ...relativePath.split("/")), { recursive: true, force: true })));
  for (const relativePath of TEMPORAL_BRIDGE_BUILD_SOURCE_PATHS) {
    invariant3(!await exists(path3.join(sitePackages, ...relativePath.split("/"))), `Temporal bridge build source survived pruning: ${relativePath}`);
  }
  return { status: "temporal-bridge-build-sources-pruned", removedPaths };
}
function shouldPruneInstalledPythonPath(relativePath, entry) {
  if (isGitMetadataBasename(entry.name) || entry.name.endsWith(".egg-info") || entry.name.endsWith(".pyc")) return true;
  return isTemporalBridgeBuildSourcePath(relativePath) || isKnownPythonNonRuntimePath(relativePath);
}
async function pruneInstalledPythonTree(root) {
  const temporalBridge = await pruneTemporalBridgeBuildSources(root);
  async function visit(directory, relativeDirectory = "") {
    const entries = await readdir2(directory, { withFileTypes: true });
    for (const entry of entries) {
      const entryPath = path3.join(directory, entry.name);
      const relativePath = relativeDirectory ? path3.posix.join(relativeDirectory, entry.name) : entry.name;
      if (FORBIDDEN_SEGMENTS.has(entry.name.toLowerCase()) || shouldPruneInstalledPythonPath(relativePath, entry)) {
        await rm2(entryPath, { recursive: true, force: true });
      } else if (entry.isDirectory()) {
        await visit(entryPath, relativePath);
      }
    }
  }
  await visit(root);
  return { temporalBridge };
}
function isMachOMagic(bytes) {
  if (bytes.length < 4) return false;
  const magic = bytes.readUInt32BE(0);
  return (/* @__PURE__ */ new Set([4277009102, 4277009103, 3472551422, 3489328638, 3405691582, 3199925962])).has(magic);
}
async function binaryContainsNeedle(filePath, needleValues) {
  const needles = needleValues.filter(Boolean).map((value) => Buffer.from(value));
  const carryLength = Math.max(0, ...needles.map((needle) => needle.length - 1));
  let carry = Buffer.alloc(0);
  for await (const chunk of createReadStream3(filePath, { highWaterMark: 1024 * 1024 })) {
    const window = Buffer.concat([carry, chunk]);
    for (const needle of needles) if (window.indexOf(needle) !== -1) return needle.toString();
    carry = window.subarray(Math.max(0, window.length - carryLength));
  }
  return null;
}
function parseOtoolDependencies(stdout, { dylib = false } = {}) {
  const dependencies = [];
  let firstDependencyInSlice = true;
  for (const line of stdout.split("\n")) {
    if (/^\S.*:$/.test(line)) {
      firstDependencyInSlice = true;
      continue;
    }
    const match = line.match(/^\s+(\S+) \(compatibility version /);
    if (!match) continue;
    if (!(dylib && firstDependencyInSlice)) dependencies.push(match[1]);
    firstDependencyInSlice = false;
  }
  return dependencies;
}
function parseMachOMinimumVersions(stdout) {
  const versions = [];
  let command = null;
  for (const rawLine of stdout.split("\n")) {
    const line = rawLine.trim();
    if (line.startsWith("Load command ")) {
      command = null;
    } else if (line === "cmd LC_BUILD_VERSION" || line === "cmd LC_VERSION_MIN_MACOSX") {
      command = line.slice(4);
    } else if (command === "LC_BUILD_VERSION" && line.startsWith("minos ")) {
      versions.push(line.slice("minos ".length).trim());
      command = null;
    } else if (command === "LC_VERSION_MIN_MACOSX" && line.startsWith("version ")) {
      versions.push(line.slice("version ".length).trim());
      command = null;
    }
  }
  return versions;
}
function macOsVersionParts(value) {
  invariant3(/^\d+(?:\.\d+){0,2}$/.test(value), `invalid Mach-O minimum macOS version ${value}`);
  return value.split(".").map(Number);
}
function compareMacOsVersions(left, right) {
  const leftParts = macOsVersionParts(left);
  const rightParts = macOsVersionParts(right);
  for (let index = 0; index < 3; index += 1) {
    const difference = (leftParts[index] ?? 0) - (rightParts[index] ?? 0);
    if (difference !== 0) return Math.sign(difference);
  }
  return 0;
}
async function scanMachODependencies(payloadRoot, {
  forbiddenStrings = [],
  declaredMinimumOsVersion = "15.0"
} = {}) {
  const files = await buildFileInventory(payloadRoot);
  let machOCount = 0;
  let dependencyCount = 0;
  let minimumOsCheckCount = 0;
  const architectureCounts = /* @__PURE__ */ new Map();
  const minimumOsVersionCounts = /* @__PURE__ */ new Map();
  let maximumObservedMinimumOsVersion = "0";
  for (const file of files) {
    if (file.type !== "file") continue;
    const absolutePath = path3.join(payloadRoot, ...file.path.split("/"));
    const handle = await open(absolutePath, "r");
    const magic = Buffer.alloc(4);
    try {
      await handle.read(magic, 0, 4, 0);
    } finally {
      await handle.close();
    }
    if (!isMachOMagic(magic)) continue;
    machOCount += 1;
    const leaked = await binaryContainsNeedle(absolutePath, [
      ...forbiddenStrings,
      "/opt/homebrew/",
      "/usr/local/bin/",
      ...FORBIDDEN_TOOL_INVOCATION_NEEDLES
    ]);
    invariant3(!leaked, `${file.path}: native binary contains forbidden build/runtime string ${leaked}`);
    let auditPath = absolutePath;
    let temporaryAuditPath = null;
    if (absolutePath.includes("(")) {
      temporaryAuditPath = path3.join(os.tmpdir(), `jobctrl-otool-${process2.pid}-${machOCount}`);
      await copyFile(absolutePath, temporaryAuditPath);
      auditPath = temporaryAuditPath;
    }
    let dependencyOutput;
    let headerOutput;
    let architectureOutput;
    let loadCommandOutput;
    try {
      ({ stdout: dependencyOutput } = await run("/usr/bin/otool", ["-L", auditPath], { cwd: payloadRoot }));
      ({ stdout: headerOutput } = await run("/usr/bin/otool", ["-hv", auditPath], { cwd: payloadRoot }));
      ({ stdout: architectureOutput } = await run("/usr/bin/lipo", ["-archs", auditPath], { cwd: payloadRoot }));
      ({ stdout: loadCommandOutput } = await run("/usr/bin/otool", ["-arch", "arm64", "-l", auditPath], { cwd: payloadRoot }));
    } finally {
      if (temporaryAuditPath) await rm2(temporaryAuditPath, { force: true });
    }
    const architectures = architectureOutput.trim().split(/\s+/).filter(Boolean).sort(bytewiseCompare3);
    invariant3(architectures.includes("arm64"), `${file.path}: Mach-O does not contain an arm64 slice (${architectures.join(", ")})`);
    const architectureKey = architectures.join(",");
    architectureCounts.set(architectureKey, (architectureCounts.get(architectureKey) ?? 0) + 1);
    const minimumOsVersions = parseMachOMinimumVersions(loadCommandOutput);
    invariant3(minimumOsVersions.length > 0, `${file.path}: arm64 Mach-O has no minimum macOS load command`);
    for (const minimumOsVersion of minimumOsVersions) {
      invariant3(
        compareMacOsVersions(minimumOsVersion, declaredMinimumOsVersion) <= 0,
        `${file.path}: arm64 Mach-O requires macOS ${minimumOsVersion}, later than declared ${declaredMinimumOsVersion}`
      );
      minimumOsCheckCount += 1;
      minimumOsVersionCounts.set(minimumOsVersion, (minimumOsVersionCounts.get(minimumOsVersion) ?? 0) + 1);
      if (compareMacOsVersions(minimumOsVersion, maximumObservedMinimumOsVersion) > 0) {
        maximumObservedMinimumOsVersion = minimumOsVersion;
      }
    }
    const dependencies = parseOtoolDependencies(dependencyOutput, { dylib: /\bDYLIB\b/.test(headerOutput) });
    dependencyCount += dependencies.length;
    for (const dependency of dependencies) {
      invariant3(
        dependency.startsWith("@rpath/") || dependency.startsWith("@loader_path/") || dependency.startsWith("@executable_path/") || dependency.startsWith("/usr/lib/") || dependency.startsWith("/System/Library/"),
        `${file.path}: non-relocatable Mach-O dependency ${dependency}`
      );
    }
  }
  invariant3(machOCount > 0, "real payload contains no Mach-O binaries");
  return {
    status: "clean",
    machOCount,
    arm64MachOCount: machOCount,
    dependencyCount,
    minimumOsCheckCount,
    declaredMinimumOsVersion,
    maximumObservedMinimumOsVersion,
    architectures: Object.fromEntries([...architectureCounts].sort(([left], [right]) => bytewiseCompare3(left, right))),
    minimumOsVersions: Object.fromEntries([...minimumOsVersionCounts].sort(([left], [right]) => compareMacOsVersions(left, right)))
  };
}
async function reserveLoopbackPort() {
  const { createServer } = await import("node:net");
  const server = createServer();
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  invariant3(address && typeof address === "object", "failed to reserve API smoke port");
  const port = address.port;
  await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  return port;
}
function createExtractedRuntimeStackPlan({ payloadRoot, stateRoot, temporalPort, apiPort, contracts }) {
  invariant3(path3.isAbsolute(payloadRoot) && path3.isAbsolute(stateRoot), "extracted runtime stack paths must be absolute");
  invariant3(Number.isInteger(temporalPort) && temporalPort > 0, "Temporal smoke port must be positive");
  invariant3(Number.isInteger(apiPort) && apiPort > 0, "API smoke port must be positive");
  const temporalAddress = `127.0.0.1:${temporalPort}`;
  const pythonExecutable = path3.join(payloadRoot, contracts.componentPaths.get("python-runtime"), "bin", "python3");
  const nodeExecutable = path3.join(payloadRoot, contracts.componentPaths.get("node-runtime"), "bin", "node");
  const temporalExecutable = path3.join(payloadRoot, contracts.componentPaths.get("temporal-runtime"), "temporal");
  const environment = {
    HOME: path3.join(stateRoot, "home"),
    JOBCTRL_DIR: path3.join(stateRoot, "home", ".jobctrl"),
    JOBCTRL_PAYLOAD_DIR: payloadRoot,
    JOBCTRL_RUNTIME_MODE: "bundled",
    JOBCTRL_WEB_ASSETS_DIR: path3.join(payloadRoot, contracts.componentPaths.get("jobctrl-web")),
    JOBCTRL_PYTHON_EXECUTABLE: pythonExecutable,
    PLAYWRIGHT_BROWSERS_PATH: path3.join(payloadRoot, contracts.componentPaths.get("chromium-core")),
    TEMPORAL_ADDRESS: temporalAddress,
    TEMPORAL_NAMESPACE: "default",
    JOBCTRL_API_PORT: String(apiPort),
    JOBCTRL_API_HOST: "127.0.0.1",
    PATH: "/usr/bin:/bin:/usr/sbin:/sbin"
  };
  return {
    environment,
    temporalAddress,
    temporalDbPath: path3.join(environment.JOBCTRL_DIR, "temporal-smoke.db"),
    temporal: {
      command: temporalExecutable,
      args: [
        "server",
        "start-dev",
        "--ip",
        "127.0.0.1",
        "--port",
        String(temporalPort),
        "--db-filename",
        path3.join(environment.JOBCTRL_DIR, "temporal-smoke.db"),
        "--headless",
        "--log-level",
        "error",
        "--disable-config-file",
        "--disable-config-env"
      ]
    },
    temporalHealth: {
      command: temporalExecutable,
      args: [
        "operator",
        "cluster",
        "health",
        "--address",
        temporalAddress,
        "--command-timeout",
        "2s",
        "--output",
        "json",
        "--disable-config-file",
        "--disable-config-env"
      ]
    },
    worker: { command: pythonExecutable, args: ["-I", "-B", "-m", "jobctrl", "worker"] },
    api: { command: nodeExecutable, args: [path3.join(payloadRoot, "api", "server.mjs")] },
    apiOrigin: `http://127.0.0.1:${apiPort}`
  };
}
var LOOPBACK_ONLY_SANDBOX_PROFILE = `(version 1)
(allow default)
(deny network-outbound (remote ip))
(allow network-outbound (remote ip "localhost:*"))`;
async function runLoopbackSandboxed(command, args, options) {
  return run("/usr/bin/sandbox-exec", ["-p", LOOPBACK_ONLY_SANDBOX_PROFILE, command, ...args], options);
}
function spawnLoopbackSandboxed(command, args, { cwd, env }) {
  const child = spawn("/usr/bin/sandbox-exec", ["-p", LOOPBACK_ONLY_SANDBOX_PROFILE, command, ...args], {
    cwd,
    env,
    stdio: ["ignore", "pipe", "pipe"]
  });
  let output = "";
  child.stdout.on("data", (chunk) => {
    output += chunk;
  });
  child.stderr.on("data", (chunk) => {
    output += chunk;
  });
  child.capturedOutput = () => output;
  return child;
}
function assertSmokeProcessRunning(child, label) {
  invariant3(
    child.exitCode === null && child.signalCode === null,
    `${label} exited during startup: ${child.capturedOutput().slice(-4e3)}`
  );
}
async function waitForTemporalHealth(plan, temporal) {
  let lastError = null;
  for (let attempt = 0; attempt < 100; attempt += 1) {
    assertSmokeProcessRunning(temporal, "embedded Temporal server");
    try {
      const health = await runLoopbackSandboxed(plan.temporalHealth.command, plan.temporalHealth.args, {
        cwd: plan.environment.JOBCTRL_DIR,
        env: plan.environment
      });
      return { status: "healthy", output: health.stdout.trim() };
    } catch (error) {
      lastError = error;
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`embedded Temporal health did not become ready: ${lastError?.message ?? "unknown error"}
${temporal.capturedOutput().slice(-4e3)}`);
}
async function waitForApiWorkerHealth(plan, api, worker) {
  let lastError = null;
  for (let attempt = 0; attempt < 120; attempt += 1) {
    assertSmokeProcessRunning(api, "extracted API");
    assertSmokeProcessRunning(worker, "extracted Temporal worker");
    try {
      const response = await fetch(`${plan.apiOrigin}/v1/health`);
      if (response.ok) {
        const health = await response.json();
        if (health?.worker?.status === "healthy" && health.worker.heartbeat?.pid === worker.pid) return health;
        lastError = new Error(`worker health is ${health?.worker?.status ?? "missing"} for pid ${health?.worker?.heartbeat?.pid ?? "missing"}`);
      } else {
        lastError = new Error(`API health returned HTTP ${response.status}`);
      }
    } catch (error) {
      lastError = error;
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`extracted runtime stack did not become ready: ${lastError?.message ?? "unknown error"}
API: ${api.capturedOutput().slice(-3e3)}
Worker: ${worker.capturedOutput().slice(-3e3)}`);
}
async function startExtractedRuntimeStack(plan) {
  await mkdir2(plan.environment.JOBCTRL_DIR, { recursive: true, mode: 448 });
  const temporal = spawnLoopbackSandboxed(plan.temporal.command, plan.temporal.args, {
    cwd: plan.environment.JOBCTRL_DIR,
    env: plan.environment
  });
  let worker = null;
  let api = null;
  try {
    const temporalHealth = await waitForTemporalHealth(plan, temporal);
    worker = spawnLoopbackSandboxed(plan.worker.command, plan.worker.args, {
      cwd: plan.environment.JOBCTRL_DIR,
      env: plan.environment
    });
    api = spawnLoopbackSandboxed(plan.api.command, plan.api.args, {
      cwd: plan.environment.JOBCTRL_DIR,
      env: plan.environment
    });
    const apiHealth = await waitForApiWorkerHealth(plan, api, worker);
    return { temporal, worker, api, temporalHealth, apiHealth };
  } catch (error) {
    if (api) await terminateChildProcess(api).catch(() => null);
    if (worker) await terminateChildProcess(worker).catch(() => null);
    await terminateChildProcess(temporal).catch(() => null);
    throw error;
  }
}
async function terminateExtractedRuntimeStack(stack) {
  return {
    api: await terminateChildProcess(stack.api),
    worker: await terminateChildProcess(stack.worker),
    temporal: await terminateChildProcess(stack.temporal, { timeoutMs: 5e3 })
  };
}
async function smokeNativeLauncherLifecycle({ payloadRoot, extractedRoot, stockEnvironment }) {
  const launcher = path3.join(payloadRoot, "launcher", "jobctrl");
  await requireFile(launcher, "native JobCtrl launcher");
  const environment = {
    ...stockEnvironment,
    JOBCTRL_RUNTIME_HOME: path3.join(extractedRoot, "runtime")
  };
  const statusJson = async () => JSON.parse((await runLoopbackSandboxed(launcher, ["status", "--json"], { cwd: extractedRoot, env: environment })).stdout);
  const waitForStatus = async (expected, label) => {
    let observed = null;
    for (let attempt = 0; attempt < 60; attempt += 1) {
      observed = await statusJson();
      if (expected.includes(observed.status)) return observed;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    throw new Error(`${label}: lifecycle status remained ${observed?.status}`);
  };
  const start = async () => runLoopbackSandboxed(launcher, ["start", "--no-open"], { cwd: extractedRoot, env: environment });
  const stop = async () => runLoopbackSandboxed(launcher, ["stop"], { cwd: extractedRoot, env: environment });
  let lifecycleStarted = false;
  try {
    const firstStart = await start();
    lifecycleStarted = true;
    invariant3(firstStart.stdout.includes("http://127.0.0.1:8766"), "native launcher did not report fixed API URL");
    let health = null;
    for (let attempt = 0; attempt < 40; attempt += 1) {
      try {
        const response = await fetch("http://127.0.0.1:8766/v1/health");
        if (response.ok) {
          health = await response.json();
          if (health?.worker?.status === "healthy") break;
        }
      } catch {
      }
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    invariant3(health?.worker?.status === "healthy", "native launcher API health was not healthy");
    let status = await statusJson();
    invariant3(status.status === "running", `native launcher status is ${status.status}`);
    for (const component of ["temporal", "worker", "api"]) invariant3(status.components?.[component]?.state === "running", `native launcher ${component} status is not running`);
    const logs = await runLoopbackSandboxed(launcher, ["logs"], { cwd: extractedRoot, env: environment });
    invariant3(logs.stdout.includes("== temporal ==") && logs.stdout.includes("== worker ==") && logs.stdout.includes("== api =="), "native launcher logs did not route all bounded component logs");
    const version = JSON.parse((await runLoopbackSandboxed(launcher, ["version", "--json"], { cwd: extractedRoot, env: environment })).stdout);
    invariant3(typeof version.buildId === "string" && /^[a-f0-9]{64}$/.test(version.manifestSha256), "native launcher version JSON is incomplete");
    await runLoopbackSandboxed(launcher, ["doctor"], { cwd: extractedRoot, env: environment });
    const digest = await runLoopbackSandboxed(launcher, ["digest", "--json"], { cwd: extractedRoot, env: environment });
    invariant3(digest.stdout.trim().startsWith("{"), "native launcher did not transparently dispatch JSON Python CLI command");
    await runLoopbackSandboxed(launcher, ["pipeline-status"], { cwd: extractedRoot, env: environment });
    await runLoopbackSandboxed(launcher, ["status", "--pipeline"], { cwd: extractedRoot, env: environment });
    process2.kill(status.components.worker.pid, "SIGKILL");
    const degraded = await waitForStatus(["degraded"], "worker-kill recovery");
    invariant3(degraded.components.worker.state !== "running", "killed worker remained reported as running");
    await stop();
    await waitForStatus(["stopped"], "worker-kill stop");
    await start();
    status = await waitForStatus(["running"], "worker-kill restart");
    invariant3(Number.isInteger(status.supervisorPid) && status.supervisorPid > 0, "native status omitted supervisor PID");
    process2.kill(status.supervisorPid, "SIGKILL");
    const orphaned = await waitForStatus(["orphaned"], "supervisor-kill recovery");
    invariant3(orphaned.components.api.state === "running", "orphaned API ownership was not reported");
    await stop();
    await waitForStatus(["stopped"], "supervisor-kill stop");
    await start();
    status = await waitForStatus(["running"], "supervisor-kill restart");
    await stop();
    const stopped = await waitForStatus(["stopped"], "final stop");
    return { startUrl: "http://127.0.0.1:8766", components: Object.keys(status.components).sort(bytewiseCompare3), manifestSha256: version.manifestSha256, pipelineStatusCompatibility: "passed", pythonDispatch: ["doctor", "digest --json"], recovery: { workerKill: "degraded-stop-restart", supervisorKill: "orphaned-stop-restart" } };
  } finally {
    if (lifecycleStarted) await stop().catch(() => null);
  }
}
async function cleanupNativeLauncherRuntime(extractedRoot) {
  const canonicalRoot = await realpath3(extractedRoot).catch(() => null);
  if (!canonicalRoot) return { status: "not-created" };
  const launcher = path3.join(canonicalRoot, "payload", "launcher", "jobctrl");
  if (!await exists(launcher)) return { status: "launcher-not-created" };
  const environment = {
    HOME: path3.join(canonicalRoot, "home"),
    JOBCTRL_DIR: path3.join(canonicalRoot, "home", ".jobctrl"),
    JOBCTRL_RUNTIME_HOME: path3.join(canonicalRoot, "runtime"),
    PATH: "/usr/bin:/bin:/usr/sbin:/sbin"
  };
  try {
    await runLoopbackSandboxed(launcher, ["stop"], { cwd: canonicalRoot, env: environment });
    return { status: "stopped" };
  } catch (error) {
    return { status: "stop-failed", error: error.message };
  }
}
function nativeLauncherLifecycleSmokeRequirement(nativeLauncherReleaseChannel = "local") {
  invariant3(RELEASE_CHANNELS2.has(nativeLauncherReleaseChannel), "native launcher lifecycle smoke release channel is invalid");
  if (nativeLauncherReleaseChannel === "local") return { status: "required" };
  return {
    status: "skipped",
    reason: "pre-sign-unavailable",
    releaseChannel: nativeLauncherReleaseChannel
  };
}
async function requireJsonResponse(url, options, label) {
  const response = await fetch(url, options);
  const text = await response.text();
  invariant3(response.ok, `${label} failed with HTTP ${response.status}: ${text.slice(0, 1e3)}`);
  try {
    return JSON.parse(text);
  } catch (error) {
    throw new Error(`${label} did not return JSON: ${error.message}`);
  }
}
function extensionCaptureSmokeHeaders(token) {
  invariant3(typeof token === "string" && token.length >= 32, "extension smoke token is invalid");
  return {
    authorization: `Bearer ${token}`,
    "content-type": "application/json",
    origin: "chrome-extension://aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    "sec-fetch-site": "cross-site"
  };
}
async function submitExtensionCaptureFixture(plan, { captureId, jobUrl, captureHtml }) {
  const pairing = await requireJsonResponse(
    `${plan.apiOrigin}/v1/extension/pairing-token`,
    { method: "GET" },
    "extension pairing-token smoke"
  );
  invariant3(typeof pairing?.token === "string" && pairing.token.length >= 32, "extension pairing-token smoke returned no token");
  const result = await requireJsonResponse(
    `${plan.apiOrigin}/v1/extension/captures`,
    {
      method: "POST",
      headers: extensionCaptureSmokeHeaders(pairing.token),
      body: JSON.stringify({
        captureId,
        originatingUrl: jobUrl,
        captureMode: "saved_html",
        capturedUrl: jobUrl,
        contentText: captureHtml,
        futureManualActionRequired: false,
        captureClient: "browser_extension",
        extensionVersion: "distribution-smoke"
      })
    },
    "extension saved-HTML capture smoke"
  );
  invariant3(result?.ok === true && result.jobKey === jobUrl, "extension capture smoke did not return the imported fixture job");
  return { itemId: result.itemId, jobKey: result.jobKey, importedAt: result.importedAt };
}
async function waitForApiWorkflow(plan, workflowType) {
  let last = null;
  for (let attempt = 0; attempt < 100; attempt += 1) {
    last = await requireJsonResponse(
      `${plan.apiOrigin}/v1/workflow-runs?page=1&pageSize=50&status=all`,
      { method: "GET" },
      "workflow projection smoke"
    );
    const run2 = (last.items ?? []).find((item) => item.workflowType === workflowType);
    if (run2?.status === "succeeded") return run2;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`${workflowType} did not reach a succeeded API projection: ${JSON.stringify(last).slice(-2e3)}`);
}
async function requirePersistedJob(plan, jobUrl) {
  const jobs = await requireJsonResponse(`${plan.apiOrigin}/v1/jobs`, { method: "GET" }, "persisted jobs smoke");
  invariant3(JSON.stringify(jobs).includes(jobUrl), "extracted API did not return the workflow-imported offline fixture job");
  return true;
}
async function describeTemporalWorkflow(plan, workflowId) {
  const probe = await runLoopbackSandboxed(plan.worker.command, [
    "-I",
    "-B",
    "-c",
    `import asyncio
import json
import os
from temporalio.client import Client

async def main():
    client = await Client.connect(os.environ["TEMPORAL_ADDRESS"], namespace=os.environ.get("TEMPORAL_NAMESPACE", "default"))
    description = await client.get_workflow_handle(os.environ["JOBCTRL_SMOKE_WORKFLOW_ID"]).describe()
    print(json.dumps({"runId": description.run_id, "status": description.status.name}, sort_keys=True))

asyncio.run(main())`
  ], {
    cwd: plan.environment.JOBCTRL_DIR,
    env: { ...plan.environment, JOBCTRL_SMOKE_WORKFLOW_ID: workflowId }
  });
  const description = JSON.parse(probe.stdout.trim());
  invariant3(/completed/i.test(description.status), `Temporal workflow ${workflowId} is not completed: ${description.status}`);
  return description;
}
async function terminateChildProcess(child, { timeoutMs = 3e3 } = {}) {
  invariant3(Number.isInteger(timeoutMs) && timeoutMs >= 0, "child termination timeout must be non-negative");
  if (child.exitCode !== null || child.signalCode !== null) {
    return { status: "exited", exitCode: child.exitCode, signalCode: child.signalCode, forced: false };
  }
  const exitPromise = once(child, "exit").then(([exitCode, signalCode]) => ({ exitCode, signalCode }));
  child.kill("SIGTERM");
  let timeout;
  const timeoutPromise = new Promise((resolve) => {
    timeout = setTimeout(() => resolve(null), timeoutMs);
  });
  let exit = await Promise.race([exitPromise, timeoutPromise]);
  clearTimeout(timeout);
  let forced = false;
  if (exit === null) {
    forced = true;
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
    exit = await exitPromise;
  }
  invariant3(exit.exitCode !== null || exit.signalCode !== null, "child exited without an exit code or signal");
  return { status: "exited", ...exit, forced };
}
async function smokePlaywrightMcpProtocol(command, args, { cwd, env }) {
  const child = spawn("/usr/bin/sandbox-exec", ["-p", LOOPBACK_ONLY_SANDBOX_PROFILE, command, ...args], {
    cwd,
    env,
    stdio: ["pipe", "pipe", "pipe"]
  });
  let output = "";
  let stderr = "";
  let pending = "";
  let nextId = 0;
  const responses = /* @__PURE__ */ new Map();
  const waiters = /* @__PURE__ */ new Map();
  const fail = (error) => {
    for (const waiter of waiters.values()) {
      clearTimeout(waiter.timeout);
      waiter.reject(error);
    }
    waiters.clear();
  };
  child.on("error", fail);
  child.stderr.on("data", (chunk) => {
    stderr += chunk;
  });
  child.stdout.on("data", (chunk) => {
    output += chunk;
    pending += chunk;
    for (; ; ) {
      const newline = pending.indexOf("\n");
      if (newline === -1) break;
      const line = pending.slice(0, newline);
      pending = pending.slice(newline + 1);
      if (!line) continue;
      let response;
      try {
        response = JSON.parse(line);
      } catch {
        continue;
      }
      if (response.id === void 0) continue;
      if (waiters.has(response.id)) {
        const waiter = waiters.get(response.id);
        waiters.delete(response.id);
        clearTimeout(waiter.timeout);
        waiter.resolve(response);
      } else {
        responses.set(response.id, response);
      }
    }
  });
  child.on("exit", (exitCode, signalCode) => {
    fail(new Error(`Playwright MCP protocol smoke exited early (${exitCode ?? signalCode}): ${(stderr || output).slice(-4e3)}`));
  });
  const request = async (method, params) => {
    const id = ++nextId;
    const response = new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        waiters.delete(id);
        reject(new Error(`Playwright MCP ${method} response timed out: ${(stderr || output).slice(-4e3)}`));
      }, 3e4);
      if (responses.has(id)) {
        const message = responses.get(id);
        responses.delete(id);
        clearTimeout(timeout);
        resolve(message);
      } else {
        waiters.set(id, { resolve, reject, timeout });
      }
    });
    child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}
`);
    return response;
  };
  try {
    const initialize = await request("initialize", {
      protocolVersion: "2024-11-05",
      capabilities: {},
      clientInfo: { name: "jobctrl-distribution-smoke", version: "1.0.0" }
    });
    invariant3(initialize.result?.serverInfo?.name === "Playwright", "bundled Playwright MCP initialize returned an unexpected server");
    child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" })}
`);
    const tools = await request("tools/list", {});
    const toolNames = (tools.result?.tools ?? []).map((tool) => tool.name).sort(bytewiseCompare3);
    for (const required of ["browser_navigate", "browser_snapshot"]) {
      invariant3(toolNames.includes(required), `bundled Playwright MCP did not advertise ${required}`);
    }
    const marker = "jobctrl-mcp-local-browser-smoke";
    const navigation = await request("tools/call", {
      name: "browser_navigate",
      arguments: { url: `data:text/html,<title>${marker}</title><main>${marker}</main>` }
    });
    invariant3(navigation.isError !== true, `bundled Playwright MCP navigation failed: ${JSON.stringify(navigation).slice(-2e3)}`);
    const snapshot = await request("tools/call", { name: "browser_snapshot", arguments: {} });
    invariant3(snapshot.isError !== true, `bundled Playwright MCP snapshot failed: ${JSON.stringify(snapshot).slice(-2e3)}`);
    invariant3(JSON.stringify(snapshot).includes(marker), "bundled Playwright MCP snapshot did not observe the managed local browser page");
    return {
      protocolVersion: initialize.result.protocolVersion,
      server: initialize.result.serverInfo,
      toolCount: toolNames.length,
      requiredTools: ["browser_navigate", "browser_snapshot"],
      localManagedChromiumNavigation: "passed"
    };
  } finally {
    child.stdin.end();
    await terminateChildProcess(child, { timeoutMs: 3e3 }).catch(() => {
    });
  }
}
async function managedMcpChromiumExecutable(payloadRoot, contracts) {
  invariant3(contracts.platform.id === "darwin-arm64", `unsupported MCP Chromium smoke platform: ${contracts.platform.id}`);
  const executable = path3.join(
    componentRoot(payloadRoot, contracts, "chromium-core"),
    "chromium_headless_shell-1208",
    "chrome-headless-shell-mac-arm64",
    "chrome-headless-shell"
  );
  return requireFile(executable, "managed Chromium executable for Playwright MCP smoke");
}
async function assertHeadlessChromiumPayload(payloadRoot, contracts) {
  const chromiumRoot = componentRoot(payloadRoot, contracts, "chromium-core");
  const files = await buildFileInventory(chromiumRoot);
  const required = "chromium_headless_shell-1208/chrome-headless-shell-mac-arm64/chrome-headless-shell";
  const executable = files.filter((file) => file.type === "file" && file.path === required);
  invariant3(executable.length === 1, "core Chromium payload must contain exactly one managed headless-shell executable");
  const topLevel = [...new Set(files.map((file) => file.path.split("/")[0]))].sort(bytewiseCompare3);
  invariant3(JSON.stringify(topLevel) === JSON.stringify(["chromium_headless_shell-1208"]), `core Chromium payload has unexpected browser revisions: ${topLevel.join(", ")}`);
  invariant3(files.filter((file) => file.type === "file" && path3.posix.basename(file.path) === "chrome-headless-shell").length === 1, "core Chromium payload must not contain an extra headless-shell revision");
  const forbidden = files.filter((file) => file.path.startsWith("chromium-") || file.path.includes(".app/") || file.path.includes("Google Chrome for Testing"));
  invariant3(forbidden.length === 0, `core Chromium payload must exclude the full browser topology: ${forbidden.map((file) => file.path).join(", ")}`);
  return { executable: path3.join(chromiumRoot, ...required.split("/")), fileCount: files.length };
}
async function prepareExtractedSmokeLayout({ archivePath, outputRoot }) {
  const extractedRoot = path3.join(outputRoot, "clean-extraction");
  await rm2(extractedRoot, { recursive: true, force: true });
  const extractionPayloadRoot = path3.join(extractedRoot, "payload");
  await mkdir2(extractionPayloadRoot, { recursive: true, mode: 493 });
  await run("/usr/bin/unzip", ["-q", archivePath, "-d", extractionPayloadRoot], { cwd: outputRoot });
  const canonicalExtractedRoot = await realpath3(extractedRoot);
  const payloadRoot = await realpath3(path3.join(canonicalExtractedRoot, "payload"));
  const homeRoot = path3.join(canonicalExtractedRoot, "home");
  await mkdir2(homeRoot, { recursive: true, mode: 448 });
  const canonicalHomeRoot = await realpath3(homeRoot);
  const stateRoot = path3.join(canonicalHomeRoot, ".jobctrl");
  await mkdir2(stateRoot, { recursive: true, mode: 448 });
  const canonicalStateRoot = await realpath3(stateRoot);
  invariant3(
    canonicalHomeRoot !== payloadRoot && !canonicalHomeRoot.startsWith(`${payloadRoot}${path3.sep}`) && !payloadRoot.startsWith(`${canonicalHomeRoot}${path3.sep}`) && canonicalStateRoot !== payloadRoot && !canonicalStateRoot.startsWith(`${payloadRoot}${path3.sep}`) && !payloadRoot.startsWith(`${canonicalStateRoot}${path3.sep}`),
    "distribution smoke HOME/state must be a sibling of the immutable payload root"
  );
  return {
    extractedRoot,
    canonicalExtractedRoot,
    payloadRoot,
    homeRoot: canonicalHomeRoot,
    stateRoot: canonicalStateRoot
  };
}
async function smokeExtractedPayload(archivePath, outputRoot, contracts, {
  nativeLauncherReleaseChannel = "local"
} = {}) {
  const {
    canonicalExtractedRoot,
    payloadRoot,
    homeRoot,
    stateRoot
  } = await prepareExtractedSmokeLayout({ archivePath, outputRoot });
  const manifest = JSON.parse(await readFile3(path3.join(payloadRoot, "manifest.json"), "utf8"));
  validateDistributionManifest(manifest, contracts);
  await verifyExactPayloadTree(payloadRoot, manifest);
  await assertHeadlessChromiumPayload(payloadRoot, contracts);
  const extractionForbiddenAudit = await scanForbiddenPayload(payloadRoot, { forbiddenAbsolutePaths: [REPO_ROOT, outputRoot] });
  const stockEnvironment = {
    HOME: homeRoot,
    JOBCTRL_DIR: stateRoot,
    JOBCTRL_PAYLOAD_DIR: payloadRoot,
    JOBCTRL_RUNTIME_MODE: "bundled",
    JOBCTRL_WEB_ASSETS_DIR: path3.join(payloadRoot, contracts.componentPaths.get("jobctrl-web")),
    JOBCTRL_PYTHON_EXECUTABLE: path3.join(payloadRoot, contracts.componentPaths.get("python-runtime"), "bin", "python3"),
    PLAYWRIGHT_BROWSERS_PATH: path3.join(payloadRoot, contracts.componentPaths.get("chromium-core")),
    PATH: "/usr/bin:/bin:/usr/sbin:/sbin"
  };
  await mkdir2(stockEnvironment.JOBCTRL_DIR, { recursive: true, mode: 448 });
  const nodeExecutable = path3.join(payloadRoot, contracts.componentPaths.get("node-runtime"), "bin", "node");
  const networkProbe = await runLoopbackSandboxed(stockEnvironment.JOBCTRL_PYTHON_EXECUTABLE, [
    "-I",
    "-B",
    "-c",
    `import json
import socket

sock = socket.socket()
sock.settimeout(1)
try:
    sock.connect(("1.1.1.1", 443))
except PermissionError as error:
    assert error.errno == 1, error
    print(json.dumps({"status": "blocked", "error": "EPERM", "target": "1.1.1.1:443"}, sort_keys=True))
else:
    raise SystemExit("non-loopback network unexpectedly allowed")
finally:
    sock.close()`
  ], { cwd: payloadRoot, env: stockEnvironment });
  const networkIsolation = {
    mechanism: "macos-sandbox-exec",
    policy: "loopback-only-outbound-ip",
    profileSha256: createHash3("sha256").update(LOOPBACK_ONLY_SANDBOX_PROFILE).digest("hex"),
    nonLoopbackProbe: JSON.parse(networkProbe.stdout.trim())
  };
  const nodeVersion = (await runLoopbackSandboxed(nodeExecutable, ["--version"], { cwd: payloadRoot, env: stockEnvironment })).stdout.trim();
  invariant3(nodeVersion === `v${contracts.versions["node-runtime"]}`, `embedded Node version mismatch: ${nodeVersion}`);
  const mcpProtocol = await smokePlaywrightMcpProtocol(
    path3.join(payloadRoot, contracts.componentPaths.get("playwright-mcp"), "bin", "playwright-mcp"),
    [
      "--headless",
      "--isolated",
      "--output-dir",
      path3.join(canonicalExtractedRoot, "playwright-mcp-smoke-output"),
      "--executable-path",
      await managedMcpChromiumExecutable(payloadRoot, contracts),
      "--output-mode",
      "stdout",
      "--codegen",
      "none"
    ],
    { cwd: payloadRoot, env: stockEnvironment }
  );
  await runLoopbackSandboxed(nodeExecutable, [
    "-e",
    `const Database=require(${JSON.stringify(path3.join(payloadRoot, "api", "node_modules", "better-sqlite3"))});const db=new Database(':memory:');db.exec('create table smoke(value integer);insert into smoke values (1)');if(db.prepare('select value from smoke').get().value!==1)process.exit(2);db.close();`
  ], { cwd: payloadRoot, env: stockEnvironment });
  await runLoopbackSandboxed(stockEnvironment.JOBCTRL_PYTHON_EXECUTABLE, ["-I", "-B", "-m", "jobctrl", "--help"], { cwd: payloadRoot, env: stockEnvironment });
  await runLoopbackSandboxed(stockEnvironment.JOBCTRL_PYTHON_EXECUTABLE, [
    "-I",
    "-B",
    "-c",
    "import ctypes, hashlib, importlib.util, json, multiprocessing, sqlite3, ssl, urllib.request\nfor name in ('_tkinter', 'tkinter', 'idlelib', 'turtledemo', 'turtle'):\n    assert importlib.util.find_spec(name) is None, name"
  ], { cwd: payloadRoot, env: stockEnvironment });
  await runLoopbackSandboxed(stockEnvironment.JOBCTRL_PYTHON_EXECUTABLE, [
    "-I",
    "-B",
    "-c",
    "import tls_client\nfrom tls_client.cffi import library\nassert library is not None"
  ], { cwd: payloadRoot, env: stockEnvironment });
  const offlineFixtureUrl = "https://offline.fixture.invalid/jobs/distribution-smoke";
  const fixtureDescription = "Build local-first job search infrastructure with Python, TypeScript, observability, reliable workflow automation, product strategy, and privacy-preserving systems. ".repeat(6);
  const fixtureJsonLd = {
    "@context": "https://schema.org",
    "@type": "JobPosting",
    title: "Distribution Smoke Engineer",
    description: fixtureDescription,
    directApply: true,
    url: offlineFixtureUrl,
    validThrough: "2999-01-01T00:00:00+00:00",
    hiringOrganization: { "@type": "Organization", name: "Offline Fixture" },
    jobLocation: {
      "@type": "Place",
      address: { "@type": "PostalAddress", addressLocality: "Barcelona", addressCountry: "Spain" }
    }
  };
  const fixtureCaptureHtml = `<!doctype html><html><head><script type="application/ld+json">${JSON.stringify(fixtureJsonLd)}</script></head><body><h1>Distribution Smoke Engineer</h1><p>${fixtureDescription}</p></body></html>`;
  const fixtureSetup = await runLoopbackSandboxed(stockEnvironment.JOBCTRL_PYTHON_EXECUTABLE, [
    "-I",
    "-B",
    "-c",
    `import json
import os
from pathlib import Path

from jobctrl.infrastructure.materials.html_resume_pdf import render_resume_html_to_pdf

pdf_path = Path(os.environ["JOBCTRL_DIR"]) / "distribution-smoke.pdf"
resume_html = """<!doctype html><html><head><meta charset='utf-8'><style>@page { size: A4; margin: 18mm; } body { font-family: sans-serif; color: #111; } h1 { font-size: 24px; }</style></head><body><h1>Distribution Smoke Resume</h1><p>Production HTML to PDF rendering from the bundled Python worker and Chromium runtime.</p></body></html>"""
render_resume_html_to_pdf(resume_html, str(pdf_path))
pdf_bytes = pdf_path.read_bytes()
assert pdf_bytes.startswith(b"%PDF-"), pdf_bytes[:16]
assert len(pdf_bytes) > 1000, len(pdf_bytes)
print(json.dumps({"pdfPath": str(pdf_path), "pdfBytes": len(pdf_bytes)}, sort_keys=True))`
  ], { cwd: payloadRoot, env: stockEnvironment });
  const fixtureEvidence = JSON.parse(fixtureSetup.stdout.trim());
  invariant3(fixtureEvidence.pdfBytes > 1e3, "production PDF renderer produced an empty PDF");
  const webAssetsRoot = path3.join(payloadRoot, contracts.componentPaths.get("jobctrl-web"), "assets");
  const webAssetNames = await readdir2(webAssetsRoot);
  const pdfModuleNames = webAssetNames.filter((name) => /^pdf-[A-Za-z0-9_-]+\.js$/.test(name));
  const pdfWorkerNames = webAssetNames.filter((name) => /^pdf\.worker-[A-Za-z0-9_-]+\.mjs$/.test(name));
  invariant3(pdfModuleNames.length === 1, `expected one bundled PDF.js module, found ${pdfModuleNames.join(", ")}`);
  invariant3(pdfWorkerNames.length === 1, `expected one bundled PDF.js worker module, found ${pdfWorkerNames.join(", ")}`);
  const apiPort = await reserveLoopbackPort();
  const temporalPort = await reserveLoopbackPort();
  const runtimePlan = createExtractedRuntimeStackPlan({
    payloadRoot,
    stateRoot: canonicalExtractedRoot,
    temporalPort,
    apiPort,
    contracts
  });
  const firstStack = await startExtractedRuntimeStack(runtimePlan);
  let pdfPreviewEvidence = null;
  let captureEvidence = null;
  let workflowEvidence = null;
  let workflowDetailEvidence = null;
  let firstTemporalDescription = null;
  let firstTermination = null;
  try {
    captureEvidence = await submitExtensionCaptureFixture(runtimePlan, {
      captureId: "distribution-smoke-capture",
      jobUrl: offlineFixtureUrl,
      captureHtml: fixtureCaptureHtml
    });
    workflowEvidence = await waitForApiWorkflow(runtimePlan, "ManualCaptureImportWorkflow");
    workflowDetailEvidence = await requireJsonResponse(
      `${runtimePlan.apiOrigin}/v1/workflow-runs/${encodeURIComponent(workflowEvidence.workflowId)}`,
      { method: "GET" },
      "manual-capture workflow history smoke"
    );
    const workflowEventTypes = new Set((workflowDetailEvidence.events ?? []).map((event) => event.eventType));
    invariant3(workflowEventTypes.has("WorkflowStarted") && workflowEventTypes.has("WorkflowCompleted"), "manual-capture workflow history is missing started/completed events");
    await requirePersistedJob(runtimePlan, offlineFixtureUrl);
    firstTemporalDescription = await describeTemporalWorkflow(runtimePlan, workflowEvidence.workflowId);
    invariant3(
      workflowDetailEvidence.temporalRunId === firstTemporalDescription.runId,
      "manual-capture workflow projection does not identify the completed Temporal run"
    );
    const webResponse = await fetch(`${runtimePlan.apiOrigin}/`);
    invariant3(webResponse.ok && (await webResponse.text()).includes("<html"), "extracted API did not serve the bundled web app");
    const browserSmoke = await runLoopbackSandboxed(stockEnvironment.JOBCTRL_PYTHON_EXECUTABLE, [
      "-I",
      "-B",
      "-c",
      `import base64
import json
import os
from pathlib import Path

from playwright.sync_api import sync_playwright

origin = os.environ["JOBCTRL_SMOKE_ORIGIN"]
pdf_bytes = Path(os.environ["JOBCTRL_SMOKE_PDF_PATH"]).read_bytes()
evaluation_input = {
    "pdfBase64": base64.b64encode(pdf_bytes).decode("ascii"),
    "pdfModuleUrl": origin + "/assets/" + os.environ["JOBCTRL_SMOKE_PDF_MODULE"],
    "pdfWorkerUrl": origin + "/assets/" + os.environ["JOBCTRL_SMOKE_PDF_WORKER"],
}
render_script = """async (input) => {
  const pdfjs = await import(input.pdfModuleUrl);
  const worker = await import(input.pdfWorkerUrl);
  if (typeof pdfjs.getDocument !== "function") throw new Error("bundled PDF.js module does not export getDocument");
  globalThis.pdfjsWorker = worker;
  pdfjs.GlobalWorkerOptions.workerSrc = input.pdfWorkerUrl;
  const bytes = Uint8Array.from(atob(input.pdfBase64), (character) => character.charCodeAt(0));
  const loadingTask = pdfjs.getDocument({ data: bytes });
  const document = await loadingTask.promise;
  const firstPage = await document.getPage(1);
  const textContent = await firstPage.getTextContent();
  const text = textContent.items.map((item) => item.str ?? "").join(" ");
  const viewport = firstPage.getViewport({ scale: 1 });
  const canvas = window.document.createElement("canvas");
  canvas.width = Math.floor(viewport.width);
  canvas.height = Math.floor(viewport.height);
  const context = canvas.getContext("2d", { willReadFrequently: true });
  if (!context) throw new Error("canvas 2D context unavailable");
  await firstPage.render({ canvas, canvasContext: context, viewport }).promise;
  let nonZeroPixelBytes = 0;
  let readbackAttempts = 0;
  for (; readbackAttempts < 5 && nonZeroPixelBytes === 0; readbackAttempts += 1) {
    const pixels = context.getImageData(0, 0, canvas.width, canvas.height).data;
    for (const value of pixels) if (value !== 0) nonZeroPixelBytes += 1;
    if (nonZeroPixelBytes === 0) await new Promise((resolve) => requestAnimationFrame(() => resolve()));
  }
  await document.destroy();
  return { width: canvas.width, height: canvas.height, nonZeroPixelBytes, readbackAttempts, text };
}"""

def preview_attempt(playwright):
    browser = playwright.chromium.launch(headless=True)
    try:
        page = browser.new_page()
        response = page.goto(origin, wait_until="domcontentloaded")
        assert response is not None and response.ok, response
        smoke_document_url = origin + "/__jobctrl_distribution_pdf_smoke"
        page.route(
            smoke_document_url,
            lambda route: route.fulfill(
                status=200,
                content_type="text/html",
                body="<!doctype html><html><body>JobCtrl PDF preview smoke</body></html>",
            ),
        )
        smoke_response = page.goto(smoke_document_url, wait_until="domcontentloaded")
        assert smoke_response is not None and smoke_response.ok, smoke_response
        return page.evaluate(render_script, evaluation_input)
    finally:
        browser.close()

with sync_playwright() as playwright:
    from pathlib import Path
    import os
    browser_root = Path(os.environ["PLAYWRIGHT_BROWSERS_PATH"])
    required_headless = browser_root / "chromium_headless_shell-1208" / "chrome-headless-shell-mac-arm64" / "chrome-headless-shell"
    assert required_headless.is_file(), required_headless
    assert not any(browser_root.glob("chromium-*")), list(browser_root.glob("chromium-*"))
    assert not any(browser_root.rglob("*.app")), "full browser app bundle entered the core payload"
    assert not any("Google Chrome for Testing" in str(candidate) for candidate in browser_root.rglob("*")), "full Chrome-for-Testing entered the core payload"
    browser_attempts = []
    result = None
    for browser_attempt in range(1, 4):
        result = preview_attempt(playwright)
        assert result["width"] > 0 and result["height"] > 0, result
        assert "Distribution Smoke Resume" in result["text"], result
        browser_attempts.append({
            "browserAttempt": browser_attempt,
            "nonZeroPixelBytes": result["nonZeroPixelBytes"],
            "readbackAttempts": result["readbackAttempts"],
        })
        if result["nonZeroPixelBytes"] > 0:
            break
    assert result is not None and result["nonZeroPixelBytes"] > 0, {"attempts": browser_attempts, "lastResult": result}
    print(json.dumps({
        "browserExecutable": str(required_headless),
        "browserLaunchAttempts": browser_attempts,
        "rootNavigation": True,
        "isolatedSameOriginDocument": True,
        **result,
    }, sort_keys=True))`
    ], {
      cwd: payloadRoot,
      env: {
        ...runtimePlan.environment,
        JOBCTRL_SMOKE_ORIGIN: runtimePlan.apiOrigin,
        JOBCTRL_SMOKE_PDF_PATH: fixtureEvidence.pdfPath,
        JOBCTRL_SMOKE_PDF_MODULE: pdfModuleNames[0],
        JOBCTRL_SMOKE_PDF_WORKER: pdfWorkerNames[0]
      }
    });
    pdfPreviewEvidence = JSON.parse(browserSmoke.stdout.trim());
    invariant3(
      pdfPreviewEvidence.rootNavigation === true && pdfPreviewEvidence.isolatedSameOriginDocument === true,
      "bundled PDF.js smoke did not prove the real root plus isolated same-origin harness boundary"
    );
    invariant3(pdfPreviewEvidence.width > 0 && pdfPreviewEvidence.height > 0 && pdfPreviewEvidence.nonZeroPixelBytes > 0, "bundled PDF.js page preview smoke failed");
  } finally {
    firstTermination = await terminateExtractedRuntimeStack(firstStack);
  }
  invariant3(firstTermination?.api?.status === "exited" && firstTermination.worker?.status === "exited" && firstTermination.temporal?.status === "exited", "first extracted runtime stack did not terminate");
  const secondStack = await startExtractedRuntimeStack(runtimePlan);
  let secondTermination = null;
  let secondTemporalDescription = null;
  let restartEvidence = null;
  try {
    invariant3(secondStack.worker.pid !== firstStack.worker.pid, "runtime restart reused the first worker pid");
    invariant3(
      secondStack.apiHealth.worker.heartbeat.workerId !== firstStack.apiHealth.worker.heartbeat.workerId,
      "runtime restart reused the first worker heartbeat identity"
    );
    invariant3(secondStack.apiHealth.dbIdentity === firstStack.apiHealth.dbIdentity, "runtime restart changed the JobCtrl DB identity");
    invariant3(secondStack.apiHealth.worker.heartbeat.pid === secondStack.worker.pid, "runtime restart health does not identify the fresh worker");
    await requirePersistedJob(runtimePlan, offlineFixtureUrl);
    const persistedWorkflow = await requireJsonResponse(
      `${runtimePlan.apiOrigin}/v1/workflow-runs/${encodeURIComponent(workflowEvidence.workflowId)}`,
      { method: "GET" },
      "persisted workflow projection smoke"
    );
    invariant3(persistedWorkflow?.status === "succeeded", "runtime restart lost the completed manual-capture workflow projection");
    invariant3(
      JSON.stringify(persistedWorkflow.events) === JSON.stringify(workflowDetailEvidence.events),
      "runtime restart changed the completed manual-capture workflow history"
    );
    secondTemporalDescription = await describeTemporalWorkflow(runtimePlan, workflowEvidence.workflowId);
    invariant3(secondTemporalDescription.runId === firstTemporalDescription.runId, "runtime restart changed the persisted Temporal run identity");
    restartEvidence = {
      status: "pass",
      firstWorkerPid: firstStack.worker.pid,
      secondWorkerPid: secondStack.worker.pid,
      firstWorkerId: firstStack.apiHealth.worker.heartbeat.workerId,
      secondWorkerId: secondStack.apiHealth.worker.heartbeat.workerId,
      dbIdentity: secondStack.apiHealth.dbIdentity,
      jobPersisted: true,
      workflowProjectionPersisted: true,
      temporalRunPersisted: true
    };
  } finally {
    secondTermination = await terminateExtractedRuntimeStack(secondStack);
  }
  invariant3(secondTermination?.api?.status === "exited" && secondTermination.worker?.status === "exited" && secondTermination.temporal?.status === "exited", "restarted extracted runtime stack did not terminate");
  const nativeLauncherLifecycleRequirement = nativeLauncherLifecycleSmokeRequirement(nativeLauncherReleaseChannel);
  const nativeLauncherLifecycle = nativeLauncherLifecycleRequirement.status === "required" ? await smokeNativeLauncherLifecycle({ payloadRoot, extractedRoot: canonicalExtractedRoot, stockEnvironment }) : nativeLauncherLifecycleRequirement;
  await verifyExactPayloadTree(payloadRoot, manifest);
  return {
    status: "pass",
    nodeVersion,
    playwrightMcp: mcpProtocol,
    tlsClientNative: "darwin-arm64-load-pass",
    dbBackedRoute: "/v1/jobs",
    browserRevision: 1208,
    offlineManualCaptureJob: offlineFixtureUrl,
    manualCaptureWorkflow: {
      itemId: captureEvidence.itemId,
      workflowId: workflowEvidence.workflowId,
      status: workflowEvidence.status,
      temporalRunId: secondTemporalDescription.runId
    },
    productionPdfBytes: fixtureEvidence.pdfBytes,
    pdfPreview: pdfPreviewEvidence,
    runtimeRestart: restartEvidence,
    runtimeTermination: { first: firstTermination, second: secondTermination },
    nativeLauncherLifecycle,
    networkIsolation,
    postSmokePayloadTree: "exact-manifest-match",
    extractionForbiddenAudit
  };
}
function filesMatchingSizeSpec(files, spec) {
  if (!spec) return [];
  return files.filter((file) => spec.paths.includes(file.path) || spec.prefixes.some((prefix) => file.path === prefix || file.path.startsWith(prefix)));
}
function summarizeSelectedFiles(files) {
  invariant3(files.length > 0, "component size selection contains no files");
  const selected = [...files].sort((left, right) => bytewiseCompare3(left.path, right.path));
  const canonical = selected.map((file) => file.type === "symlink" ? `${file.path}\0symlink\0${file.target}\0${file.sizeBytes}
` : `${file.path}\0file\0${file.sha256}\0${file.sizeBytes}\0${file.mode}
`).join("");
  return {
    sha256: createHash3("sha256").update(canonical).digest("hex"),
    sizeBytes: selected.reduce((sum, file) => sum + file.sizeBytes, 0),
    fileCount: selected.length
  };
}
function componentFilesForAccounting(files, contracts, inventory) {
  if (inventory.embeddedIn !== void 0) {
    return filesMatchingSizeSpec(files, contracts.embeddedComponentSpecs.get(inventory.id));
  }
  const root = contracts.componentPaths.get(inventory.id);
  invariant3(root, `${inventory.id}: bundled component has no payload root`);
  const owned = files.filter((file) => file.path === root || file.path.startsWith(`${root}/`));
  const shared = filesMatchingSizeSpec(files, contracts.sharedComponentSpecs.get(inventory.id));
  return [...new Map([...owned, ...shared].map((file) => [file.path, file])).values()];
}
function providerPackAggregateTreeSha256(packs) {
  const canonical = packs.map((pack) => `${pack.id}\0${pack.version}\0${pack.treeSha256}\0${pack.fileCount}\0${pack.installedBytes}
`).sort(bytewiseCompare3).join("");
  return createHash3("sha256").update(canonical).digest("hex");
}
function normalizeProviderPackMeasurement(contracts, measurement, { fixture = false } = {}) {
  const expectedLocks = [...contracts.providerPackLocks.packs].sort((left, right) => bytewiseCompare3(left.id, right.id));
  if (measurement === null) {
    invariant3(fixture, "real distribution size accounting requires exact provider-pack installed-tree measurement");
    return {
      measurementStatus: "unavailable-fixture",
      packs: expectedLocks.map((pack) => ({
        id: pack.id,
        version: pack.version,
        installedBytes: null,
        fileCount: null,
        treeSha256: null
      })),
      totals: {
        installedBytes: null,
        fileCount: null,
        treeSha256: null
      }
    };
  }
  invariant3(measurement?.schemaVersion === 1 && measurement.measurementStatus === "exact-locked-wheel-extraction", "provider-pack size measurement must be exact locked-wheel extraction evidence");
  invariant3(Array.isArray(measurement.packs), "provider-pack size measurement packs are missing");
  const measurements = /* @__PURE__ */ new Map();
  for (const pack of measurement.packs) {
    invariant3(!measurements.has(pack?.id), `provider-pack size measurement duplicates ${pack?.id}`);
    invariant3(
      typeof pack?.id === "string" && typeof pack.version === "string" && Number.isInteger(pack.installedBytes) && pack.installedBytes >= 0 && Number.isInteger(pack.fileCount) && pack.fileCount >= 0 && /^[a-f0-9]{64}$/.test(pack.treeSha256),
      "provider-pack size measurement entry is invalid"
    );
    measurements.set(pack.id, pack);
  }
  const packs = expectedLocks.map((locked) => {
    const measured = measurements.get(locked.id);
    invariant3(measured?.version === locked.version, `${locked.id}: provider-pack size measurement version does not match locked pack`);
    return {
      id: locked.id,
      version: locked.version,
      installedBytes: measured.installedBytes,
      fileCount: measured.fileCount,
      treeSha256: measured.treeSha256
    };
  });
  invariant3(measurements.size === packs.length, "provider-pack size measurement contains an unrecognized pack");
  return {
    measurementStatus: "exact-locked-wheel-extraction",
    packs,
    totals: {
      installedBytes: packs.reduce((sum, pack) => sum + pack.installedBytes, 0),
      fileCount: packs.reduce((sum, pack) => sum + pack.fileCount, 0),
      treeSha256: providerPackAggregateTreeSha256(packs)
    }
  };
}
function buildDistributionSizeAccounting(files, contracts, { allowUnmaterializedIds = /* @__PURE__ */ new Set(), providerPackMeasurement = null, fixture = false } = {}) {
  const drilldownOwnerByPath = /* @__PURE__ */ new Map();
  for (const spec of [...contracts.embeddedComponentSpecs.values(), ...contracts.sharedComponentSpecs.values()]) {
    for (const file of filesMatchingSizeSpec(files, spec)) {
      invariant3(!drilldownOwnerByPath.has(file.path), `${file.path}: size drill-down overlaps ${drilldownOwnerByPath.get(file.path)} and ${spec.id}`);
      drilldownOwnerByPath.set(file.path, spec.id);
    }
  }
  const components = [...contracts.inventoryById.values()].filter((component) => component.redistribution === "bundle").sort((left, right) => bytewiseCompare3(left.id, right.id)).map((inventory) => {
    const selected = componentFilesForAccounting(files, contracts, inventory);
    invariant3(allowUnmaterializedIds.has(inventory.id) || selected.length > 0, `${inventory.id}: bundled component has no size-accounted files`);
    const summary = selected.length > 0 ? summarizeSelectedFiles(selected) : { sizeBytes: 0, fileCount: 0 };
    const embeddedSpec = contracts.embeddedComponentSpecs.get(inventory.id);
    const sharedSpec = contracts.sharedComponentSpecs.get(inventory.id);
    const root = contracts.componentPaths.get(inventory.id) ?? null;
    const ownedFiles = root === null ? [] : files.filter((file) => file.path === root || file.path.startsWith(`${root}/`));
    const sharedFiles = filesMatchingSizeSpec(files, sharedSpec);
    const accounting = selected.length === 0 ? inventory.id === "jobctrl-release-metadata" ? "self-referential-excluded" : "fixture-unmaterialized" : embeddedSpec ? inventory.id === "system-browser-adapter" ? "shared-code" : "embedded-subset" : sharedSpec ? "owned-root-plus-shared-subset" : "owned-root";
    return {
      id: inventory.id,
      classification: inventory.classification,
      redistribution: inventory.redistribution,
      accounting,
      path: root,
      includedIn: embeddedSpec?.includedIn ?? sharedSpec?.includedIn ?? null,
      overlapsCoreTotal: Boolean(embeddedSpec || sharedSpec),
      fileCount: summary.fileCount,
      installedBytes: summary.sizeBytes,
      ...sharedSpec ? {
        ownedRootBytes: ownedFiles.reduce((sum, file) => sum + file.sizeBytes, 0),
        sharedSubsetBytes: sharedFiles.reduce((sum, file) => sum + file.sizeBytes, 0)
      } : {},
      bomRef: `pkg:generic/jobctrl/${inventory.id}@${encodeURIComponent(contracts.versions[inventory.id])}`,
      ...inventory.id === "system-browser-adapter" ? {
        sharedDependencies: {
          installedBytes: 0,
          accounting: "already-counted-in-jobctrl-worker",
          note: "Shared configuration and discovery/browser helpers are not falsely allocated to the adapter."
        }
      } : {}
    };
  });
  const expectedBundleIds = [...contracts.inventoryById.values()].filter((component) => component.redistribution === "bundle").map((component) => component.id).sort(bytewiseCompare3);
  invariant3(JSON.stringify(components.map((component) => component.id)) === JSON.stringify(expectedBundleIds), "size accounting does not cover every bundled inventory component");
  const measuredProviders = normalizeProviderPackMeasurement(contracts, providerPackMeasurement, { fixture });
  const measuredById = new Map(measuredProviders.packs.map((pack) => [pack.id, pack]));
  const packs = [...contracts.providerPackLocks.packs].sort((left, right) => bytewiseCompare3(left.id, right.id)).map((pack) => {
    const measured = measuredById.get(pack.id);
    return {
      id: pack.id,
      version: pack.version,
      redistribution: "official-download",
      accounting: "artifact-excluded-on-demand",
      includedInCoreArtifact: false,
      measurementStatus: measuredProviders.measurementStatus,
      wheelCount: pack.wheels.length,
      downloadBytes: pack.wheels.reduce((sum, wheel) => sum + wheel.sizeBytes, 0),
      installedBytes: measured.installedBytes,
      fileCount: measured.fileCount,
      treeSha256: measured.treeSha256,
      installedSizeSource: measuredProviders.measurementStatus === "exact-locked-wheel-extraction" ? "signed-wheel-safe-extraction" : "unavailable-fixture",
      bomRef: `pkg:generic/jobctrl/${pack.id}@${encodeURIComponent(pack.version)}`
    };
  });
  const expectedPackIds = [...contracts.inventoryById.values()].filter((component) => component.redistribution === "official-download").map((component) => component.id).sort(bytewiseCompare3);
  invariant3(JSON.stringify(packs.map((pack) => pack.id)) === JSON.stringify(expectedPackIds), "size accounting does not cover every provider-pack inventory component");
  return {
    components,
    providerPacks: packs,
    providerPackTotals: {
      measurementStatus: measuredProviders.measurementStatus,
      packCount: packs.length,
      wheelCount: packs.reduce((sum, pack) => sum + pack.wheelCount, 0),
      downloadBytes: packs.reduce((sum, pack) => sum + pack.downloadBytes, 0),
      installedBytes: measuredProviders.totals.installedBytes,
      fileCount: measuredProviders.totals.fileCount,
      treeSha256: measuredProviders.totals.treeSha256,
      installedSizeSource: measuredProviders.measurementStatus === "exact-locked-wheel-extraction" ? "signed-wheel-safe-extraction" : "unavailable-fixture"
    }
  };
}
function topLevelSbomComponents(contracts, preliminaryFiles) {
  return [...contracts.inventoryById.values()].filter((component) => component.redistribution === "bundle").sort((left, right) => bytewiseCompare3(left.id, right.id)).map((inventory) => {
    const selectedFiles = componentFilesForAccounting(preliminaryFiles, contracts, inventory);
    const summary = selectedFiles.length > 0 ? summarizeSelectedFiles(selectedFiles) : null;
    const root = contracts.componentPaths.get(inventory.id) ?? null;
    const includedIn = inventory.embeddedIn ?? contracts.sharedComponentSpecs.get(inventory.id)?.includedIn ?? null;
    return {
      type: inventory.id.startsWith("jobctrl-") ? "application" : "library",
      "bom-ref": `pkg:generic/jobctrl/${inventory.id}@${encodeURIComponent(contracts.versions[inventory.id])}`,
      name: inventory.id,
      version: contracts.versions[inventory.id],
      supplier: { name: inventory.owner },
      licenses: [{ expression: inventory.license }],
      externalReferences: [{ type: "distribution", url: inventory.source }],
      ...summary ? { hashes: [{ alg: "SHA-256", content: summary.sha256 }] } : {},
      properties: [
        { name: "jobctrl:classification", value: inventory.classification },
        ...root ? [{ name: "jobctrl:payload-path", value: root }] : [],
        ...includedIn ? [{ name: "jobctrl:included-in", value: includedIn }] : [],
        { name: "jobctrl:redistribution", value: inventory.redistribution }
      ]
    };
  });
}
async function generateReleaseMetadata(payloadRoot, contracts, {
  mode,
  sourceDateEpoch,
  pythonSbom = null,
  nodeLicenseInventory = null,
  providerPackMeasurement = null,
  providerPackComparison = null,
  attributionEvidence = null,
  licenseSources = []
}) {
  const releaseRoot = componentRoot(payloadRoot, contracts, "jobctrl-release-metadata");
  await rm2(releaseRoot, { recursive: true, force: true });
  await mkdir2(path3.join(releaseRoot, "licenses"), { recursive: true, mode: 493 });
  const preliminaryFiles = (await buildFileInventory(payloadRoot)).filter((file) => !file.path.startsWith(`${contracts.componentPaths.get("jobctrl-release-metadata")}/`));
  const components = topLevelSbomComponents(contracts, preliminaryFiles);
  if (mode === "real") {
    components.push({
      type: "framework",
      "bom-ref": `pkg:golang/go@${GO_TOOLCHAIN_VERSION.slice(2)}`,
      name: "Go standard library",
      version: GO_TOOLCHAIN_VERSION.slice(2),
      supplier: { name: "The Go Authors" },
      licenses: [{ expression: "BSD-3-Clause" }],
      externalReferences: [{ type: "distribution", url: "https://go.dev/" }],
      properties: [{ name: "jobctrl:launcher-closure", value: "standard-library-only" }]
    });
  }
  if (pythonSbom) {
    const python = JSON.parse(await readFile3(pythonSbom, "utf8"));
    for (const component of python.components ?? []) components.push(component);
  }
  if (nodeLicenseInventory) {
    for (const entry of nodeLicenseInventory.packages) {
      for (const version of entry.versions) {
        components.push({
          type: "library",
          "bom-ref": `pkg:npm/${encodeURIComponent(entry.name)}@${encodeURIComponent(version)}`,
          name: entry.name,
          version,
          licenses: [{ expression: entry.license }]
        });
      }
    }
  }
  const uniqueComponents = [...new Map(components.map((component) => [component["bom-ref"], component])).values()].sort((left, right) => bytewiseCompare3(left["bom-ref"], right["bom-ref"]));
  const sbom = {
    bomFormat: "CycloneDX",
    specVersion: "1.6",
    serialNumber: `urn:uuid:${createHash3("sha256").update(`jobctrl:${contracts.versions["jobctrl-launcher"]}:${sourceDateEpoch}`).digest("hex").replace(/^(.{8})(.{4})(.{4})(.{4})(.{12}).*$/, "$1-$2-$3-$4-$5")}`,
    version: 1,
    metadata: {
      timestamp: new Date(sourceDateEpoch * 1e3).toISOString(),
      component: {
        type: "application",
        name: "JobCtrl payload",
        version: contracts.versions["jobctrl-launcher"]
      },
      properties: [
        { name: "jobctrl:build-mode", value: mode },
        { name: "jobctrl:provider-packs", value: "excluded-official-download" }
      ]
    },
    components: uniqueComponents
  };
  await writeJson(path3.join(releaseRoot, "sbom.cdx.json"), sbom);
  if (pythonSbom) await copyFile(pythonSbom, path3.join(releaseRoot, "python-core.sbom.cdx.json"));
  if (nodeLicenseInventory) await writeJson(path3.join(releaseRoot, "node-production-licenses.json"), nodeLicenseInventory);
  const licenseRecords = await materializeLicenseSources(releaseRoot, licenseSources);
  if (attributionEvidence) {
    await writeJson(path3.join(releaseRoot, "attribution-evidence.json"), {
      ...attributionEvidence,
      licenseFiles: licenseRecords
    });
  }
  const attributions = topLevelSbomComponents(contracts, preliminaryFiles).map((component) => ({
    id: component.name,
    version: component.version,
    owner: contracts.inventoryById.get(component.name).owner,
    license: contracts.inventoryById.get(component.name).license,
    source: contracts.inventoryById.get(component.name).source,
    redistribution: "bundle"
  }));
  await writeJson(path3.join(releaseRoot, "licenses", "index.json"), {
    schemaVersion: 1,
    status: mode === "fixture" ? "fixture-contract" : "collected-from-production-inputs",
    components: attributions
  });
  const rootLicense = path3.join(REPO_ROOT, "LICENSE");
  if (await exists(rootLicense)) {
    await copyFile(rootLicense, path3.join(releaseRoot, "licenses", "JobCtrl-AGPL-3.0.txt"));
    await chmod2(path3.join(releaseRoot, "licenses", "JobCtrl-AGPL-3.0.txt"), 420);
  } else {
    await writeFile2(path3.join(releaseRoot, "licenses", "fixture-notice.txt"), "Fixture build: consult component-inventory.json for declared license expressions.\n", { mode: 420 });
  }
  await writeJson(path3.join(releaseRoot, "provenance.json"), {
    schemaVersion: 1,
    buildMode: mode,
    sourceDateEpoch,
    platform: contracts.platform.id,
    source: "https://github.com/ebarti/JobCtrl",
    launcherToolchain: {
      version: contracts.launcherToolchain.goVersion,
      moduleClosure: contracts.launcherToolchain.moduleClosure,
      license: contracts.launcherToolchain.license,
      licenseSource: contracts.launcherToolchain.licenseSource,
      licenseSha256: contracts.launcherToolchain.licenseSha256,
      archive: nativeGoArchiveLock(contracts.launcherToolchain),
      officialMetadataUrl: contracts.launcherToolchain.archive.officialMetadataUrl
    },
    providerPacks: {
      included: false,
      policy: "official-download",
      ids: ["antigravity-provider-runtime", "claude-agent-sdk", "codex-provider-runtime"]
    },
    lockedInputs: contracts.locks.inputs.map(({ id, componentId, version, url, sha256: sha2562 }) => ({ id, componentId, version, url, sha256: sha2562 }))
  });
  await writeJson(path3.join(releaseRoot, "provider-packs.lock.json"), contracts.providerPackLocks);
  await copyFile(
    path3.join(REPO_ROOT, "packaging", "distribution", "capability-policy.json"),
    path3.join(releaseRoot, "capability-policy.json")
  );
  await chmod2(path3.join(releaseRoot, "capability-policy.json"), 420);
  const allowedUnmaterialized = /* @__PURE__ */ new Set(["jobctrl-release-metadata"]);
  if (mode === "fixture") {
    for (const component of contracts.inventoryById.values()) {
      if (component.redistribution === "bundle" && component.embeddedIn !== void 0) allowedUnmaterialized.add(component.id);
    }
  }
  const sizeAccounting = buildDistributionSizeAccounting(preliminaryFiles, contracts, {
    allowUnmaterializedIds: allowedUnmaterialized,
    providerPackMeasurement,
    fixture: mode === "fixture"
  });
  const resolvedProviderPackComparison = providerPackComparison ?? compareProviderPackMeasurements(sizeAccounting.providerPacks);
  await writeJson(path3.join(releaseRoot, "size-report.json"), {
    schemaVersion: 1,
    measurement: "installed-logical-bytes-before-release-metadata",
    installedBytes: preliminaryFiles.reduce((sum, file) => sum + file.sizeBytes, 0),
    components: sizeAccounting.components,
    providerPacks: sizeAccounting.providerPacks,
    providerPackTotals: sizeAccounting.providerPackTotals,
    providerPackComparison: resolvedProviderPackComparison,
    compressedReport: "published beside the compressed artifact as size-report.json"
  });
}
async function manifestFiles(payloadRoot) {
  return (await buildFileInventory(payloadRoot)).filter((file) => !ENVELOPE_FILES.has(file.path));
}
async function createReleaseManifest(payloadRoot, contracts, {
  buildId,
  sourceDateEpoch,
  releaseChannel = "local",
  manifestKeyId = releaseChannel === "local" ? "local-development" : contracts.signingPolicy.manifestSigning.keyId,
  codeSigning = releaseChannel === "local" ? "unsigned-local" : "developer-id",
  notarized = releaseChannel !== "local"
}) {
  invariant3(/^[0-9A-Za-z][0-9A-Za-z._-]{7,127}$/.test(buildId), "local buildId is invalid");
  invariant3(Number.isInteger(sourceDateEpoch) && sourceDateEpoch >= 0, "sourceDateEpoch must be a non-negative integer");
  invariant3(RELEASE_CHANNELS2.has(releaseChannel), "releaseChannel is invalid");
  const files = await manifestFiles(payloadRoot);
  const components = [...contracts.componentPaths.entries()].sort(([left], [right]) => bytewiseCompare3(left, right)).map(([id, componentPath]) => {
    const inventory = contracts.inventoryById.get(id);
    const summary = summarizeComponentFiles(componentPath, files);
    return {
      id,
      classification: inventory.classification,
      version: contracts.versions[id],
      owner: inventory.owner,
      source: inventory.source,
      license: inventory.license,
      redistribution: "bundle",
      path: componentPath,
      sha256: summary.sha256,
      sizeBytes: summary.sizeBytes,
      required: inventory.requiredInCore
    };
  });
  const capabilities = [...contracts.capabilitiesById.entries()].sort(([left], [right]) => bytewiseCompare3(left, right)).map(([id, capability]) => ({
    id,
    defaultEnabled: capability.defaultEnabled,
    componentIds: [...capability.componentIds]
  }));
  const manifest = {
    schemaVersion: 1,
    appVersion: contracts.versions["jobctrl-launcher"],
    buildId,
    releaseChannel,
    sourceDateEpoch,
    platform: {
      id: contracts.platform.id,
      os: contracts.platform.os,
      arch: contracts.platform.arch,
      minimumOsVersion: contracts.platform.minimumOsVersion
    },
    launcherCompatibility: { ...contracts.platform.launcherCompatibility },
    components,
    capabilities,
    files,
    signing: {
      manifestAlgorithm: "ed25519",
      manifestKeyId,
      codeSigning,
      notarized
    }
  };
  validateDistributionManifest(manifest, contracts);
  await writeJson(path3.join(payloadRoot, "manifest.json"), manifest);
  return manifest;
}
async function createLocalManifest(payloadRoot, contracts, options) {
  const manifest = await createReleaseManifest(payloadRoot, contracts, options);
  invariant3(manifest.releaseChannel === "local", "createLocalManifest only supports local channel envelopes");
  await writeJson(path3.join(payloadRoot, "manifest.sig"), {
    schemaVersion: 1,
    status: "unsigned-local",
    manifestAlgorithm: "ed25519",
    manifestKeyId: "local-development",
    signature: null,
    promotable: false
  });
  return manifest;
}
async function verifyExactPayloadTree(payloadRoot, manifest) {
  const actual = await manifestFiles(payloadRoot);
  invariant3(JSON.stringify(actual) === JSON.stringify(manifest.files), "payload tree does not exactly match manifest.files");
  const actualEnvelope = (await readdir2(payloadRoot)).filter((name) => ENVELOPE_FILES.has(name)).sort(bytewiseCompare3);
  invariant3(JSON.stringify(actualEnvelope) === JSON.stringify([...ENVELOPE_FILES].sort(bytewiseCompare3)), "local payload envelope is incomplete");
  return true;
}
function isProbablyText(contents) {
  if (contents.includes(0)) return false;
  const sample = contents.subarray(0, Math.min(contents.length, 8192));
  let printable = 0;
  for (const value of sample) if (value === 9 || value === 10 || value === 13 || value >= 32 && value <= 126) printable += 1;
  return sample.length === 0 || printable / sample.length > 0.9;
}
async function scanForbiddenPayload(payloadRoot, { forbiddenAbsolutePaths = [] } = {}) {
  const files = await buildFileInventory(payloadRoot);
  const failures = [];
  const artifactWideNeedles = [
    ...forbiddenAbsolutePaths.filter(Boolean),
    ...FORBIDDEN_TOOL_INVOCATION_NEEDLES,
    ...FORBIDDEN_BROWSER_REDISTRIBUTION_NEEDLES
  ];
  let streamScannedFileCount = 0;
  let semanticTextScannedFileCount = 0;
  for (const file of files) {
    const lowerPath = file.path.toLowerCase();
    const segments = lowerPath.split("/");
    const pythonRelativePath = pythonRuntimeRelativePath(file.path);
    if (segments.some((segment) => FORBIDDEN_SEGMENTS.has(segment))) failures.push(`${file.path}: development/test/cache path`);
    if (lowerPath.endsWith(".map") || lowerPath.endsWith("esbuild-metafile.json")) failures.push(`${file.path}: build-only metadata`);
    if (path3.posix.basename(lowerPath) === "mockserviceworker.js" || lowerPath.includes("spikes.table-filters")) failures.push(`${file.path}: developer-only web fixture`);
    if (FORBIDDEN_PLAYWRIGHT_MCP_RUNTIME_PATHS.some((prefix) => file.path === prefix || file.path.startsWith(`${prefix}/`))) {
      failures.push(`${file.path}: Playwright MCP test/docs/viewer closure`);
    }
    if (file.path.startsWith("playwright-mcp/node_modules/") && lowerPath.endsWith(".md")) {
      failures.push(`${file.path}: Playwright MCP documentation closure`);
    }
    if (isTemporalBridgeBuildSourcePath(pythonRelativePath)) {
      failures.push(`${file.path}: Temporal bridge build/source closure`);
    }
    if (isKnownPythonNonRuntimePath(pythonRelativePath)) {
      failures.push(`${file.path}: known non-runtime Python source/docs/fixture closure`);
    }
    if (isGitMetadataBasename(path3.posix.basename(lowerPath))) failures.push(`${file.path}: Git metadata`);
    if ((lowerPath.endsWith(".md") || lowerPath.endsWith(".rst")) && !isAllowedRuntimeDocumentationPath(file.path)) {
      failures.push(`${file.path}: runtime documentation outside the legal/attribution allowlist`);
    }
    if (FORBIDDEN_PROVIDER_PATTERNS.some((pattern) => pattern.test(lowerPath))) failures.push(`${file.path}: provider pack entered the core payload`);
    if (file.type === "file" && FORBIDDEN_TOOL_NAMES.has(path3.posix.basename(lowerPath))) failures.push(`${file.path}: forbidden build tool`);
    if (file.type === "file") {
      streamScannedFileCount += 1;
      const leaked = await binaryContainsNeedle(path3.join(payloadRoot, ...file.path.split("/")), artifactWideNeedles);
      if (leaked) failures.push(`${file.path}: artifact-wide forbidden build/runtime string ${leaked}`);
    }
    if (file.type !== "file" || file.sizeBytes > 2 * 1024 * 1024) continue;
    const contents = await readFile3(path3.join(payloadRoot, ...file.path.split("/")));
    if (!isProbablyText(contents)) continue;
    semanticTextScannedFileCount += 1;
    const text = contents.toString("utf8");
    for (const forbidden of forbiddenAbsolutePaths.filter(Boolean)) {
      if (text.includes(forbidden)) failures.push(`${file.path}: leaks build path ${forbidden}`);
    }
  }
  invariant3(failures.length === 0, `forbidden payload content:
${[...new Set(failures)].sort(bytewiseCompare3).join("\n")}`);
  return {
    fileCount: files.length,
    streamScannedFileCount,
    semanticTextScannedFileCount,
    artifactWideNeedleCount: artifactWideNeedles.length,
    status: "clean"
  };
}
var CRC32_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let index = 0; index < table.length; index += 1) {
    let value = index;
    for (let bit = 0; bit < 8; bit += 1) value = value >>> 1 ^ ((value & 1) === 1 ? 3988292384 : 0);
    table[index] = value >>> 0;
  }
  return table;
})();
function updateCrc32(value, chunk) {
  let crc = value;
  for (const byte of chunk) crc = crc >>> 8 ^ CRC32_TABLE[(crc ^ byte) & 255];
  return crc >>> 0;
}
function zipDosDateTime(sourceDateEpoch) {
  invariant3(Number.isInteger(sourceDateEpoch) && sourceDateEpoch >= 0 && sourceDateEpoch <= ZIP_UINT32_MAX, "ZIP SOURCE_DATE_EPOCH must be a non-negative uint32");
  const date = new Date(Math.max(sourceDateEpoch, ZIP_EPOCH_FLOOR) * 1e3);
  const year = date.getUTCFullYear();
  invariant3(year >= 1980 && year <= 2107, "ZIP SOURCE_DATE_EPOCH is outside the DOS timestamp range");
  return {
    date: year - 1980 << 9 | date.getUTCMonth() + 1 << 5 | date.getUTCDate(),
    time: date.getUTCHours() << 11 | date.getUTCMinutes() << 5 | Math.floor(date.getUTCSeconds() / 2)
  };
}
function zipExtendedTimestamp(sourceDateEpoch) {
  const extra = Buffer.alloc(9);
  extra.writeUInt16LE(21589, 0);
  extra.writeUInt16LE(5, 2);
  extra.writeUInt8(1, 4);
  extra.writeUInt32LE(sourceDateEpoch, 5);
  return extra;
}
async function zipEntryMetadata(payloadRoot, file) {
  const source = file.type === "symlink" ? Readable.from([Buffer.from(file.target, "utf8")]) : createReadStream3(path3.join(payloadRoot, ...file.path.split("/")));
  let crc = 4294967295;
  let size = 0;
  for await (const chunk of source) {
    crc = updateCrc32(crc, chunk);
    size += chunk.length;
  }
  invariant3(size === file.sizeBytes, `${file.path}: ZIP source size drifted from manifest inventory`);
  return { crc32: (crc ^ 4294967295) >>> 0, size };
}
function zipLocalHeader({ name, extra, dos, method }) {
  const header = Buffer.alloc(30 + name.length + extra.length);
  header.writeUInt32LE(67324752, 0);
  header.writeUInt16LE(20, 4);
  header.writeUInt16LE(8, 6);
  header.writeUInt16LE(method, 8);
  header.writeUInt16LE(dos.time, 10);
  header.writeUInt16LE(dos.date, 12);
  header.writeUInt32LE(0, 14);
  header.writeUInt32LE(0, 18);
  header.writeUInt32LE(0, 22);
  header.writeUInt16LE(name.length, 26);
  header.writeUInt16LE(extra.length, 28);
  name.copy(header, 30);
  extra.copy(header, 30 + name.length);
  return header;
}
function zipCentralDirectoryHeader(entry) {
  const header = Buffer.alloc(46 + entry.name.length + entry.extra.length);
  header.writeUInt32LE(33639248, 0);
  header.writeUInt16LE(788, 4);
  header.writeUInt16LE(20, 6);
  header.writeUInt16LE(8, 8);
  header.writeUInt16LE(entry.method, 10);
  header.writeUInt16LE(entry.dos.time, 12);
  header.writeUInt16LE(entry.dos.date, 14);
  header.writeUInt32LE(entry.crc32, 16);
  header.writeUInt32LE(entry.compressedSize, 20);
  header.writeUInt32LE(entry.size, 24);
  header.writeUInt16LE(entry.name.length, 28);
  header.writeUInt16LE(entry.extra.length, 30);
  header.writeUInt16LE(0, 32);
  header.writeUInt16LE(0, 34);
  header.writeUInt16LE(0, 36);
  const mode = entry.type === "symlink" ? 41471 : 32768 | Number.parseInt(entry.mode, 8);
  header.writeUInt32LE(mode << 16 >>> 0, 38);
  header.writeUInt32LE(entry.offset, 42);
  entry.name.copy(header, 46);
  entry.extra.copy(header, 46 + entry.name.length);
  return header;
}
function zipDataDescriptor(entry) {
  const descriptor = Buffer.alloc(16);
  descriptor.writeUInt32LE(134695760, 0);
  descriptor.writeUInt32LE(entry.crc32, 4);
  descriptor.writeUInt32LE(entry.compressedSize, 8);
  descriptor.writeUInt32LE(entry.size, 12);
  return descriptor;
}
async function createDeterministicZip(payloadRoot, archivePath, sourceDateEpoch) {
  const files = await buildFileInventory(payloadRoot);
  const dos = zipDosDateTime(sourceDateEpoch);
  const extra = zipExtendedTimestamp(sourceDateEpoch);
  await mkdir2(path3.dirname(archivePath), { recursive: true, mode: 493 });
  const output = createWriteStream(archivePath, { mode: 420 });
  let offset = 0;
  const entries = [];
  async function writeChunk(chunk) {
    invariant3(offset + chunk.length <= ZIP_UINT32_MAX, "ZIP64 output is not supported");
    offset += chunk.length;
    if (!output.write(chunk)) await once(output, "drain");
  }
  try {
    for (const file of files) {
      const name = Buffer.from(file.path, "utf8");
      const metadata = await zipEntryMetadata(payloadRoot, file);
      invariant3(metadata.size <= ZIP_UINT32_MAX, `${file.path}: ZIP entry exceeds ZIP32 size limit`);
      const entry = {
        ...file,
        ...metadata,
        name,
        extra,
        dos,
        method: 8,
        offset,
        compressedSize: 0
      };
      await writeChunk(zipLocalHeader(entry));
      const source = file.type === "symlink" ? Readable.from([Buffer.from(file.target, "utf8")]) : createReadStream3(path3.join(payloadRoot, ...file.path.split("/")));
      const deflater = createDeflateRaw({ level: 9 });
      source.pipe(deflater);
      for await (const chunk of deflater) {
        entry.compressedSize += chunk.length;
        invariant3(entry.compressedSize <= ZIP_UINT32_MAX, `${file.path}: compressed ZIP entry exceeds ZIP32 size limit`);
        await writeChunk(chunk);
      }
      await writeChunk(zipDataDescriptor(entry));
      entries.push(entry);
    }
    const centralDirectoryOffset = offset;
    for (const entry of entries) await writeChunk(zipCentralDirectoryHeader(entry));
    const centralDirectorySize = offset - centralDirectoryOffset;
    invariant3(entries.length <= 65535, "ZIP entry count exceeds ZIP32 limit");
    invariant3(centralDirectorySize <= ZIP_UINT32_MAX, "ZIP central directory exceeds ZIP32 limit");
    const end = Buffer.alloc(22);
    end.writeUInt32LE(101010256, 0);
    end.writeUInt16LE(0, 4);
    end.writeUInt16LE(0, 6);
    end.writeUInt16LE(entries.length, 8);
    end.writeUInt16LE(entries.length, 10);
    end.writeUInt32LE(centralDirectorySize, 12);
    end.writeUInt32LE(centralDirectoryOffset, 16);
    end.writeUInt16LE(0, 20);
    await writeChunk(end);
    output.end();
    await finished(output);
  } catch (error) {
    output.destroy();
    await rm2(archivePath, { force: true });
    throw error;
  }
  await chmod2(archivePath, 420);
  const archiveStat = await stat2(archivePath);
  return { compressedBytes: archiveStat.size, sha256: await sha256File2(archivePath), fileCount: files.length };
}
function compareProviderPackMeasurements(current, baseline = null) {
  if (current === void 0) return void 0;
  invariant3(Array.isArray(current), "current provider-pack measurement must be an array");
  const exact = current.every((pack) => pack.measurementStatus === "exact-locked-wheel-extraction" && Number.isInteger(pack.installedBytes) && Number.isInteger(pack.fileCount) && /^[a-f0-9]{64}$/.test(pack.treeSha256));
  if (!exact) {
    const status = current.every((pack) => pack.measurementStatus === "unavailable-fixture") ? "unavailable-fixture" : "unavailable-current-measurement";
    return {
      status,
      installedBytesDelta: null,
      fileCountDelta: null,
      packs: current.map((pack) => ({ id: pack.id, version: pack.version, status }))
    };
  }
  if (baseline === null) {
    return {
      status: "baseline-not-provided",
      installedBytesDelta: null,
      fileCountDelta: null,
      packs: current.map((pack) => ({ id: pack.id, version: pack.version, status: "baseline-not-provided" }))
    };
  }
  if (!Array.isArray(baseline.providerPacks)) {
    return {
      status: "baseline-missing-provider-pack-measurement",
      installedBytesDelta: null,
      fileCountDelta: null,
      packs: current.map((pack) => ({ id: pack.id, version: pack.version, status: "baseline-missing-provider-pack-measurement" }))
    };
  }
  const previousById = new Map(baseline.providerPacks.map((pack) => [pack.id, pack]));
  const packs = current.map((pack) => {
    const previous = previousById.get(pack.id);
    if (!previous || !Number.isInteger(previous.installedBytes) || !Number.isInteger(previous.fileCount)) {
      return { id: pack.id, version: pack.version, status: "new-or-unmeasured", installedBytesDelta: null, fileCountDelta: null };
    }
    return {
      id: pack.id,
      version: pack.version,
      status: "compared",
      previousVersion: previous.version,
      installedBytesDelta: pack.installedBytes - previous.installedBytes,
      fileCountDelta: pack.fileCount - previous.fileCount,
      treeChanged: pack.treeSha256 !== previous.treeSha256
    };
  });
  const previousExact = baseline.providerPacks.every((pack) => Number.isInteger(pack.installedBytes) && Number.isInteger(pack.fileCount));
  if (!previousExact) {
    return {
      status: "baseline-missing-provider-pack-measurement",
      installedBytesDelta: null,
      fileCountDelta: null,
      packs
    };
  }
  return {
    status: "compared",
    installedBytesDelta: current.reduce((sum, pack) => sum + pack.installedBytes, 0) - baseline.providerPacks.reduce((sum, pack) => sum + pack.installedBytes, 0),
    fileCountDelta: current.reduce((sum, pack) => sum + pack.fileCount, 0) - baseline.providerPacks.reduce((sum, pack) => sum + pack.fileCount, 0),
    packs
  };
}
function compareSizeReports(current, baseline = null) {
  invariant3(current && typeof current === "object", "current size metrics must be an object");
  invariant3(typeof current.platform === "string" && current.platform.length > 0, "current size metrics require a platform");
  invariant3(Number.isInteger(current.installedBytes) && current.installedBytes >= 0, "current installedBytes must be non-negative");
  invariant3(Number.isInteger(current.compressedBytes) && current.compressedBytes >= 0, "current compressedBytes must be non-negative");
  if (baseline === null) {
    const comparison2 = {
      status: "baseline-not-provided",
      previousBuildId: null,
      installedBytesDelta: null,
      installedPercentDelta: null,
      compressedBytesDelta: null,
      compressedPercentDelta: null
    };
    const providerPacks2 = compareProviderPackMeasurements(current.providerPacks);
    return providerPacks2 === void 0 ? comparison2 : { ...comparison2, providerPacks: providerPacks2 };
  }
  invariant3(baseline && typeof baseline === "object", "baseline size report must be an object");
  invariant3(baseline.platform === current.platform, "baseline size report platform does not match the current build");
  invariant3(typeof baseline.buildId === "string" && baseline.buildId.length > 0, "baseline size report requires buildId");
  invariant3(Number.isInteger(baseline.installedBytes) && baseline.installedBytes >= 0, "baseline installedBytes must be non-negative");
  invariant3(Number.isInteger(baseline.compressedBytes) && baseline.compressedBytes >= 0, "baseline compressedBytes must be non-negative");
  const percentDelta = (value, previous) => previous === 0 ? null : Number(((value - previous) / previous * 100).toFixed(6));
  const comparison = {
    status: "compared",
    previousBuildId: baseline.buildId,
    installedBytesDelta: current.installedBytes - baseline.installedBytes,
    installedPercentDelta: percentDelta(current.installedBytes, baseline.installedBytes),
    compressedBytesDelta: current.compressedBytes - baseline.compressedBytes,
    compressedPercentDelta: percentDelta(current.compressedBytes, baseline.compressedBytes)
  };
  const providerPacks = compareProviderPackMeasurements(current.providerPacks, baseline);
  return providerPacks === void 0 ? comparison : { ...comparison, providerPacks };
}
async function buildFixturePayload({
  outputDirectory,
  buildId = "fixture-build-0001",
  sourceDateEpoch = 0,
  root = REPO_ROOT
} = {}) {
  invariant3(outputDirectory, "fixture build requires outputDirectory");
  const contracts = await loadBuildContracts(root);
  const outputRoot = path3.resolve(outputDirectory);
  const payloadRoot = path3.join(outputRoot, "payload");
  await rm2(outputRoot, { recursive: true, force: true });
  await mkdir2(payloadRoot, { recursive: true, mode: 493 });
  await writeFixtureComponents(payloadRoot, contracts);
  await generateReleaseMetadata(payloadRoot, contracts, { mode: "fixture", sourceDateEpoch });
  const manifest = await createLocalManifest(payloadRoot, contracts, { buildId, sourceDateEpoch });
  await verifyExactPayloadTree(payloadRoot, manifest);
  await scanForbiddenPayload(payloadRoot, { forbiddenAbsolutePaths: [root, outputRoot] });
  const archivePath = path3.join(outputRoot, `jobctrl-${contracts.versions["jobctrl-launcher"]}-${contracts.platform.id}.zip`);
  const compressed = await createDeterministicZip(payloadRoot, archivePath, sourceDateEpoch);
  const installedBytes = manifest.files.reduce((sum, file) => sum + file.sizeBytes, 0) + (await stat2(path3.join(payloadRoot, "manifest.json"))).size + (await stat2(path3.join(payloadRoot, "manifest.sig"))).size;
  const fixtureSizeAccounting = buildDistributionSizeAccounting(await buildFileInventory(payloadRoot), contracts, {
    allowUnmaterializedIds: new Set([...contracts.inventoryById.values()].filter((component) => component.redistribution === "bundle" && component.embeddedIn !== void 0).map((component) => component.id)),
    fixture: true
  });
  const sizeReport = {
    schemaVersion: 1,
    platform: contracts.platform.id,
    buildId,
    installedBytes,
    compressedBytes: compressed.compressedBytes,
    compressionRatio: Number((compressed.compressedBytes / installedBytes).toFixed(6)),
    archiveSha256: compressed.sha256,
    comparison: compareSizeReports({
      platform: contracts.platform.id,
      installedBytes,
      compressedBytes: compressed.compressedBytes,
      providerPacks: fixtureSizeAccounting.providerPacks
    }),
    components: fixtureSizeAccounting.components,
    providerPacks: fixtureSizeAccounting.providerPacks,
    providerPackTotals: fixtureSizeAccounting.providerPackTotals
  };
  await writeJson(path3.join(outputRoot, "size-report.json"), sizeReport);
  const installerPath = path3.join(outputRoot, "jobctrl-installer");
  await copyFile(path3.join(payloadRoot, "launcher", "jobctrl-installer"), installerPath);
  await chmod2(installerPath, 493);
  const release = await writeLocalReleaseBundle({
    outputDirectory: outputRoot,
    archivePath,
    manifestPath: path3.join(payloadRoot, "manifest.json"),
    installerPath,
    buildId,
    appVersion: contracts.versions["jobctrl-launcher"],
    platform: contracts.platform
  });
  const result = {
    schemaVersion: 1,
    mode: "fixture",
    buildId,
    releaseChannel: "local",
    archiveType: "zip",
    payloadRoot,
    archivePath,
    manifestPath: path3.join(payloadRoot, "manifest.json"),
    manifestSha256: await sha256File2(path3.join(payloadRoot, "manifest.json")),
    archiveSha256: compressed.sha256,
    installedBytes,
    compressedBytes: compressed.compressedBytes,
    release
  };
  await writeJson(path3.join(outputRoot, "build-result.json"), result);
  return { ...result, manifest, sizeReport };
}
async function buildRealPayload({
  outputDirectory,
  cacheDirectory = path3.join(os.homedir(), "Library", "Caches", "JobCtrl", "distribution"),
  buildId = "local-real-build-0001",
  sourceDateEpoch = Number.parseInt(process2.env.SOURCE_DATE_EPOCH ?? "0", 10),
  baselineSizeReportPath = null,
  releaseChannel = "local",
  releaseTrustKeyBase64 = "",
  root = REPO_ROOT
} = {}) {
  invariant3(outputDirectory, "real build requires outputDirectory");
  validateReleaseBuildBinding(releaseChannel, releaseTrustKeyBase64);
  const contracts = await loadBuildContracts(root);
  const baselineSizeReport = baselineSizeReportPath === null ? null : JSON.parse(await readFile3(path3.resolve(baselineSizeReportPath), "utf8"));
  const outputRoot = path3.resolve(outputDirectory);
  const payloadRoot = path3.join(outputRoot, "payload");
  const scratchDirectory = await mkdtemp(path3.join(os.tmpdir(), "jobctrl-real-build-"));
  await rm2(outputRoot, { recursive: true, force: true });
  await mkdir2(payloadRoot, { recursive: true, mode: 493 });
  try {
    const resolvedCacheDirectory = path3.resolve(cacheDirectory);
    const [externalInputs, nativeGoToolchain] = await Promise.all([
      assembleExternalRuntimes(payloadRoot, contracts, resolvedCacheDirectory, scratchDirectory),
      prepareNativeGoToolchain(root, resolvedCacheDirectory, scratchDirectory, contracts.launcherToolchain)
    ]);
    const pythonRuntimePrune = await pruneUnusedPythonRuntime(componentRoot(payloadRoot, contracts, "python-runtime"));
    await prepareStandardProductionInputs(root, contracts, externalInputs);
    await copyPreparedApplicationInputs(payloadRoot, root, contracts);
    await Promise.all([
      assemblePlaywrightMcp(payloadRoot, root, contracts, externalInputs),
      writeGeneratedComponents(payloadRoot, root, contracts, sourceDateEpoch, nativeGoToolchain, { releaseChannel, releaseTrustKeyBase64 })
    ]);
    await assertHeadlessChromiumPayload(payloadRoot, contracts);
    const pythonSbom = await preparePythonWorker(payloadRoot, root, contracts, scratchDirectory);
    const providerPackMeasurement = await measureProviderPackInstalledTrees(payloadRoot, root, contracts, scratchDirectory);
    const providerPackComparison = compareProviderPackMeasurements(
      normalizeProviderPackMeasurement(contracts, providerPackMeasurement).packs.map((pack) => ({
        ...pack,
        measurementStatus: "exact-locked-wheel-extraction"
      })),
      baselineSizeReport
    );
    const nodeContributors = await collectNodeContributors(payloadRoot, root, contracts);
    const [nodeBase, pythonAttribution, topLevelSources, browserResources] = await Promise.all([
      collectNodeLicenseInventory(contracts, path3.resolve(cacheDirectory), nodeContributors),
      collectPythonLicenseEvidence(payloadRoot, contracts, path3.resolve(cacheDirectory)),
      collectTopLevelLicenseEvidence(payloadRoot, root, contracts),
      browserCreditsEvidence(payloadRoot, contracts)
    ]);
    await reconcilePythonSbom(pythonSbom, pythonAttribution.packages, { sourceDateEpoch });
    const chromiumCredits = await captureChromiumCredits(payloadRoot, contracts, scratchDirectory);
    await Promise.all([
      pruneInstalledPythonTree(path3.join(componentRoot(payloadRoot, contracts, "python-runtime"), "lib", "python3.12")),
      pruneInstalledPythonTree(path3.join(componentRoot(payloadRoot, contracts, "jobctrl-worker"), "site-packages")),
      pruneInstalledPythonTree(path3.join(componentRoot(payloadRoot, contracts, "playwright-python"), "site-packages"))
    ]);
    const nodeLicenseInventory = nodeBase.inventory;
    const payloadNpmPackages = nodeContributors.filter((entry) => [...entry.contributions.values()].some((contribution) => contribution.kind === "payload-npm-tree")).map((entry) => ({
      package: entry.key,
      paths: [...entry.contributions.values()].filter((contribution) => contribution.kind === "payload-npm-tree").map((contribution) => contribution.artifactPath).sort(bytewiseCompare3)
    }));
    const licenseSources = [
      ...nodeBase.licenseSources,
      ...pythonAttribution.licenseSources,
      ...topLevelSources,
      { subject: "chromium-core-third-party-credits", source: chromiumCredits }
    ];
    await generateReleaseMetadata(payloadRoot, contracts, {
      mode: "real",
      sourceDateEpoch,
      pythonSbom,
      nodeLicenseInventory,
      providerPackMeasurement,
      providerPackComparison,
      licenseSources,
      attributionEvidence: {
        schemaVersion: 1,
        status: "complete",
        nodePackageCount: nodeLicenseInventory.packages.reduce((count, entry) => count + entry.versions.length, 0),
        pythonPackageCount: pythonAttribution.packages.length,
        payloadNpmPackages,
        browserEmbeddedResources: browserResources,
        chromiumCredits: "licenses/texts contains the verbatim LICENSE.headless_shell notice file from the pinned headless browser"
      }
    });
    const manifest = await createLocalManifest(payloadRoot, contracts, { buildId, sourceDateEpoch });
    await verifyExactPayloadTree(payloadRoot, manifest);
    const forbiddenAudit = await scanForbiddenPayload(payloadRoot, { forbiddenAbsolutePaths: [root, outputRoot, scratchDirectory] });
    const machO = await scanMachODependencies(payloadRoot, {
      forbiddenStrings: [root, outputRoot, scratchDirectory],
      declaredMinimumOsVersion: contracts.platform.minimumOsVersion
    });
    const evidenceRoot = path3.join(outputRoot, "build-evidence");
    await mkdir2(evidenceRoot, { recursive: true, mode: 493 });
    await copyFile(path3.join(root, "dist", "api", "metafile.json"), path3.join(evidenceRoot, "api-esbuild-metafile.json"));
    await chmod2(path3.join(evidenceRoot, "api-esbuild-metafile.json"), 420);
    await writeJson(path3.join(evidenceRoot, "node-contribution-closure.json"), {
      schemaVersion: 1,
      status: "complete",
      packages: nodeLicenseInventory.packages.map((entry) => ({
        package: `${entry.name}@${entry.versions[0]}`,
        contributions: entry.contributions
      }))
    });
    await writeJson(path3.join(evidenceRoot, "provider-pack-installed-trees.json"), providerPackMeasurement);
    const archivePath = path3.join(outputRoot, `jobctrl-${contracts.versions["jobctrl-launcher"]}-${contracts.platform.id}.zip`);
    const compressed = await createDeterministicZip(payloadRoot, archivePath, sourceDateEpoch);
    const smoke = await smokeExtractedPayload(archivePath, outputRoot, contracts, {
      nativeLauncherReleaseChannel: releaseChannel
    });
    await rm2(path3.join(outputRoot, "clean-extraction"), { recursive: true, force: true });
    const installedBytes = (await buildFileInventory(payloadRoot)).reduce((sum, file) => sum + file.sizeBytes, 0);
    const sizeAccounting = buildDistributionSizeAccounting(await buildFileInventory(payloadRoot), contracts, {
      providerPackMeasurement
    });
    const sizeReport = {
      schemaVersion: 1,
      platform: contracts.platform.id,
      buildId,
      installedBytes,
      compressedBytes: compressed.compressedBytes,
      compressionRatio: Number((compressed.compressedBytes / installedBytes).toFixed(6)),
      archiveSha256: compressed.sha256,
      comparison: compareSizeReports({
        platform: contracts.platform.id,
        installedBytes,
        compressedBytes: compressed.compressedBytes,
        providerPacks: sizeAccounting.providerPacks
      }, baselineSizeReport),
      components: sizeAccounting.components,
      providerPacks: sizeAccounting.providerPacks,
      providerPackTotals: sizeAccounting.providerPackTotals
    };
    await writeJson(path3.join(outputRoot, "size-report.json"), sizeReport);
    const installerPath = path3.join(outputRoot, "jobctrl-installer");
    await copyFile(path3.join(payloadRoot, "launcher", "jobctrl-installer"), installerPath);
    await chmod2(installerPath, 493);
    const release = await writeLocalReleaseBundle({
      outputDirectory: outputRoot,
      archivePath,
      manifestPath: path3.join(payloadRoot, "manifest.json"),
      installerPath,
      buildId,
      appVersion: contracts.versions["jobctrl-launcher"],
      platform: contracts.platform
    });
    const result = {
      schemaVersion: 1,
      mode: "real",
      buildId,
      releaseChannel: "local",
      nativeLauncherReleaseChannel: releaseChannel,
      nativeLauncherReleaseTrustKeyBase64: releaseTrustKeyBase64 || null,
      nativeLauncherReleaseTrustKeySha256: releaseTrustKeyBase64 ? createHash3("sha256").update(releaseTrustKeyBase64).digest("hex") : null,
      archiveType: "zip",
      payloadRoot,
      archivePath,
      manifestPath: path3.join(payloadRoot, "manifest.json"),
      manifestSha256: await sha256File2(path3.join(payloadRoot, "manifest.json")),
      archiveSha256: compressed.sha256,
      installedBytes,
      compressedBytes: compressed.compressedBytes,
      runtimePruning: [pythonRuntimePrune],
      machO,
      forbiddenAudit,
      smoke,
      release
    };
    await writeJson(path3.join(outputRoot, "build-result.json"), result);
    return { ...result, manifest, sizeReport };
  } catch (error) {
    const nativeLifecycleCleanup = await cleanupNativeLauncherRuntime(path3.join(outputRoot, "clean-extraction"));
    await writeJson(path3.join(outputRoot, "build-failure.json"), {
      schemaVersion: 1,
      mode: "real",
      buildId,
      status: "failed",
      error: error.message,
      nativeLifecycleCleanup
    });
    throw error;
  } finally {
    await rm2(scratchDirectory, { recursive: true, force: true });
  }
}
function parseCliOptions(argv) {
  if (argv[0] === "--") argv = argv.slice(1);
  const options = {};
  for (let index = 0; index < argv.length; index += 1) {
    const option = argv[index];
    invariant3(option.startsWith("--"), `unknown argument ${option}`);
    const key = option.slice(2);
    const value = argv[index + 1];
    invariant3(value && !value.startsWith("--"), `${option} requires a value`);
    invariant3(options[key] === void 0, `${option} may only be specified once`);
    options[key] = value;
    index += 1;
  }
  return options;
}
async function main2(argv = process2.argv.slice(2)) {
  const command = argv[0] ?? "fixture";
  const options = parseCliOptions(argv.slice(1));
  if (command === "audit") {
    invariant3(Object.keys(options).length === 0, "distribution audit accepts no options");
    const contracts = await loadBuildContracts(REPO_ROOT);
    process2.stdout.write(canonicalJson({
      status: "pass",
      launcherToolchain: {
        version: contracts.launcherToolchain.goVersion,
        archive: nativeGoArchiveLock(contracts.launcherToolchain)
      }
    }));
    return;
  }
  if (command === "fixture") {
    const result = await buildFixturePayload({
      outputDirectory: path3.resolve(options.output ?? path3.join(REPO_ROOT, "dist", "distribution-fixture")),
      buildId: options["build-id"] ?? "fixture-build-0001",
      sourceDateEpoch: Number.parseInt(options["source-date-epoch"] ?? process2.env.SOURCE_DATE_EPOCH ?? "0", 10)
    });
    process2.stdout.write(canonicalJson({
      mode: result.mode,
      payloadRoot: result.payloadRoot,
      archivePath: result.archivePath,
      manifestSha256: result.manifestSha256,
      archiveSha256: result.archiveSha256,
      installedBytes: result.installedBytes,
      compressedBytes: result.compressedBytes
    }));
    return;
  }
  if (command === "real") {
    const result = await buildRealPayload({
      outputDirectory: path3.resolve(options.output ?? path3.join(REPO_ROOT, "dist", "distribution-real")),
      cacheDirectory: options.cache ? path3.resolve(options.cache) : void 0,
      buildId: options["build-id"] ?? "local-real-build-0001",
      sourceDateEpoch: Number.parseInt(options["source-date-epoch"] ?? process2.env.SOURCE_DATE_EPOCH ?? "0", 10),
      baselineSizeReportPath: options["baseline-size-report"] ?? null,
      releaseChannel: options["release-channel"] ?? "local",
      releaseTrustKeyBase64: options["release-trust-key"] ?? ""
    });
    process2.stdout.write(canonicalJson({
      mode: result.mode,
      payloadRoot: result.payloadRoot,
      archivePath: result.archivePath,
      manifestSha256: result.manifestSha256,
      archiveSha256: result.archiveSha256,
      installedBytes: result.installedBytes,
      compressedBytes: result.compressedBytes,
      smoke: result.smoke
    }));
    return;
  }
  throw new Error(`unknown distribution build mode: ${command}`);
}
var invokedPath2 = process2.argv[1] ? pathToFileURL2(path3.resolve(process2.argv[1])).href : "";
if (import.meta.url === invokedPath2 && path3.basename(process2.argv[1] ?? "") === "distribution-build.mjs") {
  try {
    await main2();
  } catch (error) {
    process2.stderr.write(`distribution-build: ${error.message}
`);
    process2.exitCode = 1;
  }
}

// scripts/distribution-release.mjs
var SCRIPT_DIR3 = path4.dirname(fileURLToPath3(import.meta.url));
var REPO_ROOT2 = path4.resolve(SCRIPT_DIR3, "..");
var SHA256_PATTERN3 = /^[a-f0-9]{64}$/;
var BUILD_ID_PATTERN = /^[0-9A-Za-z][0-9A-Za-z._-]{7,127}$/;
var VERSION_PATTERN2 = /^[0-9]+\.[0-9]+\.[0-9]+(?:[-+][0-9A-Za-z.-]+)?$/;
var CHANNELS = /* @__PURE__ */ new Set(["local", "prerelease", "stable"]);
var MAX_ARCHIVE_BYTES = 4 * 1024 * 1024 * 1024;
var CANONICAL_RELEASE_BASE_URL = "https://releases.jobctrl.dev/v1";
var CHROMIUM_ENTITLEMENTS = Object.freeze({
  headlessShell: path4.join(REPO_ROOT2, "packaging", "distribution", "chromium-headless-shell.entitlements.plist")
});
var REQUIRED_VENDOR_NODE_PATHS = Object.freeze([
  "node/bin/node",
  "playwright-python/site-packages/playwright/driver/node"
]);
function invariant4(condition, message) {
  if (!condition) throw new Error(message);
}
function bytewiseCompare4(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}
function canonicalJson2(value) {
  return `${JSON.stringify(value, null, 2)}
`;
}
function assertExactKeys2(value, keys, label) {
  invariant4(value !== null && typeof value === "object" && !Array.isArray(value), `${label} must be an object`);
  const actual = Object.keys(value).sort(bytewiseCompare4);
  const expected = [...keys].sort(bytewiseCompare4);
  invariant4(JSON.stringify(actual) === JSON.stringify(expected), `${label} fields must be exactly [${expected.join(", ")}]`);
  return value;
}
function sha256Bytes(bytes) {
  return createHash4("sha256").update(bytes).digest("hex");
}
async function sha256File3(filePath) {
  const hash = createHash4("sha256");
  for await (const chunk of createReadStream4(filePath)) hash.update(chunk);
  return hash.digest("hex");
}
function validateBuildPlatform(platform) {
  invariant4(platform !== null && typeof platform === "object" && !Array.isArray(platform), "release platform must be an object");
  invariant4(platform.id === "darwin-arm64" && platform.os === "darwin" && platform.arch === "arm64", "release platform must be darwin-arm64");
  invariant4(/^\d+\.\d+(?:\.\d+)?$/.test(platform.minimumOsVersion), "release platform minimumOsVersion is invalid");
  return platform;
}
function validateDescriptorPlatform(platform) {
  assertExactKeys2(platform, ["id", "os", "arch"], "release descriptor platform");
  invariant4(platform.id === "darwin-arm64" && platform.os === "darwin" && platform.arch === "arm64", "release descriptor platform must be darwin-arm64");
  return platform;
}
function validateReleaseDescriptor(descriptor, { requireLocalFileTransport = false } = {}) {
  invariant4(descriptor !== null && typeof descriptor === "object" && !Array.isArray(descriptor), "release descriptor must be an object");
  const descriptorKeys = ["schemaVersion", "channel", "sequence", "minimumSafeSequence", "revokedBuildIds", "buildId", "appVersion", "platform", "artifact"];
  if (descriptor.channel !== "local") descriptorKeys.push("sourceCommit");
  assertExactKeys2(descriptor, descriptorKeys, "release descriptor");
  invariant4(descriptor.schemaVersion === 1, "release descriptor schemaVersion must be 1");
  invariant4(CHANNELS.has(descriptor.channel), "release descriptor channel is invalid");
  invariant4(Number.isSafeInteger(descriptor.sequence) && descriptor.sequence > 0, "release descriptor sequence must be a positive integer");
  invariant4(Number.isSafeInteger(descriptor.minimumSafeSequence) && descriptor.minimumSafeSequence >= 0 && descriptor.minimumSafeSequence <= descriptor.sequence, "release descriptor minimumSafeSequence is invalid");
  invariant4(Array.isArray(descriptor.revokedBuildIds), "release descriptor revokedBuildIds must be an array");
  const sortedRevocations = [...descriptor.revokedBuildIds].sort(bytewiseCompare4);
  invariant4(JSON.stringify(sortedRevocations) === JSON.stringify(descriptor.revokedBuildIds) && new Set(descriptor.revokedBuildIds).size === descriptor.revokedBuildIds.length, "release descriptor revokedBuildIds must be bytewise sorted and unique");
  for (const buildId of descriptor.revokedBuildIds) invariant4(typeof buildId === "string" && BUILD_ID_PATTERN.test(buildId), "release descriptor revoked buildId is invalid");
  if (descriptor.channel !== "local") invariant4(descriptor.minimumSafeSequence > 0, "network release descriptor minimumSafeSequence must be positive");
  invariant4(BUILD_ID_PATTERN.test(descriptor.buildId), "release descriptor buildId is invalid");
  invariant4(VERSION_PATTERN2.test(descriptor.appVersion), "release descriptor appVersion is invalid");
  if (descriptor.channel !== "local") invariant4(typeof descriptor.sourceCommit === "string" && /^[a-f0-9]{40}$/.test(descriptor.sourceCommit), "network release descriptor sourceCommit must be a full Git SHA");
  validateDescriptorPlatform(descriptor.platform);
  assertExactKeys2(descriptor.artifact, ["url", "sha256", "sizeBytes", "archiveType", "manifestSha256"], "release artifact");
  invariant4(descriptor.artifact.archiveType === "zip", "release artifact must be a ZIP");
  invariant4(SHA256_PATTERN3.test(descriptor.artifact.sha256), "release artifact SHA-256 is invalid");
  invariant4(SHA256_PATTERN3.test(descriptor.artifact.manifestSha256), "release artifact manifest SHA-256 is invalid");
  invariant4(Number.isSafeInteger(descriptor.artifact.sizeBytes) && descriptor.artifact.sizeBytes > 0 && descriptor.artifact.sizeBytes <= MAX_ARCHIVE_BYTES, "release artifact sizeBytes is invalid");
  let artifactUrl;
  try {
    artifactUrl = new URL(descriptor.artifact.url);
  } catch {
    throw new Error("release artifact URL is invalid");
  }
  if (descriptor.channel === "local") {
    invariant4(artifactUrl.protocol === "file:" && artifactUrl.host === "" && artifactUrl.username === "" && artifactUrl.password === "" && artifactUrl.hash === "" && artifactUrl.search === "" && artifactUrl.pathname.startsWith("/"), "local release descriptor requires a canonical absolute file:// artifact URL");
  } else {
    invariant4(artifactUrl.protocol === "https:", "network release descriptor requires an HTTPS artifact URL");
  }
  if (requireLocalFileTransport) invariant4(descriptor.channel === "local" && artifactUrl.protocol === "file:", "unsigned-local fixtures require file-only transport");
  return descriptor;
}
function validateReleaseDescriptorSignature(signature, { channel }) {
  assertExactKeys2(signature, ["schemaVersion", "status", "algorithm", "keyId", "signature"], "release descriptor signature");
  invariant4(signature.schemaVersion === 1 && signature.algorithm === "ed25519", "release descriptor signature envelope is invalid");
  invariant4(typeof signature.keyId === "string" && signature.keyId.length > 0, "release descriptor signature keyId is invalid");
  if (channel === "local") {
    invariant4(
      signature.status === "unsigned-local" && signature.keyId === "local-development" && signature.signature === null,
      "local descriptor signature must be the unsigned-local envelope"
    );
    return signature;
  }
  invariant4(signature.status === "signed" && /^[A-Za-z0-9._-]+$/.test(signature.keyId) && typeof signature.signature === "string", "network release descriptor requires a release signature");
  let decoded;
  try {
    decoded = Buffer.from(signature.signature, "base64");
  } catch {
    throw new Error("release descriptor signature must be base64 Ed25519 bytes");
  }
  invariant4(decoded.length === 64 && decoded.toString("base64") === signature.signature, "release descriptor signature must be base64 Ed25519 bytes");
  return signature;
}
function releasePublicationInputs({ descriptorRaw, descriptorUrl }) {
  invariant4(typeof descriptorRaw === "string", "release descriptor bytes must be a string");
  invariant4(typeof descriptorUrl === "string" && /^https:\/\//.test(descriptorUrl), "network release descriptor URL must use HTTPS");
  const descriptor = validateReleaseDescriptor(JSON.parse(descriptorRaw));
  invariant4(descriptor.channel === "stable" || descriptor.channel === "prerelease", "network publication inputs require a signed release channel");
  const descriptorLocation = new URL(descriptorUrl);
  const artifactLocation = new URL(descriptor.artifact.url);
  invariant4(descriptorLocation.origin === artifactLocation.origin, "network descriptor and artifact must share one release origin");
  return {
    artifactUrl: descriptor.artifact.url,
    appVersion: descriptor.appVersion,
    artifactSha256: descriptor.artifact.sha256,
    manifestSha256: descriptor.artifact.manifestSha256,
    buildId: descriptor.buildId,
    sourceCommit: descriptor.sourceCommit,
    descriptorSha256: sha256Bytes(descriptorRaw)
  };
}
function localFixtureContract(values) {
  const expected = [
    "MODE",
    "PLATFORM",
    "INSTALLER_URL",
    "INSTALLER_SHA256",
    "INSTALLER_VERSION",
    "DESCRIPTOR_FILE",
    "SIGNATURE_FILE",
    "ARCHIVE_FILE"
  ];
  assertExactKeys2(values, expected, "local fixture contract");
  for (const key of expected) invariant4(typeof values[key] === "string" && values[key].length > 0 && !/[\r\n]/.test(values[key]), `local fixture contract ${key} is invalid`);
  invariant4(values.MODE === "local-fixture" && values.PLATFORM === "darwin-arm64", "local fixture contract identity is invalid");
  invariant4(/^file:\/\//.test(values.INSTALLER_URL), "local fixture installer URL must be file://");
  invariant4(SHA256_PATTERN3.test(values.INSTALLER_SHA256), "local fixture installer SHA-256 is invalid");
  return `${expected.map((key) => `${key}=${values[key]}`).join("\n")}
`;
}
async function requireRegularFile(filePath, label) {
  const file = await lstat4(filePath);
  invariant4(file.isFile() && !file.isSymbolicLink(), `${label} must be a regular non-symlink file`);
  return file;
}
async function writeLocalReleaseBundle({ outputDirectory, archivePath, manifestPath, installerPath, buildId, appVersion, platform, sequence = 1 }) {
  invariant4(path4.isAbsolute(outputDirectory) && path4.isAbsolute(archivePath) && path4.isAbsolute(manifestPath) && path4.isAbsolute(installerPath), "local release paths must be absolute");
  invariant4(BUILD_ID_PATTERN.test(buildId), "local release buildId is invalid");
  invariant4(VERSION_PATTERN2.test(appVersion), "local release appVersion is invalid");
  validateBuildPlatform(platform);
  const [archiveInfo, installerInfo, manifestBytes] = await Promise.all([
    requireRegularFile(archivePath, "local release ZIP"),
    requireRegularFile(installerPath, "local release installer"),
    readFile4(manifestPath)
  ]);
  invariant4(archiveInfo.size > 0 && installerInfo.size > 0, "local release artifact and installer must be non-empty");
  const manifest = JSON.parse(manifestBytes.toString("utf8"));
  invariant4(manifest.buildId === buildId && manifest.appVersion === appVersion && manifest.releaseChannel === "local", "local release manifest identity does not match build metadata");
  invariant4(manifest.platform?.id === platform.id && manifest.platform?.os === platform.os && manifest.platform?.arch === platform.arch, "local release manifest platform does not match build metadata");
  const artifactFileName = path4.basename(archivePath);
  invariant4(/^jobctrl-[0-9A-Za-z._-]+-darwin-arm64\.zip$/.test(artifactFileName), "local release ZIP filename is invalid");
  const descriptorArtifactUrl = `file:///jobctrl-local-release/${artifactFileName}`;
  const descriptor = {
    schemaVersion: 1,
    channel: "local",
    sequence,
    minimumSafeSequence: 0,
    revokedBuildIds: [],
    buildId,
    appVersion,
    platform: { id: platform.id, os: platform.os, arch: platform.arch },
    artifact: {
      url: descriptorArtifactUrl,
      sha256: await sha256File3(archivePath),
      sizeBytes: archiveInfo.size,
      archiveType: "zip",
      manifestSha256: sha256Bytes(manifestBytes)
    }
  };
  validateReleaseDescriptor(descriptor, { requireLocalFileTransport: true });
  const signature = {
    schemaVersion: 1,
    status: "unsigned-local",
    algorithm: "ed25519",
    keyId: "local-development",
    signature: null
  };
  validateReleaseDescriptorSignature(signature, { channel: descriptor.channel });
  await mkdir3(outputDirectory, { recursive: true, mode: 493 });
  const descriptorPath = path4.join(outputDirectory, "release-descriptor.json");
  const signaturePath = path4.join(outputDirectory, "release-descriptor.json.sig");
  const contractPath = path4.join(outputDirectory, "local-fixture.contract");
  await Promise.all([
    writeFile3(descriptorPath, canonicalJson2(descriptor), { mode: 420 }),
    writeFile3(signaturePath, canonicalJson2(signature), { mode: 420 })
  ]);
  const contract = localFixtureContract({
    MODE: "local-fixture",
    PLATFORM: platform.id,
    INSTALLER_URL: pathToFileURL3(installerPath).href,
    INSTALLER_SHA256: await sha256File3(installerPath),
    INSTALLER_VERSION: appVersion,
    DESCRIPTOR_FILE: descriptorPath,
    SIGNATURE_FILE: signaturePath,
    ARCHIVE_FILE: archivePath
  });
  await writeFile3(contractPath, contract, { mode: 384 });
  return {
    descriptorPath,
    signaturePath,
    contractPath,
    descriptorSha256: await sha256File3(descriptorPath),
    artifactUrl: descriptor.artifact.url,
    artifactSha256: descriptor.artifact.sha256,
    manifestSha256: descriptor.artifact.manifestSha256,
    installerSha256: await sha256File3(installerPath),
    sequence
  };
}
var MANIFEST_SIGNING_DOMAIN = "jobctrl:manifest:v1\0";
var DESCRIPTOR_SIGNING_DOMAIN = "jobctrl:release-descriptor:v1\0";
var FINAL_RELEASE_ASSETS = [
  "install.sh",
  "jobctrl-installer",
  "channel-pointer.json",
  "release-descriptor.json",
  "release-descriptor.json.sig",
  "manifest.json",
  "manifest.sig",
  "release-keys.json",
  "SHA256SUMS",
  "release-metadata.json",
  "audit/notarization.json",
  "audit/notary-log.json",
  "audit/publication-status.json",
  "audit/pre-sign-comparison.json",
  "audit/size-report.json"
];
function domainMessage(domain, raw) {
  invariant4(typeof domain === "string" && domain.endsWith("\0"), "signature domain must end in NUL");
  return Buffer.concat([Buffer.from(domain, "utf8"), Buffer.from(raw, "utf8")]);
}
function publicKeyFromRaw(raw) {
  invariant4(Buffer.isBuffer(raw) && raw.length === 32, "Ed25519 public key must be 32 raw bytes");
  return createPublicKey({
    key: Buffer.concat([Buffer.from("302a300506032b6570032100", "hex"), raw]),
    format: "der",
    type: "spki"
  });
}
function rawPublicKey(publicKey) {
  const der = Buffer.from(publicKey.export({ format: "der", type: "spki" }));
  invariant4(der.length === 44 && der.subarray(0, 12).equals(Buffer.from("302a300506032b6570032100", "hex")), "not an Ed25519 SPKI public key");
  return der.subarray(12);
}
function privateKeyFromBase64(encoded) {
  invariant4(typeof encoded === "string" && encoded.length > 0 && !/\s/.test(encoded), "release signing key must be non-empty base64 PKCS#8 DER");
  const der = Buffer.from(encoded, "base64");
  invariant4(der.length > 48 && der.toString("base64") === encoded, "release signing key must be canonical base64 PKCS#8 DER");
  let privateKey;
  try {
    privateKey = createPrivateKey({ key: der, format: "der", type: "pkcs8" });
  } catch {
    throw new Error("release signing key must be an Ed25519 PKCS#8 DER key");
  }
  invariant4(privateKey.asymmetricKeyType === "ed25519", "release signing key must be Ed25519");
  return privateKey;
}
function releasePublicKeyBase64(privateKey) {
  invariant4(privateKey?.asymmetricKeyType === "ed25519", "release signing key must be Ed25519");
  return rawPublicKey(createPublicKey(privateKey)).toString("base64");
}
function signReleaseBytes({ domain, raw, privateKey, keyId, kind }) {
  invariant4(typeof raw === "string", "signed release bytes must be a UTF-8 string");
  invariant4(typeof keyId === "string" && /^[A-Za-z0-9._-]+$/.test(keyId), "release signing key id is invalid");
  invariant4(kind === "manifest" || kind === "descriptor", "release signature kind is invalid");
  invariant4(privateKey?.asymmetricKeyType === "ed25519", "release signing key must be Ed25519");
  const signature = signEd25519(null, domainMessage(domain, raw), privateKey).toString("base64");
  if (kind === "manifest") {
    return {
      schemaVersion: 1,
      status: "signed",
      manifestAlgorithm: "ed25519",
      manifestKeyId: keyId,
      signature,
      promotable: true
    };
  }
  return {
    schemaVersion: 1,
    status: "signed",
    algorithm: "ed25519",
    keyId,
    signature
  };
}
function verifyReleaseBytes({ domain, raw, signature, publicKey, keyId, kind }) {
  invariant4(publicKey?.asymmetricKeyType === "ed25519", "release verification key must be Ed25519");
  invariant4(kind === "manifest" || kind === "descriptor", "release signature kind is invalid");
  const encoded = kind === "manifest" ? signature?.signature : signature?.signature;
  const actualKeyId = kind === "manifest" ? signature?.manifestKeyId : signature?.keyId;
  invariant4(actualKeyId === keyId && typeof encoded === "string", "release signature envelope does not bind the expected key id");
  const bytes = Buffer.from(encoded, "base64");
  invariant4(bytes.length === 64 && bytes.toString("base64") === encoded, "release signature must be canonical base64 Ed25519 bytes");
  invariant4(verifyEd25519(null, domainMessage(domain, raw), publicKey, bytes), "release Ed25519 signature verification failed");
  return true;
}
function provisionedReleasePolicy(trackedPolicy) {
  invariant4(trackedPolicy?.stableReleaseStatus === "blocked-awaiting-credentials", "tracked signing policy must remain externally blocked");
  invariant4(trackedPolicy.manifestSigning?.publicKeyStatus === "unprovisioned", "tracked manifest key policy must remain unprovisioned");
  invariant4(trackedPolicy.appleSigning?.teamIdStatus === "unprovisioned", "tracked Apple signing policy must remain unprovisioned");
  const policy = structuredClone(trackedPolicy);
  policy.stableReleaseStatus = "ready";
  policy.manifestSigning.publicKeyStatus = "provisioned";
  policy.appleSigning.teamIdStatus = "provisioned";
  return policy;
}
function assertProtectedReleaseInputs({ signingKeyBase64, appleIdentity, notaryProfile, channel }) {
  invariant4(channel === "stable" || channel === "prerelease", "network release channel must be stable or prerelease");
  privateKeyFromBase64(signingKeyBase64);
  invariant4(typeof appleIdentity === "string" && appleIdentity.startsWith("Developer ID Application:"), "a protected Developer ID Application identity is required");
  invariant4(typeof notaryProfile === "string" && /^[A-Za-z0-9._-]+$/.test(notaryProfile), "a protected notary keychain profile is required");
  return true;
}
async function defaultCommandRunner(command, args, { cwd = REPO_ROOT2, env = process3.env } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn2(command, args, { cwd, env, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) resolve({ stdout, stderr });
      else reject(new Error(`${command} ${args.join(" ")} failed (${code}): ${stderr.trim() || stdout.trim()}`));
    });
  });
}
async function walkPayload(root, relative = "") {
  const entries = await readdir3(path4.join(root, relative), { withFileTypes: true });
  const results = [];
  for (const entry of entries.sort((left, right) => bytewiseCompare4(left.name, right.name))) {
    const child = relative ? path4.posix.join(relative, entry.name) : entry.name;
    const absolute = path4.join(root, child);
    const entryStat = await lstat4(absolute);
    if (entryStat.isSymbolicLink()) continue;
    if (entryStat.isDirectory()) {
      results.push({ type: "directory", relative: child, absolute });
      results.push(...await walkPayload(root, child));
    } else if (entryStat.isFile()) {
      results.push({ type: "file", relative: child, absolute });
    }
  }
  return results;
}
function pathDepth(value) {
  return value.split(path4.sep).length;
}
async function discoverAppleCodeTargets({ payloadRoot, runner = defaultCommandRunner }) {
  invariant4(path4.isAbsolute(payloadRoot), "payload root must be absolute");
  const entries = await walkPayload(payloadRoot);
  const appBundles = entries.filter((entry) => entry.type === "directory" && entry.relative.endsWith(".app")).map((entry) => entry.absolute).sort((left, right) => pathDepth(right) - pathDepth(left) || bytewiseCompare4(left, right));
  const codeBundles = entries.filter((entry) => entry.type === "directory" && /\.(?:app|framework|xpc|appex)$/.test(entry.relative)).map((entry) => entry.absolute).sort((left, right) => pathDepth(right) - pathDepth(left) || bytewiseCompare4(left, right));
  const machO = [];
  const standaloneExecutables = [];
  for (const entry of entries.filter((candidate) => candidate.type === "file")) {
    const probe = await runner("/usr/bin/file", ["-b", entry.absolute]);
    if (/Mach-O/i.test(probe.stdout)) {
      machO.push(entry.absolute);
      if (/executable/i.test(probe.stdout) && !appBundles.some((bundle) => containsPath(bundle, entry.absolute))) standaloneExecutables.push(entry.absolute);
    }
  }
  machO.sort((left, right) => pathDepth(right) - pathDepth(left) || bytewiseCompare4(left, right));
  standaloneExecutables.sort((left, right) => pathDepth(right) - pathDepth(left) || bytewiseCompare4(left, right));
  invariant4(machO.length > 0, "release payload contains no Mach-O executables to sign");
  return { payloadRoot, machO, appBundles, codeBundles, standaloneExecutables };
}
function containsPath(root, candidate) {
  return candidate === root || candidate.startsWith(`${root}${path4.sep}`);
}
function outermostAppBundles(appBundles) {
  return appBundles.filter((bundle) => !appBundles.some((other) => other !== bundle && containsPath(other, bundle)));
}
async function classifyAppleSigningTargets({ payloadRoot = null, machO, appBundles, standaloneExecutables = [], runner = defaultCommandRunner }) {
  const preservedApps = [];
  for (const bundle of outermostAppBundles(appBundles)) {
    try {
      const details = await runner("/usr/bin/codesign", ["-dv", "--verbose=4", bundle]);
      await runner("/usr/bin/codesign", ["--verify", "--deep", "--strict", "--verbose=4", bundle]);
      const gatekeeper = await runner("/usr/sbin/spctl", ["--assess", "--type", "execute", "--verbose=4", bundle]);
      const signatureDetails = `${details.stdout}
${details.stderr}`;
      const gatekeeperDetails = `${gatekeeper.stdout}
${gatekeeper.stderr}`;
      if (signatureDetails.includes("Authority=Developer ID Application:") && gatekeeperDetails.includes("source=Notarized Developer ID")) preservedApps.push(bundle);
    } catch {
    }
  }
  const preservedStandalone = [];
  const exactVendorNodes = payloadRoot === null ? null : new Set(REQUIRED_VENDOR_NODE_PATHS.map((relative) => path4.join(payloadRoot, ...relative.split("/"))));
  for (const target of machO.filter((candidate) => !appBundles.some((bundle) => containsPath(bundle, candidate)))) {
    const normalized = target.split(path4.sep).join("/");
    const isBundledNode = exactVendorNodes === null ? normalized.endsWith("/node/bin/node") || normalized.endsWith("/playwright-python/site-packages/playwright/driver/node") : exactVendorNodes.has(target);
    if (!isBundledNode) continue;
    try {
      const details = await runner("/usr/bin/codesign", ["-dv", "--verbose=4", target]);
      const signatureDetails = `${details.stdout}
${details.stderr}`;
      const expectedNode = signatureDetails.includes("Authority=Developer ID Application: Node.js Foundation (HX7739G8FX)") && signatureDetails.includes("TeamIdentifier=HX7739G8FX");
      invariant4(expectedNode, `bundled Node executable must retain the Node.js Foundation Developer ID signature: ${normalized}`);
      await runner("/usr/bin/codesign", ["--verify", "--strict", "--check-notarization", "-R=notarized", "--verbose=4", target]);
      preservedStandalone.push(target);
    } catch (error) {
      throw new Error(`bundled Node executable is not preservably signed: ${normalized}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  const signingMachO = machO.filter((target) => !preservedApps.some((bundle) => containsPath(bundle, target)));
  const signingApps = appBundles.filter((bundle) => !preservedApps.some((preserved) => containsPath(preserved, bundle)));
  return {
    machO: [...machO],
    appBundles: [...appBundles],
    preservedApps,
    preservedStandalone,
    standaloneExecutables: [...standaloneExecutables],
    signingMachO: signingMachO.filter((target) => !preservedStandalone.includes(target)),
    signingApps
  };
}
function chromiumEntitlementsForTarget(target, entitlements = CHROMIUM_ENTITLEMENTS) {
  const normalized = target.split(path4.sep).join("/");
  if (/chromium_headless_shell-1208\/chrome-headless-shell-mac-arm64\/chrome-headless-shell$/.test(normalized)) return entitlements.headlessShell;
  return null;
}
function createAppleSigningPlan({ machO, appBundles = [], codeBundles = appBundles, identity, chromiumEntitlements = CHROMIUM_ENTITLEMENTS }) {
  invariant4(Array.isArray(machO) && machO.length > 0, "Apple signing plan requires Mach-O targets");
  invariant4(Array.isArray(codeBundles), "Apple signing plan requires code bundle targets");
  invariant4(typeof identity === "string" && identity.startsWith("Developer ID Application:"), "Apple signing plan requires a Developer ID Application identity");
  const ordered = [
    ...[...new Set(machO)].sort((left, right) => pathDepth(right) - pathDepth(left) || bytewiseCompare4(left, right)),
    ...[...new Set(codeBundles)].sort((left, right) => pathDepth(right) - pathDepth(left) || bytewiseCompare4(left, right))
  ];
  const commands = ordered.map((target) => {
    const args = ["--force", "--sign", identity, "--options", "runtime", "--timestamp"];
    const entitlementPath = chromiumEntitlementsForTarget(target, chromiumEntitlements);
    if (entitlementPath) args.push("--entitlements", entitlementPath);
    args.push(target);
    return { command: "/usr/bin/codesign", args, target };
  });
  invariant4(commands.every(({ args }) => !args.includes("--deep")), "codesign --deep must never be used while signing");
  return commands;
}
async function signApplePayload({ payloadRoot, identity, runner = defaultCommandRunner }) {
  const discovered = await discoverAppleCodeTargets({ payloadRoot, runner });
  const targets = await classifyAppleSigningTargets({ ...discovered, runner });
  const requiredVendorNodes = REQUIRED_VENDOR_NODE_PATHS.map((relative) => path4.join(payloadRoot, ...relative.split("/")));
  for (const target of requiredVendorNodes) {
    invariant4(discovered.machO.includes(target), `required bundled Node executable is missing or is not Mach-O: ${path4.relative(payloadRoot, target)}`);
    invariant4(discovered.standaloneExecutables.includes(target), `required bundled Node path is not a standalone executable: ${path4.relative(payloadRoot, target)}`);
    invariant4(targets.preservedStandalone.includes(target), `required bundled Node executable was not preserved with vendor notarization: ${path4.relative(payloadRoot, target)}`);
    invariant4(!targets.signingMachO.includes(target), `required bundled Node executable would be re-signed: ${path4.relative(payloadRoot, target)}`);
  }
  invariant4(targets.preservedStandalone.length === requiredVendorNodes.length, "only the two exact bundled Node executables may be preserved as standalone vendor code");
  const signingBundles = discovered.codeBundles.filter((bundle) => !targets.preservedApps.some((preserved) => containsPath(preserved, bundle)));
  const commands = createAppleSigningPlan({ machO: targets.signingMachO, appBundles: targets.signingApps, codeBundles: signingBundles, identity });
  for (const command of commands) await runner(command.command, command.args);
  return { ...targets, signingBundles, commands };
}
function parseAcceptedNotarySubmission(raw) {
  let value;
  try {
    value = JSON.parse(raw);
  } catch {
    throw new Error("notarytool submission must be JSON");
  }
  invariant4(value?.status === "Accepted" && typeof value.id === "string" && value.id.length > 0, "notarytool submission must report Accepted with an id");
  invariant4(!Array.isArray(value.issues) || value.issues.length === 0, "notarytool submission contains notarization warnings or errors");
  return value;
}
function parseAcceptedNotaryLog(raw, submissionID) {
  let value;
  try {
    value = JSON.parse(raw);
  } catch {
    throw new Error("notarytool log must be JSON");
  }
  invariant4(value?.jobId === submissionID, "notarytool log jobId does not match the submission id");
  invariant4(value.status === "Accepted", "notarytool log does not report Accepted");
  invariant4(!Array.isArray(value.issues) || value.issues.length === 0, "notarytool log contains notarization warnings or errors");
  return value;
}
async function notarizeAndStaplePayload({ payloadRoot, archivePath, appBundles, preservedApps = [], notaryProfile, runner = defaultCommandRunner }) {
  invariant4(typeof notaryProfile === "string" && notaryProfile.length > 0, "notary profile is required");
  const submitted = parseAcceptedNotarySubmission(
    (await runner("/usr/bin/xcrun", ["notarytool", "submit", archivePath, "--keychain-profile", notaryProfile, "--wait", "--output-format", "json"])).stdout
  );
  const logPath = `${archivePath}.notary-log.json`;
  await runner("/usr/bin/xcrun", ["notarytool", "log", submitted.id, "--keychain-profile", notaryProfile, logPath]);
  const logRaw = await readFile4(logPath, "utf8");
  const log = parseAcceptedNotaryLog(logRaw, submitted.id);
  const stapleTargets = outermostAppBundles(appBundles);
  for (const bundle of stapleTargets) {
    await runner("/usr/bin/xcrun", ["stapler", "staple", bundle]);
    await runner("/usr/bin/xcrun", ["stapler", "validate", bundle]);
  }
  return { submittedArchive: archivePath, submission: submitted, log, logRaw, stapledBundles: stapleTargets, preservedVendorBundles: [...preservedApps] };
}
async function requiredEntitlementKeys(entitlementsPath) {
  const source = await readFile4(entitlementsPath, "utf8");
  const keys = [...source.matchAll(/<key>([^<]+)<\/key>/g)].map((match) => match[1]);
  invariant4(keys.length > 0, `entitlement policy has no keys: ${entitlementsPath}`);
  return keys;
}
async function verifyApplePayload({ machO, appBundles, codeBundles = [], standaloneExecutables = [], runner = defaultCommandRunner }) {
  for (const target of machO) {
    await runner("/usr/bin/codesign", ["--verify", "--strict", "--verbose=4", target]);
  }
  for (const bundle of codeBundles) await runner("/usr/bin/codesign", ["--verify", "--strict", "--verbose=4", bundle]);
  for (const target of standaloneExecutables) {
    await runner("/usr/bin/codesign", ["--verify", "--strict", "--check-notarization", "-R=notarized", "--verbose=4", target]);
  }
  for (const bundle of outermostAppBundles(appBundles)) {
    await runner("/usr/bin/codesign", ["--verify", "--deep", "--strict", "--check-notarization", "-R=notarized", "--verbose=4", bundle]);
    const gatekeeper = await runner("/usr/sbin/spctl", ["--assess", "--type", "execute", "--verbose=4", bundle]);
    invariant4(`${gatekeeper.stdout}
${gatekeeper.stderr}`.includes("source=Notarized Developer ID"), `Gatekeeper did not report Notarized Developer ID for ${bundle}`);
  }
  const entitlementTargets = [...new Set([...machO, ...codeBundles].filter((target) => chromiumEntitlementsForTarget(target)))];
  for (const target of entitlementTargets) {
    const entitlementPath = chromiumEntitlementsForTarget(target);
    const result = await runner("/usr/bin/codesign", ["-d", "--entitlements", ":-", target]);
    const detail = `${result.stdout}
${result.stderr}`;
    for (const key of await requiredEntitlementKeys(entitlementPath)) invariant4(detail.includes(key), `final signed ${target} is missing required entitlement ${key}`);
  }
  return { machOVerified: machO.length, codeBundlesVerified: codeBundles.length, notarizationVerifiedStandaloneExecutables: standaloneExecutables.length, gatekeeperVerifiedBundles: outermostAppBundles(appBundles).length, entitlementVerifiedTargets: entitlementTargets.length };
}
function requireNetworkReleasePublicKey(publicKeyBase64, label = "prepared release") {
  invariant4(typeof publicKeyBase64 === "string", `${label} public key must be a string`);
  const decoded = Buffer.from(publicKeyBase64, "base64");
  invariant4(decoded.length === 32 && decoded.toString("base64") === publicKeyBase64, `${label} requires a canonical raw Ed25519 public key`);
  return publicKeyBase64;
}
function preparedCandidatePaths(preparedDirectory, contracts) {
  const root = path4.resolve(preparedDirectory);
  const archiveFileName = `jobctrl-${contracts.versions["jobctrl-launcher"]}-${contracts.platform.id}.zip`;
  return {
    preparedDirectory: root,
    buildResultPath: path4.join(root, "build-result.json"),
    payloadRoot: path4.join(root, "payload"),
    manifestPath: path4.join(root, "payload", "manifest.json"),
    archivePath: path4.join(root, archiveFileName),
    archiveFileName
  };
}
async function filesAreBytewiseEqual(firstPath, secondPath) {
  const [firstStat, secondStat] = await Promise.all([stat3(firstPath), stat3(secondPath)]);
  if (!firstStat.isFile() || !secondStat.isFile() || firstStat.size !== secondStat.size) return false;
  const [first, second] = await Promise.all([open2(firstPath, "r"), open2(secondPath, "r")]);
  try {
    const firstBuffer = Buffer.allocUnsafe(64 * 1024);
    const secondBuffer = Buffer.allocUnsafe(64 * 1024);
    for (let offset = 0; offset < firstStat.size; ) {
      const [left, right] = await Promise.all([
        first.read(firstBuffer, 0, firstBuffer.length, offset),
        second.read(secondBuffer, 0, secondBuffer.length, offset)
      ]);
      if (left.bytesRead === 0 || left.bytesRead !== right.bytesRead || !firstBuffer.subarray(0, left.bytesRead).equals(secondBuffer.subarray(0, right.bytesRead))) return false;
      offset += left.bytesRead;
    }
    return true;
  } finally {
    await Promise.all([first.close(), second.close()]);
  }
}
async function verifyPreparedCandidate({ preparedDirectory, channel, publicKeyBase64, root = REPO_ROOT2, runner = defaultCommandRunner }) {
  invariant4(channel === "stable" || channel === "prerelease", "prepared candidate requires a network channel");
  requireNetworkReleasePublicKey(publicKeyBase64, "prepared candidate");
  const contracts = await loadBuildContracts(root);
  const paths = preparedCandidatePaths(preparedDirectory, contracts);
  const [preparedEntry, payloadEntry, buildResultEntry, manifestEntry, archiveEntry] = await Promise.all([
    lstat4(paths.preparedDirectory),
    lstat4(paths.payloadRoot),
    lstat4(paths.buildResultPath),
    lstat4(paths.manifestPath),
    lstat4(paths.archivePath)
  ]);
  invariant4(!preparedEntry.isSymbolicLink() && preparedEntry.isDirectory(), "prepared candidate root must be a real directory, not a symlink");
  invariant4(!payloadEntry.isSymbolicLink() && payloadEntry.isDirectory(), "prepared candidate payload must be a real directory, not a symlink");
  invariant4(!buildResultEntry.isSymbolicLink() && buildResultEntry.isFile(), "prepared candidate build-result.json must be a regular file, not a symlink");
  invariant4(!manifestEntry.isSymbolicLink() && manifestEntry.isFile(), "prepared candidate manifest.json must be a regular file, not a symlink");
  invariant4(!archiveEntry.isSymbolicLink() && archiveEntry.isFile(), "prepared candidate archive must be a regular file, not a symlink");
  const [buildResultRaw, manifestRaw] = await Promise.all([
    readFile4(paths.buildResultPath, "utf8"),
    readFile4(paths.manifestPath, "utf8")
  ]);
  let prepared;
  let manifest;
  try {
    prepared = JSON.parse(buildResultRaw);
    manifest = JSON.parse(manifestRaw);
  } catch (error) {
    throw new Error(`prepared candidate JSON is invalid: ${error instanceof Error ? error.message : String(error)}`);
  }
  invariant4(prepared?.mode === "real" && prepared?.releaseChannel === "local" && prepared?.archiveType === "zip", "prepared candidate is not an unsigned-local real build");
  invariant4(prepared.nativeLauncherReleaseChannel === channel, "prepared native binaries target the wrong release channel");
  invariant4(prepared.nativeLauncherReleaseTrustKeyBase64 === publicKeyBase64, "prepared native build record does not bind the expected release public key");
  invariant4(prepared.nativeLauncherReleaseTrustKeySha256 === sha256Bytes(Buffer.from(publicKeyBase64, "utf8")), "prepared native build record has an invalid release public-key digest");
  validateDistributionManifest(manifest, contracts);
  invariant4(manifest.releaseChannel === "local" && manifest.signing.codeSigning === "unsigned-local" && manifest.signing.notarized === false, "prepared manifest is not the required unsigned-local pre-sign envelope");
  invariant4(prepared.buildId === manifest.buildId, "prepared build result does not match the checkout-rooted manifest build ID");
  const manifestSha256 = sha256Bytes(Buffer.from(manifestRaw, "utf8"));
  invariant4(prepared.manifestSha256 === manifestSha256, "prepared manifest raw SHA-256 does not match build-result.json");
  await verifyExactPayloadTree(paths.payloadRoot, manifest);
  const installedBytes = (await buildFileInventory(paths.payloadRoot)).reduce((total, file) => total + file.sizeBytes, 0);
  invariant4(prepared.installedBytes === installedBytes, "prepared installed byte count does not match the checkout-rooted payload");
  const archiveSha256 = await sha256File3(paths.archivePath);
  invariant4(prepared.archiveSha256 === archiveSha256, "prepared archive SHA-256 does not match the checkout-rooted archive");
  invariant4(prepared.compressedBytes === archiveEntry.size, "prepared archive byte count does not match the checkout-rooted archive");
  const scratchDirectory = await mkdtemp2(path4.join(os2.tmpdir(), "jobctrl-prepared-verify-"));
  try {
    const rebuiltArchivePath = path4.join(scratchDirectory, paths.archiveFileName);
    const rebuilt = await createDeterministicZip(paths.payloadRoot, rebuiltArchivePath, manifest.sourceDateEpoch);
    invariant4(rebuilt.sha256 === archiveSha256 && rebuilt.compressedBytes === archiveEntry.size, "checkout-rooted deterministic archive does not match the prepared archive identity");
    invariant4(await filesAreBytewiseEqual(paths.archivePath, rebuiltArchivePath), "checkout-rooted deterministic archive bytes do not match the prepared archive");
  } finally {
    await rm3(scratchDirectory, { recursive: true, force: true });
  }
  const nativeBinding = await verifyPreparedNativeBinding({ preparedDirectory: paths.preparedDirectory, channel, publicKeyBase64, runner });
  return {
    schemaVersion: 1,
    status: "verified-unsigned-pre-sign-candidate",
    buildId: manifest.buildId,
    appVersion: manifest.appVersion,
    sourceDateEpoch: manifest.sourceDateEpoch,
    archiveSha256,
    manifestSha256,
    compressedBytes: archiveEntry.size,
    installedBytes,
    nativeLauncherReleaseChannel: channel,
    nativeLauncherReleaseTrustKeySha256: prepared.nativeLauncherReleaseTrustKeySha256,
    nativeBinding
  };
}
async function comparePreparedBuilds(firstDirectory, secondDirectory, { channel, publicKeyBase64, root = REPO_ROOT2, runner = defaultCommandRunner } = {}) {
  const [first, second] = await Promise.all([
    verifyPreparedCandidate({ preparedDirectory: firstDirectory, channel, publicKeyBase64, root, runner }),
    verifyPreparedCandidate({ preparedDirectory: secondDirectory, channel, publicKeyBase64, root, runner })
  ]);
  const fields = [
    "buildId",
    "appVersion",
    "sourceDateEpoch",
    "archiveSha256",
    "manifestSha256",
    "compressedBytes",
    "installedBytes",
    "nativeLauncherReleaseChannel",
    "nativeLauncherReleaseTrustKeySha256"
  ];
  const mismatches = fields.filter((field) => first[field] !== second[field]);
  invariant4(mismatches.length === 0, `unsigned pre-sign builds differ: ${mismatches.join(", ")}`);
  return {
    schemaVersion: 1,
    status: "identical-unsigned-pre-sign-builds",
    comparedFields: fields,
    buildId: first.buildId,
    appVersion: first.appVersion,
    sourceDateEpoch: first.sourceDateEpoch,
    archiveSha256: first.archiveSha256,
    manifestSha256: first.manifestSha256,
    compressedBytes: first.compressedBytes,
    installedBytes: first.installedBytes,
    nativeLauncherReleaseChannel: first.nativeLauncherReleaseChannel,
    nativeLauncherReleaseTrustKeySha256: first.nativeLauncherReleaseTrustKeySha256,
    note: "Signed and stapled ZIP bytes are intentionally not compared for deterministic equality."
  };
}
async function verifyPreparedNativeBinding({ preparedDirectory, channel, publicKeyBase64, runner = defaultCommandRunner }) {
  invariant4(channel === "stable" || channel === "prerelease", "prepared native binding requires a network channel");
  requireNetworkReleasePublicKey(publicKeyBase64, "prepared native binding");
  const prepared = JSON.parse(await readFile4(path4.join(preparedDirectory, "build-result.json"), "utf8"));
  invariant4(prepared.nativeLauncherReleaseChannel === channel, "prepared native binaries target the wrong release channel");
  invariant4(prepared.nativeLauncherReleaseTrustKeyBase64 === publicKeyBase64, "prepared native build record does not bind the derived release public key");
  invariant4(prepared.nativeLauncherReleaseTrustKeySha256 === sha256Bytes(Buffer.from(publicKeyBase64, "utf8")), "prepared native build record has an invalid release public-key digest");
  const payloadRoot = path4.join(preparedDirectory, "payload");
  const binaries = [path4.join(payloadRoot, "launcher", "jobctrl"), path4.join(payloadRoot, "launcher", "jobctrl-installer")];
  for (const binary of binaries) {
    const binaryEntry = await lstat4(binary);
    invariant4(!binaryEntry.isSymbolicLink() && binaryEntry.isFile(), `compiled ${path4.basename(binary)} must be a regular file, not a symlink`);
    invariant4((binaryEntry.mode & 4095) === 493, `compiled ${path4.basename(binary)} must have mode 0755`);
    const output = await runner("/usr/bin/strings", [binary]);
    invariant4(output.stdout.includes(publicKeyBase64), `compiled ${path4.basename(binary)} does not embed the derived release public key`);
    invariant4(output.stdout.includes(channel), `compiled ${path4.basename(binary)} does not embed the intended release channel`);
  }
  return { binaries, channel, publicKeySha256: prepared.nativeLauncherReleaseTrustKeySha256 };
}
function assertPreSignComparisonMatches(prepared, comparison) {
  invariant4(comparison?.status === "identical-unsigned-pre-sign-builds", "a passing unsigned pre-sign build comparison is required before signing");
  const fields = [
    "buildId",
    "archiveSha256",
    "manifestSha256",
    "compressedBytes",
    "installedBytes",
    "nativeLauncherReleaseChannel",
    "nativeLauncherReleaseTrustKeySha256"
  ];
  for (const field of fields) invariant4(comparison[field] === prepared[field], `pre-sign comparison does not bind prepared ${field}`);
  return true;
}
function networkDescriptor({ channel, sequence, minimumSafeSequence, revokedBuildIds = [], buildId, appVersion, sourceCommit, archiveUrl, archiveSha256, archiveSizeBytes, manifestSha256 }) {
  const descriptor = {
    schemaVersion: 1,
    channel,
    sequence,
    minimumSafeSequence,
    revokedBuildIds,
    buildId,
    appVersion,
    sourceCommit,
    platform: { id: "darwin-arm64", os: "darwin", arch: "arm64" },
    artifact: {
      url: archiveUrl,
      sha256: archiveSha256,
      sizeBytes: archiveSizeBytes,
      archiveType: "zip",
      manifestSha256
    }
  };
  validateReleaseDescriptor(descriptor);
  return descriptor;
}
function canonicalReleaseUrls(channel, archiveFileName, buildId) {
  invariant4(channel === "stable" || channel === "prerelease", "canonical network release channel is invalid");
  invariant4(typeof archiveFileName === "string" && /^jobctrl-[0-9A-Za-z._-]+-darwin-arm64\.zip$/.test(archiveFileName), "canonical release archive name is invalid");
  invariant4(typeof buildId === "string" && BUILD_ID_PATTERN.test(buildId), "canonical release build id is invalid");
  const base = `${CANONICAL_RELEASE_BASE_URL}/${channel}`;
  const immutableBase = `${CANONICAL_RELEASE_BASE_URL}/artifacts/${buildId}`;
  return {
    descriptorUrl: `${base}/darwin-arm64.json`,
    descriptorSignatureUrl: `${base}/darwin-arm64.json.sig`,
    // The mutable channel descriptor is promoted only after the candidate's
    // immutable descriptor has been fetched and exercised.  Promotion lanes
    // (including Homebrew and PyPI) bind this build-scoped URL, not the
    // channel pointer that a later release may replace.
    immutableDescriptorUrl: `${immutableBase}/release-descriptor.json`,
    immutableDescriptorSignatureUrl: `${immutableBase}/release-descriptor.json.sig`,
    immutableChannelPointerUrl: `${immutableBase}/channel-pointer.json`,
    artifactUrl: `${immutableBase}/${archiveFileName}`,
    installerUrl: `${immutableBase}/jobctrl-installer`,
    installScriptUrl: `${immutableBase}/install.sh`,
    immutableBase
  };
}
function validateReleaseChannelPointer(pointer) {
  assertExactKeys2(pointer, ["schemaVersion", "channel", "platform", "sourceCommit", "buildId", "sequence", "descriptor", "signature"], "release channel pointer");
  invariant4(pointer.schemaVersion === 1 && (pointer.channel === "stable" || pointer.channel === "prerelease"), "release channel pointer identity is invalid");
  validateDescriptorPlatform(pointer.platform);
  invariant4(typeof pointer.sourceCommit === "string" && /^[a-f0-9]{40}$/.test(pointer.sourceCommit), "release channel pointer source commit is invalid");
  invariant4(typeof pointer.buildId === "string" && BUILD_ID_PATTERN.test(pointer.buildId), "release channel pointer build ID is invalid");
  invariant4(Number.isSafeInteger(pointer.sequence) && pointer.sequence > 0, "release channel pointer sequence is invalid");
  for (const [label, value] of [["descriptor", pointer.descriptor], ["signature", pointer.signature]]) {
    assertExactKeys2(value, ["url", "sha256"], `release channel pointer ${label}`);
    invariant4(typeof value.url === "string", `release channel pointer ${label} URL is invalid`);
    invariant4(SHA256_PATTERN3.test(value.sha256), `release channel pointer ${label} SHA-256 is invalid`);
  }
  const canonicalOrigin = new URL(CANONICAL_RELEASE_BASE_URL).origin;
  const assertImmutableUrl = (value, expectedPath, label) => {
    let parsed;
    try {
      parsed = new URL(value);
    } catch {
      throw new Error(`release channel pointer ${label} URL is invalid`);
    }
    invariant4(parsed.protocol === "https:" && parsed.origin === canonicalOrigin && parsed.username === "" && parsed.password === "" && parsed.search === "" && parsed.hash === "", `release channel pointer ${label} URL is not canonical HTTPS`);
    invariant4(parsed.pathname === expectedPath && parsed.href === value, `release channel pointer ${label} URL is not the selected immutable build path`);
  };
  const immutablePath = `/v1/artifacts/${pointer.buildId}/release-descriptor.json`;
  assertImmutableUrl(pointer.descriptor.url, immutablePath, "descriptor");
  assertImmutableUrl(pointer.signature.url, `${immutablePath}.sig`, "signature");
  return pointer;
}
function createReleaseChannelPointer({ descriptorRaw, signatureRaw, descriptorUrl, signatureUrl }) {
  const descriptor = validateReleaseDescriptor(JSON.parse(descriptorRaw));
  const signature = validateReleaseDescriptorSignature(JSON.parse(signatureRaw), { channel: descriptor.channel });
  invariant4(signature.status === "signed", "release channel pointer requires a signed descriptor");
  const urls = canonicalReleaseUrls(descriptor.channel, path4.basename(new URL(descriptor.artifact.url).pathname), descriptor.buildId);
  invariant4(descriptor.artifact.url === urls.artifactUrl && descriptorUrl === urls.immutableDescriptorUrl && signatureUrl === urls.immutableDescriptorSignatureUrl, "release channel pointer must select the descriptor's immutable canonical build URLs");
  return validateReleaseChannelPointer({
    schemaVersion: 1,
    channel: descriptor.channel,
    platform: descriptor.platform,
    sourceCommit: descriptor.sourceCommit,
    buildId: descriptor.buildId,
    sequence: descriptor.sequence,
    descriptor: { url: descriptorUrl, sha256: sha256Bytes(Buffer.from(descriptorRaw, "utf8")) },
    signature: { url: signatureUrl, sha256: sha256Bytes(Buffer.from(signatureRaw, "utf8")) }
  });
}
function renderPinnedInstallScript({ templateRaw, installerUrl, installerSha256, installerVersion }) {
  invariant4(typeof templateRaw === "string" && templateRaw.startsWith("#!/usr/bin/env bash\n"), "install script template is invalid");
  invariant4(typeof installerUrl === "string" && installerUrl.startsWith("https://"), "published installer URL must use HTTPS");
  invariant4(SHA256_PATTERN3.test(installerSha256), "published installer SHA-256 is invalid");
  invariant4(VERSION_PATTERN2.test(installerVersion), "published installer version is invalid");
  const rendered = templateRaw.replace(/^INSTALLER_URL=""$/m, `INSTALLER_URL="${installerUrl}"`).replace(/^INSTALLER_SHA256=""$/m, `INSTALLER_SHA256="${installerSha256}"`).replace(/^INSTALLER_VERSION=""$/m, `INSTALLER_VERSION="${installerVersion}"`);
  invariant4(!/^INSTALLER_(?:URL|SHA256|VERSION)=""$/m.test(rendered), "published install script has an unresolved release pin");
  invariant4(rendered.includes("no signed native installer is published yet; P6 release signing is still blocked"), "published install script lost its fail-closed fallback");
  return rendered;
}
async function copyReleaseMetadata(payloadRoot, auditRoot) {
  const releaseRoot = path4.join(payloadRoot, "release");
  const releaseStat = await lstat4(releaseRoot);
  invariant4(releaseStat.isDirectory() && !releaseStat.isSymbolicLink(), "payload release metadata directory is missing");
  await cp(releaseRoot, path4.join(auditRoot, "release-metadata"), {
    recursive: true,
    dereference: false,
    force: true,
    errorOnExist: false
  });
}
function expectedReleaseAssetPaths({ archiveFileName }) {
  invariant4(typeof archiveFileName === "string" && archiveFileName.endsWith(".zip"), "release archive file name is invalid");
  return [...FINAL_RELEASE_ASSETS, archiveFileName].sort(bytewiseCompare4);
}
async function writeChecksumFile(releaseDirectory, files) {
  const records = [];
  for (const file of [...files].sort(bytewiseCompare4)) records.push(`${await sha256File3(path4.join(releaseDirectory, file))}  ${file}`);
  await writeFile3(path4.join(releaseDirectory, "SHA256SUMS"), `${records.join("\n")}
`, { mode: 420 });
  return records;
}
async function assertReleaseAssetInventory(releaseDirectory, { archiveFileName }) {
  const expected = expectedReleaseAssetPaths({ archiveFileName });
  const found = [];
  async function visit(relative = "") {
    for (const entry of await readdir3(path4.join(releaseDirectory, relative), { withFileTypes: true })) {
      const child = relative ? path4.posix.join(relative, entry.name) : entry.name;
      if (entry.isDirectory()) await visit(child);
      else if (entry.isFile()) found.push(child);
      else throw new Error(`release asset inventory contains unsupported entry ${child}`);
    }
  }
  await visit();
  const required = new Set(expected);
  for (const item of expected) invariant4(found.includes(item), `release asset inventory is missing ${item}`);
  invariant4(found.some((item) => item.startsWith("audit/release-metadata/licenses/")), "release asset inventory lacks copied license attribution");
  invariant4(found.some((item) => item.endsWith("sbom.cdx.json")), "release asset inventory lacks an SBOM");
  invariant4(found.some((item) => item.endsWith("provenance.json")), "release asset inventory lacks provenance evidence");
  invariant4(found.some((item) => item.endsWith("size-report.json")), "release asset inventory lacks size/dependency delta evidence");
  return { expected: [...required].sort(bytewiseCompare4), found: found.sort(bytewiseCompare4) };
}
async function releaseRegularFiles(releaseDirectory, relative = "") {
  const files = [];
  for (const entry of await readdir3(path4.join(releaseDirectory, relative), { withFileTypes: true })) {
    const child = relative ? path4.posix.join(relative, entry.name) : entry.name;
    if (entry.isDirectory()) files.push(...await releaseRegularFiles(releaseDirectory, child));
    else if (entry.isFile()) files.push(child);
    else throw new Error(`release directory has unsupported entry ${child}`);
  }
  return files.sort(bytewiseCompare4);
}
async function finalizeNetworkRelease({
  preparedDirectory,
  releaseDirectory,
  channel,
  sequence,
  minimumSafeSequence,
  revokedBuildIds = [],
  signingKeyBase64,
  appleIdentity,
  notaryProfile,
  sourceDateEpoch,
  sourceCommit,
  preSignComparison,
  runner = defaultCommandRunner,
  root = REPO_ROOT2
}) {
  assertProtectedReleaseInputs({ signingKeyBase64, appleIdentity, notaryProfile, channel });
  invariant4(typeof sourceCommit === "string" && /^[a-f0-9]{40}$/.test(sourceCommit), "final release requires an immutable source commit SHA");
  invariant4(Number.isInteger(sequence) && sequence > 0 && Number.isInteger(minimumSafeSequence) && minimumSafeSequence > 0 && minimumSafeSequence <= sequence, "network release sequence is invalid");
  const privateKey = privateKeyFromBase64(signingKeyBase64);
  const publicKeyBase64 = releasePublicKeyBase64(privateKey);
  const verifiedPrepared = await verifyPreparedCandidate({
    preparedDirectory,
    channel,
    publicKeyBase64,
    root,
    runner
  });
  const prepared = JSON.parse(await readFile4(path4.join(preparedDirectory, "build-result.json"), "utf8"));
  invariant4(prepared.releaseChannel === "local" && prepared.nativeLauncherReleaseChannel === channel, "prepared build is not a matching unsigned pre-sign network build");
  assertPreSignComparisonMatches(verifiedPrepared, preSignComparison);
  const nativeBinding = verifiedPrepared.nativeBinding;
  const payloadRoot = path4.join(preparedDirectory, "payload");
  const preparedManifest = JSON.parse(await readFile4(path4.join(payloadRoot, "manifest.json"), "utf8"));
  invariant4(preparedManifest.sourceDateEpoch === sourceDateEpoch, "finalization SOURCE_DATE_EPOCH must match the compared pre-sign build");
  const archiveFileName = `jobctrl-${preparedManifest.appVersion}-darwin-arm64.zip`;
  const urls = canonicalReleaseUrls(channel, archiveFileName, prepared.buildId);
  const notaryArchive = path4.join(preparedDirectory, `notary-${archiveFileName}`);
  const contracts = await loadBuildContracts(root, { signingPolicyOverride: provisionedReleasePolicy((await loadBuildContracts(root)).signingPolicy) });
  await rm3(path4.join(payloadRoot, "manifest.sig"), { force: true });
  const signed = await signApplePayload({ payloadRoot, identity: appleIdentity, runner });
  await createDeterministicZip(payloadRoot, notaryArchive, sourceDateEpoch);
  const notarization = await notarizeAndStaplePayload({ payloadRoot, archivePath: notaryArchive, appBundles: signed.appBundles, preservedApps: signed.preservedApps, notaryProfile, runner });
  const verification = await verifyApplePayload({ ...signed, codeBundles: signed.signingBundles, runner });
  const manifest = await createReleaseManifest(payloadRoot, contracts, {
    buildId: prepared.buildId,
    sourceDateEpoch,
    releaseChannel: channel
  });
  const manifestRaw = canonicalJson2(manifest);
  const manifestSignature = signReleaseBytes({ domain: MANIFEST_SIGNING_DOMAIN, raw: manifestRaw, privateKey, keyId: contracts.signingPolicy.manifestSigning.keyId, kind: "manifest" });
  await writeFile3(path4.join(payloadRoot, "manifest.json"), manifestRaw, { mode: 420 });
  await writeFile3(path4.join(payloadRoot, "manifest.sig"), canonicalJson2(manifestSignature), { mode: 420 });
  await verifyExactPayloadTree(payloadRoot, manifest);
  await rm3(releaseDirectory, { recursive: true, force: true });
  await mkdir3(path4.join(releaseDirectory, "audit"), { recursive: true, mode: 493 });
  const finalArchivePath = path4.join(releaseDirectory, archiveFileName);
  const finalZip = await createDeterministicZip(payloadRoot, finalArchivePath, sourceDateEpoch);
  const descriptor = networkDescriptor({
    channel,
    sequence,
    minimumSafeSequence,
    revokedBuildIds,
    buildId: manifest.buildId,
    appVersion: manifest.appVersion,
    sourceCommit,
    archiveUrl: urls.artifactUrl,
    archiveSha256: finalZip.sha256,
    archiveSizeBytes: finalZip.compressedBytes,
    manifestSha256: sha256Bytes(Buffer.from(manifestRaw, "utf8"))
  });
  const descriptorRaw = canonicalJson2(descriptor);
  const descriptorSignature = signReleaseBytes({ domain: DESCRIPTOR_SIGNING_DOMAIN, raw: descriptorRaw, privateKey, keyId: contracts.signingPolicy.manifestSigning.keyId, kind: "descriptor" });
  const publicKey = publicKeyFromRaw(Buffer.from(publicKeyBase64, "base64"));
  verifyReleaseBytes({ domain: MANIFEST_SIGNING_DOMAIN, raw: manifestRaw, signature: manifestSignature, publicKey, keyId: contracts.signingPolicy.manifestSigning.keyId, kind: "manifest" });
  verifyReleaseBytes({ domain: DESCRIPTOR_SIGNING_DOMAIN, raw: descriptorRaw, signature: descriptorSignature, publicKey, keyId: contracts.signingPolicy.manifestSigning.keyId, kind: "descriptor" });
  const releaseKeys = { schemaVersion: 1, keys: { [contracts.signingPolicy.manifestSigning.keyId]: publicKeyBase64 } };
  const publicNotarization = {
    submittedArchive: path4.basename(notarization.submittedArchive),
    submission: notarization.submission,
    log: notarization.log,
    stapledBundles: notarization.stapledBundles.map((bundle) => path4.relative(payloadRoot, bundle).split(path4.sep).join("/")),
    preservedVendorBundles: notarization.preservedVendorBundles.map((bundle) => path4.relative(payloadRoot, bundle).split(path4.sep).join("/")),
    preservedVendorStandaloneExecutables: signed.preservedStandalone.map((target) => path4.relative(payloadRoot, target).split(path4.sep).join("/"))
  };
  const publicNativeBinding = {
    ...nativeBinding,
    binaries: nativeBinding.binaries.map((binary) => path4.relative(payloadRoot, binary).split(path4.sep).join("/"))
  };
  const notarizationEvidenceRaw = canonicalJson2({ schemaVersion: 1, status: "accepted-and-stapled", notarization: publicNotarization, verification });
  invariant4(!notarizationEvidenceRaw.includes(payloadRoot) && !notarizationEvidenceRaw.includes(preparedDirectory), "public notarization evidence must not contain an absolute workspace path");
  const descriptorSignatureRaw = canonicalJson2(descriptorSignature);
  await Promise.all([
    copyFile2(path4.join(payloadRoot, "launcher", "jobctrl-installer"), path4.join(releaseDirectory, "jobctrl-installer")),
    writeFile3(path4.join(releaseDirectory, "release-descriptor.json"), descriptorRaw, { mode: 420 }),
    writeFile3(path4.join(releaseDirectory, "release-descriptor.json.sig"), descriptorSignatureRaw, { mode: 420 }),
    writeFile3(path4.join(releaseDirectory, "manifest.json"), manifestRaw, { mode: 420 }),
    writeFile3(path4.join(releaseDirectory, "manifest.sig"), canonicalJson2(manifestSignature), { mode: 420 }),
    writeFile3(path4.join(releaseDirectory, "release-keys.json"), canonicalJson2(releaseKeys), { mode: 420 }),
    copyFile2(path4.join(preparedDirectory, "size-report.json"), path4.join(releaseDirectory, "audit", "size-report.json")),
    writeFile3(path4.join(releaseDirectory, "audit", "notarization.json"), notarizationEvidenceRaw, { mode: 420 }),
    writeFile3(path4.join(releaseDirectory, "audit", "notary-log.json"), notarization.logRaw, { mode: 420 }),
    writeFile3(path4.join(releaseDirectory, "audit", "pre-sign-comparison.json"), canonicalJson2(preSignComparison), { mode: 420 })
  ]);
  await copyReleaseMetadata(payloadRoot, path4.join(releaseDirectory, "audit"));
  const channelPointer = createReleaseChannelPointer({
    descriptorRaw,
    signatureRaw: descriptorSignatureRaw,
    descriptorUrl: urls.immutableDescriptorUrl,
    signatureUrl: urls.immutableDescriptorSignatureUrl
  });
  const channelPointerRaw = canonicalJson2(channelPointer);
  await writeFile3(path4.join(releaseDirectory, "channel-pointer.json"), channelPointerRaw, { mode: 420 });
  const metadata = {
    schemaVersion: 1,
    status: "signed-notarized-release-candidate",
    publicationStatus: "blocked-until-published-candidate-smoke",
    // A signed/notarized candidate still has not been fetched from the real
    // HTTPS origin. Only the separate post-publication native smoke may
    // authorize PyPI/Homebrew promotion.
    pypiPublicationAuthorized: false,
    channel,
    buildId: manifest.buildId,
    appVersion: manifest.appVersion,
    // This copy is convenience metadata only. The authoritative provenance is
    // the same value inside the signed network descriptor below.
    sourceCommit,
    archive: { file: archiveFileName, sha256: finalZip.sha256, sizeBytes: finalZip.compressedBytes, url: urls.artifactUrl },
    installer: { file: "jobctrl-installer", sha256: await sha256File3(path4.join(releaseDirectory, "jobctrl-installer")), url: urls.installerUrl },
    publicationUrls: urls,
    manifest: { sha256: sha256Bytes(Buffer.from(manifestRaw, "utf8")), keyId: contracts.signingPolicy.manifestSigning.keyId },
    descriptor: { sha256: sha256Bytes(Buffer.from(descriptorRaw, "utf8")), keyId: contracts.signingPolicy.manifestSigning.keyId },
    channelPointer: { sha256: sha256Bytes(Buffer.from(channelPointerRaw, "utf8")), url: urls.immutableChannelPointerUrl },
    signing: { codeSigning: "Developer ID Application", notarization: "nested-apps-stapled", unsignedBuildComparisonRequired: true, nativeBinding: publicNativeBinding }
  };
  const installScript = renderPinnedInstallScript({
    templateRaw: await readFile4(path4.join(root, "scripts", "get"), "utf8"),
    installerUrl: urls.installerUrl,
    installerSha256: metadata.installer.sha256,
    installerVersion: manifest.appVersion
  });
  await writeFile3(path4.join(releaseDirectory, "install.sh"), installScript, { mode: 493 });
  await writeFile3(path4.join(releaseDirectory, "audit", "publication-status.json"), canonicalJson2({
    schemaVersion: 1,
    status: "blocked",
    publicationStatus: "blocked-until-protected-signing-notarization-and-published-candidate-smoke",
    evidencePath: "audit/publication-status.json",
    workflowContract: ".github/workflows/release-distribution.yml",
    externalRequirements: [
      "protected Developer ID Application identity",
      "protected Ed25519 release signing key",
      "protected notarization keychain profile",
      "production releases.jobctrl.dev TLS origin",
      "GitHub Actions billing-enabled macOS runner"
    ]
  }), { mode: 420 });
  await writeFile3(path4.join(releaseDirectory, "release-metadata.json"), canonicalJson2(metadata), { mode: 420 });
  invariant4(!(await readFile4(path4.join(releaseDirectory, "release-metadata.json"), "utf8")).includes(payloadRoot), "public release metadata must not contain an absolute payload path");
  await chmod3(path4.join(releaseDirectory, "jobctrl-installer"), 493);
  await writeChecksumFile(releaseDirectory, (await releaseRegularFiles(releaseDirectory)).filter((file) => file !== "SHA256SUMS"));
  const inventory = await assertReleaseAssetInventory(releaseDirectory, { archiveFileName });
  return { archivePath: finalArchivePath, archiveFileName, descriptorRaw, descriptorSignature, channelPointer, manifestRaw, manifestSignature, releaseKeys, metadata, inventory };
}
function publishedCandidateSmokePlan({ descriptorUrl, installerPath, outputHome }) {
  invariant4(typeof descriptorUrl === "string" && descriptorUrl.startsWith("https://"), "published smoke requires an HTTPS descriptor URL");
  invariant4(path4.isAbsolute(installerPath) && path4.isAbsolute(outputHome), "published smoke paths must be absolute");
  const signatureUrl = `${descriptorUrl}.sig`;
  return [
    { command: "/usr/bin/curl", args: ["--fail", "--silent", "--show-error", "--proto", "=https", "--tlsv1.2", descriptorUrl, "-o", path4.join(outputHome, "release-descriptor.json")] },
    { command: "/usr/bin/curl", args: ["--fail", "--silent", "--show-error", "--proto", "=https", "--tlsv1.2", signatureUrl, "-o", path4.join(outputHome, "release-descriptor.json.sig")] },
    { command: installerPath, args: ["--source", "curl", "--release-url", descriptorUrl, "--home", outputHome] },
    { command: path4.join(outputHome, "bin", "jobctrl"), args: ["start", "--no-open"] },
    { command: path4.join(outputHome, "bin", "jobctrl"), args: ["status", "--json"] },
    { command: path4.join(outputHome, "bin", "jobctrl"), args: ["version", "--json"] },
    { command: path4.join(outputHome, "bin", "jobctrl"), args: ["stop"] },
    { command: path4.join(outputHome, "bin", "jobctrl"), args: ["status", "--json"] }
  ];
}
function parseCommandJson(result, label) {
  try {
    return JSON.parse(result.stdout);
  } catch {
    throw new Error(`${label} did not produce JSON`);
  }
}
function assertRunningStatus(status) {
  invariant4(status?.status === "running", "published smoke status must be running");
  for (const component of ["temporal", "worker", "api"]) invariant4(status.components?.[component]?.state === "running", `published smoke ${component} is not running`);
  return true;
}
function assertStoppedStatus(status) {
  invariant4(status?.status === "stopped", "published smoke post-stop status must be stopped");
  for (const component of Object.values(status.components ?? {})) invariant4(component?.state !== "running", "published smoke leaves a live component after stop");
  return true;
}
function assertPublishedVersion(version, candidate) {
  invariant4(version?.buildId === candidate?.buildId, "published smoke version buildId does not match the downloaded descriptor");
  invariant4(version?.manifestSha256 === candidate?.manifestSha256, "published smoke version manifest SHA-256 does not match the downloaded descriptor");
  return true;
}
function candidateIdentityFromDescriptor(descriptorRaw) {
  const descriptor = validateReleaseDescriptor(JSON.parse(descriptorRaw));
  invariant4(descriptor.channel === "stable" || descriptor.channel === "prerelease", "published smoke descriptor must be a signed network channel");
  return {
    descriptorSha256: sha256Bytes(Buffer.from(descriptorRaw, "utf8")),
    buildId: descriptor.buildId,
    appVersion: descriptor.appVersion,
    artifactSha256: descriptor.artifact.sha256,
    artifactSizeBytes: descriptor.artifact.sizeBytes,
    manifestSha256: descriptor.artifact.manifestSha256
  };
}
function assertCandidateIdentity(expected, actual) {
  const keys = ["descriptorSha256", "buildId", "appVersion", "artifactSha256", "artifactSizeBytes", "manifestSha256"];
  for (const key of keys) invariant4(expected?.[key] === actual?.[key], `published smoke candidate identity mismatch for ${key}`);
  return true;
}
async function runPublishedCandidateSmoke({
  descriptorUrl,
  channelPointerUrl = null,
  installerUrl,
  installerSha256,
  expectedCandidate,
  runtimeHome = null,
  runner = defaultCommandRunner
}) {
  invariant4(typeof installerUrl === "string" && installerUrl.startsWith("https://"), "published smoke requires an HTTPS installer URL");
  invariant4(SHA256_PATTERN3.test(installerSha256), "published smoke requires an installer SHA-256");
  invariant4(expectedCandidate && typeof expectedCandidate === "object", "published smoke requires the exact expected candidate identity");
  const root = runtimeHome ?? await mkdtemp2(path4.join(os2.tmpdir(), "jobctrl-published-smoke-"));
  const isolatedHome = path4.join(root, "home");
  const isolatedRuntimeHome = path4.join(root, "runtime");
  const installerPath = path4.join(root, "downloaded-jobctrl-installer");
  const environment = { ...process3.env, HOME: isolatedHome, JOBCTRL_RUNTIME_HOME: isolatedRuntimeHome, JOBCTRL_DIR: path4.join(isolatedRuntimeHome, "state") };
  let started = false;
  let runningStatus;
  let version;
  let stoppedStatus;
  try {
    await mkdir3(isolatedHome, { recursive: true, mode: 448 });
    await mkdir3(isolatedRuntimeHome, { recursive: true, mode: 448 });
    await runner("/usr/bin/curl", ["--fail", "--silent", "--show-error", "--proto", "=https", "--tlsv1.2", installerUrl, "-o", installerPath], { env: environment });
    invariant4(await sha256File3(installerPath) === installerSha256, "published smoke downloaded installer SHA-256 mismatch");
    await chmod3(installerPath, 448);
    let releaseUrl = descriptorUrl;
    if (channelPointerUrl !== null) {
      invariant4(typeof channelPointerUrl === "string" && channelPointerUrl.startsWith("https://"), "published smoke pointer URL must use HTTPS");
      await runner("/usr/bin/curl", ["--fail", "--silent", "--show-error", "--proto", "=https", "--tlsv1.2", channelPointerUrl, "-o", path4.join(isolatedRuntimeHome, "channel-pointer.json")], { env: environment });
      const pointer = validateReleaseChannelPointer(JSON.parse(await readFile4(path4.join(isolatedRuntimeHome, "channel-pointer.json"), "utf8")));
      await runner("/usr/bin/curl", ["--fail", "--silent", "--show-error", "--proto", "=https", "--tlsv1.2", pointer.descriptor.url, "-o", path4.join(isolatedRuntimeHome, "release-descriptor.json")], { env: environment });
      await runner("/usr/bin/curl", ["--fail", "--silent", "--show-error", "--proto", "=https", "--tlsv1.2", pointer.signature.url, "-o", path4.join(isolatedRuntimeHome, "release-descriptor.json.sig")], { env: environment });
      invariant4(await sha256File3(path4.join(isolatedRuntimeHome, "release-descriptor.json")) === pointer.descriptor.sha256 && await sha256File3(path4.join(isolatedRuntimeHome, "release-descriptor.json.sig")) === pointer.signature.sha256, "published smoke immutable pointer digest mismatch");
      const pointedDescriptor = validateReleaseDescriptor(JSON.parse(await readFile4(path4.join(isolatedRuntimeHome, "release-descriptor.json"), "utf8")));
      invariant4(pointer.channel === pointedDescriptor.channel && pointer.platform.id === pointedDescriptor.platform.id && pointer.platform.os === pointedDescriptor.platform.os && pointer.platform.arch === pointedDescriptor.platform.arch && pointer.sourceCommit === pointedDescriptor.sourceCommit && pointer.buildId === pointedDescriptor.buildId && pointer.sequence === pointedDescriptor.sequence, "published smoke pointer identity does not match the signed descriptor");
      releaseUrl = channelPointerUrl;
    }
    const plan = publishedCandidateSmokePlan({ descriptorUrl: releaseUrl, installerPath, outputHome: isolatedRuntimeHome });
    for (const command of channelPointerUrl === null ? plan.slice(0, 2) : []) await runner(command.command, command.args, { env: environment });
    const observedCandidate = candidateIdentityFromDescriptor(await readFile4(path4.join(isolatedRuntimeHome, "release-descriptor.json"), "utf8"));
    assertCandidateIdentity(expectedCandidate, observedCandidate);
    for (const command of plan.slice(2)) {
      const result = await runner(command.command, command.args, { env: environment });
      if (command.args[0] === "start") started = true;
      if (command.args[0] === "status" && !started) stoppedStatus = parseCommandJson(result, "post-stop native status");
      else if (command.args[0] === "status") runningStatus = parseCommandJson(result, "native status");
      if (command.args[0] === "version") version = parseCommandJson(result, "native version");
      if (command.args[0] === "stop") started = false;
    }
    assertRunningStatus(runningStatus);
    assertPublishedVersion(version, observedCandidate);
    assertStoppedStatus(stoppedStatus);
    return {
      schemaVersion: 1,
      status: "passed",
      publicationStatus: "published-candidate-verified",
      descriptorUrl,
      ...channelPointerUrl === null ? {} : { channelPointerUrl },
      installerUrl,
      installerSha256,
      candidate: observedCandidate,
      pypiPublicationAuthorized: true,
      checks: ["https-descriptor", "https-descriptor-signature", ...channelPointerUrl === null ? [] : ["https-immutable-channel-pointer", "channel-pointer-identity"], "https-artifact-via-native-installer", "native-start", "native-status-running", "native-version-identity", "native-stop", "native-status-stopped"]
    };
  } finally {
    if (started) {
      try {
        await runner(path4.join(isolatedRuntimeHome, "bin", "jobctrl"), ["stop"], { env: environment });
      } catch {
      }
    }
    if (runtimeHome === null) await rm3(root, { recursive: true, force: true });
  }
}
async function recordPublishedCandidateSmoke({ releaseDirectory, smoke }) {
  invariant4(smoke?.status === "passed" && smoke.publicationStatus === "published-candidate-verified" && smoke.pypiPublicationAuthorized === true, "only a successful published native lifecycle smoke may authorize promotion");
  const metadata = JSON.parse(await readFile4(path4.join(releaseDirectory, "release-metadata.json"), "utf8"));
  invariant4(metadata?.pypiPublicationAuthorized === false, "candidate metadata may not self-authorize promotion");
  invariant4(smoke.descriptorUrl === metadata.publicationUrls?.immutableDescriptorUrl && smoke.channelPointerUrl === metadata.publicationUrls?.immutableChannelPointerUrl && smoke.installerUrl === metadata.publicationUrls?.installerUrl && smoke.installerSha256 === metadata.installer?.sha256, "published smoke does not bind this immutable release candidate");
  assertCandidateIdentity({
    descriptorSha256: metadata.descriptor?.sha256,
    buildId: metadata.buildId,
    appVersion: metadata.appVersion,
    artifactSha256: metadata.archive?.sha256,
    artifactSizeBytes: metadata.archive?.sizeBytes,
    manifestSha256: metadata.manifest?.sha256
  }, smoke.candidate);
  await writeFile3(path4.join(releaseDirectory, "published-candidate-smoke.json"), canonicalJson2(smoke), { mode: 420 });
  return { status: "recorded", smokePath: path4.join(releaseDirectory, "published-candidate-smoke.json"), checksumClosure: "unchanged-pre-publication-candidate" };
}
async function verifyPyPIReleaseGate({ releaseDirectory, expectedTag, sourceCommit, expectedPublicKeyBase64, expectedKeyId }) {
  invariant4(typeof expectedTag === "string" && /^v[0-9]+\.[0-9]+\.[0-9]+$/.test(expectedTag), "PyPI release gate requires a stable v<semver> tag");
  invariant4(typeof sourceCommit === "string" && /^[a-f0-9]{40}$/.test(sourceCommit), "PyPI release gate requires the checked-out audited commit SHA");
  invariant4(typeof expectedKeyId === "string" && /^[A-Za-z0-9._-]+$/.test(expectedKeyId), "PyPI release gate requires a protected expected release key id");
  invariant4(typeof expectedPublicKeyBase64 === "string" && Buffer.from(expectedPublicKeyBase64, "base64").length === 32 && Buffer.from(expectedPublicKeyBase64, "base64").toString("base64") === expectedPublicKeyBase64, "PyPI release gate requires a protected canonical raw Ed25519 public key");
  const metadata = JSON.parse(await readFile4(path4.join(releaseDirectory, "release-metadata.json"), "utf8"));
  invariant4(metadata?.status === "signed-notarized-release-candidate" && metadata.channel === "stable", "PyPI release gate requires a signed stable P6 candidate");
  invariant4(metadata.pypiPublicationAuthorized === false, "pre-publication metadata must not self-authorize PyPI");
  invariant4(metadata.appVersion === expectedTag.slice(1), "PyPI release tag does not match the signed candidate version");
  invariant4(metadata.sourceCommit === sourceCommit, "PyPI checkout commit does not match the signed candidate provenance");
  const urls = canonicalReleaseUrls("stable", metadata.archive?.file, metadata.buildId);
  invariant4(metadata.publicationUrls?.descriptorUrl === urls.descriptorUrl && metadata.publicationUrls?.immutableDescriptorUrl === urls.immutableDescriptorUrl && metadata.publicationUrls?.artifactUrl === urls.artifactUrl && metadata.publicationUrls?.installerUrl === urls.installerUrl, "PyPI release gate requires canonical published P6 URLs");
  const [descriptorRaw, descriptorSignatureRaw, channelPointerRaw, manifestRaw, manifestSignatureRaw, trustRaw, smokeRaw, checksumsRaw] = await Promise.all([
    readFile4(path4.join(releaseDirectory, "release-descriptor.json"), "utf8"),
    readFile4(path4.join(releaseDirectory, "release-descriptor.json.sig"), "utf8"),
    readFile4(path4.join(releaseDirectory, "channel-pointer.json"), "utf8"),
    readFile4(path4.join(releaseDirectory, "manifest.json"), "utf8"),
    readFile4(path4.join(releaseDirectory, "manifest.sig"), "utf8"),
    readFile4(path4.join(releaseDirectory, "release-keys.json"), "utf8"),
    readFile4(path4.join(releaseDirectory, "published-candidate-smoke.json"), "utf8"),
    readFile4(path4.join(releaseDirectory, "SHA256SUMS"), "utf8")
  ]);
  const descriptor = validateReleaseDescriptor(JSON.parse(descriptorRaw));
  const channelPointer = validateReleaseChannelPointer(JSON.parse(channelPointerRaw));
  const descriptorSignature = JSON.parse(descriptorSignatureRaw);
  const manifestSignature = JSON.parse(manifestSignatureRaw);
  const trust = JSON.parse(trustRaw);
  assertExactKeys2(trust, ["schemaVersion", "keys"], "release trust registry");
  invariant4(trust.schemaVersion === 1 && trust.keys !== null && typeof trust.keys === "object" && !Array.isArray(trust.keys), "release trust registry is invalid");
  const keyId = descriptorSignature.keyId;
  invariant4(typeof keyId === "string" && keyId === manifestSignature.manifestKeyId && typeof trust.keys[keyId] === "string", "release signatures do not share a provisioned trust key");
  invariant4(keyId === expectedKeyId && trust.keys[keyId] === expectedPublicKeyBase64, "release candidate does not bind the protected expected release trust");
  const publicKey = publicKeyFromRaw(Buffer.from(expectedPublicKeyBase64, "base64"));
  validateReleaseDescriptorSignature(descriptorSignature, { channel: "stable" });
  verifyReleaseBytes({ domain: DESCRIPTOR_SIGNING_DOMAIN, raw: descriptorRaw, signature: descriptorSignature, publicKey, keyId, kind: "descriptor" });
  verifyReleaseBytes({ domain: MANIFEST_SIGNING_DOMAIN, raw: manifestRaw, signature: manifestSignature, publicKey, keyId, kind: "manifest" });
  invariant4(descriptor.sourceCommit === sourceCommit && descriptor.sourceCommit === metadata.sourceCommit, "signed descriptor source commit does not match the checked-out audited tag");
  invariant4(descriptor.buildId === metadata.buildId && descriptor.appVersion === metadata.appVersion && descriptor.artifact.sha256 === metadata.archive.sha256, "descriptor does not bind the P6 release metadata");
  invariant4(metadata.channelPointer?.url === urls.immutableChannelPointerUrl && metadata.channelPointer?.sha256 === sha256Bytes(Buffer.from(channelPointerRaw, "utf8")), "release metadata does not bind the immutable channel pointer");
  invariant4(channelPointer.channel === descriptor.channel && channelPointer.platform.id === descriptor.platform.id && channelPointer.platform.os === descriptor.platform.os && channelPointer.platform.arch === descriptor.platform.arch && channelPointer.sourceCommit === descriptor.sourceCommit && channelPointer.buildId === descriptor.buildId && channelPointer.sequence === descriptor.sequence && channelPointer.descriptor.url === urls.immutableDescriptorUrl && channelPointer.descriptor.sha256 === sha256Bytes(Buffer.from(descriptorRaw, "utf8")) && channelPointer.signature.url === urls.immutableDescriptorSignatureUrl && channelPointer.signature.sha256 === sha256Bytes(Buffer.from(descriptorSignatureRaw, "utf8")), "immutable channel pointer does not bind the signed descriptor pair");
  invariant4(sha256Bytes(Buffer.from(descriptorRaw, "utf8")) === metadata.descriptor?.sha256, "release metadata descriptor digest does not match the signed descriptor bytes");
  invariant4(sha256Bytes(Buffer.from(manifestRaw, "utf8")) === descriptor.artifact.manifestSha256 && sha256Bytes(Buffer.from(manifestRaw, "utf8")) === metadata.manifest?.sha256, "descriptor or release metadata manifest digest does not match the released manifest bytes");
  const archivePath = path4.join(releaseDirectory, metadata.archive.file);
  invariant4(await sha256File3(archivePath) === descriptor.artifact.sha256 && (await stat3(archivePath)).size === descriptor.artifact.sizeBytes, "descriptor artifact digest or size does not match the released ZIP bytes");
  const smoke = JSON.parse(smokeRaw);
  invariant4(smoke?.status === "passed" && smoke.publicationStatus === "published-candidate-verified" && smoke.pypiPublicationAuthorized === true, "PyPI release gate requires a passing published native lifecycle smoke");
  invariant4(smoke.descriptorUrl === urls.immutableDescriptorUrl && smoke.channelPointerUrl === urls.immutableChannelPointerUrl && smoke.installerUrl === urls.installerUrl && smoke.installerSha256 === metadata.installer.sha256, "PyPI release smoke does not bind the immutable downloaded installer and descriptor");
  assertCandidateIdentity({
    descriptorSha256: metadata.descriptor?.sha256,
    buildId: metadata.buildId,
    appVersion: metadata.appVersion,
    artifactSha256: metadata.archive?.sha256,
    artifactSizeBytes: metadata.archive?.sizeBytes,
    manifestSha256: metadata.manifest?.sha256
  }, smoke.candidate);
  const checksumRecords = /* @__PURE__ */ new Map();
  for (const line of checksumsRaw.trim().split("\n")) {
    const match = line.match(/^([a-f0-9]{64})  (.+)$/);
    invariant4(match, "SHA256SUMS has an invalid record");
    invariant4(!checksumRecords.has(match[2]), "SHA256SUMS has duplicate paths");
    checksumRecords.set(match[2], match[1]);
  }
  const files = (await releaseRegularFiles(releaseDirectory)).filter((file) => file !== "SHA256SUMS" && file !== "published-candidate-smoke.json");
  invariant4(JSON.stringify([...checksumRecords.keys()].sort(bytewiseCompare4)) === JSON.stringify(files), "SHA256SUMS does not bind every release asset");
  for (const file of files) invariant4(await sha256File3(path4.join(releaseDirectory, file)) === checksumRecords.get(file), `SHA256SUMS digest mismatch for ${file}`);
  return { status: "pass", buildId: metadata.buildId, appVersion: metadata.appVersion, descriptorSha256: sha256Bytes(descriptorRaw) };
}
function parseOptions(argv) {
  const options = {};
  for (let index = 0; index < argv.length; index += 1) {
    const option = argv[index];
    invariant4(option.startsWith("--"), `unknown argument ${option}`);
    const key = option.slice(2);
    const value = argv[index + 1];
    invariant4(value !== void 0 && !value.startsWith("--") && options[key] === void 0, `${option} requires one value`);
    options[key] = value;
    index += 1;
  }
  return options;
}
function requireOptions(options, names, command, optional = []) {
  const allowed = /* @__PURE__ */ new Set([...names, ...optional]);
  const unexpected = Object.keys(options).filter((key) => !allowed.has(key));
  invariant4(unexpected.length === 0, `${command} has unsupported options: ${unexpected.join(", ")}`);
  for (const name of names) invariant4(options[name] !== void 0, `${command} requires --${name}`);
}
function parseCanonicalIntegerOption(value, name, { minimum = 0 } = {}) {
  invariant4(/^(?:0|[1-9][0-9]*)$/.test(value), `--${name} must be a canonical integer`);
  const parsed = Number(value);
  invariant4(Number.isSafeInteger(parsed) && parsed >= minimum, `--${name} must be a safe integer greater than or equal to ${minimum}`);
  return parsed;
}
async function main3(argv = process3.argv.slice(2)) {
  const [command, ...rest] = argv;
  if (command === "inspect") {
    invariant4(rest.length === 2, "usage: distribution-release.mjs inspect <descriptor.json> <descriptor.json.sig>");
    const [descriptorRaw, signatureRaw] = await Promise.all(rest.map((value) => readFile4(path4.resolve(value), "utf8")));
    const descriptor = validateReleaseDescriptor(JSON.parse(descriptorRaw));
    validateReleaseDescriptorSignature(JSON.parse(signatureRaw), { channel: descriptor.channel });
    process3.stdout.write(canonicalJson2({ channel: descriptor.channel, buildId: descriptor.buildId, descriptorSha256: sha256Bytes(descriptorRaw), artifact: descriptor.artifact }));
    return;
  }
  if (command === "validate-pointer") {
    invariant4(rest.length === 1, "usage: distribution-release.mjs validate-pointer <channel-pointer.json>");
    const pointer = validateReleaseChannelPointer(JSON.parse(await readFile4(path4.resolve(rest[0]), "utf8")));
    process3.stdout.write(canonicalJson2(pointer));
    return;
  }
  const options = parseOptions(rest);
  if (command === "prepare") {
    requireOptions(options, ["output", "channel", "build-id", "source-date-epoch"], command);
    const configuredPublicKey = process3.env.JOBCTRL_RELEASE_PUBLIC_KEY;
    const publicKey = configuredPublicKey ?? releasePublicKeyBase64(privateKeyFromBase64(process3.env.JOBCTRL_RELEASE_SIGNING_KEY ?? ""));
    invariant4(Buffer.from(publicKey, "base64").length === 32 && Buffer.from(publicKey, "base64").toString("base64") === publicKey, "prepared release requires a canonical raw Ed25519 public key");
    const result = await buildRealPayload({
      outputDirectory: path4.resolve(options.output),
      buildId: options["build-id"],
      sourceDateEpoch: parseCanonicalIntegerOption(options["source-date-epoch"], "source-date-epoch"),
      releaseChannel: options.channel,
      releaseTrustKeyBase64: publicKey
    });
    process3.stdout.write(canonicalJson2({ status: "prepared", buildId: result.buildId, archiveSha256: result.archiveSha256, manifestSha256: result.manifestSha256, nativeLauncherReleaseChannel: result.nativeLauncherReleaseChannel, nativeLauncherReleaseTrustKeySha256: result.nativeLauncherReleaseTrustKeySha256 }));
    return;
  }
  if (command === "compare") {
    requireOptions(options, ["first", "second", "channel", "public-key", "output"], command);
    const comparison = await comparePreparedBuilds(path4.resolve(options.first), path4.resolve(options.second), {
      channel: options.channel,
      publicKeyBase64: options["public-key"]
    });
    await writeFile3(path4.resolve(options.output), canonicalJson2(comparison), { mode: 420 });
    process3.stdout.write(canonicalJson2(comparison));
    return;
  }
  if (command === "verify-prepared") {
    requireOptions(options, ["prepared", "channel", "public-key"], command);
    const verification = await verifyPreparedCandidate({
      preparedDirectory: path4.resolve(options.prepared),
      channel: options.channel,
      publicKeyBase64: options["public-key"]
    });
    process3.stdout.write(canonicalJson2(verification));
    return;
  }
  if (command === "finalize") {
    requireOptions(options, ["prepared", "comparison", "output", "channel", "sequence", "minimum-safe-sequence", "revoked-build-ids", "source-date-epoch", "source-commit"], command);
    const comparison = JSON.parse(await readFile4(path4.resolve(options.comparison), "utf8"));
    const result = await finalizeNetworkRelease({
      preparedDirectory: path4.resolve(options.prepared),
      releaseDirectory: path4.resolve(options.output),
      channel: options.channel,
      sequence: parseCanonicalIntegerOption(options.sequence, "sequence", { minimum: 1 }),
      minimumSafeSequence: parseCanonicalIntegerOption(options["minimum-safe-sequence"], "minimum-safe-sequence", { minimum: 1 }),
      revokedBuildIds: JSON.parse(options["revoked-build-ids"]),
      sourceDateEpoch: parseCanonicalIntegerOption(options["source-date-epoch"], "source-date-epoch"),
      sourceCommit: options["source-commit"],
      preSignComparison: comparison,
      signingKeyBase64: process3.env.JOBCTRL_RELEASE_SIGNING_KEY ?? "",
      appleIdentity: process3.env.JOBCTRL_APPLE_SIGNING_IDENTITY ?? "",
      notaryProfile: process3.env.JOBCTRL_APPLE_NOTARY_PROFILE ?? ""
    });
    process3.stdout.write(canonicalJson2({ status: "finalized", archivePath: result.archivePath, archiveFileName: result.archiveFileName, publicationUrls: result.metadata.publicationUrls }));
    return;
  }
  if (command === "smoke") {
    requireOptions(options, ["descriptor-url", "installer-url", "installer-sha256", "release-dir", "output"], command, ["pointer-url"]);
    const metadata = JSON.parse(await readFile4(path4.join(path4.resolve(options["release-dir"]), "release-metadata.json"), "utf8"));
    const smoke = await runPublishedCandidateSmoke({
      descriptorUrl: options["descriptor-url"],
      channelPointerUrl: options["pointer-url"] ?? null,
      installerUrl: options["installer-url"],
      installerSha256: options["installer-sha256"],
      expectedCandidate: {
        descriptorSha256: metadata.descriptor?.sha256,
        buildId: metadata.buildId,
        appVersion: metadata.appVersion,
        artifactSha256: metadata.archive?.sha256,
        artifactSizeBytes: metadata.archive?.sizeBytes,
        manifestSha256: metadata.manifest?.sha256
      }
    });
    await writeFile3(path4.resolve(options.output), canonicalJson2(smoke), { mode: 420 });
    process3.stdout.write(canonicalJson2(smoke));
    return;
  }
  if (command === "record-smoke") {
    requireOptions(options, ["release-dir", "smoke"], command);
    const result = await recordPublishedCandidateSmoke({ releaseDirectory: path4.resolve(options["release-dir"]), smoke: JSON.parse(await readFile4(path4.resolve(options.smoke), "utf8")) });
    process3.stdout.write(canonicalJson2(result));
    return;
  }
  if (command === "pointer") {
    requireOptions(options, ["descriptor", "signature", "descriptor-url", "signature-url", "output"], command);
    const [descriptorRaw, signatureRaw] = await Promise.all([readFile4(path4.resolve(options.descriptor), "utf8"), readFile4(path4.resolve(options.signature), "utf8")]);
    const pointer = createReleaseChannelPointer({ descriptorRaw, signatureRaw, descriptorUrl: options["descriptor-url"], signatureUrl: options["signature-url"] });
    await writeFile3(path4.resolve(options.output), canonicalJson2(pointer), { mode: 420 });
    process3.stdout.write(canonicalJson2(pointer));
    return;
  }
  if (command === "verify-pypi-gate") {
    requireOptions(options, ["release-dir", "tag", "source-commit"], command);
    process3.stdout.write(canonicalJson2(await verifyPyPIReleaseGate({
      releaseDirectory: path4.resolve(options["release-dir"]),
      expectedTag: options.tag,
      sourceCommit: options["source-commit"],
      expectedPublicKeyBase64: process3.env.JOBCTRL_RELEASE_PUBLIC_KEY ?? "",
      expectedKeyId: process3.env.JOBCTRL_RELEASE_KEY_ID ?? ""
    })));
    return;
  }
  throw new Error("usage: distribution-release.mjs inspect|validate-pointer|prepare|compare|verify-prepared|finalize|smoke|record-smoke|pointer|verify-pypi-gate");
}
var invokedPath3 = process3.argv[1] ? pathToFileURL3(path4.resolve(process3.argv[1])).href : "";
if (import.meta.url === invokedPath3 && path4.basename(process3.argv[1] ?? "") === "distribution-release.mjs") {
  main3().catch((error) => {
    process3.stderr.write(`distribution release: ${error.message}
`);
    process3.exitCode = 1;
  });
}

// scripts/distribution-homebrew.mjs
var SCRIPT_DIR4 = path5.dirname(fileURLToPath4(import.meta.url));
var REPO_ROOT3 = path5.resolve(SCRIPT_DIR4, "..");
var FORMULA_TEMPLATE_PATH = path5.join(REPO_ROOT3, "packaging", "homebrew", "Formula", "jobctrl.rb.tmpl");
var RELEASE_TRUST_PATH = path5.join(REPO_ROOT3, "packaging", "distribution", "release-keys.json");
var RELEASE_ORIGIN = "https://releases.jobctrl.dev";
function invariant5(condition, message) {
  if (!condition) throw new Error(message);
}
function canonicalJson3(value) {
  return `${JSON.stringify(value, null, 2)}
`;
}
function sha256(value) {
  return createHash5("sha256").update(value).digest("hex");
}
function assertExactKeys3(value, keys, label) {
  invariant5(value !== null && typeof value === "object" && !Array.isArray(value), `${label} must be an object`);
  invariant5(JSON.stringify(Object.keys(value).sort()) === JSON.stringify([...keys].sort()), `${label} fields must be exact`);
  return value;
}
function requireCanonicalReleaseUrl(value, label) {
  invariant5(typeof value === "string" && value.length > 0 && !/[\x00-\x20"'\\]/.test(value), `${label} must not contain whitespace, quotes, or backslashes`);
  let parsed;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error(`${label} must be an absolute HTTPS URL`);
  }
  invariant5(parsed.protocol === "https:" && parsed.username === "" && parsed.password === "" && parsed.hash === "", `${label} must be an absolute HTTPS URL without credentials or fragments`);
  invariant5(parsed.origin === RELEASE_ORIGIN && parsed.port === "", `${label} must use the canonical ${RELEASE_ORIGIN} origin`);
  invariant5(parsed.href === value, `${label} must be canonical before it can be rendered into Ruby`);
  return parsed;
}
function requireImmutableReleaseUrl(value, label, expectedPath) {
  const parsed = requireCanonicalReleaseUrl(value, label);
  invariant5(parsed.pathname === expectedPath && parsed.search === "" && parsed.href === value, `${label} must select the exact immutable build path`);
  return parsed;
}
function signingMessage(raw) {
  return Buffer.concat([Buffer.from("jobctrl:release-descriptor:v1\0", "utf8"), Buffer.from(raw, "utf8")]);
}
function publicKeyFromBase64(encoded, keyId) {
  invariant5(typeof encoded === "string", `release trust key ${keyId} must be base64`);
  const raw = Buffer.from(encoded, "base64");
  invariant5(raw.length === 32 && raw.toString("base64") === encoded, `release trust key ${keyId} must be a raw Ed25519 public key`);
  return createPublicKey2({
    key: Buffer.concat([Buffer.from("302a300506032b6570032100", "hex"), raw]),
    format: "der",
    type: "spki"
  });
}
async function loadHomebrewReleaseTrust(trustPath = RELEASE_TRUST_PATH) {
  const trust = JSON.parse(await readFile5(trustPath, "utf8"));
  assertExactKeys3(trust, ["schemaVersion", "keys"], "Homebrew release trust registry");
  invariant5(trust.schemaVersion === 1 && trust.keys !== null && typeof trust.keys === "object" && !Array.isArray(trust.keys), "Homebrew release trust registry is invalid");
  const keys = /* @__PURE__ */ new Map();
  for (const [keyId, encoded] of Object.entries(trust.keys).sort(([left], [right]) => left.localeCompare(right))) {
    invariant5(/^[A-Za-z0-9._-]+$/.test(keyId), "Homebrew release trust key id is invalid");
    keys.set(keyId, publicKeyFromBase64(encoded, keyId));
  }
  return keys;
}
function verifyReleaseDescriptorSignature({ descriptorRaw, signatureRaw, trust }) {
  const descriptor = JSON.parse(descriptorRaw);
  const signature = JSON.parse(signatureRaw);
  validateReleaseDescriptor(descriptor);
  validateReleaseDescriptorSignature(signature, { channel: descriptor.channel });
  invariant5(descriptor.channel === "stable", "Homebrew formula rendering requires a stable descriptor");
  invariant5(trust instanceof Map, "Homebrew release trust must be loaded before signature verification");
  const key = trust.get(signature.keyId);
  invariant5(key, `no Homebrew release trust key is provisioned for ${signature.keyId}`);
  const encoded = Buffer.from(signature.signature, "base64");
  invariant5(verifySignature(null, signingMessage(descriptorRaw), key, encoded), "Homebrew release descriptor Ed25519 signature verification failed");
  return descriptor;
}
function templateValues({ descriptor, descriptorRaw, signatureRaw, descriptorUrl }) {
  validateReleaseDescriptor(descriptor);
  invariant5(descriptor.channel === "stable", "Homebrew formula rendering requires a stable descriptor");
  const immutableBase = `/v1/artifacts/${descriptor.buildId}`;
  const descriptorOrigin = requireImmutableReleaseUrl(descriptorUrl, "Homebrew descriptor URL", `${immutableBase}/release-descriptor.json`);
  const artifactOrigin = requireImmutableReleaseUrl(descriptor.artifact.url, "Homebrew artifact URL", `${immutableBase}/jobctrl-${descriptor.appVersion}-darwin-arm64.zip`);
  invariant5(descriptorOrigin.origin === artifactOrigin.origin, "Homebrew descriptor and artifact must share one release origin");
  return {
    ARTIFACT_URL: descriptor.artifact.url,
    ARTIFACT_SHA256: descriptor.artifact.sha256,
    APP_VERSION: descriptor.appVersion,
    BUILD_ID: descriptor.buildId,
    MANIFEST_SHA256: descriptor.artifact.manifestSha256,
    DESCRIPTOR_URL: descriptorUrl,
    DESCRIPTOR_SHA256: sha256(descriptorRaw),
    SIGNATURE_SHA256: sha256(signatureRaw ?? "")
  };
}
async function renderHomebrewFormula({ descriptorRaw, signatureRaw, descriptorUrl, trust }) {
  const descriptor = verifyReleaseDescriptorSignature({ descriptorRaw, signatureRaw, trust });
  const values = templateValues({ descriptor, descriptorRaw, signatureRaw, descriptorUrl });
  let formula = await readFile5(FORMULA_TEMPLATE_PATH, "utf8");
  for (const [token, value] of Object.entries(values)) formula = formula.replaceAll(`{{${token}}}`, value);
  invariant5(!/{{[A-Z_]+}}/.test(formula), "Homebrew formula template has an unresolved token");
  validateRenderedHomebrewFormula({ formula, descriptor, descriptorRaw, signatureRaw, descriptorUrl });
  return { formula, descriptor, descriptorSha256: values.DESCRIPTOR_SHA256, publicationInputs: releasePublicationInputs({ descriptorRaw, descriptorUrl }) };
}
function validateRenderedHomebrewFormula({ formula, descriptor, descriptorRaw, signatureRaw = "", descriptorUrl }) {
  validateReleaseDescriptor(descriptor);
  const values = templateValues({ descriptor, descriptorRaw, signatureRaw, descriptorUrl });
  const required = [
    `url "${values.ARTIFACT_URL}"`,
    `sha256 "${values.ARTIFACT_SHA256}"`,
    `version "${values.APP_VERSION}"`,
    `JOBCTRL_BUILD_ID = "${values.BUILD_ID}"`,
    `JOBCTRL_MANIFEST_SHA256 = "${values.MANIFEST_SHA256}"`,
    `JOBCTRL_DESCRIPTOR_URL = "${values.DESCRIPTOR_URL}"`,
    `JOBCTRL_DESCRIPTOR_SHA256 = "${values.DESCRIPTOR_SHA256}"`,
    `JOBCTRL_SIGNATURE_SHA256 = "${values.SIGNATURE_SHA256}"`,
    'require "open3"',
    '"/usr/bin/codesign", "--verify", "--deep", "--strict", "--check-notarization", "-R=notarized", "--verbose=2", bundle.to_s',
    '"/usr/bin/codesign", "--verify", "--strict", "--check-notarization", "-R=notarized", "--verbose=2", executable.to_s',
    '"/usr/sbin/spctl", "--assess", "--type", "execute", "--verbose=4", bundle.to_s',
    'gatekeeper_output.include?("source=Notarized Developer ID")',
    'verify_notarized_executable!(buildpath/"launcher/jobctrl")',
    'verify_notarized_executable!(buildpath/"launcher/jobctrl-installer")',
    "managed_headless_shell",
    "verify_notarized_executable!(managed_headless_shell)",
    'resource "jobctrl-release-descriptor"',
    'resource "jobctrl-release-descriptor-signature"',
    'bootstrap.install "release-descriptor.json" => "homebrew-release.json"',
    'bootstrap.install "release-descriptor.json.sig" => "homebrew-release.json.sig"',
    'bootstrap.install cached_download => "jobctrl-release.zip"',
    'bootstrap/"homebrew-bootstrap.json"',
    'bin.install_symlink bootstrap/"jobctrl"'
  ];
  for (const marker of required) invariant5(formula.includes(marker), `rendered Homebrew formula is missing ${marker}`);
  invariant5(formula.includes("Formula installation remains entirely prefix-owned"), "rendered Homebrew formula must use first-invocation bootstrap");
  invariant5(!formula.includes('verify_notarized_app!(buildpath/"launcher/jobctrl")'), "rendered Homebrew formula must not Gatekeeper-assess raw launcher executables");
  invariant5(!formula.includes("Pathname.new(Dir.home)"), "rendered Homebrew formula must not write the user home during install");
  invariant5(!/\bhead\s+/.test(formula), "rendered Homebrew formula must not have a HEAD/source path");
  invariant5(!/depends_on\s+/.test(formula), "rendered Homebrew formula must not install a developer-toolchain dependency");
  for (const forbidden of ["corepack", "git", "node", "uv", "temporal", "poppler", "chrome"]) {
    invariant5(!new RegExp(`depends_on\\s+"${forbidden}"`).test(formula), `rendered Homebrew formula must not depend on ${forbidden}`);
  }
  return true;
}
async function verifyHomebrewPromotionEvidence({ descriptorRaw, signatureRaw, descriptorUrl, formulaRaw, evidenceRaw, trust }) {
  const canonicalRender = await renderHomebrewFormula({ descriptorRaw, signatureRaw, descriptorUrl, trust });
  const { descriptor } = canonicalRender;
  invariant5(
    formulaRaw === canonicalRender.formula,
    "Homebrew promotion formula must match the canonical checked-in template render byte-for-byte"
  );
  const evidence = JSON.parse(evidenceRaw);
  assertExactKeys3(evidence, ["schemaVersion", "status", "signatureVerified", "publishedArtifactSmoke", "descriptorSha256", "formulaSha256", "artifact", "publishedCandidate"], "Homebrew promotion evidence");
  invariant5(evidence.schemaVersion === 1 && evidence.status === "verified" && evidence.signatureVerified === true && evidence.publishedArtifactSmoke === "passed", "Homebrew promotion evidence is not verified after signed artifact smoke");
  const descriptorSha256 = sha256(descriptorRaw);
  const canonicalFormulaSha256 = sha256(canonicalRender.formula);
  invariant5(evidence.descriptorSha256 === descriptorSha256 && evidence.formulaSha256 === canonicalFormulaSha256, "Homebrew promotion evidence digest mismatch");
  assertExactKeys3(evidence.artifact, ["url", "sha256", "manifestSha256", "buildId", "appVersion"], "Homebrew promotion artifact evidence");
  invariant5(
    evidence.artifact.url === descriptor.artifact.url && evidence.artifact.sha256 === descriptor.artifact.sha256 && evidence.artifact.manifestSha256 === descriptor.artifact.manifestSha256 && evidence.artifact.buildId === descriptor.buildId && evidence.artifact.appVersion === descriptor.appVersion,
    "Homebrew promotion evidence does not match the descriptor artifact identity"
  );
  assertCandidateIdentity(candidateIdentityFromDescriptor(descriptorRaw), evidence.publishedCandidate);
  return { descriptorSha256, formulaSha256: canonicalFormulaSha256, artifact: evidence.artifact };
}
function parseOptions2(argv) {
  const options = {};
  for (let index = 0; index < argv.length; index += 1) {
    const option = argv[index];
    invariant5(option.startsWith("--"), `unknown argument ${option}`);
    const key = option.slice(2);
    const value = argv[index + 1];
    invariant5(value && !value.startsWith("--") && options[key] === void 0, `${option} requires one value`);
    options[key] = value;
    index += 1;
  }
  return options;
}
function assertOptionKeys(options, allowed, command) {
  const unknown = Object.keys(options).filter((key) => !allowed.includes(key)).sort();
  invariant5(unknown.length === 0, `${command} contains unsupported options: ${unknown.join(", ")}`);
}
async function main4(argv = process4.argv.slice(2)) {
  const command = argv[0];
  const options = parseOptions2(argv.slice(1));
  const required = (name) => {
    invariant5(options[name], `--${name} is required`);
    return path5.resolve(options[name]);
  };
  if (command === "render") {
    assertOptionKeys(options, ["descriptor", "signature", "descriptor-url", "output", "trust"], command);
    const [descriptorRaw, signatureRaw] = await Promise.all([readFile5(required("descriptor"), "utf8"), readFile5(required("signature"), "utf8")]);
    const trust = await loadHomebrewReleaseTrust(options.trust ? path5.resolve(options.trust) : RELEASE_TRUST_PATH);
    const result = await renderHomebrewFormula({ descriptorRaw, signatureRaw, descriptorUrl: options["descriptor-url"], trust });
    const output = required("output");
    await mkdir4(path5.dirname(output), { recursive: true, mode: 493 });
    await writeFile4(output, result.formula, { mode: 420 });
    process4.stdout.write(canonicalJson3({ output, descriptorSha256: result.descriptorSha256, formulaSha256: sha256(result.formula), buildId: result.descriptor.buildId }));
    return;
  }
  if (command === "verify-promotion") {
    assertOptionKeys(options, ["descriptor", "signature", "descriptor-url", "formula", "evidence", "trust"], command);
    const [descriptorRaw, signatureRaw, formulaRaw, evidenceRaw] = await Promise.all([
      readFile5(required("descriptor"), "utf8"),
      readFile5(required("signature"), "utf8"),
      readFile5(required("formula"), "utf8"),
      readFile5(required("evidence"), "utf8")
    ]);
    const trust = await loadHomebrewReleaseTrust(options.trust ? path5.resolve(options.trust) : RELEASE_TRUST_PATH);
    const result = await verifyHomebrewPromotionEvidence({ descriptorRaw, signatureRaw, formulaRaw, evidenceRaw, descriptorUrl: options["descriptor-url"], trust });
    process4.stdout.write(canonicalJson3({ status: "pass", ...result }));
    return;
  }
  throw new Error("usage: distribution-homebrew.mjs render|verify-promotion --descriptor <path> --signature <path> --descriptor-url <https-url> [--output <path>|--formula <path> --evidence <path>]");
}
var invokedPath4 = process4.argv[1] ? pathToFileURL4(path5.resolve(process4.argv[1])).href : "";
if (import.meta.url === invokedPath4 && path5.basename(process4.argv[1] ?? "") === "distribution-homebrew.mjs") {
  main4().catch((error) => {
    process4.stderr.write(`distribution homebrew: ${error.message}
`);
    process4.exitCode = 1;
  });
}

// scripts/distribution-homebrew-render-entry.mjs
var invokedPath5 = process5.argv[1] ? pathToFileURL5(path6.resolve(process5.argv[1])).href : "";
if (import.meta.url === invokedPath5) {
  try {
    await main4(process5.argv.slice(2));
  } catch (error) {
    process5.stderr.write(`distribution homebrew: ${error.message}
`);
    process5.exitCode = 1;
  }
}
export {
  renderHomebrewFormula
};
