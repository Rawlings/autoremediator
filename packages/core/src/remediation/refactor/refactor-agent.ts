/**
 * Breaking Change Refactoring Engine
 *
 * Automatically refactors consumer call sites when upgrading a vulnerable package
 * across breaking major versions or breaking minor changes using AST analysis.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { parseSync } from "oxc-parser";
import type { ConsumerCallSite } from "./call-site-finder.js";

export interface ArgumentTransformOptions {
  callee: string;
  dropIndex?: number;
  reorder?: [number, number];
}

export interface RefactorParams {
  cwd: string;
  packageName: string;
  fromVersion: string;
  toVersion: string;
  diagnosticError: string;
  callSites: ConsumerCallSite[];
  argumentTransforms?: ArgumentTransformOptions;
}

export interface RefactorExecutionResult {
  applied: boolean;
  refactoredFiles: string[];
  snapshots: Record<string, string>;
  error?: string;
}

export interface ParsedTsDiagnostic {
  filePath?: string;
  line?: number;
  column?: number;
  code?: string;
  message: string;
  suggestedSymbol?: string;
  missingMember?: string;
}

interface TextEdit {
  start: number;
  end: number;
  replacement: string;
}

function applyEdits(source: string, edits: TextEdit[]): string {
  if (edits.length === 0) return source;
  // Sort descending by start offset to avoid line/index shift skew
  const sorted = [...edits].sort((a, b) => b.start - a.start);
  let result = source;
  for (const edit of sorted) {
    result = result.slice(0, edit.start) + edit.replacement + result.slice(edit.end);
  }
  return result;
}

/**
 * Parses compiler/typecheck diagnostic output into structured errors.
 */
export function parseCompilerDiagnostics(diagnosticError: string): ParsedTsDiagnostic[] {
  const diagnostics: ParsedTsDiagnostic[] = [];
  const lines = diagnosticError.split("\n");

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;

    // Pattern 1: path/to/file.ts(line,col): error TSxxxx: message
    // Pattern 2: path/to/file.ts:line:col - error TSxxxx: message
    const match = trimmed.match(
      /(?:([^\s:(]+)[:(](\d+)[:,](\d+)\)?:?\s*(?:-\s*)?(?:error\s+)?(TS\d+)?:?\s*(.*))/i,
    );

    if (match) {
      const [, filePath, lineStr, colStr, code, message] = match;
      const diag: ParsedTsDiagnostic = {
        filePath,
        line: lineStr ? parseInt(lineStr, 10) : undefined,
        column: colStr ? parseInt(colStr, 10) : undefined,
        code,
        message: message || trimmed,
      };

      // Extract "Did you mean 'xyz'?"
      const suggestionMatch = diag.message.match(/Did you mean ['"]([a-zA-Z0-9_$]+)['"]\?/i);
      if (suggestionMatch) {
        diag.suggestedSymbol = suggestionMatch[1];
      }

      // Extract missing exported member or property
      const missingMatch =
        diag.message.match(/has no exported member ['"]([a-zA-Z0-9_$]+)['"]/i) ||
        diag.message.match(/Property ['"]([a-zA-Z0-9_$]+)['"] does not exist/i);
      if (missingMatch) {
        diag.missingMember = missingMatch[1];
      }

      diagnostics.push(diag);
    }
  }

  return diagnostics;
}

/**
 * Restores original file contents from snapshot in case of failure.
 */
export function revertRefactorSnapshots(snapshots: Record<string, string>): void {
  for (const [filePath, content] of Object.entries(snapshots)) {
    try {
      writeFileSync(filePath, content, "utf8");
    } catch {
      // Ignore write errors during emergency rollback
    }
  }
}

/**
 * Transforms function call arguments via AST manipulation (dropping parameters, reordering arguments).
 */
export function transformCallArguments(
  content: string,
  options: {
    callee: string;
    dropIndex?: number;
    reorder?: [number, number];
    filePath?: string;
  },
): { modified: boolean; newContent: string } {
  const parseResult = parseSync(options.filePath ?? "file.ts", content);
  if (!parseResult.program) {
    return { modified: false, newContent: content };
  }

  const edits: TextEdit[] = [];

  function walk(node: any) {
    if (!node || typeof node !== "object") return;

    if (node.type === "CallExpression") {
      const calleeText = content.slice(node.callee.start, node.callee.end);
      const matchesCallee =
        calleeText === options.callee || calleeText.endsWith(`.${options.callee}`);

      if (matchesCallee) {
        const args = node.arguments || [];

        // Parameter removal / argument dropping
        if (options.dropIndex !== undefined) {
          const idx = options.dropIndex;
          if (idx >= 0 && idx < args.length) {
            if (args.length === 1) {
              edits.push({
                start: args[0].start,
                end: args[0].end,
                replacement: "",
              });
            } else if (idx < args.length - 1) {
              // Not the last argument: remove up to the start of the next argument
              edits.push({
                start: args[idx].start,
                end: args[idx + 1].start,
                replacement: "",
              });
            } else {
              // Last argument: remove from the end of the previous argument up to end of this argument
              edits.push({
                start: args[idx - 1].end,
                end: args[idx].end,
                replacement: "",
              });
            }
          }
        }

        // Argument reordering
        if (options.reorder) {
          const [i, j] = options.reorder;
          if (i >= 0 && j >= 0 && i < args.length && j < args.length && i !== j) {
            const argIText = content.slice(args[i].start, args[i].end);
            const argJText = content.slice(args[j].start, args[j].end);
            edits.push({
              start: args[i].start,
              end: args[i].end,
              replacement: argJText,
            });
            edits.push({
              start: args[j].start,
              end: args[j].end,
              replacement: argIText,
            });
          }
        }
      }
    }

    for (const key of Object.keys(node)) {
      if (key === "parent") continue;
      const child = node[key];
      if (Array.isArray(child)) {
        for (const item of child) walk(item);
      } else if (child && typeof child === "object") {
        walk(child);
      }
    }
  }

  walk(parseResult.program);

  if (edits.length === 0) {
    return { modified: false, newContent: content };
  }

  return { modified: true, newContent: applyEdits(content, edits) };
}

/**
 * Applies deterministic and compiler-guided AST transformations to a source file.
 */
function transformFileContent(
  content: string,
  packageName: string,
  diagnosticError: string,
  filePath?: string,
  argumentTransforms?: ArgumentTransformOptions,
): { modified: boolean; newContent: string } {
  let currentContent = content;
  let modified = false;

  const parseResult = parseSync(filePath ?? "file.ts", currentContent);
  if (!parseResult.program) {
    return { modified: false, newContent: content };
  }

  const edits: TextEdit[] = [];
  const body = (parseResult.program as any).body || [];

  let defaultLocalName: string | undefined;
  let namespaceLocalName: string | undefined;
  let defaultImportDecl: any;
  let subpathImportDecl: any;
  let subpathName: string | undefined;

  for (const statement of body) {
    if (statement.type === "ImportDeclaration" && statement.source?.value) {
      const specText = String(statement.source.value);
      if (specText === packageName) {
        for (const spec of statement.specifiers || []) {
          if (spec.type === "ImportDefaultSpecifier") {
            defaultLocalName = spec.local?.name;
            defaultImportDecl = statement;
          } else if (spec.type === "ImportNamespaceSpecifier") {
            namespaceLocalName = spec.local?.name;
          }
        }
      } else if (specText.startsWith(`${packageName}/`)) {
        subpathImportDecl = statement;
        subpathName = specText.slice(packageName.length + 1);
        for (const spec of statement.specifiers || []) {
          if (spec.type === "ImportDefaultSpecifier") {
            defaultLocalName = spec.local?.name;
          }
        }
      }
    }
  }

  // 1. Subpath Import Migration: e.g. `import v4 from "uuid/v4"` -> `import { v4 as v4 } from "uuid";`
  if (
    subpathImportDecl &&
    (diagnosticError.includes(`Cannot find module '${packageName}/`) ||
      diagnosticError.includes(`Cannot find module "${packageName}/`))
  ) {
    const local = defaultLocalName || subpathName || "default";
    const newImport = `import { ${subpathName} as ${local} } from "${packageName}";`;
    edits.push({
      start: subpathImportDecl.start,
      end: subpathImportDecl.end,
      replacement: newImport,
    });
  }

  // 2. Known library breaking change migrations
  // A. rimraf: rimraf.sync(...) -> rimrafSync(...) with import { rimrafSync } from "rimraf"
  if (
    packageName === "rimraf" &&
    (diagnosticError.includes("sync") ||
      diagnosticError.includes("rimrafSync") ||
      currentContent.includes("rimraf.sync(") ||
      (defaultLocalName && currentContent.includes(`${defaultLocalName}.sync(`)))
  ) {
    const targetLocal = defaultLocalName || "rimraf";
    function walkRimraf(node: any) {
      if (!node || typeof node !== "object") return;
      if (
        node.type === "CallExpression" &&
        node.callee?.type === "MemberExpression" &&
        node.callee.object?.type === "Identifier" &&
        node.callee.object.name === targetLocal &&
        node.callee.property?.name === "sync"
      ) {
        edits.push({
          start: node.callee.start,
          end: node.callee.end,
          replacement: "rimrafSync",
        });
      }
      for (const k of Object.keys(node)) {
        if (k === "parent") continue;
        const v = node[k];
        if (Array.isArray(v)) v.forEach(walkRimraf);
        else if (v && typeof v === "object") walkRimraf(v);
      }
    }
    walkRimraf(parseResult.program);

    if (defaultImportDecl) {
      edits.push({
        start: defaultImportDecl.start,
        end: defaultImportDecl.end,
        replacement: `import { rimrafSync } from "rimraf";`,
      });
    }
  }

  // B. uuid: uuid.v4(...) -> uuidv4(...) with import { v4 as uuidv4 } from "uuid"
  if (
    packageName === "uuid" &&
    (diagnosticError.includes("v4") ||
      diagnosticError.includes("uuidv4") ||
      currentContent.includes("uuid.v4(") ||
      (defaultLocalName && currentContent.includes(`${defaultLocalName}.v4(`)))
  ) {
    const targetLocal = defaultLocalName || "uuid";
    function walkUuid(node: any) {
      if (!node || typeof node !== "object") return;
      if (
        node.type === "CallExpression" &&
        node.callee?.type === "MemberExpression" &&
        node.callee.object?.type === "Identifier" &&
        node.callee.object.name === targetLocal &&
        node.callee.property?.name === "v4"
      ) {
        edits.push({
          start: node.callee.start,
          end: node.callee.end,
          replacement: "uuidv4",
        });
      }
      for (const k of Object.keys(node)) {
        if (k === "parent") continue;
        const v = node[k];
        if (Array.isArray(v)) v.forEach(walkUuid);
        else if (v && typeof v === "object") walkUuid(v);
      }
    }
    walkUuid(parseResult.program);

    if (defaultImportDecl) {
      edits.push({
        start: defaultImportDecl.start,
        end: defaultImportDecl.end,
        replacement: `import { v4 as uuidv4 } from "uuid";`,
      });
    }
  }

  // C. glob: glob.sync(...) -> globSync(...) with import { globSync } from "glob"
  if (
    packageName === "glob" &&
    (diagnosticError.includes("sync") ||
      diagnosticError.includes("globSync") ||
      currentContent.includes("glob.sync(") ||
      (defaultLocalName && currentContent.includes(`${defaultLocalName}.sync(`)))
  ) {
    const targetLocal = defaultLocalName || "glob";
    function walkGlob(node: any) {
      if (!node || typeof node !== "object") return;
      if (
        node.type === "CallExpression" &&
        node.callee?.type === "MemberExpression" &&
        node.callee.object?.type === "Identifier" &&
        node.callee.object.name === targetLocal &&
        node.callee.property?.name === "sync"
      ) {
        edits.push({
          start: node.callee.start,
          end: node.callee.end,
          replacement: "globSync",
        });
      }
      for (const k of Object.keys(node)) {
        if (k === "parent") continue;
        const v = node[k];
        if (Array.isArray(v)) v.forEach(walkGlob);
        else if (v && typeof v === "object") walkGlob(v);
      }
    }
    walkGlob(parseResult.program);

    if (defaultImportDecl) {
      edits.push({
        start: defaultImportDecl.start,
        end: defaultImportDecl.end,
        replacement: `import { globSync } from "glob";`,
      });
    }
  }

  // D. mkdirp: mkdirp.sync(...) -> mkdirpSync(...) with import { mkdirpSync } from "mkdirp"
  if (
    packageName === "mkdirp" &&
    (diagnosticError.includes("sync") ||
      diagnosticError.includes("mkdirpSync") ||
      currentContent.includes("mkdirp.sync(") ||
      (defaultLocalName && currentContent.includes(`${defaultLocalName}.sync(`)))
  ) {
    const targetLocal = defaultLocalName || "mkdirp";
    function walkMkdirp(node: any) {
      if (!node || typeof node !== "object") return;
      if (
        node.type === "CallExpression" &&
        node.callee?.type === "MemberExpression" &&
        node.callee.object?.type === "Identifier" &&
        node.callee.object.name === targetLocal &&
        node.callee.property?.name === "sync"
      ) {
        edits.push({
          start: node.callee.start,
          end: node.callee.end,
          replacement: "mkdirpSync",
        });
      }
      for (const k of Object.keys(node)) {
        if (k === "parent") continue;
        const v = node[k];
        if (Array.isArray(v)) v.forEach(walkMkdirp);
        else if (v && typeof v === "object") walkMkdirp(v);
      }
    }
    walkMkdirp(parseResult.program);

    if (defaultImportDecl) {
      edits.push({
        start: defaultImportDecl.start,
        end: defaultImportDecl.end,
        replacement: `import { mkdirpSync } from "mkdirp";`,
      });
    }
  }

  // 3. Default export removed in favor of namespace (TS2614, TS1192, "no default export")
  if (
    defaultImportDecl &&
    defaultLocalName &&
    (diagnosticError.includes("no default export") ||
      diagnosticError.includes("has no exported member 'default'") ||
      diagnosticError.includes("has no exported member default") ||
      diagnosticError.includes("TS2614") ||
      diagnosticError.includes("TS1192"))
  ) {
    edits.push({
      start: defaultImportDecl.start,
      end: defaultImportDecl.end,
      replacement: `import * as ${defaultLocalName} from "${packageName}";`,
    });
  }

  // 4. Namespace import deprecated in favor of default import (TS1259)
  if (
    namespaceLocalName &&
    (diagnosticError.includes("can only be used with a default import") ||
      diagnosticError.includes("only be used with a default import") ||
      diagnosticError.includes("TS1259"))
  ) {
    for (const statement of body) {
      if (
        statement.type === "ImportDeclaration" &&
        String(statement.source?.value) === packageName
      ) {
        edits.push({
          start: statement.start,
          end: statement.end,
          replacement: `import ${namespaceLocalName} from "${packageName}";`,
        });
      }
    }
  }

  // 5. Compiler feedback: "Did you mean 'XYZ'?" auto-replacement
  const diagnostics = parseCompilerDiagnostics(diagnosticError);
  for (const diag of diagnostics) {
    if (diag.missingMember && diag.suggestedSymbol) {
      const missing = diag.missingMember;
      const suggested = diag.suggestedSymbol;

      const lineStarts: number[] = [0];
      for (let i = 0; i < currentContent.length; i++) {
        if (currentContent[i] === "\n") lineStarts.push(i + 1);
      }
      function getLine(offset: number): number {
        let low = 0;
        let high = lineStarts.length - 1;
        while (low <= high) {
          const mid = Math.floor((low + high) / 2);
          if (lineStarts[mid]! <= offset) {
            if (mid === lineStarts.length - 1 || lineStarts[mid + 1]! > offset) {
              return mid + 1;
            }
            low = mid + 1;
          } else {
            high = mid - 1;
          }
        }
        return 1;
      }

      function walkDiagnostics(node: any) {
        if (!node || typeof node !== "object") return;
        if (node.type === "MemberExpression" && node.property?.name === missing) {
          const line = getLine(node.start);
          const lineMatches = !diag.line || diag.line === line;
          if (lineMatches) {
            edits.push({
              start: node.property.start,
              end: node.property.end,
              replacement: suggested,
            });
          }
        }
        if (
          node.type === "ImportSpecifier" &&
          (node.imported?.name === missing || node.local?.name === missing)
        ) {
          edits.push({
            start: node.local.start,
            end: node.local.end,
            replacement: suggested,
          });
        }
        for (const k of Object.keys(node)) {
          if (k === "parent") continue;
          const v = node[k];
          if (Array.isArray(v)) v.forEach(walkDiagnostics);
          else if (v && typeof v === "object") walkDiagnostics(v);
        }
      }

      walkDiagnostics(parseResult.program);
    }
  }

  if (edits.length > 0) {
    currentContent = applyEdits(currentContent, edits);
    modified = true;
  }

  // 6. Explicit argument transforms if supplied
  if (argumentTransforms) {
    const argResult = transformCallArguments(currentContent, {
      ...argumentTransforms,
      filePath,
    });
    if (argResult.modified) {
      currentContent = argResult.newContent;
      modified = true;
    }
  }

  return { modified, newContent: currentContent };
}

export async function refactorConsumerCallSites(
  params: RefactorParams,
): Promise<RefactorExecutionResult> {
  const { packageName, diagnosticError, callSites, argumentTransforms } = params;

  if (callSites.length === 0) {
    return {
      applied: false,
      refactoredFiles: [],
      snapshots: {},
      error: `No consumer call sites found for "${packageName}".`,
    };
  }

  const snapshots: Record<string, string> = {};
  const refactoredFiles: string[] = [];

  try {
    for (const site of callSites) {
      const originalContent = site.sourceContent || readFileSync(site.filePath, "utf8");
      snapshots[site.filePath] = originalContent;

      const { modified, newContent } = transformFileContent(
        originalContent,
        packageName,
        diagnosticError,
        site.filePath,
        argumentTransforms,
      );

      if (modified && newContent !== originalContent) {
        writeFileSync(site.filePath, newContent, "utf8");
        refactoredFiles.push(site.filePath);
      }
    }

    if (refactoredFiles.length === 0) {
      return {
        applied: false,
        refactoredFiles: [],
        snapshots,
        error: "No automated codemod pattern matched the diagnostic error.",
      };
    }

    return {
      applied: true,
      refactoredFiles,
      snapshots,
    };
  } catch (err) {
    revertRefactorSnapshots(snapshots);
    const message = err instanceof Error ? err.message : String(err);
    return {
      applied: false,
      refactoredFiles: [],
      snapshots,
      error: `Failed to apply breaking change refactoring: ${message}`,
    };
  }
}
