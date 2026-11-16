import stripAnsi from "strip-ansi";

export function plain(text: string): string {
  return stripAnsi.default(text);
}

export function visibleLength(text: string): number {
  return plain(text).length;
}
