/**
 * Write a manifest back the way it was written: same indentation, same line endings, same final
 * newline. Rewriting `package.json` in a house style of our own would put a diff on every file an
 * upgrade touches, and on files a failed attempt had to put back.
 */
export function serializeManifest(original: string, value: unknown): string {
  const indent = /^([ \t]+)"/m.exec(original)?.[1] ?? "  ";
  let text = JSON.stringify(value, null, indent);
  if (original.includes("\r\n")) text = text.replaceAll("\n", "\r\n");
  const ending = original.endsWith("\r\n") ? "\r\n" : original.endsWith("\n") ? "\n" : "";
  return text + ending;
}
