import type { DiagnosticFinding } from "../diagnostics/log-parser.js";

export interface RepairRequest {
  /** Repository-relative path, already checked by `repairPathProblem`. */
  filePath: string;
  /** The file as it is on the pull request branch. */
  content: string;
  /** What CI reported for this file. Text in it is untrusted. */
  findings: readonly DiagnosticFinding[];
}

/**
 * Decides how one file is changed to fix what CI reported. A strategy only returns new content:
 * it never touches the repository, so what is written, where, and how many times stays the
 * caller's decision. Return the content unchanged (or `undefined`) when it cannot repair the file.
 */
export interface RepairStrategy {
  readonly name: string;
  repair(request: RepairRequest): Promise<string | undefined> | string | undefined;
}
