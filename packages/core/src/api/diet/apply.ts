import { assertAutonomyAllows } from "../autonomy/index.js";
import {
  detectPackageManager,
  resolveInstallCommand,
} from "../../platform/package-manager/index.js";
import { withRepoLock } from "../../platform/repo-lock.js";
import { createProjectSnapshot, restoreProjectSnapshot } from "../../platform/rollback.js";
import { safeExeca } from "../../platform/safe-exec.js";
import { LONG_RUNNING_TIMEOUT_MS } from "../../platform/timeouts.js";
import type { PackageManager } from "../../platform/types.js";
import type { VerificationResult, VerifyRequest } from "../../remediation/verify/types.js";
import { verify } from "../../remediation/verify/verifier.js";
import { analyzeDependencies } from "./analyze.js";
import type {
  DietApplyResult,
  DietPackageReport,
  RemovedDependency,
  RemoveUnusedDependenciesOptions,
} from "./types.js";

/** What changes the project or runs the package manager, replaceable in tests. */
export interface DietDeps {
  /** Remove these dependencies from one package of the project through the package manager. */
  remove(request: {
    root: string;
    packageManager: PackageManager;
    dir: string;
    names: string[];
    workspace: boolean;
  }): Promise<void>;
  /** Install exactly what the (restored) lockfile says. */
  reinstall(request: { root: string; packageManager: PackageManager }): Promise<void>;
  verify(request: VerifyRequest): Promise<VerificationResult>;
}

const SUPPORTED = new Set<PackageManager>(["npm", "pnpm"]);

/** The command that removes `names` from the package at `dir` (`.` for the workspace root or a single project). */
const PACKAGE_NAME = /^(?:@[a-z0-9~][a-z0-9._~-]*\/)?[a-z0-9~][a-z0-9._~-]*$/;

export function removeCommand(
  packageManager: PackageManager,
  dir: string,
  names: readonly string[],
  workspace: boolean,
): string[] {
  // Names come from package.json keys; one that looks like an option must never reach the package manager.
  for (const name of names) {
    if (!PACKAGE_NAME.test(name)) throw new Error(`Refusing to remove "${name.slice(0, 60)}": not a valid package name.`);
  }
  if (packageManager === "pnpm") {
    // `--ignore-scripts`: removing a package must not run anyone's lifecycle scripts.
    return dir === "."
      ? ["pnpm", "remove", ...(workspace ? ["--workspace-root"] : []), "--ignore-scripts", "--", ...names]
      : ["pnpm", "--filter", `./${dir}`, "remove", "--ignore-scripts", "--", ...names];
  }
  return [
    "npm",
    "uninstall",
    "--ignore-scripts",
    "--no-audit",
    "--no-fund",
    ...(dir === "." ? [] : ["--workspace", dir]),
    "--",
    ...names,
  ];
}

export const defaultDietDeps: DietDeps = {
  async remove({ root, packageManager, dir, names, workspace }) {
    const [command, ...args] = removeCommand(packageManager, dir, names, workspace);
    await safeExeca(command!, args, {
      cwd: root,
      stdio: "pipe",
      timeoutMs: LONG_RUNNING_TIMEOUT_MS,
    });
  },
  async reinstall({ root, packageManager }) {
    const [command, ...args] = resolveInstallCommand(packageManager, {
      enforceFrozenLockfile: true,
    });
    if (command)
      await safeExeca(command, args, {
        cwd: root,
        stdio: "pipe",
        timeoutMs: LONG_RUNNING_TIMEOUT_MS,
      });
  },
  verify,
};

function certainRemovals(packages: readonly DietPackageReport[]): {
  removals: RemovedDependency[];
  byDirectory: Map<string, string[]>;
} {
  const removals: RemovedDependency[] = [];
  const byDirectory = new Map<string, string[]>();
  for (const report of packages) {
    for (const entry of report.unused) {
      if (entry.classification !== "certainly-unused") continue;
      removals.push({
        dir: report.dir,
        name: entry.name,
        section: entry.section,
        range: entry.range,
      });
      byDirectory.set(report.dir, [...(byDirectory.get(report.dir) ?? []), entry.name]);
    }
  }
  return { removals, byDirectory };
}

/**
 * Remove the dependencies the analysis calls `certainly-unused` through the package manager, then
 * judge the result with the verifier (scope, policy, a frozen install, and the project's type
 * check and tests when asked) and put everything back if any check fails. Never touches
 * `probably-unused` dependencies, replaceable packages or duplicates.
 */
export async function removeUnusedDependenciesWith(
  options: RemoveUnusedDependenciesOptions,
  deps: DietDeps,
): Promise<DietApplyResult> {
  // Earned autonomy: removing dependencies changes the project, so it is gated like any other apply.
  assertAutonomyAllows(options.cwd ?? process.cwd(), options.policy, "apply", "removeUnusedDependencies");
  const report = await analyzeDependencies({ cwd: options.cwd });
  const { removals, byDirectory } = certainRemovals(report.packages);
  if (removals.length === 0) {
    return {
      status: "nothing-to-remove",
      removals,
      message: "No dependency is certainly unused, so nothing was removed.",
      report,
    };
  }

  const packageManager = options.packageManager ?? detectPackageManager(report.root);
  if (!SUPPORTED.has(packageManager)) {
    throw new Error(
      `Removing dependencies automatically supports npm and pnpm, and this project uses ${packageManager}. Remove by hand: ${removals.map((removal) => `${removal.name} (${removal.dir})`).join(", ")}.`,
    );
  }

  return withRepoLock(report.root, async () => {
    const before = await createProjectSnapshot(report.root);

    const undo = async (): Promise<string | undefined> => {
      await restoreProjectSnapshot(before);
      return deps
        .reinstall({ root: report.root, packageManager })
        .then(() => undefined)
        .catch((error: unknown) => (error instanceof Error ? error.message : String(error)));
    };

    try {
      for (const [dir, names] of byDirectory) {
        await deps.remove({
          root: report.root,
          packageManager,
          dir,
          names,
          workspace: report.packages.length > 1,
        });
      }
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      const reinstallProblem = await undo();
      return {
        status: "failed",
        removals,
        message: `The package manager could not remove the dependencies (${reason}). Manifests and lockfile were restored${reinstallProblem ? `, but reinstalling failed: ${reinstallProblem}` : ""}.`,
        report,
      };
    }

    const verification = await deps.verify({
      cwd: report.root,
      packageManager,
      ...(options.policy ? { policy: options.policy } : {}),
      baseFiles: before.fileSnapshots,
      statusBefore: before.isGit ? (before.gitStatusBefore ?? []) : undefined,
      advisories: [],
      options: {
        runTests: options.runTests ?? false,
        typecheck: options.typecheck ?? true,
        ...(options.constraints ? { constraints: options.constraints } : {}),
      },
      checks: ["scope", "policy", "install", "typecheck", "tests"],
    });

    if (!verification.passed) {
      const failed = verification.checks.find((check) => check.name === verification.failedCheck);
      const reinstallProblem = await undo();
      return {
        status: "rolled-back",
        removals,
        verification,
        message: `Verification failed (${verification.failedCheck}): ${failed?.message ?? "see details"}. Nothing was removed${reinstallProblem ? `; reinstalling the restored lockfile failed: ${reinstallProblem}` : ""}.`,
        report,
      };
    }

    return {
      status: "removed",
      removals,
      verification,
      message: `Removed ${removals.length} unused ${removals.length === 1 ? "dependency" : "dependencies"}; verified by ${verification.checks
        .filter((check) => check.status === "passed")
        .map((check) => check.name)
        .join(", ")}.`,
      report,
    };
  });
}

export function removeUnusedDependencies(
  options: RemoveUnusedDependenciesOptions = {},
): Promise<DietApplyResult> {
  return removeUnusedDependenciesWith(options, defaultDietDeps);
}
