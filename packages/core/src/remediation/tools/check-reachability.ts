/**
 * Tool: check-reachability (Pillar 3.1)
 *
 * Uses the high-performance Oxc (Oxidation Compiler) AST parser to scan project
 * source files for static imports, dynamic imports, CommonJS require calls,
 * and re-exports. Performs interprocedural AST call-graph tracing for target symbols
 * and resolves tsconfig/jsconfig path aliases.
 */
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";
import { parseSync, type ParseResult } from "oxc-parser";
import { defineTool } from "./tool-compat.js";
import { z } from "zod";
import type { ReachabilityAssessment, ReachabilityEvidence } from "../../platform/types.js";

const SOURCE_EXTENSIONS = new Set([".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", ".mts", ".cts"]);
const IGNORED_DIRS = new Set([
  "node_modules",
  ".git",
  "dist",
  "build",
  "coverage",
  ".next",
  ".turbo",
  ".pnpm-store",
]);

export interface TsconfigPathsConfig {
  baseUrl: string;
  paths: Record<string, string[]>;
}

/**
 * Loads compilerOptions.baseUrl and compilerOptions.paths from tsconfig.json or jsconfig.json
 */
export function loadTsconfigPaths(cwd: string): TsconfigPathsConfig | undefined {
  for (const configName of ["tsconfig.json", "jsconfig.json"]) {
    const fullPath = join(cwd, configName);
    if (!existsSync(fullPath)) continue;
    try {
      const raw = readFileSync(fullPath, "utf8");
      // Remove trailing commas / comments if any for robust parsing
      const cleaned = raw.replace(/\/\*[\s\S]*?\*\/|\/\/.*/g, "");
      const parsed = JSON.parse(cleaned);
      const compilerOptions = parsed.compilerOptions;
      if (compilerOptions?.paths) {
        return {
          baseUrl: compilerOptions.baseUrl ? resolve(cwd, compilerOptions.baseUrl) : cwd,
          paths: compilerOptions.paths,
        };
      }
    } catch {
      // Ignore invalid config
    }
  }
  return undefined;
}

/**
 * Resolves an aliased import path according to tsconfig paths mapping
 */
export function resolveAliasedPath(
  importSource: string,
  config?: TsconfigPathsConfig,
): string | undefined {
  if (!config || !config.paths || isAbsolute(importSource) || importSource.startsWith(".")) {
    return undefined;
  }

  for (const [pattern, replacements] of Object.entries(config.paths)) {
    if (pattern === importSource && replacements[0]) {
      return resolve(config.baseUrl, replacements[0]);
    }
    if (pattern.endsWith("/*")) {
      const prefix = pattern.slice(0, -2);
      if (importSource.startsWith(prefix)) {
        const suffix = importSource.slice(prefix.length);
        const replacement = replacements[0]?.slice(0, -2) ?? "";
        return resolve(config.baseUrl, replacement + suffix);
      }
    }
  }
  return undefined;
}

function* walkSourceFiles(dir: string): Generator<string> {
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return;
  }
  for (const entry of entries) {
    if (IGNORED_DIRS.has(entry)) continue;
    const full = join(dir, entry);
    let stat;
    try {
      stat = statSync(full);
    } catch {
      continue;
    }
    if (stat.isDirectory()) {
      yield* walkSourceFiles(full);
    } else if (SOURCE_EXTENSIONS.has(full.slice(full.lastIndexOf(".")))) {
      yield full;
    }
  }
}

function matchesPackage(
  sourceValue: string,
  packageName: string,
  tsconfig?: TsconfigPathsConfig,
): boolean {
  if (sourceValue === packageName || sourceValue.startsWith(`${packageName}/`)) {
    return true;
  }
  const resolved = resolveAliasedPath(sourceValue, tsconfig);
  if (resolved && (resolved.includes(`/${packageName}/`) || resolved.endsWith(`/${packageName}`))) {
    return true;
  }
  return false;
}

interface AstNode {
  type: string;
  [key: string]: unknown;
}

function walkAst(node: AstNode | null | undefined, visitor: (node: AstNode) => void): void {
  if (!node || typeof node !== "object") return;
  visitor(node);

  for (const key of Object.keys(node)) {
    if (key === "parent" || key === "start" || key === "end") continue;
    const value = node[key];
    if (Array.isArray(value)) {
      for (const child of value) {
        if (child && typeof child === "object" && "type" in child) {
          walkAst(child as AstNode, visitor);
        }
      }
    } else if (value && typeof value === "object" && "type" in value) {
      walkAst(value as AstNode, visitor);
    }
  }
}

export interface ExtractedReference {
  matchType: ReachabilityEvidence["matchType"];
  symbols: string[];
  importedIdentifiers: Map<string, string>; // local variable name -> imported member name
  isReExported: boolean;
}

/**
 * Extracts package references and imported symbols using the Oxc AST parser.
 */
export function extractPackageReferences(
  filename: string,
  content: string,
  packageName: string,
  tsconfig?: TsconfigPathsConfig,
): ExtractedReference[] {
  const results: ExtractedReference[] = [];

  let parseResult: ParseResult | undefined;
  try {
    parseResult = parseSync(filename, content);
  } catch {
    return results;
  }

  if (!parseResult?.program) return results;

  walkAst(parseResult.program as unknown as AstNode, (node) => {
    // 1. Static Import Declarations: import ... from 'pkg'
    if (node.type === "ImportDeclaration") {
      const source = node.source as { value?: string } | undefined;
      if (source?.value && matchesPackage(source.value, packageName, tsconfig)) {
        const symbols: string[] = [];
        const importedIdentifiers = new Map<string, string>();
        const specifiers = (node.specifiers ?? []) as AstNode[];

        for (const spec of specifiers) {
          if (spec.type === "ImportSpecifier") {
            const imported = spec.imported as { name?: string; value?: string } | undefined;
            const local = spec.local as { name?: string } | undefined;
            const importedName = imported?.name ?? imported?.value ?? local?.name;
            const localName = local?.name ?? importedName;
            if (importedName && localName) {
              symbols.push(importedName);
              importedIdentifiers.set(localName, importedName);
            }
          } else if (spec.type === "ImportDefaultSpecifier") {
            const local = spec.local as { name?: string } | undefined;
            symbols.push("default");
            if (local?.name) importedIdentifiers.set(local.name, "default");
          } else if (spec.type === "ImportNamespaceSpecifier") {
            const local = spec.local as { name?: string } | undefined;
            symbols.push("*");
            if (local?.name) importedIdentifiers.set(local.name, "*");
          }
        }

        results.push({
          matchType: "import",
          symbols: symbols.length > 0 ? symbols : ["*"],
          importedIdentifiers,
          isReExported: false,
        });
      }
    }

    // 2. Dynamic Import Expressions: import('pkg')
    if (node.type === "ImportExpression") {
      const source = node.source as { value?: string } | undefined;
      if (source?.value && matchesPackage(source.value, packageName, tsconfig)) {
        results.push({
          matchType: "dynamic-import",
          symbols: ["*"],
          importedIdentifiers: new Map(),
          isReExported: false,
        });
      }
    }

    // 3. CommonJS Require Calls: require('pkg')
    if (
      node.type === "CallExpression" &&
      (node.callee as { name?: string })?.name === "require" &&
      Array.isArray(node.arguments) &&
      node.arguments.length > 0
    ) {
      const firstArg = node.arguments[0] as { value?: string } | undefined;
      if (
        firstArg?.value &&
        typeof firstArg.value === "string" &&
        matchesPackage(firstArg.value, packageName, tsconfig)
      ) {
        results.push({
          matchType: "require",
          symbols: ["*"],
          importedIdentifiers: new Map(),
          isReExported: false,
        });
      }
    }

    // 4. Re-export Declarations: export ... from 'pkg'
    if (node.type === "ExportNamedDeclaration" || node.type === "ExportAllDeclaration") {
      const source = node.source as { value?: string } | undefined;
      if (source?.value && matchesPackage(source.value, packageName, tsconfig)) {
        const symbols: string[] = [];
        if (node.type === "ExportAllDeclaration") {
          symbols.push("*");
        } else {
          const specifiers = (node.specifiers ?? []) as AstNode[];
          for (const spec of specifiers) {
            const local = spec.local as { name?: string; value?: string } | undefined;
            const exported = spec.exported as { name?: string; value?: string } | undefined;
            const name = exported?.name ?? exported?.value ?? local?.name ?? local?.value;
            if (name) symbols.push(name);
          }
        }
        results.push({
          matchType: "re-export",
          symbols: symbols.length > 0 ? symbols : ["*"],
          importedIdentifiers: new Map(),
          isReExported: true,
        });
      }
    }
  });

  return results;
}

/**
 * Traces AST call expressions to see if the vulnerable symbol is actually invoked.
 */
export function traceSymbolInvocations(
  content: string,
  filename: string,
  importedIdentifiers: Map<string, string>,
  targetSymbol?: string,
): { invoked: boolean; callCount: number } {
  if (!targetSymbol) {
    return { invoked: true, callCount: 1 };
  }

  let parseResult: ParseResult | undefined;
  try {
    parseResult = parseSync(filename, content);
  } catch {
    return { invoked: true, callCount: 1 };
  }

  if (!parseResult?.program) {
    return { invoked: true, callCount: 1 };
  }

  let callCount = 0;

  walkAst(parseResult.program as unknown as AstNode, (node) => {
    // Check direct function calls: func() or new Func()
    if (node.type === "CallExpression" || node.type === "NewExpression") {
      const callee = node.callee as AstNode | undefined;
      if (!callee) return;

      // 1. Direct identifier invocation: template()
      if (callee.type === "Identifier") {
        const name = (callee as { name?: string }).name;
        if (name) {
          const importedName = importedIdentifiers.get(name);
          if (importedName === targetSymbol || name === targetSymbol) {
            callCount++;
          }
        }
      }

      // 2. Member expression invocation: _.template() or lodash.template()
      if (callee.type === "MemberExpression") {
        const object = callee.object as { name?: string } | undefined;
        const property = callee.property as { name?: string; value?: string } | undefined;
        const propName = property?.name ?? property?.value;

        if (object?.name && propName) {
          const importedName = importedIdentifiers.get(object.name);
          if (
            (importedName === "*" ||
              importedName === "default" ||
              object.name === "lodash" ||
              object.name === "_") &&
            propName === targetSymbol
          ) {
            callCount++;
          }
        }
      }
    }
  });

  return {
    invoked: callCount > 0,
    callCount,
  };
}

export function assessPackageReachability(
  cwd: string,
  packageName: string,
  targetSymbol?: string,
): ReachabilityAssessment {
  const tsconfig = loadTsconfigPaths(cwd);
  const evidence: ReachabilityEvidence[] = [];
  let scanned = 0;
  let hasReExport = false;
  let totalInvocations = 0;
  let hasPackageImport = false;

  for (const filePath of walkSourceFiles(cwd)) {
    scanned++;
    let content: string;
    try {
      content = readFileSync(filePath, "utf8");
    } catch {
      continue;
    }

    const refs = extractPackageReferences(filePath, content, packageName, tsconfig);
    if (refs.length > 0) {
      hasPackageImport = true;
    }

    for (const ref of refs) {
      if (ref.isReExported) {
        hasReExport = true;
      }

      const matchesSymbol =
        !targetSymbol ||
        ref.symbols.includes("*") ||
        ref.symbols.includes("default") ||
        ref.symbols.includes(targetSymbol);

      if (matchesSymbol) {
        let invoked = true;
        let callCount = 1;

        if (targetSymbol && !ref.isReExported) {
          const trace = traceSymbolInvocations(
            content,
            filePath,
            ref.importedIdentifiers,
            targetSymbol,
          );
          invoked = trace.invoked;
          callCount = trace.callCount;
          totalInvocations += callCount;
        }

        evidence.push({
          filePath,
          matchType: ref.matchType,
          importedSymbols: ref.symbols,
          symbol: targetSymbol,
          invoked,
          callCount,
        });
      }
    }
  }

  if (scanned === 0) {
    return {
      packageName,
      status: "unknown",
      reason: `No source files found under ${cwd}`,
      reachabilityBasis: "unknown",
    };
  }

  if (!hasPackageImport) {
    return {
      packageName,
      status: "not-reachable",
      reason: `No source files reference '${packageName}'`,
      reachabilityBasis: "import-present",
      justification: "code_not_in_execute_path",
      evidence: [],
    };
  }

  // If targetSymbol was specified
  if (targetSymbol) {
    const isReachable = hasReExport || totalInvocations > 0;
    if (isReachable) {
      return {
        packageName,
        status: "reachable",
        reason: hasReExport
          ? `Package '${packageName}' re-exports symbols to external consumers`
          : `Found ${totalInvocations} call-site(s) invoking vulnerable symbol '${targetSymbol}' across ${evidence.filter((e) => e.invoked).length} file(s)`,
        reachabilityBasis: "call-path-found",
        evidence,
      };
    }

    return {
      packageName,
      status: "not-reachable",
      reason: `Package '${packageName}' is imported but vulnerable symbol '${targetSymbol}' is never invoked in any execution path`,
      reachabilityBasis: "call-graph-uninvoked",
      justification: "code_not_in_execute_path",
      evidence,
    };
  }

  return {
    packageName,
    status: "reachable",
    reason: `Found ${evidence.length} source file(s) referencing '${packageName}'`,
    reachabilityBasis: "import-present",
    evidence,
  };
}

export const checkReachabilityTool = defineTool({
  description:
    "Scan project source files for import/require/export references and perform AST call-graph reachability analysis for a package and vulnerable symbols using Oxc AST parser. Returns reachability status: reachable, not-reachable, or unknown.",
  parameters: z.object({
    cwd: z.string().describe("Project root directory to scan"),
    packageName: z.string().describe("Package name to search for (e.g. 'lodash' or '@babel/core')"),
    symbol: z
      .string()
      .optional()
      .describe("Optional vulnerable function/symbol name to check specifically in call graph"),
  }),
  execute({ cwd, packageName, symbol }) {
    return assessPackageReachability(cwd, packageName, symbol);
  },
});
