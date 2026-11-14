import { stripAnsi } from "./log-parser.js";

/** Control characters, zero-width and bidirectional marks, line and paragraph separators. */
function isUnsafe(character: string): boolean {
  const code = character.codePointAt(0) ?? 0;
  return (
    code < 0x20 ||
    code === 0x7f ||
    (code >= 0x20_0b && code <= 0x20_0f) ||
    (code >= 0x20_28 && code <= 0x20_2e) ||
    (code >= 0x20_66 && code <= 0x20_69)
  );
}

/**
 * Text taken from CI output is untrusted: it can contain markdown, mentions and slash commands
 * meant for whoever reads the comment. It only ever goes into a comment inside a code fence, after
 * this: control characters removed, backticks defused so nothing can close the fence, whitespace
 * collapsed and the length capped.
 */
export function oneLine(text: string, maxLength: number): string {
  const cleaned = Array.from(stripAnsi(text), (character) =>
    isUnsafe(character) ? " " : character,
  )
    .join("")
    .replaceAll("`", "'")
    .replaceAll(/\s+/g, " ")
    .trim();
  return cleaned.length > maxLength ? `${cleaned.slice(0, maxLength - 1)}…` : cleaned;
}

/** A fenced block whose content cannot end the fence early. */
export function fenced(lines: readonly string[]): string {
  return ["```text", ...lines.map((line) => oneLine(line, 300)), "```"].join("\n");
}
