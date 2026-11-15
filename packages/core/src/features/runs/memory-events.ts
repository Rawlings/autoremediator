/**
 * What runs teach the repository's memory, from facts the run established itself: an upgrade the
 * verifier rejected, and a test command that passed. Nothing here reads an agent's claims; a
 * rejection's reason is a fixed sentence naming the verifier check, never text from command output
 * or an agent. Recording is best effort and says on the run's ledger when it could not.
 */
import semver from "semver";

import { detectPackageManager } from "../../infra/package-manager/index.js";
import { errorMessage } from "../../shared/errors.js";
import type { PackageManager } from "../../shared/types.js";
import {
  addMemory,
  MEMORY_LIMITS,
  type NewMemoryEntry,
  parseTestCommand,
} from "../memory/index.js";
import { resolveProjectTestCommand } from "../memory/test-command.js";
import type { CheckName, VerificationResult } from "../verify/types.js";
import type { PlanOptions } from "./plan.js";

/**
 * Checks whose failure says something about the upgrade itself. Scope, policy and supply-chain
 * failures are decisions about rules and release age, which change without the upgrade changing, so
 * they are not remembered as "this upgrade does not work".
 */
const UPGRADE_CHECKS: ReadonlySet<CheckName> = new Set([
  "install",
  "vuln-gone",
  "typecheck",
  "tests",
  "proof-of-fix",
]);

/** The facts of one upgrade a run attempted. */
export interface UpgradeFacts {
  packageName: string;
  fromVersion: string;
  toVersion: string;
}

/** A rejection the verifier made, as a memory entry; undefined when it does not call for one. */
export function rejectedUpgradeEntry(
  upgrade: UpgradeFacts,
  verification: VerificationResult | undefined,
): NewMemoryEntry | undefined {
  const check = verification?.failedCheck;
  if (!verification || verification.passed || !check || !UPGRADE_CHECKS.has(check))
    return undefined;
  if (semver.valid(upgrade.toVersion) === null) return undefined;
  return {
    kind: "rejected-upgrade",
    package: upgrade.packageName,
    ...(semver.valid(upgrade.fromVersion) === null ? {} : { fromVersion: upgrade.fromVersion }),
    toVersion: upgrade.toVersion,
    reason: `the verifier's ${check} check failed after the upgrade`,
    check,
    expiresInDays: MEMORY_LIMITS.rejectionTtlDays,
  };
}

/** Test commands that a verification ran and passed. */
export function passedTestCommands(verification: VerificationResult | undefined): string[] {
  return (
    verification?.checks.flatMap((check) =>
      check.name === "tests" && check.status === "passed" && check.command
        ? [check.command.join(" ")]
        : [],
    ) ?? []
  );
}

export function testCommandEntry(command: string): NewMemoryEntry | undefined {
  if (typeof parseTestCommand(command) === "string") return undefined;
  return {
    kind: "test-command",
    command,
    expiresInDays: MEMORY_LIMITS.testCommandTtlDays,
  };
}

/** The command the apply step ran for items it applied with tests requested. */
export function appliedTestCommand(cwd: string, options: PlanOptions): string | undefined {
  if (options.runTests !== true) return undefined;
  const pm = (options.packageManager as PackageManager | undefined) ?? detectPackageManager(cwd);
  return resolveProjectTestCommand(pm, options.constraints, cwd).join(" ");
}

/** Record entries on behalf of a run. Returns what was newly recorded; reports problems instead of throwing. */
export async function recordMemory(
  cwd: string,
  runId: string,
  entries: ReadonlyArray<NewMemoryEntry | undefined>,
  onProblem: (problem: string) => void,
): Promise<string[]> {
  const recorded: string[] = [];
  for (const entry of entries) {
    if (!entry) continue;
    try {
      const result = await addMemory(cwd, { ...entry, source: runId });
      if (result.created) recorded.push(result.entry.id);
    } catch (error) {
      onProblem(`memory entry not recorded: ${errorMessage(error)}`);
    }
  }
  return recorded;
}
