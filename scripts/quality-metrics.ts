/**
 * Read-only code quality metrics: the baseline the refactor is measured against.
 *
 *   node scripts/quality-metrics.ts                 print the table for all packages
 *   node scripts/quality-metrics.ts --json out.json also write the numbers as JSON
 *   node scripts/quality-metrics.ts packages/core/src   limit to one or more directories
 *
 * Counts come from a real parse (oxc-parser), not regexes, so strings and comments do not skew
 * them. Tests, fixtures and generated output are skipped: the numbers describe shipped code.
 */
import { readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
const require = createRequire(join(root, "packages/core/package.json"));
const { parseSync } = require("oxc-parser") as {
  parseSync: (file: string, source: string) => { program: AstNode; errors: unknown[] };
};

interface AstNode {
  type: string;
  start: number;
  end: number;
  [key: string]: unknown;
}

const SKIPPED_DIRS = new Set([
  "node_modules",
  "dist",
  "coverage",
  "__tests__",
  "tests",
  "testing",
  "test",
  "fixtures",
  ".vite",
]);
const MAX_LINE = 100;
const FILE_LIMIT = 400;
const FUNCTION_LIMIT = 80;
const SYNC_FS = new Set([
  "readFileSync",
  "writeFileSync",
  "appendFileSync",
  "existsSync",
  "readdirSync",
  "statSync",
  "mkdirSync",
  "rmSync",
  "renameSync",
  "copyFileSync",
  "execSync",
  "spawnSync",
]);

function isSource(name: string): boolean {
  return /\.(ts|mts|cts)$/.test(name) && !/\.test\.|\.spec\.|\.d\.ts$/.test(name);
}

function collect(dir: string, out: string[]): void {
  for (const name of readdirSync(dir)) {
    if (SKIPPED_DIRS.has(name)) continue;
    const full = join(dir, name);
    if (statSync(full).isDirectory()) collect(full, out);
    else if (isSource(name)) out.push(full);
  }
}

interface Counts {
  files: number;
  lines: number;
  filesOver400: number;
  filesOver600: number;
  filesOver800: number;
  functions: number;
  functionsOver80: number;
  functionsOver100: number;
  asCasts: number;
  asUnknownAs: number;
  jsonParseCast: number;
  nonNull: number;
  anyKeyword: number;
  errorMessageIdiom: number;
  conditionalSpreads: number;
  nestedTernaries: number;
  bracelessIfMultiLine: number;
  bracelessIfOneLine: number;
  silentCatch: number;
  syncFsCalls: number;
  processEnvReads: number;
  longLines: number;
  moduleArrowFns: number;
  moduleFunctionDecls: number;
  typesFiles: number;
  indexFilesWithLogic: number;
  duplicateHelperNames: number;
}

function emptyCounts(): Counts {
  return {
    files: 0,
    lines: 0,
    filesOver400: 0,
    filesOver600: 0,
    filesOver800: 0,
    functions: 0,
    functionsOver80: 0,
    functionsOver100: 0,
    asCasts: 0,
    asUnknownAs: 0,
    jsonParseCast: 0,
    nonNull: 0,
    anyKeyword: 0,
    errorMessageIdiom: 0,
    conditionalSpreads: 0,
    nestedTernaries: 0,
    bracelessIfMultiLine: 0,
    bracelessIfOneLine: 0,
    silentCatch: 0,
    syncFsCalls: 0,
    processEnvReads: 0,
    longLines: 0,
    moduleArrowFns: 0,
    moduleFunctionDecls: 0,
    typesFiles: 0,
    indexFilesWithLogic: 0,
    duplicateHelperNames: 0,
  };
}

const FUNCTION_TYPES = new Set([
  "FunctionDeclaration",
  "FunctionExpression",
  "ArrowFunctionExpression",
]);

function unwrap(node: unknown): unknown {
  let current = node;
  while (isNode(current) && current.type === "ParenthesizedExpression") {
    current = current["expression"];
  }
  return current;
}

function isNode(value: unknown): value is AstNode {
  return typeof value === "object" && value !== null && typeof (value as AstNode).type === "string";
}

function calleeName(node: AstNode): string | undefined {
  const callee = node["callee"];
  if (!isNode(callee)) return undefined;
  if (callee.type === "Identifier") return callee["name"] as string;
  if (callee.type === "MemberExpression" && isNode(callee["property"])) {
    return callee["property"]["name"] as string | undefined;
  }
  return undefined;
}

function isProcessEnv(node: AstNode): boolean {
  const object = node["object"];
  return (
    node.type === "MemberExpression" &&
    isNode(object) &&
    object.type === "MemberExpression" &&
    isNode(object["object"]) &&
    object["object"]["name"] === "process" &&
    isNode(object["property"]) &&
    object["property"]["name"] === "env"
  );
}

interface FileContext {
  source: string;
  counts: Counts;
  lineOf: (offset: number) => number;
}

function createLineLookup(source: string): (offset: number) => number {
  const lineStarts = [0];
  for (let i = 0; i < source.length; i += 1) {
    if (source[i] === "\n") lineStarts.push(i + 1);
  }
  return (offset) => {
    let low = 0;
    let high = lineStarts.length - 1;
    while (low < high) {
      const mid = (low + high + 1) >> 1;
      if ((lineStarts[mid] ?? 0) <= offset) low = mid;
      else high = mid - 1;
    }
    return low + 1;
  };
}

function isUnknownCast(inner: unknown): boolean {
  return (
    isNode(inner) &&
    inner.type === "TSAsExpression" &&
    isNode(inner["typeAnnotation"]) &&
    inner["typeAnnotation"].type === "TSUnknownKeyword"
  );
}

function countCast(node: AstNode, { source, counts }: FileContext): void {
  const inner = unwrap(node["expression"]);
  const type = node["typeAnnotation"];
  const isConst = isNode(type) && isNode(type["typeName"]) && type["typeName"]["name"] === "const";
  if (!isConst) counts.asCasts += 1;
  if (isUnknownCast(inner)) counts.asUnknownAs += 1;
  const parsesJson =
    isNode(inner) &&
    inner.type === "CallExpression" &&
    source.slice(inner.start, inner.start + 10) === "JSON.parse";
  if (parsesJson) counts.jsonParseCast += 1;
}

function countTernary(node: AstNode, inTernary: boolean, { source, counts }: FileContext): void {
  if (inTernary) counts.nestedTernaries += 1;
  const firstLine = source.slice(node.start, node.end).split("\n")[0] ?? "";
  if (/instanceof Error\s*\?/.test(firstLine)) counts.errorMessageIdiom += 1;
}

function countIf(node: AstNode, { counts, lineOf }: FileContext): void {
  const consequent = node["consequent"];
  if (!isNode(consequent) || consequent.type === "BlockStatement") return;
  if (lineOf(node.start) === lineOf(consequent.end)) counts.bracelessIfOneLine += 1;
  else counts.bracelessIfMultiLine += 1;
}

function countFunction(node: AstNode, { counts, lineOf }: FileContext): void {
  counts.functions += 1;
  const length = lineOf(node.end) - lineOf(node.start) + 1;
  if (length > FUNCTION_LIMIT) counts.functionsOver80 += 1;
  if (length > 100) counts.functionsOver100 += 1;
}

function countNode(node: AstNode, inTernary: boolean, context: FileContext): void {
  const { counts } = context;
  if (FUNCTION_TYPES.has(node.type)) countFunction(node, context);
  switch (node.type) {
    case "TSAsExpression": {
      countCast(node, context);
      break;
    }
    case "TSNonNullExpression": {
      counts.nonNull += 1;
      break;
    }
    case "TSAnyKeyword": {
      counts.anyKeyword += 1;
      break;
    }
    case "ConditionalExpression": {
      countTernary(node, inTernary, context);
      break;
    }
    case "SpreadElement": {
      const argument = unwrap(node["argument"]);
      if (isNode(argument) && argument.type === "ConditionalExpression") {
        counts.conditionalSpreads += 1;
      }
      break;
    }
    case "IfStatement": {
      countIf(node, context);
      break;
    }
    case "CatchClause": {
      const body = node["body"];
      if (isNode(body) && Array.isArray(body["body"]) && body["body"].length === 0) {
        counts.silentCatch += 1;
      }
      break;
    }
    case "CallExpression": {
      const name = calleeName(node);
      if (name && SYNC_FS.has(name)) counts.syncFsCalls += 1;
      break;
    }
    case "MemberExpression": {
      if (isProcessEnv(node)) counts.processEnvReads += 1;
      break;
    }
    default: {
      break;
    }
  }
}

function walk(node: AstNode, inTernary: boolean, context: FileContext): void {
  countNode(node, inTernary, context);
  const nextTernary = FUNCTION_TYPES.has(node.type)
    ? false
    : node.type === "ConditionalExpression" || inTernary;
  for (const [key, value] of Object.entries(node)) {
    if (key === "type" || key === "start" || key === "end") continue;
    if (Array.isArray(value)) {
      for (const child of value) {
        if (isNode(child)) walk(child, nextTernary, context);
      }
    } else if (isNode(value)) {
      walk(value, nextTernary, context);
    }
  }
}

function countLines(source: string, rel: string, counts: Counts): void {
  const lines = source.split("\n");
  counts.files += 1;
  counts.lines += lines.length;
  if (lines.length > FILE_LIMIT) counts.filesOver400 += 1;
  if (lines.length > 600) counts.filesOver600 += 1;
  if (lines.length > 800) counts.filesOver800 += 1;
  counts.longLines += lines.filter((line) => line.length > MAX_LINE).length;
  if (rel.split(sep).at(-1) === "types.ts") counts.typesFiles += 1;
}

function recordHelper(id: unknown, rel: string, helperNames: Map<string, Set<string>>): void {
  if (!isNode(id) || typeof id["name"] !== "string") return;
  const owners = helperNames.get(id["name"]) ?? new Set<string>();
  owners.add(rel);
  helperNames.set(id["name"], owners);
}

/** Counts module-level function style and reports whether the file holds any logic. */
function countModuleDeclaration(
  statement: AstNode,
  rel: string,
  counts: Counts,
  helperNames: Map<string, Set<string>>,
): boolean {
  const exported =
    (statement.type === "ExportNamedDeclaration" ||
      statement.type === "ExportDefaultDeclaration") &&
    isNode(statement["declaration"]);
  const declaration = exported ? (statement["declaration"] as AstNode) : statement;
  if (declaration.type === "FunctionDeclaration") {
    counts.moduleFunctionDecls += 1;
    recordHelper(declaration["id"], rel, helperNames);
    return true;
  }
  if (declaration.type === "ClassDeclaration") return true;
  if (declaration.type !== "VariableDeclaration") return false;
  let hasLogic = false;
  for (const declarator of declaration["declarations"] as AstNode[]) {
    const init = declarator["init"];
    if (isNode(init) && init.type === "ArrowFunctionExpression") {
      counts.moduleArrowFns += 1;
      recordHelper(declarator["id"], rel, helperNames);
      hasLogic = true;
    }
  }
  return hasLogic;
}

function measureFile(
  file: string,
  counts: Counts,
  helperNames: Map<string, Set<string>>,
  rel: string,
): void {
  const source = readFileSync(file, "utf8");
  countLines(source, rel, counts);
  const context: FileContext = { source, counts, lineOf: createLineLookup(source) };
  const { program } = parseSync(file, source);
  let hasLogic = false;
  for (const statement of program["body"] as AstNode[]) {
    if (countModuleDeclaration(statement, rel, counts, helperNames)) hasLogic = true;
    walk(statement, false, context);
  }
  if (rel.split(sep).at(-1) === "index.ts" && hasLogic) counts.indexFilesWithLogic += 1;
}

function main(): void {
  const args = process.argv.slice(2);
  const jsonAt = args.indexOf("--json");
  const jsonOut = jsonAt !== -1 ? args[jsonAt + 1] : undefined;
  const dirs = args.filter((arg, index) => arg !== "--json" && index !== jsonAt + 1);
  const roots = dirs.length
    ? dirs.map((dir) => join(process.cwd(), dir))
    : readdirSync(join(root, "packages"))
        .map((name) => join(root, "packages", name, "src"))
        .filter((dir) => {
          try {
            return statSync(dir).isDirectory();
          } catch {
            return false;
          }
        });

  const results: Record<string, Counts> = {};
  const helperNames = new Map<string, Set<string>>();
  const biggest: { file: string; lines: number }[] = [];
  for (const dir of roots) {
    const files: string[] = [];
    collect(dir, files);
    const counts = emptyCounts();
    for (const file of files) {
      const rel = relative(root, file);
      measureFile(file, counts, helperNames, rel);
      biggest.push({ file: rel, lines: readFileSync(file, "utf8").split("\n").length });
    }
    results[relative(root, dir)] = counts;
  }
  const duplicated = [...helperNames.entries()]
    .filter(([, owners]) => owners.size > 1)
    .toSorted((a, b) => b[1].size - a[1].size);
  const first = Object.values(results)[0];
  if (first) first.duplicateHelperNames = duplicated.length;

  const keys = Object.keys(emptyCounts()) as (keyof Counts)[];
  const names = Object.keys(results);
  const width = Math.max(...keys.map((key) => key.length)) + 2;
  process.stdout.write(`${"metric".padEnd(width)}${names.map((n) => n.padStart(28)).join("")}\n`);
  for (const key of keys) {
    const cells = names.map((name) => String(results[name]?.[key] ?? 0).padStart(28));
    process.stdout.write(`${key.padEnd(width)}${cells.join("")}\n`);
  }
  const largest = biggest.toSorted((a, b) => b.lines - a.lines);
  process.stdout.write("\nlargest files\n");
  for (const { file, lines } of largest.slice(0, 10)) {
    process.stdout.write(`  ${String(lines).padStart(5)}  ${file}\n`);
  }
  process.stdout.write("\nhelper names defined in more than one file\n");
  for (const [name, owners] of duplicated.slice(0, 15)) {
    process.stdout.write(`  ${String(owners.size).padStart(3)}  ${name}\n`);
  }
  if (jsonOut) {
    writeFileSync(
      jsonOut,
      `${JSON.stringify({ results, duplicatedHelpers: duplicated.map(([n, o]) => [n, [...o]]) }, null, 2)}\n`,
    );
  }
}

main();
