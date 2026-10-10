/**
 * Breaking Change Refactoring Engine
 *
 * Automatically refactors consumer call sites when upgrading a vulnerable package
 * across breaking major versions or breaking minor changes.
 */
import { readFileSync, writeFileSync } from "node:fs";
import type { ConsumerCallSite } from "./call-site-finder.js";

export interface RefactorParams {
  cwd: string;
  packageName: string;
  fromVersion: string;
  toVersion: string;
  diagnosticError: string;
  callSites: ConsumerCallSite[];
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
 * Known library breaking change migration transforms
 */
const KNOWN_MIGRATIONS: Record<
  string,
  Array<{
    detect: (content: string, diag: string) => boolean;
    transform: (content: string) => string;
  }>
> = {
  rimraf: [
    {
      detect: (content, diag) => diag.includes("sync") && content.includes("rimraf.sync("),
      transform: (content) => {
        let res = content.replace(/import\s+rimraf\s+from\s+['"]rimraf['"];?/g, "");
        res = `import { rimrafSync } from "rimraf";\n` + res;
        return res.replace(/rimraf\.sync\(/g, "rimrafSync(");
      },
    },
  ],
  uuid: [
    {
      detect: (content, diag) => diag.includes("v4") && content.includes("uuid.v4("),
      transform: (content) => {
        let res = content.replace(/import\s+uuid\s+from\s+['"]uuid['"];?/g, "");
        res = `import { v4 as uuidv4 } from "uuid";\n` + res;
        return res.replace(/uuid\.v4\(/g, "uuidv4(");
      },
    },
    {
      // Subpath import migration: `import v4 from "uuid/v4"` -> `import { v4 } from "uuid"`
      detect: (content) => /from\s+['"]uuid\/v4['"]/.test(content),
      transform: (content) =>
        content.replace(
          /import\s+([a-zA-Z0-9_$]+)\s+from\s+['"]uuid\/v4['"];?/g,
          `import { v4 as $1 } from "uuid";`,
        ),
    },
  ],
  glob: [
    {
      detect: (content, diag) => diag.includes("sync") && content.includes("glob.sync("),
      transform: (content) => {
        let res = content.replace(/import\s+glob\s+from\s+['"]glob['"];?/g, "");
        res = `import { globSync } from "glob";\n` + res;
        return res.replace(/glob\.sync\(/g, "globSync(");
      },
    },
  ],
  mkdirp: [
    {
      detect: (content, diag) => diag.includes("sync") && content.includes("mkdirp.sync("),
      transform: (content) => {
        let res = content.replace(/import\s+mkdirp\s+from\s+['"]mkdirp['"];?/g, "");
        res = `import { mkdirpSync } from "mkdirp";\n` + res;
        return res.replace(/mkdirp\.sync\(/g, "mkdirpSync(");
      },
    },
  ],
};

function escapeRegex(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Applies deterministic and compiler-guided transformations to a source file.
 */
function transformFileContent(
  content: string,
  packageName: string,
  diagnosticError: string,
  filePath?: string,
): { modified: boolean; newContent: string } {
  let modified = false;
  let newContent = content;

  // 1. Check known library migrations
  const migrations = KNOWN_MIGRATIONS[packageName];
  if (migrations) {
    for (const mig of migrations) {
      if (mig.detect(newContent, diagnosticError)) {
        const transformed = mig.transform(newContent);
        if (transformed !== newContent) {
          newContent = transformed;
          modified = true;
        }
      }
    }
  }

  // 2. Default export removed in favor of namespace or named export
  // e.g. "Module '\"chalk\"' has no default export", "has no exported member 'default'", TS2614, TS1192
  if (
    diagnosticError.includes("no default export") ||
    diagnosticError.includes("has no exported member 'default'") ||
    diagnosticError.includes("has no exported member default") ||
    diagnosticError.includes("TS2614") ||
    diagnosticError.includes("TS1192")
  ) {
    // `import foo from "pkg"` -> `import * as foo from "pkg"`
    const defaultImportRegex = new RegExp(
      `import\\s+([a-zA-Z0-9_$]+)\\s+from\\s+['"]${escapeRegex(packageName)}['"]`,
      "g",
    );
    if (defaultImportRegex.test(newContent)) {
      newContent = newContent.replace(
        defaultImportRegex,
        `import * as $1 from "${packageName}"`,
      );
      modified = true;
    }
  }

  // 3. Namespace import deprecated in favor of default import
  // e.g. "This module is declared with using 'export =', and can only be used with a default import" (TS1259)
  if (
    diagnosticError.includes("can only be used with a default import") ||
    diagnosticError.includes("only be used with a default import") ||
    diagnosticError.includes("TS1259")
  ) {
    const starImportRegex = new RegExp(
      `import\\s+\\*\\s+as\\s+([a-zA-Z0-9_$]+)\\s+from\\s+['"]${escapeRegex(packageName)}['"]`,
      "g",
    );
    if (starImportRegex.test(newContent)) {
      newContent = newContent.replace(
        starImportRegex,
        `import $1 from "${packageName}"`,
      );
      modified = true;
    }
  }

  // 4. Compiler feedback: "Did you mean 'XYZ'?" auto-replacement
  const diagnostics = parseCompilerDiagnostics(diagnosticError);
  for (const diag of diagnostics) {
    if (diag.missingMember && diag.suggestedSymbol) {
      const missingMember = diag.missingMember;
      const suggestedSymbol = diag.suggestedSymbol;

      // If error specified a line number in this file, target that line specifically
      if (
        filePath &&
        diag.filePath &&
        filePath.endsWith(diag.filePath) &&
        diag.line &&
        diag.line > 0
      ) {
        const fileLines = newContent.split("\n");
        const idx = diag.line - 1;
        if (idx >= 0 && idx < fileLines.length) {
          const line = fileLines[idx]!;
          const replaced = line
            .replace(new RegExp(`\\.${escapeRegex(missingMember)}\\b`, "g"), `.${suggestedSymbol}`)
            .replace(new RegExp(`\\b${escapeRegex(missingMember)}\\b`, "g"), suggestedSymbol);
          if (replaced !== line) {
            fileLines[idx] = replaced;
            newContent = fileLines.join("\n");
            modified = true;
          }
        }
      } else {
        // Replace member expression: pkg.missingMember -> pkg.suggestedSymbol
        const memberRegex = new RegExp(`\\.${escapeRegex(missingMember)}\\b`, "g");
        if (memberRegex.test(newContent)) {
          newContent = newContent.replace(memberRegex, `.${suggestedSymbol}`);
          modified = true;
        }

        // Replace in named imports: import { missingMember } from "pkg"
        const importPattern = new RegExp(
          `import\\s*\\{[^}]*\\b${escapeRegex(missingMember)}\\b[^}]*\\}\\s*from\\s*['"]${escapeRegex(packageName)}['"]`,
          "g",
        );
        if (importPattern.test(newContent)) {
          newContent = newContent.replace(
            importPattern,
            (match) => match.replace(new RegExp(`\\b${escapeRegex(missingMember)}\\b`, "g"), suggestedSymbol),
          );
          modified = true;
        }
      }
    }
  }

  // 5. Targeted type error suppression if errors point specifically to this file
  // Sort descending by line number to avoid line-shift index skew!
  const lineDiags = diagnostics
    .filter(
      (d) =>
        Boolean(filePath && d.filePath && filePath.endsWith(d.filePath) && typeof d.line === "number" && d.line > 0),
    )
    .sort((a, b) => b.line! - a.line!);

  const processedLines = new Set<number>();
  for (const diag of lineDiags) {
    if (processedLines.has(diag.line!)) continue;
    processedLines.add(diag.line!);

    const fileLines = newContent.split("\n");
    const targetLineIdx = diag.line! - 1;
    if (targetLineIdx >= 0 && targetLineIdx < fileLines.length) {
      const prevLine = targetLineIdx > 0 ? fileLines[targetLineIdx - 1] : "";
      if (!prevLine?.includes("@ts-expect-error") && !fileLines[targetLineIdx]?.includes("@ts-expect-error")) {
        const indent = fileLines[targetLineIdx]?.match(/^\s*/)?.[0] || "";
        fileLines.splice(
          targetLineIdx,
          0,
          `${indent}// @ts-expect-error [autoremediator-refactor]: breaking change in ${packageName}`,
        );
        newContent = fileLines.join("\n");
        modified = true;
      }
    }
  }

  return { modified, newContent };
}

export async function refactorConsumerCallSites(
  params: RefactorParams,
): Promise<RefactorExecutionResult> {
  const { packageName, diagnosticError, callSites } = params;

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
      snapshots: {},
      error: `Failed to apply breaking change refactoring: ${message}`,
    };
  }
}
