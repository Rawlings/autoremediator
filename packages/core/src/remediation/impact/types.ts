/** Types shared by the fix-diff and upgrade-impact analyses and exposed through the SDK. */

export interface ParamInfo {
  name: string;
  optional: boolean;
  rest: boolean;
  /** Type annotation as source text (declaration files only). */
  type?: string;
}

export interface ClassMemberInfo {
  name: string;
  static: boolean;
  kind: "method" | "getter" | "setter" | "field" | "constructor";
  params?: ParamInfo[];
  /** Fingerprint of the member body (JavaScript analysis). */
  fingerprint: string;
}

/** A package version's analysable files. */
export interface PackageSource {
  name: string;
  version: string;
  files: Map<string, string>;
  manifest: Record<string, unknown>;
  /** `true` when the registry's integrity digest was available and matched. */
  integrityVerified: boolean;
}

export type CallSiteKind =
  | "import"
  | "require"
  | "dynamic-import"
  | "reexport"
  | "call"
  | "new"
  | "member"
  | "reference"
  | "type-reference";

/** A place in the project's own source that uses something from the package. */
export interface CallSite {
  file: string;
  line: number;
  kind: CallSiteKind;
  /** The source line, trimmed and shortened. */
  text: string;
  /** Arguments passed, when the site is a call without spread arguments. */
  argCount?: number;
  /**
   * `exact`: the project's binding to the package is followed to this site.
   * `name-match`: only the member name matches (class members cannot be resolved without types).
   */
  confidence: "exact" | "name-match";
}
