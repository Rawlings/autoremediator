import { resolve } from "node:path";

import { readTraceFile } from "../trace/fold.js";
import { assessRuntimeReachability } from "../trace/verdict.js";
/**
 * Public SDK API: checkReachability
 */
import { assessPackageReachability } from "./check-reachability.js";
import type {
  CheckReachabilityOptions,
  ReachabilityAssessment,
  RuntimeReachability,
} from "./types.js";

/**
 * Combine the static scan with what a traced run showed. Runtime evidence can only add reachability
 * (a call that was observed happened); it never turns a static "reachable" into "not-reachable",
 * because a package that did not run in a traced command may still run elsewhere.
 */
function withRuntimeEvidence(
  staticResult: ReachabilityAssessment,
  runtime: RuntimeReachability,
  symbol: string | undefined,
): ReachabilityAssessment {
  const merged: ReachabilityAssessment = {
    ...staticResult,
    evidenceKind: staticResult.status === "unknown" ? "runtime" : "both",
    runtime,
  };
  // Without a symbol the question is "is the package used at all", which a load answers.
  const observed =
    runtime.verdict === "called-in-tests" ||
    (symbol === undefined &&
      (runtime.verdict === "loaded-in-tests" || runtime.verdict === "loaded-not-called-in-tests"));
  if (!observed || staticResult.status === "reachable") return merged;

  const { justification: _dropped, ...rest } = merged;
  return {
    ...rest,
    status: "reachable",
    staticStatus: staticResult.status,
    reachabilityBasis:
      runtime.verdict === "called-in-tests" ? "runtime-call-observed" : "runtime-load-observed",
    reason: `${runtime.reason} The static scan reported: ${staticResult.reason}`,
  };
}

export async function checkReachability(
  options: CheckReachabilityOptions,
): Promise<ReachabilityAssessment> {
  const cwd = options.cwd ?? process.cwd();
  const staticResult = assessPackageReachability(cwd, options.packageName, options.symbol);
  if (!options.traceFile) return { ...staticResult, evidenceKind: "static" };

  const trace = readTraceFile(resolve(cwd, options.traceFile));
  const runtime = assessRuntimeReachability(trace, options.packageName, options.symbol);
  return withRuntimeEvidence(staticResult, runtime, options.symbol);
}
