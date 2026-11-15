import { normalizeForMatch } from "./sanitize.js";

/** The request as tokens, each knowing which rule (clause) it belongs to. */
export interface RequestIndex {
  tokens: string[];
  /** `clause[i]` is the rule that `tokens[i]` is part of. */
  clause: number[];
}

/** Normalised words of a text: lower-case, punctuation and spacing folded away, package names kept whole. */
export const tokensOf = (text: string): string[] =>
  normalizeForMatch(text)
    .split(" ")
    .map((token) => token.replaceAll(/^[.\-/]+|[.\-/]+$/g, ""))
    .filter(Boolean);

/** Split a request into rules: by line, semicolon or sentence end. */
export function clausesOf(request: string): string[] {
  return request
    .split(/[;\n]+|\.(?=\s|$)/)
    .map((clause) => clause.trim())
    .filter((clause) => tokensOf(clause).length > 0);
}

export function indexRequest(request: string): RequestIndex {
  const tokens: string[] = [];
  const clause: number[] = [];
  for (const [number, text] of clausesOf(request).entries()) {
    for (const token of tokensOf(text)) {
      tokens.push(token);
      clause.push(number);
    }
  }
  return { tokens, clause };
}

/** Start positions where `phrase` occurs in the request as a run of consecutive words, in order. */
export function findPhrase(index: RequestIndex, phrase: string): number[] {
  const words = tokensOf(phrase);
  if (words.length === 0) return [];
  const starts: number[] = [];
  for (let start = 0; start + words.length <= index.tokens.length; start += 1) {
    if (words.every((word, offset) => index.tokens[start + offset] === word)) starts.push(start);
  }
  return starts;
}

const NEGATION_WORDS = new Set([
  "never",
  "not",
  "no",
  "without",
  "cannot",
  "nor",
  "neither",
  "dont",
  "doesnt",
  "cant",
  "wont",
  "shouldnt",
  "mustnt",
  "isnt",
  "arent",
]);
/** Stems of `don't`, `can't` and the like, which normalisation splits into the stem and `t`. */
const NEGATION_STEMS = new Set([
  "don",
  "doesn",
  "didn",
  "can",
  "won",
  "shouldn",
  "mustn",
  "isn",
  "aren",
  "wouldn",
  "couldn",
]);
/** How many words before a phrase a negation still governs it. */
const NEGATION_REACH = 4;

/** Whether the word at `position` negates what follows it (`no longer` does not). */
function negatesAt(tokens: readonly string[], position: number): boolean {
  const token = tokens[position] ?? "";
  if (token === "no") return tokens[position + 1] !== "longer";
  if (token === "t") return NEGATION_STEMS.has(tokens[position - 1] ?? "");
  return NEGATION_WORDS.has(token);
}

/**
 * Whether a negation (never, not, don't, without, no...) governs the run of words that starts at
 * `start`: inside it, or in the few words before it within the same rule. A model that quotes
 * "allow major bumps" out of "Never allow major bumps" is quoting words that say the opposite.
 */
export function isNegated(index: RequestIndex, start: number, length: number): boolean {
  const ruleStart = index.clause[start];
  for (
    let position = Math.max(0, start - NEGATION_REACH);
    position < start + length && position < index.tokens.length;
    position += 1
  ) {
    if (position < start && index.clause[position] !== ruleStart) continue;
    if (negatesAt(index.tokens, position)) return true;
  }
  return false;
}
