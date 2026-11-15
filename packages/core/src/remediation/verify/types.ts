import { VERIFY_CHECK_VALUES } from "../../platform/option-schemas.js";
import type { CveDetails, PackageManager, RemediationConstraints } from "../../platform/types.js";

/** In the order they run: cheap and static first, then anything that installs or executes code. */
export const CHECK_NAMES = VERIFY_CHECK_VALUES;

export type CheckName = (typeof CHECK_NAMES)[number];

export type CheckStatus = "passed" | "failed" | "skipped";

export interface CheckResult {
  name: CheckName;
  status: CheckStatus;
  /** One line: what was checked, or why it failed or was skipped. */
  message: string;
  /** Specifics that make a failure actionable (files, packages, command output tail). */
  details?: string[];
  durationMs: number;
}

export interface VerificationResult {
  /** Every check that ran passed. Skipped checks do not count against it. */
  passed: boolean;
  /** The first check that failed; later checks are reported as skipped. */
  failedCheck?: CheckName;
  checks: CheckResult[];
  /** Files the change touched, when it could be determined. */
  changedFiles?: string[];
  durationMs: number;
}

export interface VerifyOptions {
  runTests?: boolean;
  typecheck?: boolean;
  proofOfFix?: boolean | string;
  requireProofOfFix?: boolean;
  reproductionTest?: string;
  patchesDir?: string;
  constraints?: RemediationConstraints;
  /** The change may edit the project's own source (breaking-change refactors, agent repairs). */
  allowSourceEdits?: boolean;
  /** Skip checks that need the network. */
  offline?: boolean;
  /**
   * Leave the autonomy track record (a committed file Autoremediator itself appends to after each
   * run) out of the scope check. Set only when judging the project itself, never a checkout an
   * agent has been editing, so an agent cannot raise its own level.
   */
  ignoreTrackRecord?: boolean;
}

export interface VerifyRequest {
  cwd: string;
  packageManager?: PackageManager;
  /** Policy file path or inline policy. */
  policy?: string;
  /** Manifest, lockfile and patch contents before the change by relative path; null = did not exist. */
  baseFiles: ReadonlyMap<string, string | null>;
  /**
   * `git status --porcelain` lines before the change, so what changed can be told from what was
   * already dirty. Undefined when the project is not a git repository, which skips the scope check.
   */
  statusBefore?: readonly string[];
  /** Advisories the change is meant to have resolved. */
  advisories: readonly CveDetails[];
  /** Packages that are knowingly left vulnerable (not part of this change). */
  expectedRemaining?: readonly string[];
  options?: VerifyOptions;
  /** Run only these checks (default: all, in canonical order). */
  checks?: readonly CheckName[];
}
