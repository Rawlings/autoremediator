import { errorMessage } from "../../shared/errors.js";
import { CHECKS, type CheckFn, createCheckContext } from "./checks.js";
import {
  CHECK_NAMES,
  type CheckName,
  type CheckResult,
  type VerificationResult,
  type VerifyRequest,
} from "./types.js";

/**
 * Judge a project that a change has been made to. Deterministic: no model is consulted, and nothing
 * the change's author says about it is taken on trust. Checks run cheapest first and stop at the
 * first failure; the rest are reported as skipped, so a result always lists every check.
 *
 * It does not care how the change was made. A plan applied in place, an agent's attempt in a
 * worktree and a hand edit are judged by the same checks.
 */
export async function verify(
  request: VerifyRequest,
  checks: Partial<Record<CheckName, CheckFn>> = CHECKS,
): Promise<VerificationResult> {
  const started = Date.now();
  const wanted = new Set(request.checks ?? CHECK_NAMES);
  const context = createCheckContext(request);

  const results: CheckResult[] = [];
  let failedCheck: CheckName | undefined;

  for (const name of CHECK_NAMES) {
    if (!wanted.has(name)) continue;
    if (failedCheck) {
      results.push({
        name,
        status: "skipped",
        message: `not run: ${failedCheck} failed`,
        durationMs: 0,
      });
      continue;
    }

    const run = checks[name] ?? CHECKS[name];
    const checkStarted = Date.now();
    let outcome;
    try {
      outcome = await run(context);
    } catch (error) {
      // A check that blows up has not shown the change is fine.
      outcome = {
        status: "failed" as const,
        message: "the check could not complete",
        details: [errorMessage(error)],
      };
    }
    results.push({ name, ...outcome, durationMs: Date.now() - checkStarted });
    if (outcome.status === "failed") failedCheck = name;
  }

  const changedFiles = await context.changedFiles().catch(() => undefined);
  return {
    passed: failedCheck === undefined,
    ...(failedCheck ? { failedCheck } : {}),
    checks: results,
    ...(changedFiles ? { changedFiles } : {}),
    durationMs: Date.now() - started,
  };
}
