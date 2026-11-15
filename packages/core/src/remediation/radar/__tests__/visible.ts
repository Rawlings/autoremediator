/** Ranges (hex) a terminal or a reader should never be handed: controls, escapes, bidi marks, tag characters. */
const HIDDEN = "0-1f 7f-9f 200b-200f 2028-202e 2060-206f e0000-e007f"
  .split(" ")
  .map((range) => range.split("-").map((code) => Number.parseInt(code, 16)) as [number, number]);

/** Code points in `text` that fall in the hidden ranges, as `U+XXXX`. */
export function hiddenCodePoints(text: string): string[] {
  const found: string[] = [];
  for (let index = 0; index < text.length; index++) {
    const code = text.codePointAt(index) ?? 0;
    if (code > 0xff_ff) index++;
    if (HIDDEN.some(([low, high]) => code >= low && code <= high)) {
      found.push(`U+${code.toString(16).toUpperCase().padStart(4, "0")}`);
    }
  }
  return found;
}
