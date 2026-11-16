export interface FormatOptions {
  /** Thousands separator. Default: a narrow no-break space (U+202F). */
  separator?: string;
}
export function format(cents: number, options?: FormatOptions): string;
