/**
 * JavaScript export analysis: what a module file exports (ESM and CommonJS, re-exports, classes and
 * their members) and a canonical fingerprint of each exported definition, so two versions of a
 * package can be compared by what the code does rather than how it is formatted.
 */
import {
  canonicalForm,
  isNode,
  nameOfNode,
  parseSource,
  propertyName,
  walk,
  type AstNode,
} from "./ast.js";
import type { ClassMemberInfo, ParamInfo } from "./types.js";

export type DefinitionKind = "function" | "class" | "value";

export interface LocalDef {
  name: string;
  kind: DefinitionKind;
  /** Fingerprint of the definition with nested named definitions left out. */
  fingerprint: string;
  /** Identifier names mentioned in the definition. */
  refs: Set<string>;
  tokens: Set<string>;
  nodeCount: number;
  params?: ParamInfo[];
  members?: ClassMemberInfo[];
}

export interface ExportBinding {
  name: string;
  kind: DefinitionKind | "module";
  fingerprint: string;
  /** Name of the local definition this export is, when it is one. */
  local?: string;
  refs: Set<string>;
  tokens: Set<string>;
  nodeCount: number;
  params?: ParamInfo[];
  members?: ClassMemberInfo[];
  /** Relative module the value is `require`d from (`exports.x = require("./x")`). */
  moduleRef?: string;
}

export interface ReExport {
  /** Relative module specifier, or a package name for an external re-export. */
  source: string;
  kind: "all" | "named" | "namespace";
  names: Array<{ exported: string; imported: string }>;
  namespace?: string;
  /** `module.exports = require("./x")`: the default (whole-module) export carries over too. */
  includeDefault?: boolean;
}

export interface ModuleInfo {
  path: string;
  /** Fingerprint of the whole file. */
  fingerprint: string;
  locals: Map<string, LocalDef>;
  exports: Map<string, ExportBinding>;
  reexports: ReExport[];
  /** Relative modules this file imports or requires. */
  relativeImports: string[];
  /** How the exports were found; `namespace-assignments` is a weak heuristic. */
  discovery: "declared" | "namespace-assignments" | "none";
}

const FUNCTION_TYPES = new Set([
  "FunctionDeclaration",
  "FunctionExpression",
  "ArrowFunctionExpression",
  "TSDeclareFunction",
  "TSEmptyBodyFunctionExpression",
]);

function isFunctionNode(node: AstNode | undefined): node is AstNode {
  return node !== undefined && FUNCTION_TYPES.has(node.type);
}

function isClassNode(node: AstNode | undefined): node is AstNode {
  return (
    node !== undefined && (node.type === "ClassDeclaration" || node.type === "ClassExpression")
  );
}

function identName(node: unknown): string | undefined {
  return isNode(node) && node.type === "Identifier" ? String(node.name) : undefined;
}

/** Parameters of a function node as `ParamInfo`s (JavaScript view: a default makes it optional). */
export function paramsOfFunction(fn: AstNode): ParamInfo[] {
  const params = (fn.params as unknown[] | undefined) ?? [];
  const result: ParamInfo[] = [];
  for (const [index, raw] of params.entries()) {
    if (!isNode(raw)) continue;
    if (raw.type === "AssignmentPattern") {
      result.push({ name: identName(raw.left) ?? `arg${index}`, optional: true, rest: false });
    } else if (raw.type === "RestElement") {
      result.push({ name: identName(raw.argument) ?? `arg${index}`, optional: true, rest: true });
    } else if (raw.type === "Identifier") {
      result.push({ name: String(raw.name), optional: raw.optional === true, rest: false });
    } else {
      result.push({ name: `arg${index}`, optional: false, rest: false });
    }
  }
  return result;
}

function membersOfClass(cls: AstNode): ClassMemberInfo[] {
  const body = (cls.body as AstNode | undefined)?.body as unknown[] | undefined;
  const members: ClassMemberInfo[] = [];
  for (const item of body ?? []) {
    if (!isNode(item)) continue;
    if (item.type !== "MethodDefinition" && item.type !== "PropertyDefinition") continue;
    if (item.accessibility === "private") continue;
    const key = item.key as AstNode | undefined;
    if (key?.type === "PrivateIdentifier") continue;
    const name = propertyName(key, item.computed === true);
    if (name === undefined) continue;
    const isStatic = item.static === true;
    if (item.type === "MethodDefinition") {
      const value = item.value as AstNode | undefined;
      const kind = item.kind as string;
      members.push({
        name: kind === "constructor" ? "constructor" : name,
        static: isStatic,
        kind:
          kind === "constructor"
            ? "constructor"
            : kind === "get"
              ? "getter"
              : kind === "set"
                ? "setter"
                : "method",
        params: isFunctionNode(value) ? paramsOfFunction(value) : undefined,
        fingerprint: value ? canonicalForm(value).fingerprint : "",
      });
    } else {
      members.push({
        name,
        static: isStatic,
        kind: "field",
        fingerprint: item.value && isNode(item.value) ? canonicalForm(item.value).fingerprint : "",
      });
    }
  }
  return members;
}

function requireSpecifier(node: AstNode | undefined): string | undefined {
  if (node?.type !== "CallExpression") return undefined;
  const callee = node.callee as AstNode | undefined;
  if (callee?.type !== "Identifier" || callee.name !== "require") return undefined;
  const first = (node.arguments as unknown[] | undefined)?.[0];
  return isNode(first) && first.type === "Literal" && typeof first.value === "string"
    ? first.value
    : undefined;
}

function isModuleExports(node: unknown): boolean {
  return (
    isNode(node) &&
    node.type === "MemberExpression" &&
    identName(node.object) === "module" &&
    propertyName(node.property, node.computed === true) === "exports"
  );
}

function isVoidZero(node: AstNode): boolean {
  return (
    (node.type === "UnaryExpression" && node.operator === "void") ||
    (node.type === "Identifier" && node.name === "undefined")
  );
}

function identifierNames(root: AstNode): Set<string> {
  const names = new Set<string>();
  walk(root, (node) => {
    if (node.type === "Identifier") names.add(String(node.name));
  });
  return names;
}

function isNamedDefinition(node: AstNode): string | undefined {
  if ((node.type === "FunctionDeclaration" || node.type === "ClassDeclaration") && node.id) {
    return identName(node.id);
  }
  if (node.type === "VariableDeclarator") {
    const name = identName(node.id);
    const init = node.init as AstNode | undefined;
    if (name && init && (isFunctionNode(init) || isClassNode(init))) return name;
  }
  return undefined;
}

interface LocalAccumulator {
  kind: DefinitionKind;
  fingerprints: string[];
  refs: Set<string>;
  tokens: Set<string>;
  nodeCount: number;
  params?: ParamInfo[];
  members?: ClassMemberInfo[];
}

function collectLocals(program: AstNode): Map<string, LocalDef> {
  const accumulators = new Map<string, LocalAccumulator>();
  const add = (name: string, root: AstNode, kind: DefinitionKind, definition?: AstNode): void => {
    const form = canonicalForm(root, placeholder);
    const existing = accumulators.get(name);
    const accumulator: LocalAccumulator = existing ?? {
      kind,
      fingerprints: [],
      refs: new Set(),
      tokens: new Set(),
      nodeCount: 0,
    };
    accumulator.fingerprints.push(form.fingerprint);
    for (const ref of identifierNames(root)) accumulator.refs.add(ref);
    for (const token of form.tokens) accumulator.tokens.add(token);
    accumulator.nodeCount += form.nodeCount;
    if (!existing) {
      if (isFunctionNode(definition)) accumulator.params = paramsOfFunction(definition);
      if (isClassNode(definition)) accumulator.members = membersOfClass(definition);
      accumulators.set(name, accumulator);
    }
  };

  walk(program, (node, _parent, ancestors) => {
    const named = isNamedDefinition(node);
    if (named !== undefined) {
      const definition =
        node.type === "VariableDeclarator" ? (node.init as AstNode | undefined) : node;
      add(named, node, isClassNode(definition) ? "class" : "function", definition);
      return;
    }
    if (node.type === "VariableDeclarator") {
      const name = identName(node.id);
      if (!name || !node.init || requireSpecifier(node.init as AstNode)) return;
      // Module-level values only: a `var index = -1` inside a function is not a definition worth
      // tracking, and would merge into one entry per name.
      const insideNamedDefinition = ancestors.some((ancestor) => isNamedDefinition(ancestor));
      if (!insideNamedDefinition) add(name, node, "value");
    }
  });

  const locals = new Map<string, LocalDef>();
  for (const [name, accumulator] of accumulators) {
    locals.set(name, {
      name,
      kind: accumulator.kind,
      fingerprint: accumulator.fingerprints.join("+"),
      refs: accumulator.refs,
      tokens: accumulator.tokens,
      nodeCount: accumulator.nodeCount,
      params: accumulator.params,
      members: accumulator.members,
    });
  }
  return locals;
}

/** Fingerprint stand-in for a nested named definition, which is tracked on its own. */
function placeholder(node: AstNode): string | undefined {
  const nested = isNamedDefinition(node);
  return nested === undefined ? undefined : `def:${nested}`;
}

/** Analyse one module file; undefined when it cannot be parsed. */
export function analyzeModule(path: string, code: string): ModuleInfo | undefined {
  const program = parseSource(path, code);
  if (!program) return undefined;

  const locals = collectLocals(program);
  const exports = new Map<string, ExportBinding>();
  const reexports: ReExport[] = [];
  const relativeImports = new Set<string>();
  const requireAliases = new Map<string, string>();
  let moduleExportsLocal: string | undefined;
  let moduleExportsRequire: string | undefined;

  const bindingFromLocal = (exportName: string, localName: string): ExportBinding | undefined => {
    const local = locals.get(localName);
    if (local) {
      return {
        name: exportName,
        kind: local.kind,
        fingerprint: local.fingerprint,
        local: localName,
        refs: local.refs,
        tokens: local.tokens,
        nodeCount: local.nodeCount,
        params: local.params,
        members: local.members,
      };
    }
    const moduleRef = requireAliases.get(localName);
    if (moduleRef) {
      return {
        name: exportName,
        kind: "module",
        fingerprint: `module:${moduleRef}`,
        refs: new Set(),
        tokens: new Set(),
        nodeCount: 1,
        moduleRef,
      };
    }
    return undefined;
  };

  const bindingFromExpression = (exportName: string, expression: AstNode): ExportBinding => {
    const identifier = identName(expression);
    if (identifier) {
      const fromLocal = bindingFromLocal(exportName, identifier);
      if (fromLocal) return fromLocal;
    }
    const required = requireSpecifier(expression);
    if (required) {
      return {
        name: exportName,
        kind: "module",
        fingerprint: `module:${required}`,
        refs: new Set(),
        tokens: new Set(),
        nodeCount: 1,
        moduleRef: required,
      };
    }
    const form = canonicalForm(expression, placeholder);
    const kind: DefinitionKind = isFunctionNode(expression)
      ? "function"
      : isClassNode(expression)
        ? "class"
        : "value";
    return {
      name: exportName,
      kind,
      fingerprint: form.fingerprint,
      refs: identifierNames(expression),
      tokens: form.tokens,
      nodeCount: form.nodeCount,
      params: isFunctionNode(expression) ? paramsOfFunction(expression) : undefined,
      members: isClassNode(expression) ? membersOfClass(expression) : undefined,
    };
  };

  const setExport = (name: string, binding: ExportBinding): void => {
    if (name === "__esModule") return;
    exports.set(name, binding);
  };

  const noteImport = (specifier: string | undefined): void => {
    if (specifier?.startsWith(".")) relativeImports.add(specifier);
  };

  // `const x = require("./x")` aliases, needed to resolve `module.exports = x`.
  walk(program, (node) => {
    if (node.type === "VariableDeclarator") {
      const name = identName(node.id);
      const specifier = requireSpecifier(node.init as AstNode | undefined);
      if (name && specifier) requireAliases.set(name, specifier);
    }
    if (node.type === "ImportDeclaration") {
      const source = (node.source as { value?: string } | undefined)?.value;
      noteImport(source);
      if (source) {
        for (const specifier of (node.specifiers as AstNode[] | undefined) ?? []) {
          const local = identName(specifier.local);
          if (local && specifier.type === "ImportNamespaceSpecifier") {
            requireAliases.set(local, source);
          }
        }
      }
    }
    const required = requireSpecifier(node);
    if (required) noteImport(required);
  });

  const handleAssignment = (node: AstNode): void => {
    const left = node.left as AstNode | undefined;
    if (!left || node.operator !== "=") return;
    let right = node.right as AstNode | undefined;
    while (right?.type === "AssignmentExpression") right = right.right as AstNode | undefined;
    if (!right || isVoidZero(right)) return;

    if (isModuleExports(left)) {
      const required = requireSpecifier(right);
      if (required) {
        moduleExportsRequire = required;
        return;
      }
      if (right.type === "ObjectExpression") {
        for (const property of (right.properties as AstNode[] | undefined) ?? []) {
          if (property.type === "SpreadElement") {
            const spread = requireSpecifier(property.argument as AstNode | undefined);
            if (spread) {
              reexports.push({ source: spread, kind: "all", names: [] });
              noteImport(spread);
            }
            continue;
          }
          const name = propertyName(property.key, property.computed === true);
          const value = property.value as AstNode | undefined;
          if (name !== undefined && value) setExport(name, bindingFromExpression(name, value));
        }
        return;
      }
      const alias = identName(right);
      if (alias && !locals.has(alias) && !requireAliases.has(alias)) {
        // `module.exports = _` where `_` is built elsewhere: its properties are the exports.
        moduleExportsLocal = alias;
        return;
      }
      if (alias && (locals.has(alias) || requireAliases.has(alias))) {
        moduleExportsLocal = alias;
        const binding = bindingFromLocal("module.exports", alias);
        if (binding) setExport("module.exports", binding);
        return;
      }
      setExport("module.exports", bindingFromExpression("module.exports", right));
      return;
    }

    if (left.type !== "MemberExpression") return;
    const target = left.object as AstNode | undefined;
    const targetName = identName(target);
    const isExportsObject =
      targetName === "exports" ||
      isModuleExports(target) ||
      (moduleExportsLocal !== undefined && targetName === moduleExportsLocal);
    if (!isExportsObject) return;
    const name = propertyName(left.property, left.computed === true);
    if (name === undefined) return;
    setExport(name, bindingFromExpression(name, right));
  };

  // ESM declarations, in the order they appear.
  for (const statement of (program.body as AstNode[] | undefined) ?? []) {
    if (statement.type === "ExportNamedDeclaration") {
      const source = (statement.source as { value?: string } | null)?.value;
      const declaration = statement.declaration as AstNode | null;
      if (declaration) {
        if (
          (declaration.type === "FunctionDeclaration" || declaration.type === "ClassDeclaration") &&
          declaration.id
        ) {
          const name = identName(declaration.id);
          const binding = name ? bindingFromLocal(name, name) : undefined;
          if (name && binding) exports.set(name, binding);
        } else if (declaration.type === "VariableDeclaration") {
          for (const declarator of (declaration.declarations as AstNode[] | undefined) ?? []) {
            const name = identName(declarator.id);
            if (!name) continue;
            const binding =
              bindingFromLocal(name, name) ??
              (declarator.init
                ? bindingFromExpression(name, declarator.init as AstNode)
                : undefined);
            if (binding) exports.set(name, binding);
          }
        }
        continue;
      }
      const specifiers = (statement.specifiers as AstNode[] | undefined) ?? [];
      if (source) {
        noteImport(source);
        reexports.push({
          source,
          kind: "named",
          names: specifiers.map((specifier) => ({
            exported: nameOfNode(specifier.exported) ?? "",
            imported: nameOfNode(specifier.local) ?? "",
          })),
        });
      } else {
        for (const specifier of specifiers) {
          const exported = nameOfNode(specifier.exported) ?? "";
          const local = nameOfNode(specifier.local) ?? "";
          const binding = bindingFromLocal(exported, local);
          if (binding) exports.set(exported, binding);
        }
      }
    } else if (statement.type === "ExportAllDeclaration") {
      const source = (statement.source as { value?: string } | undefined)?.value;
      if (!source) continue;
      noteImport(source);
      const exported = statement.exported as { name?: string; value?: string } | null;
      reexports.push(
        exported
          ? { source, kind: "namespace", names: [], namespace: exported.name ?? exported.value }
          : { source, kind: "all", names: [] },
      );
    } else if (statement.type === "ExportDefaultDeclaration") {
      const declaration = statement.declaration as AstNode | undefined;
      if (!declaration) continue;
      const declaredName = declaration.id ? identName(declaration.id) : undefined;
      if (declaredName && locals.has(declaredName)) {
        const binding = bindingFromLocal("default", declaredName);
        if (binding) exports.set("default", binding);
      } else {
        exports.set("default", bindingFromExpression("default", declaration));
      }
    }
  }

  // CommonJS: assignments anywhere (they are often inside a UMD wrapper).
  const assignments: AstNode[] = [];
  walk(program, (node) => {
    if (node.type === "AssignmentExpression") assignments.push(node);
    if (node.type === "CallExpression") {
      const callee = node.callee as AstNode | undefined;
      const calleeName =
        identName(callee) ??
        (callee?.type === "MemberExpression"
          ? propertyName(callee.property, callee.computed === true)
          : undefined);
      const args = (node.arguments as AstNode[] | undefined) ?? [];
      if (
        (calleeName === "__exportStar" || calleeName === "__export") &&
        args[0] &&
        requireSpecifier(args[0])
      ) {
        const source = requireSpecifier(args[0]);
        if (source) {
          noteImport(source);
          reexports.push({ source, kind: "all", names: [] });
        }
      }
      if (
        callee?.type === "MemberExpression" &&
        identName(callee.object) === "Object" &&
        propertyName(callee.property, false) === "defineProperty" &&
        args.length >= 3 &&
        (identName(args[0]) === "exports" || isModuleExports(args[0])) &&
        args[1]?.type === "Literal" &&
        typeof args[1].value === "string"
      ) {
        const name = args[1].value;
        const descriptor = args[2];
        if (name !== "__esModule" && descriptor?.type === "ObjectExpression") {
          const getter = (descriptor.properties as AstNode[]).find(
            (property) => propertyName(property.key, property.computed === true) === "get",
          );
          const value = (descriptor.properties as AstNode[]).find(
            (property) => propertyName(property.key, property.computed === true) === "value",
          );
          const source = (getter?.value ?? value?.value) as AstNode | undefined;
          if (source) {
            const form = canonicalForm(source, placeholder);
            exports.set(name, {
              name,
              kind: "value",
              fingerprint: form.fingerprint,
              refs: identifierNames(source),
              tokens: form.tokens,
              nodeCount: form.nodeCount,
            });
          }
        }
      }
    }
  });
  for (const assignment of assignments) {
    if (isModuleExports(assignment.left)) handleAssignment(assignment);
  }
  for (const assignment of assignments) {
    if (!isModuleExports(assignment.left)) handleAssignment(assignment);
  }

  if (moduleExportsRequire) {
    reexports.push({
      source: moduleExportsRequire,
      kind: "all",
      names: [],
      includeDefault: true,
    });
  }

  let discovery: ModuleInfo["discovery"] =
    exports.size > 0 || reexports.length > 0 ? "declared" : "none";
  if (discovery === "none") {
    // UMD bundles such as lodash export a namespace function built up with `ns.name = fn`.
    const counts = new Map<string, number>();
    for (const assignment of assignments) {
      const left = assignment.left as AstNode | undefined;
      if (left?.type !== "MemberExpression" || left.computed === true) continue;
      const object = identName(left.object);
      if (object) counts.set(object, (counts.get(object) ?? 0) + 1);
    }
    const [best] = [...counts].toSorted((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
    if (best && best[1] >= 8) {
      for (const assignment of assignments) {
        const left = assignment.left as AstNode | undefined;
        if (left?.type !== "MemberExpression" || left.computed === true) continue;
        if (identName(left.object) !== best[0]) continue;
        const name = propertyName(left.property, false);
        const right = assignment.right as AstNode | undefined;
        if (name !== undefined && right) exports.set(name, bindingFromExpression(name, right));
      }
      if (exports.size > 0) discovery = "namespace-assignments";
    }
  }

  return {
    path,
    fingerprint: canonicalForm(program).fingerprint,
    locals,
    exports,
    reexports,
    relativeImports: [...relativeImports].toSorted(),
    discovery,
  };
}
