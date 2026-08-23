/**
 * Public SDK API: checkReachability
 */
import { assessPackageReachability } from "../../remediation/tools/check-reachability.js";
import type { CheckReachabilityOptions, ReachabilityAssessment } from "../../platform/types.js";

export async function checkReachability(
  options: CheckReachabilityOptions,
): Promise<ReachabilityAssessment> {
  const cwd = options.cwd ?? process.cwd();
  return assessPackageReachability(cwd, options.packageName, options.symbol);
}
