/**
 * Code signals between two published versions of a package: what a fix for an injection, traversal,
 * prototype-pollution or ReDoS bug tends to add (a guard, a containment check, a length limit, a
 * sanitizer, a regular expression without nested quantifiers) or remove (an `eval`, a shell, an
 * `innerHTML` write). Found by walking the syntax tree of every file present in both versions, so
 * reformatting and comments do not count. A signal is something the new version has and the old one
 * did not (or the reverse for removed sinks), keyed by the normalised source text of the node.
 *
 * HEURISTIC. A guard can be added for a reason that has nothing to do with security. Each signal is
 * evidence for a human to read, never a statement that a vulnerability existed.
 */
import { parseSource, walk, type AstNode } from "../impact/ast.js";
import { evidenceLine, sanitizeEvidence } from "./sanitize.js";
import { RADAR_POINTS, type RadarFlag } from "./types.js";

type CodeSignal = keyof typeof RADAR_POINTS.code;

/** One occurrence of a pattern in one file. */
interface Finding {
  signal: CodeSignal;
  /** Normalised source text of the node: identity for "was this already there?". */
  key: string;
  line: number;
  /** Source of the line, for evidence. */
  snippet: string;
}

const MAX_FILE_BYTES = 1_500_000;
const MAX_FILES = 400;
const MAX_KEY = 160;

const SKIPPED_PATH =
  /(?:^|\/)(?:tests?|__tests__|specs?|examples?|benchmarks?|bench|fixtures?|docs?|coverage)\/|\.(?:test|spec)\.[cm]?[jt]sx?$|\.d\.[cm]?ts$|\.min\./i;

function lineStarts(code: string): number[] {
  const starts = [0];
  for (let index = 0; index < code.length; index++) {
    if (code[index] === "\n") starts.push(index + 1);
  }
  return starts;
}

function lineOf(starts: readonly number[], offset: number): number {
  let low = 0;
  let high = starts.length - 1;
  while (low < high) {
    const middle = Math.ceil((low + high) / 2);
    if ((starts[middle] ?? 0) <= offset) low = middle;
    else high = middle - 1;
  }
  return low + 1;
}

/** The `name` of an identifier-like node, or "" when it has none. */
const nameOf = (node: AstNode | undefined): string =>
  typeof node?.name === "string" ? node.name : "";

const str = (node: unknown): string | undefined =>
  typeof (node as AstNode | undefined)?.value === "string"
    ? ((node as AstNode).value as string)
    : undefined;

function asNode(value: unknown): AstNode | undefined {
  return typeof value === "object" && value !== null && typeof (value as AstNode).type === "string"
    ? (value as AstNode)
    : undefined;
}

/** `a.b.c` as text for simple member chains, else undefined. */
function dotted(node: AstNode | undefined): string | undefined {
  if (!node) return undefined;
  if (node.type === "Identifier") return String(node.name);
  if (node.type === "ThisExpression") return "this";
  if (node.type === "MemberExpression" && node.computed !== true) {
    const object = dotted(asNode(node.object));
    const property = asNode(node.property);
    return object !== undefined && property ? `${object}.${String(property.name)}` : undefined;
  }
  return undefined;
}

function calleeName(call: AstNode): string | undefined {
  const callee = asNode(call.callee);
  if (!callee) return undefined;
  if (callee.type === "Identifier") return String(callee.name);
  if (callee.type === "MemberExpression" && callee.computed !== true) {
    return nameOf(asNode(callee.property));
  }
  return undefined;
}

// ---------------------------------------------------------------------------------------------
// Regular expressions
// ---------------------------------------------------------------------------------------------

/**
 * Whether a regular expression has a shape known to backtrack catastrophically or quadratically:
 * a quantified group that itself contains a quantifier, two adjacent identical quantified atoms
 * (`\s*\s*`), or an unanchored `\s+$` / `\s*$`. Conservative: it names shapes, it does not prove
 * a bound.
 */
export function isRedosProne(source: string): boolean {
  if (/(\\[sdwSDW]|\.|\[[^\]]*\])[*+]\??\1[*+]/.test(source)) return true;
  if (!source.startsWith("^") && /(?:\\s|\[ \\t\]|\[\\s\])[*+]\$$/.test(source)) return true;

  const groups: Array<{ quantified: boolean }> = [];
  for (let index = 0; index < source.length; index++) {
    const char = source[index];
    if (char === "\\") {
      index++;
    } else if (char === "[") {
      // Skip a character class; `]` first is literal.
      index++;
      if (source[index] === "^") index++;
      if (source[index] === "]") index++;
      while (index < source.length && source[index] !== "]") {
        if (source[index] === "\\") index++;
        index++;
      }
    } else if (char === "(") {
      groups.push({ quantified: false });
    } else if (
      char === "+" ||
      char === "*" ||
      (char === "{" && /^\{\d+,\d*\}/.test(source.slice(index)))
    ) {
      const top = groups.at(-1);
      if (top) top.quantified = true;
    } else if (char === ")") {
      const closed = groups.pop();
      const next = source.slice(index + 1);
      if (closed?.quantified && /^(?:[+*]|\{\d+,\d*\})/.test(next)) return true;
      // The inner quantifier counts for the enclosing group too.
      const parent = groups.at(-1);
      if (closed?.quantified && parent) parent.quantified = true;
    }
  }
  return false;
}

function regexSource(node: AstNode): string | undefined {
  const regex = node.regex as { pattern?: string; flags?: string } | undefined;
  if (regex?.pattern !== undefined) return regex.pattern;
  return undefined;
}

// ---------------------------------------------------------------------------------------------
// Patterns
// ---------------------------------------------------------------------------------------------

const PROTO_NAMES = new Set(["__proto__", "constructor", "prototype"]);
const SANITIZER_NAME = /^(?:sanitiz|escape|encodeURI|purif|stripTags|stripHtml|htmlEscape)/i;
const VALIDATOR_NAME =
  /^(?:validate|isValid|assert[A-Z_]|isSafe|isPlainObject|checkPath|checkUrl|checkInput|ensure[A-Z])/;
const LIMIT_NAME =
  /^(?:MAX|LIMIT)_[A-Z_]*(?:LENGTH|SIZE|DEPTH|BYTES|LEN|COUNT)$|^MAX_?[A-Z_]*(?:LENGTH|SIZE|DEPTH|BYTES|LEN)$/;
const REJECTION_MESSAGE =
  /\binvalid\b|\billegal\b|\bforbidden\b|not allowed|\bunsafe\b|\bdisallowed\b|too (?:long|large|deep|big)|\bexceeds?\b|not permitted|\bunsupported\b.*\b(?:option|variable)\b/i;
const SINK_MODULES = new Set(["child_process", "node:child_process", "vm", "node:vm"]);
const SINK_MEMBERS = new Set(["innerHTML", "outerHTML", "dangerouslySetInnerHTML"]);

interface Context {
  code: string;
  starts: number[];
}

function normalised(context: Context, node: AstNode): string {
  return context.code.slice(node.start, node.end).replaceAll(/\s+/g, " ").slice(0, MAX_KEY);
}

function snippetAt(context: Context, line: number): string {
  const start = context.starts[line - 1] ?? 0;
  const end = context.starts[line] ?? context.code.length;
  return context.code.slice(start, end).trim();
}

function stringArgument(call: AstNode, index: number): string | undefined {
  const args = call.arguments as unknown[] | undefined;
  return str(args?.[index]);
}

function lengthMember(node: AstNode | undefined): boolean {
  return (
    node?.type === "MemberExpression" &&
    node.computed !== true &&
    asNode(node.property)?.name === "length"
  );
}

/** Every pattern occurrence in a parsed file. */
function collect(program: AstNode, context: Context): Finding[] {
  const findings: Finding[] = [];
  const add = (signal: CodeSignal, node: AstNode, key = normalised(context, node)): void => {
    const line = lineOf(context.starts, node.start);
    findings.push({ signal, key, line, snippet: snippetAt(context, line) });
  };

  // `throw new Error(INVALID_VARIABLE_TEXT)`: the message is a string constant declared in the file.
  const constants = new Map<string, string>();
  walk(program, (node) => {
    if (node.type === "VariableDeclarator") {
      const id = asNode(node.id);
      const text = str(asNode(node.init));
      if (id?.type === "Identifier" && text !== undefined) constants.set(String(id.name), text);
    }
    return true;
  });

  walk(program, (node) => {
    switch (node.type) {
      case "BinaryExpression": {
        const operator = String(node.operator);
        const left = asNode(node.left);
        const right = asNode(node.right);
        if (["===", "==", "!==", "!="].includes(operator)) {
          const literal = str(left) ?? str(right);
          if (literal !== undefined && PROTO_NAMES.has(literal)) add("prototype-guard-added", node);
        }
        if ([">", ">=", "<", "<="].includes(operator)) {
          const other = lengthMember(left) ? right : lengthMember(right) ? left : undefined;
          if (other) {
            const limitIdentifier =
              other.type === "Identifier" && LIMIT_NAME.test(String(other.name));
            const limitNumber =
              other.type === "Literal" && typeof other.value === "number" && other.value >= 64;
            if (limitIdentifier || limitNumber) add("length-limit-added", node);
          }
        }
        break;
      }
      case "SwitchCase": {
        const literal = str(asNode(node.test));
        if (literal !== undefined && PROTO_NAMES.has(literal) && literal !== "prototype") {
          add("prototype-guard-added", node, `case ${literal}`);
        }
        break;
      }
      case "VariableDeclarator": {
        const id = asNode(node.id);
        if (id?.type === "Identifier" && LIMIT_NAME.test(String(id.name))) {
          add("length-limit-added", node, `limit ${String(id.name)}`);
        }
        if (id?.type === "Identifier" && SANITIZER_NAME.test(String(id.name))) {
          add("sanitizer-added", node, `define ${String(id.name)}`);
        }
        break;
      }
      case "FunctionDeclaration": {
        const name = nameOf(asNode(node.id));
        if (SANITIZER_NAME.test(name)) add("sanitizer-added", node, `define ${name}`);
        else if (VALIDATOR_NAME.test(name)) add("validator-added", node, `define ${name}`);
        break;
      }
      case "ThrowStatement": {
        const thrown = asNode(node.argument);
        if (thrown?.type === "NewExpression") {
          const message = asNode((thrown.arguments as unknown[] | undefined)?.[0]);
          const text =
            str(message) ??
            (message?.type === "Identifier" ? constants.get(nameOf(message)) : undefined) ??
            (message?.type === "TemplateLiteral"
              ? (message.quasis as AstNode[] | undefined)
                  ?.map((quasi) => (quasi.value as { cooked?: string } | undefined)?.cooked ?? "")
                  .join(" ")
              : undefined);
          if (text !== undefined && REJECTION_MESSAGE.test(text)) {
            add("invalid-input-rejected", node, `throw ${text.slice(0, 100)}`);
          }
        }
        break;
      }
      case "NewExpression":
      case "CallExpression": {
        const name = calleeName(node);
        const callee = asNode(node.callee);
        const chain = dotted(callee);
        if (
          node.type === "NewExpression" &&
          callee?.type === "Identifier" &&
          callee.name === "RegExp"
        ) {
          const pattern = stringArgument(node, 0);
          if (pattern !== undefined)
            add(
              isRedosProne(pattern) ? "redos-regex-replaced" : "regex-changed",
              node,
              `regex /${pattern}/`,
            );
        }
        if (name !== undefined) {
          if (SANITIZER_NAME.test(name)) add("sanitizer-added", node, `call ${name}`);
          else if (VALIDATOR_NAME.test(name)) add("validator-added", node, `call ${name}`);
          if (name === "timingSafeEqual") add("timing-safe-compare-added", node, "timingSafeEqual");
          if (name === "hasOwn" || (name === "call" && chain?.endsWith("hasOwnProperty.call"))) {
            add("own-property-check-added", node, `own ${chain ?? name}`);
          }
          if (name === "create" && chain === "Object.create") {
            const first = (node.arguments as AstNode[] | undefined)?.[0];
            if (first?.type === "Literal" && first.value === null)
              add("null-prototype-object-added", node);
          }
          if (["includes", "indexOf", "startsWith", "endsWith"].includes(name)) {
            const needle = stringArgument(node, 0);
            if (needle?.includes("..")) add("traversal-check-added", node);
            else if (name === "startsWith") add("path-containment-added", node, "startsWith");
          }
          if (
            chain !== undefined &&
            /^(?:path\.)?(?:resolve|normalize|relative|isAbsolute)$|^fs\.realpath(?:Sync)?$/.test(
              chain,
            )
          ) {
            add("path-containment-added", node, `path ${chain}`);
          }
        }
        // Sinks: counted so that their disappearance can be seen.
        if (
          (node.type === "CallExpression" &&
            callee?.type === "Identifier" &&
            (callee.name === "eval" || callee.name === "Function")) ||
          (node.type === "NewExpression" &&
            callee?.type === "Identifier" &&
            callee.name === "Function") ||
          chain === "document.write" ||
          (chain?.startsWith("vm.run") ?? false)
        ) {
          add("dangerous-sink-removed", node);
        }
        if (name === "require") {
          const module = stringArgument(node, 0);
          if (module !== undefined && SINK_MODULES.has(module)) add("dangerous-sink-removed", node);
        }
        break;
      }
      case "ImportDeclaration": {
        const source = str(asNode(node.source));
        if (source !== undefined && SINK_MODULES.has(source)) add("dangerous-sink-removed", node);
        break;
      }
      case "Literal": {
        const source = regexSource(node);
        if (source !== undefined) {
          add(
            isRedosProne(source) ? "redos-regex-replaced" : "regex-changed",
            node,
            `regex /${source}/`,
          );
        }
        break;
      }
      case "AssignmentExpression": {
        const target = asNode(node.left);
        if (
          target?.type === "MemberExpression" &&
          target.computed !== true &&
          SINK_MEMBERS.has(String(asNode(target.property)?.name))
        ) {
          add("dangerous-sink-removed", node);
        }
        break;
      }
      default: {
        break;
      }
    }
    return true;
  });
  return findings;
}

// ---------------------------------------------------------------------------------------------
// Diff
// ---------------------------------------------------------------------------------------------

export interface FileVersions {
  before: ReadonlyMap<string, string>;
  after: ReadonlyMap<string, string>;
}

export interface CodeDiffResult {
  flags: RadarFlag[];
  filesCompared: number;
  filesChanged: number;
  /** Files skipped for size, count cap or parse failure. */
  filesSkipped: number;
}

interface Hit {
  signal: CodeSignal;
  file: string;
  line: number;
  snippet: string;
  key: string;
}

function parseFindings(file: string, code: string): Finding[] | undefined {
  const program = parseSource(file, code);
  if (!program) return undefined;
  return collect(program, { code, starts: lineStarts(code) });
}

function multiset(findings: readonly Finding[]): Map<string, number> {
  const counts = new Map<string, number>();
  for (const finding of findings) {
    const id = `${finding.signal}\u0000${finding.key}`;
    counts.set(id, (counts.get(id) ?? 0) + 1);
  }
  return counts;
}

const REMOVAL_SIGNALS = new Set<CodeSignal>([
  "dangerous-sink-removed",
  "redos-regex-replaced",
  "regex-changed",
]);
const ADDITION_SIGNALS = new Set<CodeSignal>([
  "prototype-guard-added",
  "traversal-check-added",
  "path-containment-added",
  "timing-safe-compare-added",
  "sanitizer-added",
  "invalid-input-rejected",
  "own-property-check-added",
  "null-prototype-object-added",
  "length-limit-added",
  "validator-added",
]);

/**
 * Compare two versions' files and return what changed in security-relevant ways. `release` labels
 * the flags (a version, or a span when several releases were diffed at once).
 */
export function codeDiffFlags(versions: FileVersions, release: string): CodeDiffResult {
  const hits: Hit[] = [];
  let filesCompared = 0;
  let filesChanged = 0;
  let filesSkipped = 0;

  const paths = [...versions.after.keys()]
    .filter((path) => versions.before.has(path) && !SKIPPED_PATH.test(path))
    .toSorted();
  for (const path of paths) {
    const before = versions.before.get(path) ?? "";
    const after = versions.after.get(path) ?? "";
    filesCompared++;
    if (before === after) continue;
    if (
      filesChanged >= MAX_FILES ||
      before.length > MAX_FILE_BYTES ||
      after.length > MAX_FILE_BYTES
    ) {
      filesSkipped++;
      continue;
    }
    filesChanged++;
    const was = parseFindings(path, before);
    const now = parseFindings(path, after);
    if (!was || !now) {
      filesSkipped++;
      continue;
    }
    const wasCounts = multiset(was);
    const nowCounts = multiset(now);

    const addedRegexes = now.filter(
      (finding) =>
        (finding.signal === "regex-changed" || finding.signal === "redos-regex-replaced") &&
        (nowCounts.get(`${finding.signal}\u0000${finding.key}`) ?? 0) >
          (wasCounts.get(`${finding.signal}\u0000${finding.key}`) ?? 0),
    );
    const safeReplacement = addedRegexes.find((finding) => finding.signal === "regex-changed");

    const spent = new Map<string, number>();
    for (const finding of now) {
      if (!ADDITION_SIGNALS.has(finding.signal)) continue;
      const id = `${finding.signal}\u0000${finding.key}`;
      const used = (spent.get(id) ?? 0) + 1;
      spent.set(id, used);
      if (used > (wasCounts.get(id) ?? 0)) {
        hits.push({
          signal: finding.signal,
          file: path,
          line: finding.line,
          snippet: finding.snippet,
          key: finding.key,
        });
      }
    }
    // Removals are read from the old version: report the line it had there.
    const removedSpent = new Map<string, number>();
    for (const finding of was) {
      if (!REMOVAL_SIGNALS.has(finding.signal)) continue;
      const id = `${finding.signal}\u0000${finding.key}`;
      const used = (removedSpent.get(id) ?? 0) + 1;
      removedSpent.set(id, used);
      if (used <= (nowCounts.get(id) ?? 0)) continue;
      if (finding.signal === "redos-regex-replaced") {
        hits.push({
          signal: safeReplacement ? "redos-regex-replaced" : "redos-regex-removed",
          file: path,
          line: finding.line,
          snippet: `${finding.key}${safeReplacement ? ` -> ${safeReplacement.key}` : " (removed)"}`,
          key: finding.key,
        });
      } else if (finding.signal === "regex-changed") {
        hits.push({
          signal: "regex-changed",
          file: path,
          line: finding.line,
          snippet: finding.key,
          key: finding.key,
        });
      } else {
        hits.push({
          signal: finding.signal,
          file: path,
          line: finding.line,
          snippet: finding.snippet,
          key: finding.key,
        });
      }
    }
  }

  // Path containment needs both halves in one file: a resolve/relative and a prefix check.
  const containment = hits.filter((hit) => hit.signal === "path-containment-added");
  const filesWithBoth = new Set(
    containment
      .filter((hit) => hit.key === "startsWith")
      .map((hit) => hit.file)
      .filter((file) =>
        containment.some((other) => other.file === file && other.key !== "startsWith"),
      ),
  );
  const kept = hits.filter(
    (hit) => hit.signal !== "path-containment-added" || filesWithBoth.has(hit.file),
  );

  const bySignal = new Map<CodeSignal, Hit[]>();
  for (const hit of kept) bySignal.set(hit.signal, [...(bySignal.get(hit.signal) ?? []), hit]);

  const flags: RadarFlag[] = [];
  for (const [signal, group] of bySignal) {
    const first = group[0];
    if (!first) continue;
    flags.push({
      category: "code",
      signal,
      release,
      points: RADAR_POINTS.code[signal],
      location: sanitizeEvidence(`${first.file}:${first.line}`, 160),
      evidence: evidenceLine(`${first.file}:${first.line}`, first.snippet),
      occurrences: group.length,
    });
  }
  return {
    flags: flags.toSorted((a, b) => b.points - a.points || a.signal.localeCompare(b.signal)),
    filesCompared,
    filesChanged,
    filesSkipped,
  };
}

const meaningfulLines = (text: string): string[] =>
  text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(
      (line) =>
        line !== "" && !line.startsWith("//") && !line.startsWith("*") && !line.startsWith("/*"),
    );

/** Added and removed non-blank lines between two files (multiset difference), for a model to read. */
export function lineDiff(before: string, after: string): { added: string[]; removed: string[] } {
  const counts = new Map<string, number>();
  for (const line of meaningfulLines(before)) counts.set(line, (counts.get(line) ?? 0) + 1);
  const added: string[] = [];
  for (const line of meaningfulLines(after)) {
    const left = counts.get(line) ?? 0;
    if (left > 0) counts.set(line, left - 1);
    else added.push(line);
  }
  const removed: string[] = [];
  for (const [line, count] of counts)
    for (let index = 0; index < count; index++) removed.push(line);
  return { added, removed };
}
