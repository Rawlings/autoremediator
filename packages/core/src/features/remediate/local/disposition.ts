import type { DispositionPolicy } from "../../../infra/policy/types.js";
import type { ProjectSnapshot } from "../../../infra/rollback/rollback.js";
import { restoreProjectSnapshotSync } from "../../../infra/rollback/rollback.js";
import type { CveSeverity } from "../../../shared/types.js";
import type { Disposition, DispositionSignals, PatchResult, SlaBreach } from "../types.js";

const ESCALATE_SEVERITIES_DEFAULT = ["CRITICAL", "HIGH"] as const;

/**
 * Compute the autonomous disposition for a single PatchResult.
 * Precedence order is deterministic — first match wins.
 */
export function computeDisposition(
  signals: DispositionSignals,
  policy?: DispositionPolicy,
): { disposition: Disposition; dispositionReason: string } {
  const escalateOnKev = policy?.escalateOnKev ?? true;
  const escalateOnSlaBreachSeverities =
    policy?.escalateOnSlaBreachSeverities ?? (ESCALATE_SEVERITIES_DEFAULT as unknown as string[]);
  const holdForTransitive = policy?.holdForTransitive ?? false;
  const minConfidenceForAutoApply = policy?.minConfidenceForAutoApply ?? 0.7;

  // 1. Hard-fail unresolved reasons
  const hardFailReasons = [
    "validation-failed",
    "patch-validation-failed",
    "install-failed",
  ] as const;
  if (
    signals.unresolvedReason &&
    (hardFailReasons as readonly string[]).includes(signals.unresolvedReason)
  ) {
    return { disposition: "escalate", dispositionReason: signals.unresolvedReason };
  }

  // 4. KEV exploit signal
  if (signals.exploitSignalTriggered && escalateOnKev) {
    return { disposition: "escalate", dispositionReason: "kev-exploit-signal" };
  }

  // 5. SLA breach on escalatable severity
  if (signals.slaBreaches && signals.slaBreaches.length > 0) {
    const matched = signals.slaBreaches.some((b) =>
      escalateOnSlaBreachSeverities.includes(b.severity),
    );
    if (matched) {
      return { disposition: "escalate", dispositionReason: "sla-breach" };
    }
  }

  // 6. Patch confidence too low
  if (signals.unresolvedReason === "patch-confidence-too-low") {
    return { disposition: "hold-for-approval", dispositionReason: "patch-confidence-too-low" };
  }

  // 7. Hold for transitive
  if (holdForTransitive && signals.dependencyScope === "transitive") {
    return { disposition: "hold-for-approval", dispositionReason: "transitive-dependency" };
  }

  // 8. Unresolved (not applied)
  if (!signals.applied && signals.unresolvedReason) {
    return { disposition: "simulate-only", dispositionReason: signals.unresolvedReason };
  }

  // 9. Applied but low confidence
  if (
    signals.applied &&
    signals.confidence !== undefined &&
    signals.confidence < minConfidenceForAutoApply
  ) {
    return { disposition: "hold-for-approval", dispositionReason: "low-confidence" };
  }

  // 10. Applied
  if (signals.applied) {
    return { disposition: "auto-apply", dispositionReason: "safe-apply" };
  }

  // 11. Default
  return { disposition: "simulate-only", dispositionReason: "unresolved" };
}

export interface DispositionContext {
  exploitSignalTriggered?: boolean;
  slaBreaches?: SlaBreach[];
  severity?: CveSeverity;
  policy?: DispositionPolicy;
  containmentMode?: boolean;
  cwd?: string;
  snapshot?: ProjectSnapshot;
  onContainmentRollback?: () => void;
}

export function applyDispositionAndContainment(
  result: PatchResult,
  context: DispositionContext,
): PatchResult {
  const disposition = computeDisposition(
    {
      exploitSignalTriggered: context.exploitSignalTriggered,
      slaBreaches: context.slaBreaches,
      dependencyScope: result.dependencyScope,
      unresolvedReason: result.unresolvedReason,
      confidence: result.confidence,
      riskLevel: result.riskLevel,
      applied: result.applied,
      severity: context.severity,
    },
    context.policy,
  );

  const withDisposition: PatchResult = {
    ...result,
    disposition: disposition.disposition,
    dispositionReason: disposition.dispositionReason,
  };

  // Containment holds back autonomous changes that still need a human decision. It must never
  // undo an `escalate` fix: for applied results that is an exploited (KEV) or overdue (SLA) CVE,
  // where the fix is exactly what should stay in place while someone is notified.
  if (
    context.containmentMode &&
    withDisposition.disposition === "hold-for-approval" &&
    withDisposition.applied
  ) {
    if (context.snapshot) {
      restoreProjectSnapshotSync(context.snapshot);
    }
    if (context.onContainmentRollback) {
      try {
        context.onContainmentRollback();
      } catch {
        // Non-fatal callback error
      }
    }
    return {
      ...withDisposition,
      applied: false,
      unresolvedReason: "policy-blocked",
    };
  }

  return withDisposition;
}
