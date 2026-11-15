/**
 * Public API surface of a package version: what it exports and with what shape.
 *
 * Read from declaration files (`.d.ts`) with oxc-parser when the package ships them, and from the
 * JavaScript export analysis otherwise (names, kinds, parameter counts and class members only; no
 * types). Signatures are kept as source text so a comparison can say what changed, not just that
 * something did.
 */
import { isNode, nameOfNode, parseSource, propertyName, type AstNode } from "./ast.js";
import type { PackageIndex } from "./package-index.js";
import type { ParamInfo } from "./types.js";

export interface Signature {
  params: ParamInfo[];
  returns?: string;
  typeParams?: string;
  /** `<T>(a: string, b?: number) => R`, normalised. */
  text: string;
}

export type MemberKind = "method" | "property" | "constructor" | "getter" | "setter" | "call" | "construct" | "index";

export interface ApiMember {
  /** Unique within the container: `name`, `static name`, `[call]`, `[new]`, `[index]`. */
  key: string;
  name: string;
  static: boolean;
  kind: MemberKind;
  optional: boolean;
  readonly: boolean;
  signatures: Signature[];
  /** Property type as source text. */
  type?: string;
}

export type SymbolKind =
  | "function"
  | "class"
  | "interface"
  | "type"
  | "enum"
  | "variable"
  | "namespace"
  | "module"
  | "value";

export interface ApiSymbol {
  name: string;
  kind: SymbolKind;
  signatures: Signature[];
  members: Map<string, ApiMember>;
  /** Type alias body, variable type or enum initialisers, as source text. */
  type?: string;
  /** `extends` clause as source text. */
  extends?: string;
  /** Types a variable is declared as, by name (`Chalk`, `ns.Options`), resolved into `members`. */
  typeRefs?: string[];
  /** Declarations nested in a namespace, by name. */
  nested?: Map<string, ApiSymbol>;
}

export interface ApiSurface {
  source: "types" | "js";
  entryFile?: string;
  symbols: Map<string, ApiSymbol>;
  notes: string[];
}

function squash(text: string): string {
  return text.replaceAll(/\/\*[\s\S]*?\*\//g, "").replaceAll(/\s+/g, " ").replaceAll(/\s*([,;])\s*/g, "$1 ").trim();
}

function slice(code: string, node: AstNode | null | undefined): string | undefined {
  return node ? squash(code.slice(node.start, node.end)) : undefined;
}

function annotationText(code: string, annotation: unknown): string | undefined {
  if (!isNode(annotation)) return undefined;
  const inner = annotation.typeAnnotation;
  return isNode(inner) ? slice(code, inner) : slice(code, annotation);
}

function paramOf(code: string, raw: AstNode, index: number): ParamInfo {
  if (raw.type === "RestElement") {
    const argument = raw.argument as AstNode | undefined;
    return {
      name: argument?.type === "Identifier" ? String(argument.name) : `arg${index}`,
      optional: true,
      rest: true,
      type: annotationText(code, raw.typeAnnotation),
    };
  }
  if (raw.type === "Identifier") {
    return {
      name: String(raw.name),
      optional: raw.optional === true,
      rest: false,
      type: annotationText(code, raw.typeAnnotation),
    };
  }
  if (raw.type === "AssignmentPattern") {
    const left = raw.left as AstNode | undefined;
    return { name: left?.type === "Identifier" ? String(left.name) : `arg${index}`, optional: true, rest: false };
  }
  return { name: `arg${index}`, optional: raw.optional === true, rest: false, type: annotationText(code, raw.typeAnnotation) };
}

function signatureOf(code: string, fn: AstNode): Signature {
  const params = ((fn.params as unknown[] | undefined) ?? [])
    .filter((param): param is AstNode => isNode(param))
    .filter((param) => !(param.type === "Identifier" && param.name === "this"))
    .map((param, index) => paramOf(code, param, index));
  const returns = annotationText(code, fn.returnType);
  const typeParams = slice(code, fn.typeParameters as AstNode | undefined);
  const paramText = params
    .map((param) => `${param.rest ? "..." : ""}${param.name}${param.optional && !param.rest ? "?" : ""}${param.type ? `: ${param.type}` : ""}`)
    .join(", ");
  return {
    params,
    returns,
    typeParams,
    text: `${typeParams ?? ""}(${paramText}) => ${returns ?? "unknown"}`,
  };
}

function addMember(symbol: ApiSymbol, member: ApiMember): void {
  const existing = symbol.members.get(member.key);
  if (existing) {
    existing.signatures.push(...member.signatures);
    existing.optional = existing.optional && member.optional;
    existing.type ??= member.type;
  } else {
    symbol.members.set(member.key, member);
  }
}

function memberKey(name: string, isStatic: boolean): string {
  return isStatic ? `static ${name}` : name;
}

function readMembers(code: string, symbol: ApiSymbol, body: unknown[]): void {
  for (const raw of body) {
    if (!isNode(raw)) continue;
    const accessibility = raw.accessibility as string | null | undefined;
    if (accessibility === "private") continue;
    switch (raw.type) {
      case "PropertyDefinition":
      case "TSAbstractPropertyDefinition":
      case "TSPropertySignature": {
        const key = raw.key as AstNode | undefined;
        if (key?.type === "PrivateIdentifier") break;
        const name = propertyName(key, raw.computed === true);
        if (name === undefined) break;
        const isStatic = raw.static === true;
        addMember(symbol, {
          key: memberKey(name, isStatic),
          name,
          static: isStatic,
          kind: "property",
          optional: raw.optional === true,
          readonly: raw.readonly === true,
          signatures: [],
          type: annotationText(code, raw.typeAnnotation) ?? "unknown",
        });
        break;
      }
      case "MethodDefinition":
      case "TSAbstractMethodDefinition": {
        const key = raw.key as AstNode | undefined;
        if (key?.type === "PrivateIdentifier") break;
        const name = propertyName(key, raw.computed === true);
        const value = raw.value as AstNode | undefined;
        if (name === undefined || !value) break;
        const isStatic = raw.static === true;
        const methodKind = raw.kind as string;
        const kind: MemberKind =
          methodKind === "constructor" ? "constructor" : methodKind === "get" ? "getter" : methodKind === "set" ? "setter" : "method";
        addMember(symbol, {
          key: kind === "constructor" ? "[new]" : memberKey(kind === "getter" || kind === "setter" ? `${kind === "getter" ? "get" : "set"} ${name}` : name, isStatic),
          name: kind === "constructor" ? "constructor" : name,
          static: isStatic,
          kind,
          optional: raw.optional === true,
          readonly: false,
          signatures: [signatureOf(code, value)],
        });
        break;
      }
      case "TSMethodSignature": {
        const name = propertyName(raw.key, raw.computed === true);
        if (name === undefined) break;
        addMember(symbol, {
          key: name,
          name,
          static: false,
          kind: "method",
          optional: raw.optional === true,
          readonly: false,
          signatures: [signatureOf(code, raw)],
        });
        break;
      }
      case "TSCallSignatureDeclaration": {
        addMember(symbol, { key: "[call]", name: "[call]", static: false, kind: "call", optional: false, readonly: false, signatures: [signatureOf(code, raw)] });
        break;
      }
      case "TSConstructSignatureDeclaration": {
        addMember(symbol, { key: "[new]", name: "[new]", static: false, kind: "construct", optional: false, readonly: false, signatures: [signatureOf(code, raw)] });
        break;
      }
      case "TSIndexSignature": {
        addMember(symbol, {
          key: "[index]",
          name: "[index]",
          static: raw.static === true,
          kind: "index",
          optional: false,
          readonly: raw.readonly === true,
          signatures: [],
          type: `${((raw.parameters as AstNode[] | undefined) ?? []).map((param) => annotationText(code, param.typeAnnotation) ?? "").join(", ")} -> ${annotationText(code, raw.typeAnnotation) ?? "unknown"}`,
        });
        break;
      }
      default: {
        break;
      }
    }
  }
}

function blankSymbol(name: string, kind: SymbolKind): ApiSymbol {
  return { name, kind, signatures: [], members: new Map() };
}

function mergeInto(target: ApiSymbol, incoming: ApiSymbol): void {
  // Declaration merging: a function with a namespace, a class with an interface.
  const priority: SymbolKind[] = ["class", "function", "enum", "variable", "interface", "type", "namespace", "module", "value"];
  if (priority.indexOf(incoming.kind) < priority.indexOf(target.kind)) target.kind = incoming.kind;
  target.signatures.push(...incoming.signatures);
  for (const member of incoming.members.values()) addMember(target, { ...member, signatures: [...member.signatures] });
  target.type ??= incoming.type;
  target.extends ??= incoming.extends;
  if (incoming.typeRefs) target.typeRefs = [...(target.typeRefs ?? []), ...incoming.typeRefs];
  if (incoming.nested) {
    target.nested ??= new Map();
    for (const [name, symbol] of incoming.nested) {
      const known = target.nested.get(name);
      if (known) mergeInto(known, symbol);
      else target.nested.set(name, symbol);
    }
  }
}

/** Named types and inline object members a declared type is made of (`A & B & { c(): void }`). */
function collectTypeShape(code: string, symbol: ApiSymbol, type: AstNode): void {
  if (type.type === "TSIntersectionType") {
    for (const part of (type.types as AstNode[] | undefined) ?? []) collectTypeShape(code, symbol, part);
  } else if (type.type === "TSTypeReference") {
    const name = typeName(type.typeName as AstNode | undefined);
    if (name) symbol.typeRefs = [...(symbol.typeRefs ?? []), name];
  } else if (type.type === "TSTypeLiteral") {
    readMembers(code, symbol, (type.members as unknown[] | undefined) ?? []);
  }
}

function typeName(node: AstNode | undefined): string | undefined {
  if (node?.type === "Identifier") return String(node.name);
  if (node?.type === "TSQualifiedName") {
    const left = typeName(node.left as AstNode | undefined);
    const right = (node.right as { name?: string } | undefined)?.name;
    return left && right ? `${left}.${right}` : undefined;
  }
  return undefined;
}

function symbolFromDeclaration(code: string, declaration: AstNode): ApiSymbol[] {
  switch (declaration.type) {
    case "TSDeclareFunction":
    case "FunctionDeclaration": {
      const id = declaration.id as AstNode | undefined;
      if (id?.type !== "Identifier") return [];
      const symbol = blankSymbol(String(id.name), "function");
      symbol.signatures.push(signatureOf(code, declaration));
      return [symbol];
    }
    case "ClassDeclaration":
    case "TSAbstractClassDeclaration": {
      const id = declaration.id as AstNode | undefined;
      if (id?.type !== "Identifier") return [];
      const symbol = blankSymbol(String(id.name), "class");
      symbol.extends = slice(code, declaration.superClass as AstNode | undefined);
      readMembers(code, symbol, ((declaration.body as AstNode | undefined)?.body as unknown[] | undefined) ?? []);
      return [symbol];
    }
    case "TSInterfaceDeclaration": {
      const id = declaration.id as AstNode | undefined;
      if (id?.type !== "Identifier") return [];
      const symbol = blankSymbol(String(id.name), "interface");
      const parents = ((declaration.extends as AstNode[] | undefined) ?? []).map((parent) => slice(code, parent)).filter(Boolean);
      if (parents.length > 0) symbol.extends = parents.join(", ");
      readMembers(code, symbol, ((declaration.body as AstNode | undefined)?.body as unknown[] | undefined) ?? []);
      return [symbol];
    }
    case "TSTypeAliasDeclaration": {
      const id = declaration.id as AstNode | undefined;
      if (id?.type !== "Identifier") return [];
      const symbol = blankSymbol(String(id.name), "type");
      symbol.type = `${slice(code, declaration.typeParameters as AstNode | undefined) ?? ""}${slice(code, declaration.typeAnnotation as AstNode | undefined) ?? "unknown"}`;
      return [symbol];
    }
    case "TSEnumDeclaration": {
      const id = declaration.id as AstNode | undefined;
      if (id?.type !== "Identifier") return [];
      const symbol = blankSymbol(String(id.name), "enum");
      const members = ((declaration.body as AstNode | undefined)?.members as AstNode[] | undefined) ?? (declaration.members as AstNode[] | undefined) ?? [];
      for (const member of members) {
        const name = nameOfNode(member.id);
        if (name === undefined) continue;
        addMember(symbol, {
          key: name,
          name,
          static: false,
          kind: "property",
          optional: false,
          readonly: true,
          signatures: [],
          type: slice(code, member.initializer as AstNode | undefined) ?? "auto",
        });
      }
      return [symbol];
    }
    case "VariableDeclaration": {
      const result: ApiSymbol[] = [];
      for (const declarator of (declaration.declarations as AstNode[] | undefined) ?? []) {
        const id = declarator.id as AstNode | undefined;
        if (id?.type !== "Identifier") continue;
        const symbol = blankSymbol(String(id.name), "variable");
        symbol.type = annotationText(code, id.typeAnnotation) ?? "unknown";
        const annotation = (id.typeAnnotation as AstNode | undefined)?.typeAnnotation as AstNode | undefined;
        if (annotation) collectTypeShape(code, symbol, annotation);
        result.push(symbol);
      }
      return result;
    }
    case "TSModuleDeclaration": {
      const id = declaration.id as AstNode | undefined;
      if (id?.type !== "Identifier") return [];
      const symbol = blankSymbol(String(id.name), "namespace");
      symbol.nested = new Map();
      const body = (declaration.body as AstNode | undefined)?.body as AstNode[] | undefined;
      for (const statement of body ?? []) {
        const inner = statement.type === "ExportNamedDeclaration" ? (statement.declaration as AstNode | undefined) : statement;
        if (!inner) continue;
        for (const nested of symbolFromDeclaration(code, inner)) {
          const known = symbol.nested.get(nested.name);
          if (known) mergeInto(known, nested);
          else symbol.nested.set(nested.name, nested);
          addMember(symbol, {
            key: nested.name,
            name: nested.name,
            static: false,
            kind: nested.kind === "function" ? "method" : "property",
            optional: false,
            readonly: false,
            signatures: nested.signatures,
            type: nested.kind === "function" ? undefined : (nested.type ?? `${nested.kind} with ${nested.members.size} members`),
          });
        }
      }
      return [symbol];
    }
    default: {
      return [];
    }
  }
}

interface DtsFileInfo {
  declared: Map<string, ApiSymbol>;
  exported: Map<string, string>;
  reexports: Array<{ source: string; names?: Array<{ exported: string; imported: string }>; all: boolean; namespace?: string }>;
  exportAssignment?: string;
}

function readDtsFile(path: string, code: string): DtsFileInfo | undefined {
  const program = parseSource(path, code);
  if (!program) return undefined;
  const info: DtsFileInfo = { declared: new Map(), exported: new Map(), reexports: [] };

  const declare = (symbols: ApiSymbol[], exported: boolean): void => {
    for (const symbol of symbols) {
      const existing = info.declared.get(symbol.name);
      if (existing) mergeInto(existing, symbol);
      else info.declared.set(symbol.name, symbol);
      if (exported) info.exported.set(symbol.name, symbol.name);
    }
  };

  for (const statement of (program.body as AstNode[] | undefined) ?? []) {
    switch (statement.type) {
      case "ExportNamedDeclaration": {
        const declaration = statement.declaration as AstNode | null;
        const source = (statement.source as { value?: string } | null)?.value;
        if (declaration) {
          declare(symbolFromDeclaration(code, declaration), true);
        } else if (source) {
          info.reexports.push({
            source,
            all: false,
            names: ((statement.specifiers as AstNode[] | undefined) ?? []).map((specifier) => ({
              exported: nameOfNode(specifier.exported) ?? "",
              imported: nameOfNode(specifier.local) ?? "",
            })),
          });
        } else {
          for (const specifier of (statement.specifiers as AstNode[] | undefined) ?? []) {
            const exported = nameOfNode(specifier.exported) ?? "";
            const local = nameOfNode(specifier.local) ?? "";
            if (exported && local) info.exported.set(exported, local);
          }
        }
        break;
      }
      case "ExportAllDeclaration": {
        const source = (statement.source as { value?: string } | undefined)?.value;
        const exported = statement.exported as { name?: string; value?: string } | null;
        if (source) info.reexports.push({ source, all: !exported, namespace: exported?.name ?? exported?.value });
        break;
      }
      case "ExportDefaultDeclaration": {
        const declaration = statement.declaration as AstNode | undefined;
        if (!declaration) break;
        if (declaration.type === "Identifier") {
          info.exported.set("default", String(declaration.name));
        } else {
          const symbols = symbolFromDeclaration(code, declaration);
          if (symbols[0]) {
            symbols[0].name = "default";
            declare(symbols, true);
          }
        }
        break;
      }
      case "TSExportAssignment": {
        const expression = statement.expression as AstNode | undefined;
        if (expression?.type === "Identifier") info.exportAssignment = String(expression.name);
        break;
      }
      default: {
        declare(symbolFromDeclaration(code, statement), false);
        break;
      }
    }
  }
  for (const symbol of info.declared.values()) expandTypeRefs(info.declared, symbol, 0);
  return info;
}

function lookupType(declared: Map<string, ApiSymbol>, name: string): ApiSymbol | undefined {
  const [head, ...rest] = name.split(".");
  let current = head ? declared.get(head) : undefined;
  for (const part of rest) current = current?.nested?.get(part);
  return current;
}

/** Give a variable the members of the named types it is declared as (and their base interfaces). */
function expandTypeRefs(declared: Map<string, ApiSymbol>, symbol: ApiSymbol, depth: number): void {
  if (depth > 3) return;
  const refs = [...(symbol.typeRefs ?? [])];
  if (symbol.kind === "interface" && symbol.extends) {
    for (const part of symbol.extends.split(",")) {
      const name = /^[A-Za-z_$][\w$.]*/.exec(part.trim())?.[0];
      if (name) refs.push(name);
    }
  }
  for (const ref of refs) {
    const target = lookupType(declared, ref);
    if (!target || target === symbol) continue;
    expandTypeRefs(declared, target, depth + 1);
    for (const member of target.members.values()) {
      if (!symbol.members.has(member.key)) symbol.members.set(member.key, { ...member, signatures: [...member.signatures] });
    }
  }
  symbol.typeRefs = undefined;
}

const MAX_DTS_DEPTH = 12;

/** Public API of a package from its declaration files, starting at `entryFile`. */
export function extractDtsSurface(index: PackageIndex, entryFile: string): ApiSurface {
  const notes: string[] = [];
  const cache = new Map<string, DtsFileInfo | undefined>();
  const load = (path: string): DtsFileInfo | undefined => {
    if (!cache.has(path)) {
      const code = index.source.files.get(path);
      cache.set(path, code === undefined ? undefined : readDtsFile(path, code));
    }
    return cache.get(path);
  };

  const resolveDts = (from: string, specifier: string): string | undefined => {
    if (!specifier.startsWith(".")) return undefined;
    const base = joinPath(from, specifier).replace(/\.(?:[cm]?js|d\.[cm]?ts)$/, "");
    return [`${base}.d.ts`, `${base}.d.mts`, `${base}.d.cts`, `${base}/index.d.ts`].find((candidate) =>
      index.hasFile(candidate),
    );
  };

  const resolveFile = (path: string, depth: number, stack: Set<string>): Map<string, ApiSymbol> => {
    const result = new Map<string, ApiSymbol>();
    const info = load(path);
    if (!info || depth > MAX_DTS_DEPTH || stack.has(path)) return result;
    stack.add(path);

    for (const [exported, local] of info.exported) {
      const symbol = info.declared.get(local);
      if (symbol) result.set(exported, { ...symbol, name: exported, signatures: [...symbol.signatures], members: new Map(symbol.members) });
    }
    for (const reexport of info.reexports) {
      const target = resolveDts(path, reexport.source);
      if (!target) {
        notes.push(`Re-export from "${reexport.source}" in ${path} was not followed (outside the package).`);
        continue;
      }
      const targetExports = resolveFile(target, depth + 1, stack);
      if (reexport.all) {
        for (const [name, symbol] of targetExports) if (name !== "default" && !result.has(name)) result.set(name, symbol);
      } else if (reexport.names) {
        for (const { exported, imported } of reexport.names) {
          const symbol = targetExports.get(imported);
          if (symbol) result.set(exported, { ...symbol, name: exported });
        }
      } else if (reexport.namespace) {
        const namespace = blankSymbol(reexport.namespace, "namespace");
        for (const [name, symbol] of targetExports) {
          addMember(namespace, { key: name, name, static: false, kind: symbol.kind === "function" ? "method" : "property", optional: false, readonly: false, signatures: symbol.signatures, type: symbol.type ?? symbol.kind });
        }
        result.set(reexport.namespace, namespace);
      }
    }
    if (info.exportAssignment) {
      const target = info.declared.get(info.exportAssignment);
      if (target) {
        result.set("default", { ...target, name: "default", signatures: [...target.signatures], members: new Map(target.members) });
        // `export = x` with a merged namespace: the namespace's declarations are the named exports.
        for (const [name, nested] of target.nested ?? []) result.set(name, nested);
      }
    }
    stack.delete(path);
    return result;
  };

  return { source: "types", entryFile, symbols: resolveFile(entryFile, 0, new Set()), notes };
}

function joinPath(from: string, relative: string): string {
  const parts = from.split("/").slice(0, -1);
  for (const segment of relative.split("/")) {
    if (segment === "." || segment === "") continue;
    if (segment === "..") parts.pop();
    else parts.push(segment);
  }
  return parts.join("/");
}

/** Public API of a package from its JavaScript, when no declaration files are available. */
export function extractJsSurface(index: PackageIndex, entryFile: string): ApiSurface {
  const symbols = new Map<string, ApiSymbol>();
  for (const [rawName, binding] of index.exportsOf(entryFile)) {
    // A CommonJS `module.exports = fn` is what an ESM or interop consumer sees as the default.
    const name = rawName === "module.exports" ? "default" : rawName;
    const kind: SymbolKind = binding.kind === "function" ? "function" : binding.kind === "class" ? "class" : binding.kind === "module" ? "module" : "value";
    const symbol = blankSymbol(name, kind);
    if (binding.params) {
      const text = `(${binding.params.map((param) => `${param.rest ? "..." : ""}${param.name}${param.optional && !param.rest ? "?" : ""}`).join(", ")})`;
      symbol.signatures.push({ params: binding.params, text });
    }
    for (const member of binding.members ?? []) {
      addMember(symbol, {
        key: member.kind === "constructor" ? "[new]" : memberKey(member.name, member.static),
        name: member.name,
        static: member.static,
        kind: member.kind === "field" ? "property" : member.kind,
        optional: false,
        readonly: false,
        signatures: member.params ? [{ params: member.params, text: `(${member.params.map((param) => param.name).join(", ")})` }] : [],
      });
    }
    symbols.set(name, symbol);
  }
  return {
    source: "js",
    entryFile,
    symbols,
    notes: ["Declared from JavaScript only: parameter and return types are not visible."],
  };
}
