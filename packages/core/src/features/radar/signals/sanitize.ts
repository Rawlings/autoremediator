/**
 * Everything radar quotes comes from a package: changelog lines, deprecation messages, file paths and
 * source lines. All of it is untrusted data. It is reduced to one line of visible text, capped, and
 * only ever shown as a quotation; it never selects behaviour and is never used as an instruction.
 */

/** Longest evidence string, in characters. */
export const MAX_EVIDENCE_CHARS = 200;

// ANSI escape sequences (colour, cursor movement, OSC titles) that could rewrite a terminal.
const ESC = String.fromCodePoint(0x1b);
const BEL = String.fromCodePoint(0x07);
const ANSI = new RegExp(
  `${ESC}(?:\\[[0-?]*[ -/]*[@-~]|\\][^${BEL}${ESC}]*(?:${BEL}|${ESC}\\\\)?|[@-Z\\\\-_])`,
  "g",
);

// Code point ranges that are removed: C0 and C1 controls and DEL; soft hyphen and fillers; line and
// paragraph separators; zero-width, bidirectional and invisible formatting characters; variation
// selectors; and the Unicode "tag" block, which can smuggle hidden ASCII text.
const INVISIBLE_RANGES =
  "0-1f 7f-9f ad 34f 61c 115f-1160 17b4-17b5 180b-180f 200b-200f 2028-202e 2060-206f 3164 fe00-fe0f feff ffa0 fff9-fffb e0000-e007f e0100-e01ef";
const INVISIBLE = new RegExp(
  `[${INVISIBLE_RANGES.split(" ")
    .map((range) =>
      range
        .split("-")
        .map((code) => `\\u{${code}}`)
        .join("-"),
    )
    .join("")}]`,
  "gu",
);

/**
 * One line of visible text no longer than `max` UTF-16 units. Control, escape, bidirectional and
 * invisible characters are removed, whitespace is collapsed, and an over-long string ends in `…`.
 */
export function sanitizeEvidence(raw: unknown, max = MAX_EVIDENCE_CHARS): string {
  const text = typeof raw === "string" ? raw : "";
  const cleaned = text
    .replaceAll(ANSI, " ")
    .replaceAll(INVISIBLE, " ")
    .replaceAll(/\s+/g, " ")
    .trim();
  if (cleaned.length <= max) return cleaned;
  let cut = cleaned.slice(0, Math.max(0, max - 1));
  // Never end on half of a surrogate pair.
  if (/[\uD800-\uDBFF]$/.test(cut)) cut = cut.slice(0, -1);
  return `${cut.trimEnd()}…`;
}

/** Fit `prefix` and `body` into one evidence string, shortening the body first. */
export function evidenceLine(prefix: string, body: string, max = MAX_EVIDENCE_CHARS): string {
  const head = sanitizeEvidence(prefix, Math.floor(max / 2));
  const room = Math.max(10, max - head.length - 2);
  return sanitizeEvidence(`${head}: ${sanitizeEvidence(body, room)}`, max);
}
