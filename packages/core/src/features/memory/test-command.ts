import { resolveTestCommand } from "../../infra/package-manager/index.js";
import type { RemediationConstraints } from "../../infra/policy/types.js";
import type { PackageManager } from "../../shared/types.js";
import { memoryTestCommand } from "./consume.js";

/**
 * The command that runs a project's tests. A project whose `package.json` has no test script gets
 * the test command its memory holds, if any (see `memoryTestCommand`); a script the project defines
 * is never overridden, and a workspace selection leaves the choice to the package manager.
 */
export function resolveProjectTestCommand(
  pm: PackageManager,
  constraints: RemediationConstraints | undefined,
  cwd: string,
): string[] {
  if (!constraints?.workspace && pm !== "deno") {
    const remembered = memoryTestCommand(cwd, pm);
    if (remembered) return remembered;
  }
  return resolveTestCommand(pm, constraints);
}
