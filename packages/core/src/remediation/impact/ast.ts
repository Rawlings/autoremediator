/**
 * AST helpers shared by the fix-diff and upgrade-impact analyses: parsing, walking with parents,
 * and a canonical form of a subtree that ignores formatting and comments.
 */
import { createHash } from "node:crypto";

import { parseSync } from "oxc-parser";

export interface AstNode {
  type: string;
  start: number;
  end: number;
  [key: string]: unknown;
}

export function isNode(value: unknown): value is AstNode {
  return typeof value === "object" && value !== null && typeof (value as AstNode).type === "string";
}

/** Parse a file; undefined when it cannot be parsed at all (an empty program from a broken file). */
export function parseSource(file: string, code: string): AstNode | undefined {
  try {
    const result = parseSync(file, code, { preserveParens: false });
    const program = result.program as unknown as AstNode | undefined;
    if (!program) return undefined;
    const body = program.body as unknown[] | undefined;
    if (result.errors.length > 0 && (body?.length ?? 0) === 0 && code.trim() !== "") {
      return undefined;
    }
    return program;
  } catch {
    return undefined;
  }
}

const SKIPPED_KEYS = new Set(["start", "end", "range", "loc", "parent"]);

/** Child nodes of a node, in source order of the parser's keys. */
export function childNodes(node: AstNode): AstNode[] {
  const children: AstNode[] = [];
  for (const key of Object.keys(node)) {
    if (SKIPPED_KEYS.has(key)) continue;
    const value = node[key];
    if (Array.isArray(value)) {
      for (const item of value) if (isNode(item)) children.push(item);
    } else if (isNode(value)) {
      children.push(value);
    }
  }
  return children;
}

/**
 * Depth-first walk with the parent chain. Return `false` from `visit` to skip a node's subtree.
 * Iterative, so a deeply nested file cannot overflow the stack.
 */
export function walk(
  root: AstNode,
  visit: (node: AstNode, parent: AstNode | undefined, ancestors: readonly AstNode[]) => boolean | void,
): void {
  const ancestors: AstNode[] = [];
  const stack: Array<{ node: AstNode; depth: number }> = [{ node: root, depth: 0 }];
  while (stack.length > 0) {
    const item = stack.pop();
    if (!item) break;
    ancestors.length = item.depth;
    const parent = ancestors.at(-1);
    const descend = visit(item.node, parent, ancestors);
    if (descend === false) continue;
    ancestors.push(item.node);
    const children = childNodes(item.node);
    for (let index = children.length - 1; index >= 0; index--) {
      const child = children[index];
      if (child) stack.push({ node: child, depth: item.depth + 1 });
    }
  }
}

export interface CanonicalForm {
  /** Hash of the subtree with positions, comments, quote style and parentheses removed. */
  fingerprint: string;
  nodeCount: number;
  /** Identifier names, string and regular-expression literals appearing in the subtree. */
  tokens: Set<string>;
}

const MAX_TOKENS = 4000;
const MAX_STRING_TOKEN = 120;

function literalText(node: AstNode): string {
  const regex = node.regex as { pattern?: string; flags?: string } | undefined;
  if (regex) return `/${regex.pattern ?? ""}/${regex.flags ?? ""}`;
  if (typeof node.bigint === "string") return `${node.bigint}n`;
  const value = node.value;
  if (typeof value === "string") return value;
  return `${typeof value}:${String(value)}`;
}

/**
 * Canonical form of a subtree. `placeholder` may return a replacement label for a descendant
 * (used to leave nested named functions out of their parent's fingerprint).
 */
export function canonicalForm(
  root: AstNode,
  placeholder?: (node: AstNode) => string | undefined,
): CanonicalForm {
  const hash = createHash("sha256");
  const tokens = new Set<string>();
  let nodeCount = 0;

  const addToken = (token: string): void => {
    if (tokens.size < MAX_TOKENS && token !== "") tokens.add(token.slice(0, MAX_STRING_TOKEN));
  };

  const feed = (node: AstNode, isRoot: boolean): void => {
    if (!isRoot && placeholder) {
      const label = placeholder(node);
      if (label !== undefined) {
        hash.update(`@ref(${label})`);
        return;
      }
    }
    nodeCount++;
    hash.update(`<${node.type}`);
    if (node.type === "Identifier" || node.type === "PrivateIdentifier") {
      const name = String(node.name);
      hash.update(`:${name}`);
      addToken(name);
    } else if (node.type === "Literal") {
      const text = literalText(node);
      hash.update(`:${typeof node.value}:${text}`);
      addToken(text);
    } else if (node.type === "TemplateElement") {
      const cooked = (node.value as { cooked?: string | null } | undefined)?.cooked ?? "";
      hash.update(`:${cooked}`);
      addToken(cooked);
    }
    for (const key of Object.keys(node).toSorted()) {
      if (SKIPPED_KEYS.has(key) || key === "raw" || key === "type") continue;
      if (key === "name" && (node.type === "Identifier" || node.type === "PrivateIdentifier")) {
        continue;
      }
      if (node.type === "Literal" && (key === "value" || key === "regex" || key === "bigint")) {
        continue;
      }
      if (node.type === "TemplateElement" && key === "value") continue;
      const value = node[key];
      if (isNode(value)) {
        hash.update(`.${key}=`);
        feed(value, false);
      } else if (Array.isArray(value)) {
        hash.update(`.${key}=[`);
        for (const item of value) {
          if (isNode(item)) feed(item, false);
          else hash.update(`${typeof item}:${String(item)},`);
        }
        hash.update("]");
      } else if (
        typeof value === "string" ||
        typeof value === "number" ||
        typeof value === "boolean" ||
        typeof value === "bigint"
      ) {
        hash.update(`.${key}=${typeof value}:${String(value)}`);
      }
    }
    hash.update(">");
  };

  feed(root, true);
  return { fingerprint: hash.digest("hex").slice(0, 20), nodeCount, tokens };
}

/** Offsets of the start of every line, for converting a character offset to a line number. */
export function lineStarts(code: string): number[] {
  const starts = [0];
  for (let index = 0; index < code.length; index++) {
    if (code.codePointAt(index) === 10) starts.push(index + 1);
  }
  return starts;
}

/** 1-based line of a character offset. */
export function lineOf(starts: readonly number[], offset: number): number {
  let low = 0;
  let high = starts.length - 1;
  while (low < high) {
    const mid = Math.ceil((low + high) / 2);
    if ((starts[mid] ?? 0) <= offset) low = mid;
    else high = mid - 1;
  }
  return low + 1;
}

/** Name of an identifier or string-literal node (`{ name }` or `{ value }`). */
export function nameOfNode(node: unknown): string | undefined {
  if (!isNode(node)) return undefined;
  if (typeof node.name === "string") return node.name;
  return typeof node.value === "string" ? node.value : undefined;
}

/** Name of a property key that is a plain identifier or string literal; undefined when computed. */
export function propertyName(
  key: unknown,
  computed: boolean | undefined,
): string | undefined {
  if (!isNode(key)) return undefined;
  if (key.type === "Identifier" && !computed) return String(key.name);
  if (key.type === "Literal" && typeof key.value === "string") return key.value;
  if (key.type === "Literal" && typeof key.value === "number") return String(key.value);
  return undefined;
}
