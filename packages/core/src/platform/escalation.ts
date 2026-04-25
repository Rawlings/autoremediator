import type { EscalationAction, EscalationGraph, UnresolvedReason } from "./types.js";

export const DEFAULT_ESCALATION_GRAPH: EscalationGraph = {
  "consensus-failed": "create-draft-pr",
  "patch-validation-failed": "open-issue",
  "patch-confidence-too-low": "open-issue",
  "source-fetch-failed": "notify-channel",
  "patch-generation-failed": "notify-channel",
  "no-safe-version": "open-issue",
  "validation-failed": "create-draft-pr",
};

export function computeEscalationAction(
  reason: UnresolvedReason | undefined,
  graph?: EscalationGraph
): EscalationAction {
  if (!reason) return "none";

  const mergedGraph: EscalationGraph = {
    ...DEFAULT_ESCALATION_GRAPH,
    ...(graph ?? {}),
  };

  return mergedGraph[reason] ?? "none";
}
