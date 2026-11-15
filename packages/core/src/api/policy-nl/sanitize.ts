/** Longest plain-language request accepted. Rules are short; a longer text is not a rule list. */
export const MAX_REQUEST_LENGTH = 2000;
/** Longest suppression note written to a policy file. */
export const MAX_NOTE_LENGTH = 200;

/** Thrown for input that is refused before any model is called. */
export class PolicyRequestError extends Error {
  override readonly name = "PolicyRequestError";
}

/**
 * Control characters (other than newline and tab, which are handled separately), DEL and C1; zero-width
 * and bidirectional formatting characters that can hide or reorder text; and the byte-order mark.
 */
function isInvisible(code: number): boolean {
  return (
    (code <= 0x1f && code !== 0x09 && code !== 0x0a) ||
    (code >= 0x7f && code <= 0x9f) ||
    (code >= 0x20_0b && code <= 0x20_0f) ||
    (code >= 0x20_2a && code <= 0x20_2e) ||
    (code >= 0x20_60 && code <= 0x20_64) ||
    (code >= 0x20_66 && code <= 0x20_69) ||
    code === 0xfe_ff
  );
}

/** Remove the characters {@link isInvisible} names. Exported for tests that check output is clean. */
export function stripInvisible(text: string): string {
  let kept = "";
  for (const char of text) {
    if (!isInvisible(char.codePointAt(0) ?? 0)) kept += char;
  }
  return kept;
}

/**
 * Clean the user's request. It is untrusted: it is capped, stripped of control and invisible
 * characters, and has its line breaks kept (they separate rules) but its runs of blank space
 * collapsed. Nothing here makes text safe to follow; the model's answer is validated separately.
 */
export function sanitizeRequest(raw: string): string {
  if (typeof raw !== "string") throw new PolicyRequestError("The request must be text.");
  if (raw.length > MAX_REQUEST_LENGTH * 2) {
    throw new PolicyRequestError(
      `The request is too long (limit ${MAX_REQUEST_LENGTH} characters).`,
    );
  }
  const text = stripInvisible(raw.replaceAll(/\r\n?/g, "\n"))
    .replaceAll(/[^\S\n]+/g, " ")
    .replaceAll(/ ?\n ?/g, "\n")
    .replaceAll(/\n{3,}/g, "\n\n")
    .trim();
  if (text === "") throw new PolicyRequestError("The request is empty.");
  if (text.length > MAX_REQUEST_LENGTH) {
    throw new PolicyRequestError(
      `The request is too long (limit ${MAX_REQUEST_LENGTH} characters).`,
    );
  }
  return text;
}

/** A suppression note: one line, no control characters, capped. The only free text a policy may get. */
export function sanitizeNote(raw: string): string {
  return stripInvisible(raw).replaceAll(/\s+/gu, " ").trim().slice(0, MAX_NOTE_LENGTH);
}

/** Lower-case, collapse punctuation and blank space, so a phrase can be found in the request. */
export function normalizeForMatch(text: string): string {
  return text
    .toLowerCase()
    .replaceAll(/[^\p{L}\p{N}@/*.-]+/gu, " ")
    .trim();
}
