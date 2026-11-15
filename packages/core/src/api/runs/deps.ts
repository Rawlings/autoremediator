import {
  detectPackageManager,
  getYarnMajorVersion,
  resolveInstallCommand,
} from "../../platform/package-manager/index.js";
import { withRepoLock } from "../../platform/repo-lock.js";
import { safeExeca } from "../../platform/safe-exec.js";
import type { PatchResult } from "../../platform/types.js";
import {
  type AttemptDeps,
  type AttemptRequest,
  type AttemptResult,
  runRepairAttempt,
} from "../../remediation/repair/attempt.js";
import { applyPackageOverrideTool } from "../../remediation/tools/apply-package-override/index.js";
import { applyVersionBumpTool } from "../../remediation/tools/apply-version-bump.js";
import type { VerificationResult, VerifyRequest } from "../../remediation/verify/types.js";
import { verify } from "../../remediation/verify/verifier.js";
import type { PlanItem, PlanOptions } from "../../runs/plan.js";

/** The operations that change the project or run the package manager; replaceable in tests. */
export interface RunDeps {
  applyItem: (
    item: PlanItem,
    context: { cwd: string; options: PlanOptions },
  ) => Promise<PatchResult>;
  /** Install exactly what the restored lockfile says. */
  reinstall: (context: { cwd: string; options: PlanOptions | undefined }) => Promise<void>;
  verify: (request: VerifyRequest) => Promise<VerificationResult>;
  /** Try to repair an upgrade in an isolated checkout. */
  attempt: (request: AttemptRequest) => Promise<AttemptResult>;
  /** The pieces of an attempt a host agent drives itself (checkout, upgrade, verify, diff). */
  attemptDeps?: AttemptDeps;
}

export const defaultRunDeps: RunDeps = {
  async applyItem(item, { cwd, options }) {
    const shared = {
      cwd,
      packageName: item.packageName,
      fromVersion: item.fromVersion,
      toVersion: item.toVersion,
      dryRun: false,
      policy: options.policy,
      runTests: options.runTests ?? false,
      installMode: options.constraints?.installMode,
      installPreferOffline: options.constraints?.installPreferOffline,
      enforceFrozenLockfile: options.constraints?.enforceFrozenLockfile,
      workspace: options.constraints?.workspace,
      reproductionTest: options.reproductionTest,
      proofOfFix: options.proofOfFix,
      requireProofOfFix: options.requireProofOfFix,
      ...(options.packageManager
        ? { packageManager: options.packageManager as "npm" | "pnpm" | "yarn" | "bun" | "deno" }
        : {}),
      ...(options.patchesDir ? { patchesDir: options.patchesDir } : {}),
    };
    return item.strategy === "version-bump"
      ? applyVersionBumpTool.execute({
          ...shared,
          typecheck: options.typecheck,
          breakingChangeRefactor: options.breakingChangeRefactor,
        })
      : applyPackageOverrideTool.execute(shared);
  },

  async reinstall({ cwd, options }) {
    const pm =
      (options?.packageManager as ReturnType<typeof detectPackageManager> | undefined) ??
      detectPackageManager(cwd);
    const yarnMajor = pm === "yarn" ? await getYarnMajorVersion(cwd) : undefined;
    // Frozen, so the lockfile that was just restored is installed as it is and not rewritten.
    const [command, ...args] = resolveInstallCommand(
      pm,
      { ...options?.constraints, enforceFrozenLockfile: true },
      yarnMajor,
    );
    if (!command) return;
    await withRepoLock(cwd, () => safeExeca(command, args, { cwd, stdio: "pipe" }));
  },

  verify,
  attempt: (request) => runRepairAttempt(request),
};
