/**
 * Call counting for native ES modules.
 *
 * An ES module's exports are live bindings that nothing outside the module can replace, so the only
 * way to count calls is to rewrite the binding from inside. After the module has evaluated, this
 * appends `name = wrap(name)` for each exported function or class declaration, so every importer
 * (and the module's own internal callers) get the counting wrapper. The original source is left
 * as is, so line numbers and source maps are unchanged.
 *
 * Bindings that cannot be reassigned (`const`, anonymous default exports, imported bindings) are
 * reported as not counted instead of being rewritten.
 */
import { createRequire } from "node:module";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/** Which exports of a module are visible through a re-export from an entry, and under what names. */
export interface ReexportSelection {
  /** `export * from`: every export is visible. */
  all: boolean;
  /** Exported name in the target to the names other modules re-export it as. */
  names: Map<string, Set<string>>;
}

export interface InstrumentResult {
  /** The source with counting appended, or undefined when nothing could be counted. */
  source?: string;
  wrapped: string[];
  unwrapped: Record<string, string>;
  /** Relative modules this one re-exports from, which are instrumented in turn. */
  reexports: Map<string, ReexportSelection>;
}

interface NameNode {
  kind: string;
  name: string | null;
}
interface ExportEntry {
  moduleRequest: { value: string } | null;
  importName: NameNode;
  exportName: NameNode;
  localName: NameNode;
}
interface AstNode {
  type: string;
  [key: string]: unknown;
}
interface ParsedModule {
  program: { body: AstNode[] };
  module: { staticExports: { entries: ExportEntry[] }[] };
  errors: unknown[];
}

type ParseFn = (filename: string, source: string) => ParsedModule;
let parseSync: ParseFn | undefined;

/** oxc-parser loads on first use, so processes that never instrument an ES module do not pay for it. */
function parse(filename: string, source: string): ParsedModule {
  parseSync ??= (createRequire(import.meta.url)("oxc-parser") as { parseSync: ParseFn }).parseSync;
  return parseSync(filename, source);
}

type LocalKind = "function" | "class" | "let" | "var" | "const";

/** Top-level declarations by local name, which tells a reassignable binding from a `const`. */
function topLevelDeclarations(body: AstNode[]): Map<string, LocalKind> {
  const locals = new Map<string, LocalKind>();
  const declare = (node: AstNode | undefined): void => {
    if (!node) return;
    if (node.type === "FunctionDeclaration" || node.type === "ClassDeclaration") {
      const id = node.id as { name?: string } | null;
      if (id?.name) locals.set(id.name, node.type === "FunctionDeclaration" ? "function" : "class");
    } else if (node.type === "VariableDeclaration") {
      const kind = node.kind as string;
      const declarations = node.declarations as { id: { type: string; name?: string } }[];
      for (const declarator of declarations) {
        // Destructuring patterns are not tracked: their bindings fall through as unknown locals.
        if (declarator.id.type === "Identifier" && declarator.id.name) {
          locals.set(
            declarator.id.name,
            kind === "const" || kind === "using" ? "const" : (kind as LocalKind),
          );
        }
      }
    }
  };
  for (const node of body) {
    if (node.type === "ExportNamedDeclaration" || node.type === "ExportDefaultDeclaration") {
      declare(node.declaration as AstNode | undefined);
    } else {
      declare(node);
    }
  }
  return locals;
}

function select(
  reexports: Map<string, ReexportSelection>,
  target: string,
  importName: string | undefined,
  alias: string | undefined,
): void {
  const selection = reexports.get(target) ?? { all: false, names: new Map() };
  if (importName === undefined) {
    selection.all = true;
  } else {
    const aliases = selection.names.get(importName) ?? new Set<string>();
    if (alias !== undefined) aliases.add(alias);
    selection.names.set(importName, aliases);
  }
  reexports.set(target, selection);
}

/**
 * Work out what to count in one ES module.
 *
 * `visible` limits counting to the exports an importer can reach: undefined for an entry module
 * (every export), or the selection a re-exporting module made for a module reached through one.
 * `globalKey` names the runtime registry the appended code calls (`wrap(fn, names, packageKey)`).
 */
export function instrumentEsModule(
  filename: string,
  source: string,
  visible: ReexportSelection | undefined,
  registry: string,
  packageKey: string,
): InstrumentResult {
  const result: InstrumentResult = { wrapped: [], unwrapped: {}, reexports: new Map() };
  const parsed = parse(filename, source);
  if (parsed.errors.length > 0) {
    result.unwrapped["*"] = "source-could-not-be-parsed";
    return result;
  }
  const locals = topLevelDeclarations(parsed.program.body);
  const statements: string[] = [];

  const wanted = (exportName: string): string[] | undefined => {
    if (!visible) return [exportName];
    const aliases = visible.names.get(exportName);
    if (aliases) return [exportName, ...aliases];
    return visible.all ? [exportName] : undefined;
  };

  for (const statement of parsed.module.staticExports) {
    for (const entry of statement.entries) {
      const exportName = entry.exportName.kind === "Default" ? "default" : entry.exportName.name;
      if (entry.moduleRequest) {
        const specifier = entry.moduleRequest.value;
        if (specifier.startsWith(".") || specifier.startsWith("/")) {
          const target = resolve(dirname(filename), specifier);
          if (entry.importName.kind === "AllButDefault") {
            select(result.reexports, target, undefined, undefined);
          } else if (entry.importName.kind === "Name" && entry.importName.name) {
            // `export { a as b } from "./x.js"`: counted in x.js under both names.
            const exported = exportName ?? entry.importName.name;
            select(result.reexports, target, entry.importName.name, exported);
          } else if (entry.importName.kind === "All" && exportName) {
            result.unwrapped[exportName] = "namespace-reexport";
          }
        } else if (exportName) {
          result.unwrapped[exportName] = "reexport-of-another-package";
        }
        continue;
      }
      if (!exportName) continue;
      const names = wanted(exportName);
      if (!names) continue;
      const local = entry.localName.name;
      const kind = local ? locals.get(local) : undefined;
      if (!local || entry.localName.kind !== "Name") {
        result.unwrapped[exportName] = "anonymous-or-expression-export";
      } else if (kind === "const") {
        result.unwrapped[exportName] = "const-binding";
      } else if (kind === undefined) {
        result.unwrapped[exportName] = "binding-is-not-a-top-level-declaration";
      } else {
        statements.push(
          `try{${local}=r.wrap(${local},${JSON.stringify(names)},${JSON.stringify(packageKey)})}catch{}`,
        );
        result.wrapped.push(...names);
      }
    }
  }

  if (statements.length > 0) {
    result.source = `${source}\n;{const r=globalThis[Symbol.for(${JSON.stringify(registry)})];if(r){${statements.join(";")}}}\n`;
  }
  return result;
}

/** The file a `file:` URL names, or undefined for other schemes. */
export function filePathOf(url: string): string | undefined {
  if (!url.startsWith("file:")) return undefined;
  try {
    return fileURLToPath(url);
  } catch {
    return undefined;
  }
}
