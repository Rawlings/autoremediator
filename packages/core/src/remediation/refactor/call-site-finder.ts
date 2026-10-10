/**
 * Call-Site Finder for Breaking Change Remediation
 *
 * Scans project source files using oxc-parser to identify all call sites,
 * import statements, and member expressions referencing a target dependency.
 */
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";
import { parseSync } from "oxc-parser";

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

export interface ImportReference {
  localName: string;
  importedName: string;
  isDefault: boolean;
  isNamespace: boolean;
}

export interface ConsumerCallSite {
  filePath: string;
  sourceContent: string;
  importSources: string[];
  imports: ImportReference[];
  referencedLines: number[];
}

function* walkFiles(dir: string): Generator<string> {
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
      yield* walkFiles(full);
    } else {
      const ext = full.slice(full.lastIndexOf("."));
      if (SOURCE_EXTENSIONS.has(ext)) {
        yield full;
      }
    }
  }
}

export function findPackageCallSites(
  cwd: string,
  packageName: string,
): ConsumerCallSite[] {
  const callSites: ConsumerCallSite[] = [];

  for (const filePath of walkFiles(cwd)) {
    let content: string;
    try {
      content = readFileSync(filePath, "utf8");
    } catch {
      continue;
    }

    // Quick regex pre-filter to avoid unnecessary AST parsing
    if (!content.includes(packageName)) {
      continue;
    }

    try {
      const parseResult = parseSync(filePath, content);
      if (!parseResult.program) continue;

      const program = parseResult.program as unknown as {
        body: Array<{
          type: string;
          source?: { value?: string };
          specifiers?: Array<{
            type: string;
            local?: { name?: string; loc?: { start?: { line?: number } }; };
            imported?: { name?: string };
          }>;
          [key: string]: unknown;
        }>;
      };

      const imports: ImportReference[] = [];
      const importSources: string[] = [];
      const localNames = new Set<string>();

      for (const statement of program.body) {
        if (statement.type === "ImportDeclaration" && statement.source?.value) {
          const importSource = statement.source.value;
          if (importSource === packageName || importSource.startsWith(`${packageName}/`)) {
            importSources.push(importSource);

            for (const spec of statement.specifiers || []) {
              const localName = spec.local?.name || "";
              if (!localName) continue;
              localNames.add(localName);

              if (spec.type === "ImportDefaultSpecifier") {
                imports.push({
                  localName,
                  importedName: "default",
                  isDefault: true,
                  isNamespace: false,
                });
              } else if (spec.type === "ImportNamespaceSpecifier") {
                imports.push({
                  localName,
                  importedName: "*",
                  isDefault: false,
                  isNamespace: true,
                });
              } else if (spec.type === "ImportSpecifier") {
                imports.push({
                  localName,
                  importedName: spec.imported?.name || localName,
                  isDefault: false,
                  isNamespace: false,
                });
              }
            }
          }
        }
      }

      if (imports.length > 0 || importSources.length > 0) {
        // Collect line numbers referencing the imported identifiers
        const lines = content.split("\n");
        const referencedLines: number[] = [];

        lines.forEach((line, index) => {
          for (const local of localNames) {
            // Word boundary match
            const regex = new RegExp(`\\b${local}\\b`);
            if (regex.test(line)) {
              referencedLines.push(index + 1);
              break;
            }
          }
        });

        callSites.push({
          filePath,
          sourceContent: content,
          importSources,
          imports,
          referencedLines,
        });
      }
    } catch {
      // Ignore parser syntax errors in consumer files
    }
  }

  return callSites;
}
