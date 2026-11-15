/**
 * Which parts of a package the project's own source uses, with file and line.
 *
 * Follows the project's bindings: `import { a } from "pkg"`, `import x from "pkg"` then `x.b()`,
 * `const { c } = require("pkg")`, `require("pkg").d`. A use is recorded per export name.
 * What cannot be followed (the module object passed along, computed member access) is recorded as
 * opaque, so a caller can tell "does not use X" from "uses the package in ways we cannot see".
 * Class instance members cannot be resolved without types; they are matched by member name only and
 * labelled `name-match`.
 */
import { readFileSync, statSync } from "node:fs";
import { relative } from "node:path";

import { walkSourceFiles } from "../reachability/check-reachability.js";
import { lineOf, lineStarts, parseSource, propertyName, walk, type AstNode } from "./ast.js";
import type { CallSite, CallSiteKind } from "./types.js";

export interface UsageIndex {
  packageName: string;
  filesScanned: number;
  filesUsingPackage: number;
  /** Specifiers the project imports: `pkg`, `pkg/sub`. */
  specifiers: Set<string>;
  /** specifier -> export name (`default` for the module object itself) -> sites. */
  exportUses: Map<string, Map<string, CallSite[]>>;
  /** specifier -> exported class or namespace name -> member name -> sites (static members). */
  staticMemberUses: Map<string, Map<string, Map<string, CallSite[]>>>;
  /** specifier -> sites where the module object is used in a way that cannot be followed. */
  opaque: Map<string, CallSite[]>;
  /** specifier -> every `require()` and dynamic `import()` of it. */
  requireSites: Map<string, CallSite[]>;
  /** specifier -> every static `import` / `export from` of it. */
  importSites: Map<string, CallSite[]>;
  /** `.name` accesses in files that use the package, for matching class members by name only. */
  memberNameUses: Map<string, CallSite[]>;
}

const MAX_FILES = 20_000;
const MAX_FILE_BYTES = 1024 * 1024;
const MAX_SITES_PER_KEY = 200;

interface Binding {
  specifier: string;
  mode: "named" | "object";
  /** Export name for a named binding. */
  name?: string;
}

function push<K, V>(map: Map<K, V[]>, key: K, value: V): void {
  const list = map.get(key);
  if (!list) map.set(key, [value]);
  else if (list.length < MAX_SITES_PER_KEY) list.push(value);
}

function nested<V>(
  map: Map<string, Map<string, V[]>>,
  outer: string,
  inner: string,
  value: V,
): void {
  let innerMap = map.get(outer);
  if (!innerMap) {
    innerMap = new Map();
    map.set(outer, innerMap);
  }
  push(innerMap, inner, value);
}

/** Map an import source to `pkg` or `pkg/sub`, or undefined when it is another package. */
export function specifierOfSource(source: string, packageName: string): string | undefined {
  if (source === packageName) return packageName;
  if (!source.startsWith(`${packageName}/`)) return undefined;
  const rest = source
    .slice(packageName.length + 1)
    .replace(/\.[cm]?js$/, "")
    .replace(/\/index$/, "");
  return rest === "" ? packageName : `${packageName}/${rest}`;
}

function literalString(node: unknown): string | undefined {
  const candidate = node as AstNode | undefined;
  return candidate?.type === "Literal" && typeof candidate.value === "string"
    ? candidate.value
    : undefined;
}

/** The module specifier of `require("x")` / `import("x")`, if the node is one. */
function loadSpecifier(node: AstNode): string | undefined {
  if (node.type === "ImportExpression") return literalString(node.source);
  if (node.type !== "CallExpression") return undefined;
  const callee = node.callee as AstNode | undefined;
  if (callee?.type !== "Identifier" || callee.name !== "require") return undefined;
  return literalString((node.arguments as unknown[] | undefined)?.[0]);
}

const TRANSPARENT = new Set([
  "AwaitExpression",
  "ChainExpression",
  "TSAsExpression",
  "TSNonNullExpression",
  "TSSatisfiesExpression",
]);

export function buildUsageIndex(cwd: string, packageName: string): UsageIndex {
  const index: UsageIndex = {
    packageName,
    filesScanned: 0,
    filesUsingPackage: 0,
    specifiers: new Set(),
    exportUses: new Map(),
    staticMemberUses: new Map(),
    opaque: new Map(),
    requireSites: new Map(),
    importSites: new Map(),
    memberNameUses: new Map(),
  };

  for (const path of walkSourceFiles(cwd)) {
    if (index.filesScanned >= MAX_FILES) break;
    if (/\.d\.[cm]?ts$/.test(path)) continue;
    let code: string;
    try {
      if (statSync(path).size > MAX_FILE_BYTES) continue;
      code = readFileSync(path, "utf8");
    } catch {
      continue;
    }
    index.filesScanned++;
    if (!code.includes(packageName)) continue;
    scanFile(index, relative(cwd, path), code);
  }
  return index;
}

function argCountOf(call: AstNode): number | undefined {
  const args = (call.arguments as AstNode[] | undefined) ?? [];
  return args.some((argument) => argument.type === "SpreadElement") ? undefined : args.length;
}

function scanFile(index: UsageIndex, file: string, code: string): void {
  const program = parseSource(file, code);
  if (!program) return;
  const starts = lineStarts(code);
  const lines = code.split("\n");
  const packageName = index.packageName;

  const site = (node: AstNode, kind: CallSiteKind, extra: Partial<CallSite> = {}): CallSite => {
    const line = lineOf(starts, node.start);
    return {
      file,
      line,
      kind,
      text: (lines[line - 1] ?? "").trim().slice(0, 160),
      confidence: "exact",
      ...extra,
    };
  };
  const dedupe = new Set<string>();
  const once = (key: string): boolean => {
    if (dedupe.has(key)) return false;
    dedupe.add(key);
    return true;
  };

  const bindings = new Map<string, Binding>();
  let usesPackage = false;
  const useExport = (specifier: string, name: string, entry: CallSite): void => {
    if (!once(`${specifier}|${name}|${entry.line}|${entry.kind}`)) return;
    nested(index.exportUses, specifier, name, entry);
  };
  const markOpaque = (specifier: string, entry: CallSite): void => {
    if (once(`o|${specifier}|${entry.line}`)) push(index.opaque, specifier, entry);
  };
  const sourceSpecifier = (value: unknown): string | undefined =>
    typeof value === "string" ? specifierOfSource(value, packageName) : undefined;

  // Pass 1: where the package comes in, and the local names it is bound to.
  walk(program, (node, _parent, ancestors) => {
    if (node.type === "ImportDeclaration") {
      const specifier = sourceSpecifier((node.source as { value?: unknown } | undefined)?.value);
      if (!specifier) return true;
      usesPackage = true;
      index.specifiers.add(specifier);
      push(index.importSites, specifier, site(node, "import"));
      for (const item of (node.specifiers as AstNode[] | undefined) ?? []) {
        const local = (item.local as { name?: string } | undefined)?.name;
        if (!local) continue;
        if (item.type === "ImportSpecifier") {
          const imported = item.imported as { name?: string; value?: string } | undefined;
          const name = imported?.name ?? imported?.value ?? local;
          if (name === "default") {
            bindings.set(local, { specifier, mode: "object" });
          } else {
            bindings.set(local, { specifier, mode: "named", name });
            useExport(specifier, name, site(item, "import"));
          }
        } else {
          bindings.set(local, { specifier, mode: "object" });
        }
      }
      return false;
    }
    if (node.type === "ExportNamedDeclaration" || node.type === "ExportAllDeclaration") {
      const specifier = sourceSpecifier(
        (node.source as { value?: unknown } | null | undefined)?.value,
      );
      if (!specifier) return true;
      usesPackage = true;
      index.specifiers.add(specifier);
      push(index.importSites, specifier, site(node, "reexport"));
      if (node.type === "ExportAllDeclaration") {
        markOpaque(specifier, site(node, "reexport"));
      } else {
        for (const item of (node.specifiers as AstNode[] | undefined) ?? []) {
          const local = item.local as { name?: string; value?: string } | undefined;
          const name = local?.name ?? local?.value;
          if (name) useExport(specifier, name, site(item, "reexport"));
        }
      }
      return false;
    }

    const specifier = (() => {
      const loaded = loadSpecifier(node);
      return loaded === undefined ? undefined : specifierOfSource(loaded, packageName);
    })();
    if (specifier === undefined) return true;
    usesPackage = true;
    index.specifiers.add(specifier);
    const loadSite = site(node, node.type === "ImportExpression" ? "dynamic-import" : "require");
    push(index.requireSites, specifier, loadSite);

    // Climb through `await`, `as` and optional chains to where the value goes.
    let value: AstNode = node;
    let parentIndex = ancestors.length - 1;
    for (
      let current = ancestors[parentIndex];
      current && TRANSPARENT.has(current.type);
      current = ancestors[parentIndex]
    ) {
      value = current;
      parentIndex--;
    }
    const valueParent = ancestors[parentIndex];
    const container = ancestors[parentIndex - 1];
    if (!valueParent) return true;

    if (valueParent.type === "VariableDeclarator" && valueParent.init === value) {
      const id = valueParent.id as AstNode | undefined;
      if (id?.type === "Identifier") {
        bindings.set(String(id.name), { specifier, mode: "object" });
        return true;
      }
      if (id?.type === "ObjectPattern") {
        for (const property of (id.properties as AstNode[] | undefined) ?? []) {
          if (property.type !== "Property") {
            markOpaque(specifier, loadSite);
            continue;
          }
          const name = propertyName(property.key, property.computed === true);
          const target = property.value as AstNode | undefined;
          const local =
            target?.type === "Identifier"
              ? String(target.name)
              : target?.type === "AssignmentPattern" &&
                  (target.left as AstNode | undefined)?.type === "Identifier"
                ? String((target.left as AstNode).name)
                : undefined;
          if (name === undefined) {
            markOpaque(specifier, loadSite);
            continue;
          }
          useExport(specifier, name, site(property, "reference"));
          if (local) bindings.set(local, { specifier, mode: "named", name });
        }
        return true;
      }
      markOpaque(specifier, loadSite);
      return true;
    }
    if (valueParent.type === "MemberExpression" && valueParent.object === value) {
      const name = propertyName(valueParent.property, valueParent.computed === true);
      if (name === undefined || (node.type === "ImportExpression" && name === "then")) {
        markOpaque(specifier, loadSite);
        return true;
      }
      // `const x = require("p").x`: x is a named binding.
      if (
        container?.type === "VariableDeclarator" &&
        container.init === valueParent &&
        (container.id as AstNode | undefined)?.type === "Identifier"
      ) {
        bindings.set(String((container.id as AstNode).name), { specifier, mode: "named", name });
      }
      if (container?.type === "CallExpression" && container.callee === valueParent) {
        useExport(specifier, name, site(valueParent, "call", { argCount: argCountOf(container) }));
      } else {
        useExport(specifier, name, site(valueParent, "member"));
      }
      return true;
    }
    if (valueParent.type === "CallExpression" && valueParent.callee === value) {
      useExport(
        specifier,
        "default",
        site(valueParent, "call", { argCount: argCountOf(valueParent) }),
      );
      return true;
    }
    if (valueParent.type === "ExpressionStatement") return true;
    if (
      valueParent.type === "AssignmentExpression" &&
      valueParent.right === value &&
      (valueParent.left as AstNode | undefined)?.type === "Identifier"
    ) {
      bindings.set(String((valueParent.left as AstNode).name), { specifier, mode: "object" });
      return true;
    }
    markOpaque(specifier, loadSite);
    return true;
  });

  if (!usesPackage) return;
  index.filesUsingPackage++;

  // Pass 2: uses of the bound names, and `.member` names for class members.
  walk(program, (node, parent, ancestors) => {
    if (node.type === "ImportDeclaration") return false;
    if (node.type === "MemberExpression" && node.computed !== true) {
      const name = propertyName(node.property, false);
      const objectName =
        (node.object as AstNode | undefined)?.type === "Identifier"
          ? String((node.object as AstNode).name)
          : undefined;
      const bound = objectName ? bindings.get(objectName) : undefined;
      if (name !== undefined && bound?.mode !== "object") {
        const entry = site(node, "member", { confidence: "name-match" });
        if (once(`m|${name}|${entry.line}`)) push(index.memberNameUses, name, entry);
      }
    }
    if (node.type !== "Identifier") return true;
    const local = String(node.name);
    const binding = bindings.get(local);
    if (!binding || !parent) return true;

    // Declarations and property names are not uses.
    if (parent.type === "VariableDeclarator" && parent.id === node) return true;
    if (parent.type === "MemberExpression" && parent.property === node && parent.computed !== true)
      return true;
    if (
      (parent.type === "Property" ||
        parent.type === "MethodDefinition" ||
        parent.type === "PropertyDefinition" ||
        parent.type === "TSPropertySignature") &&
      parent.key === node &&
      parent.computed !== true
    ) {
      return true;
    }
    if (
      (parent.type === "FunctionDeclaration" || parent.type === "ClassDeclaration") &&
      parent.id === node
    )
      return true;
    if (
      parent.type === "ImportSpecifier" ||
      parent.type === "ImportDefaultSpecifier" ||
      parent.type === "ImportNamespaceSpecifier"
    )
      return true;

    const grand = ancestors.at(-2);
    const exportName = binding.mode === "named" ? (binding.name ?? "default") : "default";
    const record = (kind: CallSiteKind, extra: Partial<CallSite> = {}): void => {
      useExport(binding.specifier, exportName, site(node, kind, extra));
    };

    if (parent.type === "MemberExpression" && parent.object === node) {
      const member =
        parent.computed === true
          ? literalString(parent.property)
          : propertyName(parent.property, false);
      if (member === undefined) {
        if (binding.mode === "object") markOpaque(binding.specifier, site(node, "reference"));
        else record("reference");
        return true;
      }
      const isCall = grand?.type === "CallExpression" && grand.callee === parent;
      const isNew = grand?.type === "NewExpression" && grand.callee === parent;
      const kind: CallSiteKind = isCall ? "call" : isNew ? "new" : "member";
      const extra = isCall && grand ? { argCount: argCountOf(grand) } : {};
      if (binding.mode === "object") {
        useExport(binding.specifier, member, site(parent, kind, extra));
      } else {
        record("reference");
        let byExport = index.staticMemberUses.get(binding.specifier);
        if (!byExport) {
          byExport = new Map();
          index.staticMemberUses.set(binding.specifier, byExport);
        }
        let byMember = byExport.get(exportName);
        if (!byMember) {
          byMember = new Map();
          byExport.set(exportName, byMember);
        }
        push(byMember, member, site(parent, kind, extra));
      }
      return true;
    }
    if (parent.type === "CallExpression" && parent.callee === node) {
      record("call", { argCount: argCountOf(parent) });
      return true;
    }
    if (parent.type === "NewExpression" && parent.callee === node) {
      record("new", { argCount: argCountOf(parent) });
      return true;
    }
    if (parent.type === "TSTypeReference" && parent.typeName === node) {
      record("type-reference");
      return true;
    }
    if (parent.type === "TSQualifiedName" && parent.left === node && binding.mode === "object") {
      const right = (parent.right as { name?: string } | undefined)?.name;
      if (right) useExport(binding.specifier, right, site(parent, "type-reference"));
      return true;
    }
    if (binding.mode === "object") markOpaque(binding.specifier, site(node, "reference"));
    else record("reference");
    return true;
  });
}

/** Sites using an export of a specifier; `default` and `module.exports` are the same thing. */
export function sitesForExport(
  index: UsageIndex,
  specifier: string,
  exportName: string,
): CallSite[] {
  const byName = index.exportUses.get(specifier);
  if (!byName) return [];
  const names =
    exportName === "default" || exportName === "module.exports" ? ["default"] : [exportName];
  return names.flatMap((name) => byName.get(name) ?? []);
}

export function sitesForStaticMember(
  index: UsageIndex,
  specifier: string,
  exportName: string,
  member: string,
): CallSite[] {
  return index.staticMemberUses.get(specifier)?.get(exportName)?.get(member) ?? [];
}

export function isUsed(index: UsageIndex, specifier: string): boolean {
  return index.specifiers.has(specifier);
}
