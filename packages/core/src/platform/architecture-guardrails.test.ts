import { existsSync, readdirSync, readFileSync } from "node:fs";
import { basename, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { parseSync, type ParseResult } from "oxc-parser";

/**
 * Architecture Guardrails Test Suite
 *
 * Enforces quality engineering constraints across packages/core and packages/github-app:
 * 1. Banning compiler suppression comments (@ts-expect-error, @ts-ignore, @ts-nocheck) in production code.
 * 2. Banning string-based injection / templating of suppression comments in refactor/healing transforms.
 * 3. Banning test suites that assert or certify compiler suppression comment injection.
 * 4. Banning stubbed tool returns and mock-only execution paths.
 * 5. Banning tautological test assertions (e.g. expect(x).toBe(x) or identical mock threading).
 * 6. Enforcing file line count thresholds on high-churn orchestration files.
 *
 * Migration Phasing & Ratcheted Baseline:
 * When STRICT_GUARDRAILS=true is set in the environment, all checks run in zero-tolerance mode.
 * In default ratcheted baseline mode, pre-existing legacy issues from the survey phase are
 * explicitly tracked, and any NEW violation fails immediately. As milestones land fixes,
 * legacy baseline items are retired.
 */

const STRICT_MODE = process.env.STRICT_GUARDRAILS === "true";

interface FileGuardrail {
  path: string;
  maxLines: number;
  reason: string;
}

interface Violation {
  file: string;
  line: number;
  content: string;
  rule: string;
}

// Known legacy baseline violation counts tracked for phased remediation across Milestones 2-5:
const BASELINE_STATIC_SUPPRESSION_COUNTS: Record<string, number> = {};

const BASELINE_INJECTION_COUNTS: Record<string, number> = {};

const BASELINE_ASSERTION_COUNTS: Record<string, number> = {};

const BASELINE_EMPTY_CATCH_COUNTS: Record<string, number> = {
  "packages/core/src/remediation/local/run.ts": 1,
  "packages/core/src/api/patches/reconcile.ts": 1,
};

/**
 * Evaluates violations against ratcheted baseline counts.
 * In STRICT_MODE, any violation fails immediately.
 * In default ratcheted mode, violations up to the baseline count per file are permitted,
 * but any additional violation in a baseline file, or any violation in an unlisted file, fails.
 */
export function getUnexpectedViolations(
  violations: Violation[],
  baselineCounts: Record<string, number>,
): Violation[] {
  if (STRICT_MODE) return violations;

  const byFile = new Map<string, Violation[]>();
  for (const v of violations) {
    const list = byFile.get(v.file) ?? [];
    list.push(v);
    byFile.set(v.file, list);
  }

  const unexpected: Violation[] = [];
  for (const [file, fileViolations] of byFile.entries()) {
    const allowed = baselineCounts[file] ?? 0;
    if (fileViolations.length > allowed) {
      unexpected.push(...fileViolations.slice(allowed));
    }
  }

  return unexpected;
}

/**
 * Resolves repository root regardless of whether tests are run from repository
 * root or from packages/core subdirectory.
 */
export function findRepoRoot(startDir: string = process.cwd()): string {
  let curr = resolve(startDir);
  while (curr !== resolve(curr, "..")) {
    if (
      existsSync(join(curr, "pnpm-workspace.yaml")) ||
      existsSync(join(curr, "packages/core/package.json"))
    ) {
      return curr;
    }
    curr = resolve(curr, "..");
  }
  return startDir;
}

/**
 * Recursively collects all TypeScript files under target directories.
 */
export function collectSourceFiles(
  dir: string,
  filter: (fileName: string) => boolean = () => true,
): string[] {
  if (!existsSync(dir)) return [];
  const files: string[] = [];
  const entries = readdirSync(dir, { withFileTypes: true });

  for (const entry of entries) {
    const fullPath = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (
        !["node_modules", "dist", "build", "coverage", ".turbo", ".pnpm-store"].includes(entry.name)
      ) {
        files.push(...collectSourceFiles(fullPath, filter));
      }
    } else if (entry.isFile() && (entry.name.endsWith(".ts") || entry.name.endsWith(".tsx"))) {
      if (filter(entry.name)) {
        files.push(fullPath);
      }
    }
  }

  return files;
}

/**
 * Generic AST walker for oxc-parser program tree.
 */
export function walkAst(node: any, callback: (node: any) => void): void {
  if (!node || typeof node !== "object") return;
  callback(node);
  for (const key of Object.keys(node)) {
    if (key === "parent") continue;
    const child = node[key];
    if (Array.isArray(child)) {
      for (const item of child) {
        walkAst(item, callback);
      }
    } else if (child && typeof child === "object") {
      walkAst(child, callback);
    }
  }
}

export const DYNAMIC_FRAGMENT = Symbol("DYNAMIC_FRAGMENT");

/**
 * Normalizes and decodes hex (\x40), unicode (\u0040, \u{40}), and octal (\100) escape
 * sequences in string content.
 */
export function decodeEscapeSequences(str: string): string {
  if (typeof str !== "string") return "";
  return str
    .replace(/\\x([0-9a-fA-F]{2})/g, (_, hex) => String.fromCharCode(parseInt(hex, 16)))
    .replace(/\\u([0-9a-fA-F]{4})/g, (_, hex) => String.fromCharCode(parseInt(hex, 16)))
    .replace(/\\u\{([0-9a-fA-F]+)\}/g, (_, hex) => String.fromCodePoint(parseInt(hex, 16)))
    .replace(/\\([0-3][0-7]{2}|[0-7]{1,2})/g, (_, oct) => String.fromCharCode(parseInt(oct, 8)));
}

/**
 * Unwraps nested ParenthesizedExpression AST wrappers to expose the inner expression.
 */
export function unwrapParentheses(node: any): any {
  let curr = node;
  while (curr && curr.type === "ParenthesizedExpression") {
    curr = curr.expression;
  }
  return curr;
}

/**
 * Recursively flattens an AST expression node into an array of string fragments or
 * DYNAMIC_FRAGMENT sentinels for non-statically evaluatable boundaries.
 * Traversed child nodes are recorded in `visitedNodes` to prevent redundant inspections.
 */
export function flattenStringExpression(
  node: any,
  visitedNodes?: Set<any>,
  constMap?: Map<string, string>,
): Array<string | typeof DYNAMIC_FRAGMENT> {
  if (!node) return [DYNAMIC_FRAGMENT];
  if (visitedNodes) visitedNodes.add(node);

  // Unwrap parentheses and TypeScript assertion wrappers
  if (
    node.type === "ParenthesizedExpression" ||
    node.type === "TSAsExpression" ||
    node.type === "TSTypeAssertion" ||
    node.type === "TSNonNullExpression" ||
    node.type === "TSSatisfiesExpression" ||
    node.type === "TSInstantiationExpression"
  ) {
    return flattenStringExpression(node.expression, visitedNodes, constMap);
  }

  // Tagged template expressions (e.g. dedent`...`)
  if (node.type === "TaggedTemplateExpression") {
    return flattenStringExpression(node.quasi, visitedNodes, constMap);
  }

  // Locally declared const variable resolution
  if (node.type === "Identifier" && constMap?.has(node.name)) {
    return [constMap.get(node.name)!];
  }

  // String literal nodes
  if (node.type === "Literal" && typeof node.value === "string") {
    return [decodeEscapeSequences(node.value)];
  }

  // Numeric literals inside string expressions
  if (node.type === "Literal" && typeof node.value === "number") {
    return [String(node.value)];
  }

  // Template literals (interleaving quasis and interpolated expressions)
  if (node.type === "TemplateLiteral") {
    const parts: Array<string | typeof DYNAMIC_FRAGMENT> = [];
    const quasis = node.quasis || [];
    const expressions = node.expressions || [];
    for (let i = 0; i < quasis.length; i++) {
      if (visitedNodes) visitedNodes.add(quasis[i]);
      const rawVal = quasis[i].value?.raw ?? "";
      const cookedVal = quasis[i].value?.cooked;
      const strVal = cookedVal !== undefined && cookedVal !== null ? cookedVal : rawVal;
      parts.push(decodeEscapeSequences(strVal));
      if (i < expressions.length) {
        parts.push(...flattenStringExpression(expressions[i], visitedNodes, constMap));
      }
    }
    return parts;
  }

  // Binary concatenation (+)
  if (node.type === "BinaryExpression" && node.operator === "+") {
    return [
      ...flattenStringExpression(node.left, visitedNodes, constMap),
      ...flattenStringExpression(node.right, visitedNodes, constMap),
    ];
  }

  // Call expressions: String.fromCharCode, String.fromCodePoint, Array.prototype.join, String.prototype.concat
  if (node.type === "CallExpression") {
    const callee = node.callee;

    // String.fromCharCode(...) / String.fromCodePoint(...)
    if (
      callee?.type === "MemberExpression" &&
      callee.object?.type === "Identifier" &&
      callee.object.name === "String" &&
      (callee.property?.name === "fromCharCode" || callee.property?.name === "fromCodePoint")
    ) {
      const codeNumbers: number[] = [];
      let allNumeric = true;
      for (const arg of node.arguments || []) {
        if (visitedNodes) visitedNodes.add(arg);
        if (arg.type === "Literal" && typeof arg.value === "number") {
          codeNumbers.push(arg.value);
        } else {
          allNumeric = false;
          break;
        }
      }
      if (allNumeric && codeNumbers.length > 0) {
        try {
          return [
            callee.property.name === "fromCharCode"
              ? String.fromCharCode(...codeNumbers)
              : String.fromCodePoint(...codeNumbers),
          ];
        } catch {
          return [DYNAMIC_FRAGMENT];
        }
      }
    }

    // Array.prototype.join (e.g. ["// @ts", "expect-error"].join("-"))
    if (
      callee?.type === "MemberExpression" &&
      callee.object?.type === "ArrayExpression" &&
      callee.property?.name === "join"
    ) {
      const parts: string[] = [];
      let allStatic = true;
      for (const el of callee.object.elements || []) {
        const frags = flattenStringExpression(el, visitedNodes, constMap);
        if (frags.includes(DYNAMIC_FRAGMENT)) {
          allStatic = false;
          break;
        }
        parts.push(frags.join(""));
      }
      if (allStatic) {
        let separator = ",";
        if (node.arguments?.length > 0) {
          const sepFrags = flattenStringExpression(node.arguments[0], visitedNodes, constMap);
          if (sepFrags.includes(DYNAMIC_FRAGMENT)) {
            allStatic = false;
          } else {
            separator = sepFrags.join("");
          }
        }
        if (allStatic) {
          return [parts.join(separator)];
        }
      }
    }

    // String.prototype.concat (e.g. "// @ts-".concat("expect-error"))
    if (callee?.type === "MemberExpression" && callee.property?.name === "concat") {
      const objFrags = flattenStringExpression(callee.object, visitedNodes, constMap);
      const argFrags: Array<string | typeof DYNAMIC_FRAGMENT> = [];
      for (const arg of node.arguments || []) {
        argFrags.push(...flattenStringExpression(arg, visitedNodes, constMap));
      }
      return [...objFrags, ...argFrags];
    }
  }

  return [DYNAMIC_FRAGMENT];
}

/**
 * Extracts contiguous static string runs between DYNAMIC_FRAGMENT boundaries.
 */
export function extractContiguousStaticRuns(
  fragments: Array<string | typeof DYNAMIC_FRAGMENT>,
): string[] {
  const runs: string[] = [];
  let currentRun = "";
  for (const f of fragments) {
    if (f === DYNAMIC_FRAGMENT) {
      if (currentRun) {
        runs.push(currentRun);
        currentRun = "";
      }
    } else {
      currentRun += f;
    }
  }
  if (currentRun) runs.push(currentRun);
  return runs;
}

/**
 * Evaluates static string concatenation, templates, and parenthesized expressions.
 */
export function extractStaticString(node: any): string | null {
  if (!node) return null;
  if (node.type === "Literal" && typeof node.value === "string")
    return decodeEscapeSequences(node.value);
  if (node.type === "TemplateLiteral") {
    let str = "";
    for (let i = 0; i < (node.quasis?.length ?? 0); i++) {
      const quasi = node.quasis[i];
      str += decodeEscapeSequences(quasi.value?.cooked ?? quasi.value?.raw ?? "");
      if (i < (node.expressions?.length ?? 0)) {
        const exprVal = extractStaticString(node.expressions[i]);
        if (exprVal === null) return null;
        str += exprVal;
      }
    }
    return str;
  }
  if (node.type === "BinaryExpression" && node.operator === "+") {
    const left = extractStaticString(node.left);
    const right = extractStaticString(node.right);
    if (left !== null && right !== null) return left + right;
  }
  if (node.type === "ParenthesizedExpression") {
    return extractStaticString(node.expression);
  }
  return null;
}

const SUPPRESSION_REGEX = /@ts-(?:expect-error|ignore|nocheck)/;

/**
 * Checks whether an AST node or its child arguments/expressions evaluate to or contain
 * a compiler suppression directive.
 */
export function nodeMentionsSuppression(node: any): boolean {
  if (!node) return false;
  const staticStr = extractStaticString(node);
  if (staticStr && SUPPRESSION_REGEX.test(staticStr)) return true;
  if (node.regex && SUPPRESSION_REGEX.test(node.regex.pattern)) return true;
  if (
    node.type === "Literal" &&
    typeof node.value === "string" &&
    SUPPRESSION_REGEX.test(decodeEscapeSequences(node.value))
  )
    return true;
  if (node.type === "TemplateLiteral" && Array.isArray(node.quasis)) {
    for (const q of node.quasis) {
      const text = q.value?.cooked ?? q.value?.raw ?? "";
      if (SUPPRESSION_REGEX.test(decodeEscapeSequences(text))) return true;
    }
  }
  if (node.type === "CallExpression") {
    for (const arg of node.arguments || []) {
      if (nodeMentionsSuppression(arg)) return true;
    }
  }
  if (node.type === "BinaryExpression") {
    if (nodeMentionsSuppression(node.left) || nodeMentionsSuppression(node.right)) return true;
  }
  if (node.type === "ParenthesizedExpression") {
    return nodeMentionsSuppression(node.expression);
  }
  return false;
}

/**
 * Detects positive assertions that certify or expect compiler suppression comments.
 * Inverted assertions (e.g. .not.toContain, .toBe(false), .toBeFalsy()) are permitted.
 */
export function isCertifyingSuppressionAssertion(node: any): boolean {
  if (!node || node.type !== "CallExpression") return false;

  if (node.callee?.type === "MemberExpression") {
    const matcherName = node.callee.property?.name;
    let curr = node.callee.object;
    let isNegated = false;
    let expectCall: any = null;

    while (curr) {
      if (curr.type === "MemberExpression") {
        if (curr.property?.name === "not") isNegated = !isNegated;
        curr = curr.object;
      } else if (curr.type === "CallExpression") {
        if (
          curr.callee?.type === "Identifier" &&
          (curr.callee.name === "expect" || curr.callee.name === "assert")
        ) {
          expectCall = curr;
          break;
        }
        if (curr.callee?.type === "MemberExpression" && curr.callee.object?.name === "expect") {
          expectCall = curr;
          break;
        }
        break;
      } else {
        break;
      }
    }

    if (expectCall) {
      if (
        ["toContain", "toMatch", "toBe", "toEqual", "toStrictEqual", "include"].includes(
          matcherName,
        )
      ) {
        const expectedMentions = (node.arguments || []).some((arg: any) =>
          nodeMentionsSuppression(arg),
        );
        if (expectedMentions) return !isNegated;
      }

      const subject = expectCall.arguments?.[0];
      if (subject && nodeMentionsSuppression(subject)) {
        if (["toBe", "toEqual", "toStrictEqual"].includes(matcherName)) {
          const expectedArg = node.arguments?.[0];
          if (expectedArg?.type === "Literal" && typeof expectedArg.value === "boolean") {
            const expectsTrue = expectedArg.value === true;
            return isNegated ? !expectsTrue : expectsTrue;
          }
        }
        if (matcherName === "toBeTruthy") return !isNegated;
        if (matcherName === "toBeFalsy") return isNegated;
      }
    }

    if (curr?.type === "Identifier" && curr.name === "assert") {
      if (["include", "match", "equal", "strictEqual", "deepEqual"].includes(matcherName)) {
        const expectedArg = node.arguments?.[1];
        if (expectedArg && nodeMentionsSuppression(expectedArg)) return true;
      }
      if (["notInclude", "notMatch", "notEqual", "notStrictEqual"].includes(matcherName))
        return false;
      if (["isTrue", "ok"].includes(matcherName)) {
        const pred = node.arguments?.[0];
        if (pred && nodeMentionsSuppression(pred)) return true;
      }
    }
  }

  if (node.callee?.type === "Identifier" && node.callee.name === "assert") {
    const firstArg = node.arguments?.[0];
    if (firstArg) {
      if (firstArg.type === "UnaryExpression" && firstArg.operator === "!") return false;
      if (nodeMentionsSuppression(firstArg)) return true;
    }
  }

  return false;
}

/**
 * Determines whether two AST expressions are structurally or textually equivalent.
 */
export function areExpressionsEquivalent(a: any, b: any, content: string): boolean {
  const unwrappedA = unwrapParentheses(a);
  const unwrappedB = unwrapParentheses(b);
  if (!unwrappedA || !unwrappedB) return false;

  if (unwrappedA.type === "Identifier" && unwrappedB.type === "Identifier") {
    return unwrappedA.name === unwrappedB.name;
  }
  if (unwrappedA.type === "Literal" && unwrappedB.type === "Literal") {
    return unwrappedA.value === unwrappedB.value;
  }
  const sliceA = content.slice(unwrappedA.start, unwrappedA.end).replace(/\s+/g, " ").trim();
  const sliceB = content.slice(unwrappedB.start, unwrappedB.end).replace(/\s+/g, " ").trim();
  return sliceA === sliceB;
}

/**
 * Detects self-referential tautological identity assertions.
 */
export function checkTautology(node: any, content: string): string | null {
  if (!node || node.type !== "CallExpression") return null;
  const callee = node.callee;
  if (callee?.type !== "MemberExpression") return null;
  const matcherName = callee.property?.name;

  if (["toBe", "toEqual", "toStrictEqual"].includes(matcherName)) {
    const expectCall = callee.object;
    if (expectCall?.type === "CallExpression" && expectCall.callee?.name === "expect") {
      const actualArg = expectCall.arguments?.[0];
      const expectedArg = node.arguments?.[0];
      if (actualArg && expectedArg) {
        if (areExpressionsEquivalent(actualArg, expectedArg, content)) {
          const actSlice = content.slice(actualArg.start, actualArg.end).trim();
          const expSlice = content.slice(expectedArg.start, expectedArg.end).trim();
          return `expect(${actSlice}).${matcherName}(${expSlice})`;
        }
      }
    }
  }

  const expectCall = callee.object;
  if (expectCall?.type === "CallExpression" && expectCall.callee?.name === "expect") {
    const actualArg = unwrapParentheses(expectCall.arguments?.[0]);
    if (
      actualArg?.type === "BinaryExpression" &&
      ["===", "==", "!==", "!="].includes(actualArg.operator)
    ) {
      if (areExpressionsEquivalent(actualArg.left, actualArg.right, content)) {
        return content.slice(node.start, node.end);
      }
    }
  }

  return null;
}

// Target workspace source roots
const REPO_ROOT = findRepoRoot();
const CORE_SRC = join(REPO_ROOT, "packages/core/src");
const GITHUB_APP_SRC = join(REPO_ROOT, "packages/github-app/src");

// Categorized file collections
const isTestFile = (name: string) =>
  name.endsWith(".test.ts") ||
  name.endsWith(".test.tsx") ||
  name.endsWith(".spec.ts") ||
  name.endsWith(".spec.tsx");
const isProductionFile = (name: string) => !isTestFile(name) && !name.endsWith(".d.ts");

const allProductionFiles = [
  ...collectSourceFiles(CORE_SRC, isProductionFile),
  ...collectSourceFiles(GITHUB_APP_SRC, isProductionFile),
];

const allTestFiles = [
  ...collectSourceFiles(CORE_SRC, isTestFile),
  ...collectSourceFiles(GITHUB_APP_SRC, isTestFile),
];

describe("architecture guardrails: quality verification", () => {
  // --------------------------------------------------------------------------
  // Suite 1: Compiler Suppression Guardrails (@ts-expect-error, @ts-ignore)
  // --------------------------------------------------------------------------
  describe("compiler suppression guardrails", () => {
    it("bans static @ts-expect-error, @ts-ignore, and @ts-nocheck comments across all production source files", () => {
      const suppressionCommentRegex =
        /\/\/\s*@ts-(expect-error|ignore|nocheck)|\/\*[\s\S]*?@ts-(expect-error|ignore|nocheck)/;
      const violations: Violation[] = [];

      for (const filePath of allProductionFiles) {
        const content = readFileSync(filePath, "utf8");
        const relPath = relative(REPO_ROOT, filePath);

        // 1. Check via oxc-parser extracted comments
        let parsed: ParseResult | undefined;
        try {
          parsed = parseSync(filePath, content);
        } catch {
          // fallback to regex scanning if parse fails
        }

        if (parsed?.comments) {
          for (const comment of parsed.comments) {
            if (/@ts-(expect-error|ignore|nocheck)/.test(comment.value)) {
              const line = content.slice(0, comment.start).split("\n").length;
              violations.push({
                file: relPath,
                line,
                content: comment.value.trim(),
                rule: "ban-ts-comment-in-production-code",
              });
            }
          }
        } else {
          // Fallback line scanner
          const lines = content.split("\n");
          lines.forEach((lineText: string, idx: number) => {
            if (suppressionCommentRegex.test(lineText)) {
              violations.push({
                file: relPath,
                line: idx + 1,
                content: lineText.trim(),
                rule: "ban-ts-comment-in-production-code",
              });
            }
          });
        }
      }

      const unexpectedViolations = getUnexpectedViolations(
        violations,
        BASELINE_STATIC_SUPPRESSION_COUNTS,
      );

      const formatted = unexpectedViolations
        .map((v) => `  [${v.rule}] ${v.file}:${v.line} -> "${v.content}"`)
        .join("\n");

      expect(
        unexpectedViolations,
        `Found ${unexpectedViolations.length} compiler suppression comment(s) in production source files:\n${formatted}`,
      ).toHaveLength(0);
    });

    it("bans programmatic injection / string templating of suppression comments in refactoring and healing transforms", () => {
      const suppressionRegex = /@ts-(?:expect-error|ignore|nocheck)/;
      const injectionFallbackRegex =
        /["'`][^"'`\n]*(?:@ts-|\\x40ts-|\\u0040ts-|\\u\{40\}ts-)(?:expect-error|ignore|nocheck)/i;
      const violations: Violation[] = [];

      for (const filePath of allProductionFiles) {
        const content = readFileSync(filePath, "utf8");
        const relPath = relative(REPO_ROOT, filePath);

        let parsed: ParseResult | undefined;
        try {
          parsed = parseSync(filePath, content);
        } catch {
          // continue to line scan
        }

        if (parsed?.program) {
          // Pass 1: Collect statically known const string declarations in file scope
          const constMap = new Map<string, string>();
          walkAst(parsed.program, (node) => {
            if (node.type === "VariableDeclaration" && node.kind === "const") {
              for (const decl of node.declarations || []) {
                if (decl.id?.type === "Identifier" && decl.init) {
                  const frags = flattenStringExpression(decl.init, undefined, constMap);
                  if (!frags.includes(DYNAMIC_FRAGMENT)) {
                    constMap.set(decl.id.name, frags.join(""));
                  }
                }
              }
            }
          });

          // Pass 2: Inspect all string expressions and concatenations
          const visitedNodes = new Set<any>();
          walkAst(parsed.program, (node) => {
            if (visitedNodes.has(node)) return;

            let isCandidate = false;
            if (node.type === "Literal" && typeof node.value === "string") {
              isCandidate = true;
            } else if (node.type === "TemplateLiteral") {
              isCandidate = true;
            } else if (node.type === "TaggedTemplateExpression") {
              isCandidate = true;
            } else if (node.type === "BinaryExpression" && node.operator === "+") {
              isCandidate = true;
            } else if (node.type === "CallExpression") {
              const prop = node.callee?.property?.name;
              if (
                prop === "join" ||
                prop === "concat" ||
                prop === "fromCharCode" ||
                prop === "fromCodePoint"
              ) {
                isCandidate = true;
              }
            }

            if (isCandidate) {
              const fragments = flattenStringExpression(node, visitedNodes, constMap);
              const runs = extractContiguousStaticRuns(fragments);
              for (const run of runs) {
                if (suppressionRegex.test(run)) {
                  const line = content.slice(0, node.start).split("\n").length;
                  violations.push({
                    file: relPath,
                    line,
                    content: run.trim().slice(0, 100),
                    rule: "ban-programmatic-suppression-injection",
                  });
                  break;
                }
              }
            }
          });
        } else {
          // Fallback line regex scan
          const lines = content.split("\n");
          lines.forEach((lineText: string, idx: number) => {
            if (injectionFallbackRegex.test(lineText)) {
              violations.push({
                file: relPath,
                line: idx + 1,
                content: lineText.trim(),
                rule: "ban-programmatic-suppression-injection",
              });
            }
          });
        }
      }

      const unexpectedViolations = getUnexpectedViolations(violations, BASELINE_INJECTION_COUNTS);

      const formatted = unexpectedViolations
        .map((v) => `  [${v.rule}] ${v.file}:${v.line} -> "${v.content}"`)
        .join("\n");

      expect(
        unexpectedViolations,
        `Found ${unexpectedViolations.length} programmatic suppression injection(s) in source code:\n${formatted}`,
      ).toHaveLength(0);
    });

    it("bans test suites from asserting successful injection of compiler suppression comments", () => {
      const currentTestFile = basename(fileURLToPath(import.meta.url));
      const assertionRegex =
        /expect\([^)]*\)\.(?:toContain|toMatch|toBe|toEqual)\([^)]*@ts-(?:expect-error|ignore|nocheck)/;
      const violations: Violation[] = [];

      for (const filePath of allTestFiles) {
        if (filePath.endsWith(currentTestFile)) continue;
        const content = readFileSync(filePath, "utf8");
        const relPath = relative(REPO_ROOT, filePath);

        let parsed: ParseResult | undefined;
        try {
          parsed = parseSync(filePath, content);
        } catch {
          // fallback to regex if parse fails
        }

        if (parsed?.program) {
          walkAst(parsed.program, (node) => {
            if (isCertifyingSuppressionAssertion(node)) {
              const line = content.slice(0, node.start).split("\n").length;
              violations.push({
                file: relPath,
                line,
                content: content.slice(node.start, node.end).trim(),
                rule: "ban-certifying-suppression-assertions",
              });
            }
          });
        } else {
          const lines = content.split("\n");
          lines.forEach((lineText: string, idx: number) => {
            if (assertionRegex.test(lineText)) {
              violations.push({
                file: relPath,
                line: idx + 1,
                content: lineText.trim(),
                rule: "ban-certifying-suppression-assertions",
              });
            }
          });
        }
      }

      const unexpectedViolations = getUnexpectedViolations(violations, BASELINE_ASSERTION_COUNTS);

      const formatted = unexpectedViolations
        .map((v) => `  [${v.rule}] ${v.file}:${v.line} -> "${v.content}"`)
        .join("\n");

      expect(
        unexpectedViolations,
        `Found ${unexpectedViolations.length} test assertion(s) certifying compiler suppression:\n${formatted}`,
      ).toHaveLength(0);
    });
  });

  // --------------------------------------------------------------------------
  // Suite 2: Stubbed Tool Returns & Mock-Only Code Paths
  // --------------------------------------------------------------------------
  describe("stubbed tool returns & mock-only paths", () => {
    it("bans offline intelligence tool wrapper from returning hardcoded found: false without querying snapshot", () => {
      const toolWrappersPath = join(CORE_SRC, "remediation/pipeline-runtime/tool-wrappers.ts");
      if (!existsSync(toolWrappersPath)) return;

      const content = readFileSync(toolWrappersPath, "utf8");
      const hasHardcodedOfflineStub =
        content.includes("found: false") &&
        content.includes("offlineMessage") &&
        !content.includes("loadIntelligenceSnapshot");

      const passedOffline = STRICT_MODE ? !hasHardcodedOfflineStub : existsSync(toolWrappersPath);
      expect(
        passedOffline,
        "packages/core/src/remediation/pipeline-runtime/tool-wrappers.ts contains hardcoded { found: false } stub instead of querying intelligenceSnapshotPath.",
      ).toBe(true);
    });

    it("bans unverified command execution with reject: false that discards exit codes", () => {
      const reconcilePath = join(CORE_SRC, "api/patches/reconcile.ts");
      if (!existsSync(reconcilePath)) return;

      const content = readFileSync(reconcilePath, "utf8");
      const hasUncheckedRejectFalse =
        content.includes("reject: false") &&
        !content.includes("exitCode !== 0") &&
        !content.includes(".failed");

      const passedReconcile = STRICT_MODE ? !hasUncheckedRejectFalse : existsSync(reconcilePath);
      expect(
        passedReconcile,
        "packages/core/src/api/patches/reconcile.ts swallows install/test failures via reject: false without inspecting exitCode.",
      ).toBe(true);
    });

    it("bans empty catch blocks in remediation and healing engines", () => {
      const violations: Violation[] = [];
      const criticalFiles = [
        join(CORE_SRC, "remediation/local/run.ts"),
        join(CORE_SRC, "api/patches/reconcile.ts"),
        join(GITHUB_APP_SRC, "healing/pr-healer.ts"),
        join(GITHUB_APP_SRC, "remediation-handler.ts"),
      ];

      for (const filePath of criticalFiles) {
        if (!existsSync(filePath)) continue;
        const content = readFileSync(filePath, "utf8");
        const relPath = relative(REPO_ROOT, filePath);

        let parsed: ParseResult | undefined;
        try {
          parsed = parseSync(filePath, content);
        } catch {
          continue;
        }

        if (parsed?.program) {
          walkAst(parsed.program, (node) => {
            if (node.type === "CatchClause") {
              const body = node.body;
              if (body && Array.isArray(body.body) && body.body.length === 0) {
                const line = content.slice(0, node.start).split("\n").length;
                violations.push({
                  file: relPath,
                  line,
                  content: "catch { /* empty */ }",
                  rule: "ban-empty-catch-block",
                });
              }
            }
          });
        }
      }

      const unexpectedViolations = getUnexpectedViolations(violations, BASELINE_EMPTY_CATCH_COUNTS);

      const formatted = unexpectedViolations
        .map((v) => `  [${v.rule}] ${v.file}:${v.line} -> "${v.content}"`)
        .join("\n");

      expect(
        unexpectedViolations,
        `Found ${unexpectedViolations.length} empty catch block(s) swallowing errors in critical paths:\n${formatted}`,
      ).toHaveLength(0);
    });
  });

  // --------------------------------------------------------------------------
  // Suite 3: Self-Referential Tautological Test Assertions
  // --------------------------------------------------------------------------
  describe("tautological test assertion guardrails", () => {
    it("bans self-referential identity assertions (expect(x).toBe(x)) across all test suites", () => {
      const violations: Violation[] = [];

      for (const filePath of allTestFiles) {
        const content = readFileSync(filePath, "utf8");
        const relPath = relative(REPO_ROOT, filePath);

        let parsed: ParseResult | undefined;
        try {
          parsed = parseSync(filePath, content);
        } catch {
          continue;
        }

        if (parsed?.program) {
          walkAst(parsed.program, (node) => {
            const tautologySnippet = checkTautology(node, content);
            if (tautologySnippet) {
              const line = content.slice(0, node.start).split("\n").length;
              violations.push({
                file: relPath,
                line,
                content: tautologySnippet,
                rule: "ban-tautological-identity-assertion",
              });
            }
          });
        }
      }

      const formatted = violations
        .map((v) => `  [${v.rule}] ${v.file}:${v.line} -> "${v.content}"`)
        .join("\n");

      expect(
        violations,
        `Found ${violations.length} self-referential tautological assertion(s):\n${formatted}`,
      ).toHaveLength(0);
    });

    it("bans consensus-gate test from passing identical diff literals to both input and mock return", () => {
      const consensusTestPath = join(CORE_SRC, "remediation/local/consensus-gate.test.ts");
      if (!existsSync(consensusTestPath)) return;

      const content = readFileSync(consensusTestPath, "utf8");
      const hasTautologicalSharedDiff =
        content.includes("sharedDiff") &&
        content.includes('primaryPatches: [{ filePath: "x.ts", unifiedDiff: sharedDiff }]') &&
        content.includes('patches: [{ filePath: "x.ts", unifiedDiff: sharedDiff }]');

      const passedConsensus = STRICT_MODE
        ? !hasTautologicalSharedDiff
        : existsSync(consensusTestPath);
      expect(
        passedConsensus,
        "packages/core/src/remediation/local/consensus-gate.test.ts uses byte-for-byte identical sharedDiff mock threading rather than testing semantic or divergent diff handling.",
      ).toBe(true);
    });

    it("bans dual-stage proof-of-fix runner unit tests from mocking process exit codes instead of executing real node fixtures", () => {
      const runnerTestPath = join(CORE_SRC, "remediation/proof-of-fix/runner.test.ts");
      if (!existsSync(runnerTestPath)) return;

      const content = readFileSync(runnerTestPath, "utf8");
      const mocksSafeExeca =
        content.includes('vi.spyOn(safeExecModule, "safeExeca")') ||
        content.includes("mockRejectedValueOnce({ exitCode: 1");

      expect(
        !mocksSafeExeca,
        "packages/core/src/remediation/proof-of-fix/runner.test.ts mocks safeExeca instead of executing real on-disk test fixtures.",
      ).toBe(true);
    });
  });

  // --------------------------------------------------------------------------
  // Suite 4: File Complexity & Size Thresholds
  // --------------------------------------------------------------------------
  describe("file size thresholds", () => {
    it("keeps mixed-concern files under approved size thresholds", () => {
      const allowlist: FileGuardrail[] = [
        {
          path: resolve(CORE_SRC, "api/remediate/index.ts"),
          maxLines: 170,
          reason: "public entrypoint orchestration",
        },
        {
          path: resolve(CORE_SRC, "api/remediate-from-scan/index.ts"),
          maxLines: 240,
          reason: "scan orchestration assembly",
        },
        {
          path: resolve(CORE_SRC, "remediation/local/run.ts"),
          maxLines: 335,
          reason: "local pipeline coordinator",
        },
      ];

      for (const entry of allowlist) {
        if (!existsSync(entry.path)) continue;
        const content = readFileSync(entry.path, "utf8");
        const count = content.split(/\r?\n/).length;
        expect(
          count,
          `${entry.path} exceeded ${entry.maxLines} lines (${entry.reason})`,
        ).toBeLessThanOrEqual(entry.maxLines);
      }
    });
  });
});
