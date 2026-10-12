/**
 * Call-Site Finder for Breaking Change Remediation
 *
 * Scans project source files using oxc-parser AST parsing to identify
 * all call sites, import statements, member expressions, and argument usages
 * referencing a target dependency without false positives from comments or strings.
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
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

export type ImportKind =
  | "default"
  | "namespace"
  | "named"
  | "require-default"
  | "require-destructured";

export interface ImportReference {
  localName: string;
  importedName: string;
  isDefault: boolean;
  isNamespace: boolean;
  kind?: ImportKind;
  start?: number;
  end?: number;
}

export interface AstCallSite {
  start: number;
  end: number;
  line: number;
  column: number;
  calleeText: string;
  expressionType: "call" | "property-access";
  localSymbol: string;
  memberName?: string;
  argumentCount: number;
  argumentSpans: Array<{ start: number; end: number; text: string }>;
}

export interface ConsumerCallSite {
  filePath: string;
  sourceContent: string;
  importSources: string[];
  imports: ImportReference[];
  referencedLines: number[];
  callSites?: AstCallSite[];
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

export function findPackageCallSites(cwd: string, packageName: string): ConsumerCallSite[] {
  const callSites: ConsumerCallSite[] = [];

  for (const filePath of walkFiles(cwd)) {
    let content: string;
    try {
      content = readFileSync(filePath, "utf8");
    } catch {
      continue;
    }

    // Quick pre-filter to avoid unnecessary parsing
    if (!content.includes(packageName)) {
      continue;
    }

    try {
      const parseResult = parseSync(filePath, content);
      if (!parseResult.program) continue;

      const program = parseResult.program as unknown as {
        body: Array<any>;
      };

      const imports: ImportReference[] = [];
      const importSources: string[] = [];
      const localNames = new Set<string>();

      // 1. Identify all imports targeting packageName
      for (const statement of program.body) {
        if (statement.type === "ImportDeclaration" && statement.source?.value) {
          const importSource = String(statement.source.value);
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
                  kind: "default",
                  start: spec.local?.start,
                  end: spec.local?.end,
                });
              } else if (spec.type === "ImportNamespaceSpecifier") {
                imports.push({
                  localName,
                  importedName: "*",
                  isDefault: false,
                  isNamespace: true,
                  kind: "namespace",
                  start: spec.local?.start,
                  end: spec.local?.end,
                });
              } else if (spec.type === "ImportSpecifier") {
                imports.push({
                  localName,
                  importedName: spec.imported?.name || localName,
                  isDefault: false,
                  isNamespace: false,
                  kind: "named",
                  start: spec.local?.start,
                  end: spec.local?.end,
                });
              }
            }
          }
        }

        // CommonJS require handling
        if (statement.type === "VariableDeclaration") {
          for (const decl of statement.declarations || []) {
            if (
              decl.init?.type === "CallExpression" &&
              decl.init.callee?.type === "Identifier" &&
              decl.init.callee.name === "require" &&
              decl.init.arguments?.[0]?.value
            ) {
              const importSource = String(decl.init.arguments[0].value);
              if (importSource === packageName || importSource.startsWith(`${packageName}/`)) {
                importSources.push(importSource);
                if (decl.id?.type === "Identifier") {
                  const localName = decl.id.name;
                  localNames.add(localName);
                  imports.push({
                    localName,
                    importedName: "default",
                    isDefault: true,
                    isNamespace: false,
                    kind: "require-default",
                  });
                } else if (decl.id?.type === "ObjectPattern") {
                  for (const prop of decl.id.properties || []) {
                    const localName = prop.value?.name || prop.key?.name;
                    if (localName) {
                      localNames.add(localName);
                      imports.push({
                        localName,
                        importedName: prop.key?.name || localName,
                        isDefault: false,
                        isNamespace: false,
                        kind: "require-destructured",
                      });
                    }
                  }
                }
              }
            }
          }
        }
      }

      if (imports.length === 0 && importSources.length === 0) {
        continue;
      }

      // Compute line starts for accurate line/col lookup
      const lineStarts: number[] = [0];
      for (let i = 0; i < content.length; i++) {
        if (content[i] === "\n") lineStarts.push(i + 1);
      }
      function getLineCol(offset: number): { line: number; column: number } {
        let low = 0;
        let high = lineStarts.length - 1;
        while (low <= high) {
          const mid = Math.floor((low + high) / 2);
          if (lineStarts[mid]! <= offset) {
            if (mid === lineStarts.length - 1 || lineStarts[mid + 1]! > offset) {
              return { line: mid + 1, column: offset - lineStarts[mid]! + 1 };
            }
            low = mid + 1;
          } else {
            high = mid - 1;
          }
        }
        return { line: 1, column: offset + 1 };
      }

      // 2. Walk AST to find genuine call sites and member references (not in strings or comments)
      const referencedLinesSet = new Set<number>();
      const astCallSites: AstCallSite[] = [];

      function walk(node: any, parentType?: string) {
        if (!node || typeof node !== "object") return;

        if (node.type === "CallExpression") {
          let localSymbol = "";
          let memberName: string | undefined;

          if (node.callee?.type === "Identifier" && localNames.has(node.callee.name)) {
            localSymbol = node.callee.name;
          } else if (
            node.callee?.type === "MemberExpression" &&
            node.callee.object?.type === "Identifier" &&
            localNames.has(node.callee.object.name)
          ) {
            localSymbol = node.callee.object.name;
            memberName = node.callee.property?.name;
          }

          if (localSymbol) {
            const { line, column } = getLineCol(node.start);
            referencedLinesSet.add(line);

            const argumentSpans = (node.arguments || []).map((arg: any) => ({
              start: arg.start,
              end: arg.end,
              text: content.slice(arg.start, arg.end),
            }));

            astCallSites.push({
              start: node.start,
              end: node.end,
              line,
              column,
              calleeText: content.slice(node.callee.start, node.callee.end),
              expressionType: "call",
              localSymbol,
              memberName,
              argumentCount: (node.arguments || []).length,
              argumentSpans,
            });
          }
        } else if (node.type === "MemberExpression") {
          if (node.object?.type === "Identifier" && localNames.has(node.object.name)) {
            const { line, column } = getLineCol(node.start);
            referencedLinesSet.add(line);

            if (parentType !== "CallExpression") {
              astCallSites.push({
                start: node.start,
                end: node.end,
                line,
                column,
                calleeText: content.slice(node.start, node.end),
                expressionType: "property-access",
                localSymbol: node.object.name,
                memberName: node.property?.name,
                argumentCount: 0,
                argumentSpans: [],
              });
            }
          }
        } else if (node.type === "Identifier") {
          if (localNames.has(node.name)) {
            const isImportDecl = Boolean(parentType?.startsWith("Import"));
            if (!isImportDecl) {
              const { line } = getLineCol(node.start);
              referencedLinesSet.add(line);
            }
          }
        }

        for (const key of Object.keys(node)) {
          if (key === "parent") continue;
          const child = node[key];
          if (Array.isArray(child)) {
            for (const item of child) {
              walk(item, node.type);
            }
          } else if (child && typeof child === "object") {
            walk(child, node.type);
          }
        }
      }

      walk(program);

      const referencedLines = Array.from(referencedLinesSet).sort((a, b) => a - b);

      callSites.push({
        filePath,
        sourceContent: content,
        importSources,
        imports,
        referencedLines,
        callSites: astCallSites,
      });
    } catch {
      // Ignore parser syntax errors in consumer files
    }
  }

  return callSites;
}
