/** True for characters that must not survive into markdown or a shell command: control characters and line separators. */
const isUnsafe = (character: string): boolean => {
  const point = character.codePointAt(0) ?? 0;
  return point < 0x20 || point === 0x7f || point === 0x20_28 || point === 0x20_29;
};

/** Replace control characters (newlines, tabs, NUL, ...) so one untrusted string stays on one line. */
export function stripControl(value: string, replacement = " "): string {
  let out = "";
  for (const character of value) out += isUnsafe(character) ? replacement : character;
  return out;
}
