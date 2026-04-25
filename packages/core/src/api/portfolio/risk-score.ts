import type { PortfolioTarget } from "../../platform/types.js";

const SEVERITY_WEIGHT: Record<string, number> = {
  CRITICAL: 40,
  HIGH: 30,
  MEDIUM: 10,
  LOW: 5,
  UNKNOWN: 0,
};

export function scorePortfolioTarget(target: PortfolioTarget): number {
  const severity = target.riskHint?.severity;
  const severityWeight = severity ? (SEVERITY_WEIGHT[severity] ?? 0) : 0;
  const exploitSignalBonus = target.riskHint?.exploitSignal === true ? 25 : 0;
  const slaBreachBonus = target.riskHint?.slaBreached === true ? 20 : 0;

  return severityWeight + exploitSignalBonus + slaBreachBonus;
}

export function rankPortfolioTargets(targets: PortfolioTarget[]): Array<{ target: PortfolioTarget; rank: number }> {
  const scoredTargets = targets.map((target, index) => ({
    target,
    index,
    score: scorePortfolioTarget(target),
  }));

  scoredTargets.sort((left, right) => {
    if (right.score !== left.score) {
      return right.score - left.score;
    }
    return left.index - right.index;
  });

  return scoredTargets.map((entry, index) => ({
    target: entry.target,
    rank: index + 1,
  }));
}
