/**
 * A package version as a set of modules: entry points from `package.json` (`exports`, `main`,
 * `module`, `types`), module resolution inside the package, and the effective exports of a module
 * after following its re-exports.
 */
import { posix } from "node:path";

import { asRecord } from "../../shared/guards.js";
import { analyzeModule, type ExportBinding, type ModuleInfo } from "./js-exports.js";
import type { PackageSource } from "./types.js";

export interface EntryPoint {
  /** `.` or a subpath such as `./sub`. */
  subpath: string;
  /** JavaScript file (package-relative) the subpath resolves to. */
  file?: string;
  /** Declaration file for the subpath. */
  typesFile?: string;
}

export interface ResolvedExport extends ExportBinding {
  definedIn: string;
}

// `require` before `import`: the CommonJS build is usually the implementation, while the ESM entry
// is often a thin wrapper that re-exports it.
const RUNTIME_CONDITIONS = ["node", "require", "default", "import", "module"] as const;
const JS_EXTENSIONS = [".js", ".mjs", ".cjs", ".ts", ".mts", ".cts", ".tsx", ".jsx"];

function cleanTarget(target: string): string {
  return posix.normalize(target.replace(/^\.\//, ""));
}

/** Find the first string leaf reachable through the given condition order. */
function pickLeaf(value: unknown, conditions: readonly string[], depth = 0): string | undefined {
  if (depth > 8) return undefined;
  if (typeof value === "string") return value;
  if (Array.isArray(value)) {
    for (const item of value) {
      const found = pickLeaf(item, conditions, depth + 1);
      if (found) return found;
    }
    return undefined;
  }
  const record = asRecord(value);
  if (!record) return undefined;
  for (const condition of conditions) {
    if (condition in record) {
      const found = pickLeaf(record[condition], conditions, depth + 1);
      if (found) return found;
    }
  }
  return undefined;
}

function isSubpathMap(exportsField: Record<string, unknown>): boolean {
  return Object.keys(exportsField).some((key) => key.startsWith("."));
}

/** The `exports` field as `subpath -> target value`, or undefined when absent. */
export function exportsMapOf(manifest: Record<string, unknown>): Map<string, unknown> | undefined {
  const field = manifest.exports;
  if (field === undefined || field === null) return undefined;
  const record = asRecord(field);
  if (record && isSubpathMap(record)) return new Map(Object.entries(record));
  return new Map([[".", field]]);
}

/** Whether a package's published files can all be deep-imported (no `exports` map to restrict them). */
export function allowsDeepImports(manifest: Record<string, unknown>): boolean {
  return exportsMapOf(manifest) === undefined;
}

function withExtensionVariants(file: string): string[] {
  const variants = [file];
  for (const extension of JS_EXTENSIONS) variants.push(`${file}${extension}`);
  for (const extension of JS_EXTENSIONS) variants.push(`${file}/index${extension}`);
  return variants;
}

function resolveExisting(files: Map<string, string>, target: string): string | undefined {
  const cleaned = cleanTarget(target);
  return withExtensionVariants(cleaned).find((candidate) => files.has(candidate));
}

function declarationFor(files: Map<string, string>, runtimeFile: string): string | undefined {
  const base = runtimeFile.replace(/\.(?:[cm]?[jt]sx?)$/, "");
  const extensionMap: Record<string, string> = { ".mjs": ".d.mts", ".cjs": ".d.cts" };
  const extension = /\.[cm]?[jt]sx?$/.exec(runtimeFile)?.[0] ?? ".js";
  const candidates = [`${base}${extensionMap[extension] ?? ".d.ts"}`, `${base}.d.ts`];
  return candidates.find((candidate) => files.has(candidate));
}

function expandPattern(
  subpath: string,
  target: string,
  files: Map<string, string>,
): Array<{ subpath: string; file: string }> {
  const cleaned = cleanTarget(target);
  const star = cleaned.indexOf("*");
  if (star === -1) return [];
  const before = cleaned.slice(0, star);
  const after = cleaned.slice(star + 1);
  const result: Array<{ subpath: string; file: string }> = [];
  for (const file of files.keys()) {
    if (!file.startsWith(before) || !file.endsWith(after) || file.endsWith(".d.ts")) continue;
    const middle = file.slice(before.length, file.length - after.length);
    if (middle === "") continue;
    result.push({ subpath: subpath.replaceAll("*", middle), file });
  }
  return result.toSorted((a, b) => a.subpath.localeCompare(b.subpath)).slice(0, 500);
}

/** Entry points of a package: every `exports` subpath, or `main`/`module`/`types` and `index`. */
export function entryPoints(source: PackageSource): EntryPoint[] {
  const { manifest, files } = source;
  const map = exportsMapOf(manifest);
  const entries: EntryPoint[] = [];

  if (map) {
    for (const [subpath, value] of map) {
      const typesLeaf = pickLeaf(value, ["types", ...RUNTIME_CONDITIONS]);
      const runtimeLeaf = pickLeaf(value, RUNTIME_CONDITIONS);
      if (subpath.includes("*")) {
        const pattern = runtimeLeaf ?? typesLeaf;
        if (pattern) {
          for (const expanded of expandPattern(subpath, pattern, files)) {
            entries.push({
              subpath: expanded.subpath,
              file: expanded.file,
              typesFile: declarationFor(files, expanded.file),
            });
          }
        }
        continue;
      }
      const typesCandidate =
        typesLeaf && /\.d\.[cm]?ts$/.test(typesLeaf)
          ? resolveExisting(files, typesLeaf)
          : undefined;
      const file =
        runtimeLeaf && !/\.d\.[cm]?ts$/.test(runtimeLeaf)
          ? resolveExisting(files, runtimeLeaf)
          : undefined;
      const manifestTypes =
        typeof manifest.types === "string"
          ? manifest.types
          : typeof manifest.typings === "string"
            ? manifest.typings
            : undefined;
      entries.push({
        subpath,
        file,
        typesFile:
          typesCandidate ??
          (file ? declarationFor(files, file) : undefined) ??
          (subpath === "." && manifestTypes ? resolveExisting(files, manifestTypes) : undefined),
      });
    }
    return entries;
  }

  const main = typeof manifest.main === "string" ? manifest.main : undefined;
  const moduleField = typeof manifest.module === "string" ? manifest.module : undefined;
  const file =
    (main ? resolveExisting(files, main) : undefined) ??
    (moduleField ? resolveExisting(files, moduleField) : undefined) ??
    resolveExisting(files, "index");
  const typesField =
    typeof manifest.types === "string"
      ? manifest.types
      : typeof manifest.typings === "string"
        ? manifest.typings
        : undefined;
  const typesFile =
    (typesField ? resolveExisting(files, typesField) : undefined) ??
    (file ? declarationFor(files, file) : undefined) ??
    (files.has("index.d.ts") ? "index.d.ts" : undefined);
  entries.push({ subpath: ".", file, typesFile });
  return entries;
}

/** The import specifier a consumer writes for a subpath of the package. */
export function specifierFor(packageName: string, subpath: string): string {
  return subpath === "." ? packageName : `${packageName}${subpath.slice(1)}`;
}

export type ModuleFormat = "esm-only" | "cjs-only" | "dual";

/** Which module systems a consumer can load the package with, judged from the manifest. */
export function moduleFormat(manifest: Record<string, unknown>): ModuleFormat {
  const isModuleType = manifest.type === "module";
  const formatOf = (path: string): "esm" | "cjs" => {
    if (path.endsWith(".mjs") || path.endsWith(".mts")) return "esm";
    if (path.endsWith(".cjs") || path.endsWith(".cts")) return "cjs";
    return isModuleType ? "esm" : "cjs";
  };
  const map = exportsMapOf(manifest);
  const formats = new Set<"esm" | "cjs">();
  if (map) {
    const rootValue = map.get(".") ?? [...map.values()][0];
    const visit = (value: unknown, condition: string | undefined, depth: number): void => {
      if (depth > 8) return;
      if (typeof value === "string") {
        if (/\.d\.[cm]?ts$/.test(value)) return;
        if (condition === "require") formats.add("cjs");
        else if (condition === "import" || condition === "module") formats.add("esm");
        else formats.add(formatOf(value));
        return;
      }
      if (Array.isArray(value)) {
        for (const item of value) visit(item, condition, depth + 1);
        return;
      }
      const record = asRecord(value);
      if (!record) return;
      for (const [key, nested] of Object.entries(record)) {
        if (key === "types") continue;
        visit(
          nested,
          key === "require" || key === "import" || key === "module" ? key : condition,
          depth + 1,
        );
      }
    };
    visit(rootValue, undefined, 0);
  } else {
    if (typeof manifest.main === "string") formats.add(formatOf(manifest.main));
    else formats.add(formatOf("index.js"));
    if (typeof manifest.module === "string") formats.add("esm");
  }
  if (formats.has("esm") && formats.has("cjs")) return "dual";
  return formats.has("esm") ? "esm-only" : "cjs-only";
}

export class PackageIndex {
  readonly source: PackageSource;
  readonly entries: EntryPoint[];
  private readonly modules = new Map<string, ModuleInfo | undefined>();
  private readonly resolved = new Map<string, Map<string, ResolvedExport>>();

  constructor(source: PackageSource) {
    this.source = source;
    this.entries = entryPoints(source);
  }

  hasFile(path: string): boolean {
    return this.source.files.has(path);
  }

  module(path: string): ModuleInfo | undefined {
    if (this.modules.has(path)) return this.modules.get(path);
    const code = this.source.files.get(path);
    const info = code === undefined ? undefined : analyzeModule(path, code);
    this.modules.set(path, info);
    return info;
  }

  resolveRelative(from: string, specifier: string): string | undefined {
    if (!specifier.startsWith(".")) return undefined;
    const joined = posix.normalize(posix.join(posix.dirname(from), specifier));
    if (joined.startsWith("..")) return undefined;
    const stripped = joined.replace(/\.(?:[cm]?js|jsx)$/, "");
    const candidates = [
      ...withExtensionVariants(joined),
      ...(stripped === joined ? [] : withExtensionVariants(stripped)),
    ];
    return candidates.find(
      (candidate) => this.source.files.has(candidate) && !candidate.endsWith(".d.ts"),
    );
  }

  /** Effective exports of a module: its own, plus those it re-exports from other modules. */
  exportsOf(path: string, stack: Set<string> = new Set()): Map<string, ResolvedExport> {
    const cached = this.resolved.get(path);
    if (cached) return cached;
    if (stack.has(path)) return new Map();
    stack.add(path);

    const result = new Map<string, ResolvedExport>();
    const info = this.module(path);
    if (info) {
      for (const [name, binding] of info.exports) {
        let resolved: ResolvedExport = { ...binding, definedIn: path };
        if (binding.moduleRef) {
          const target = this.resolveRelative(path, binding.moduleRef);
          const targetInfo = target ? this.module(target) : undefined;
          if (targetInfo) {
            resolved = { ...resolved, fingerprint: `module:${targetInfo.fingerprint}` };
          }
        }
        result.set(name, resolved);
      }
      for (const reexport of info.reexports) {
        const target = this.resolveRelative(path, reexport.source);
        if (!target) continue;
        const targetExports = this.exportsOf(target, stack);
        if (reexport.kind === "all") {
          for (const [name, binding] of targetExports) {
            if (name === "default" && !reexport.includeDefault) continue;
            if (!result.has(name)) result.set(name, binding);
          }
        } else if (reexport.kind === "named") {
          for (const { exported, imported } of reexport.names) {
            const binding = targetExports.get(imported);
            if (binding) result.set(exported, { ...binding, name: exported });
          }
        } else if (reexport.namespace) {
          const targetInfo = this.module(target);
          result.set(reexport.namespace, {
            name: reexport.namespace,
            kind: "module",
            fingerprint: `module:${targetInfo?.fingerprint ?? target}`,
            refs: new Set(),
            tokens: new Set(),
            nodeCount: 1,
            definedIn: target,
          });
        }
      }
    }
    stack.delete(path);
    this.resolved.set(path, result);
    return result;
  }
}
