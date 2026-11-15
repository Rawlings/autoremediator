/** Turn a package's flags into a score, a confidence label and a per-category breakdown. */
import {
  CATEGORY_CAPS,
  CONFIDENCE_THRESHOLDS,
  type RadarCategory,
  type RadarConfidence,
  type RadarFlag,
} from "./types.js";

export interface RadarScore {
  score: number;
  /** Absent when the score is below the lowest threshold: nothing worth reporting. */
  confidence?: RadarConfidence;
  /** Points per category after its cap. */
  breakdown: Record<RadarCategory, number>;
}

const CATEGORIES: readonly RadarCategory[] = ["changelog", "code", "metadata", "model"];

/** Sum per category, cap each, add them (at most 100), and label the result. */
export function scoreFlags(flags: readonly RadarFlag[]): RadarScore {
  const breakdown: Record<RadarCategory, number> = { changelog: 0, code: 0, metadata: 0, model: 0 };
  for (const category of CATEGORIES) {
    const raw = flags
      .filter((flag) => flag.category === category)
      .reduce((total, flag) => total + flag.points, 0);
    breakdown[category] = Math.min(CATEGORY_CAPS[category], raw);
  }
  const score = Math.min(
    100,
    CATEGORIES.reduce((total, category) => total + breakdown[category], 0),
  );
  const deterministic = (["changelog", "code", "metadata"] as const).filter(
    (category) => breakdown[category] > 0,
  );

  let confidence: RadarConfidence | undefined;
  if (score >= CONFIDENCE_THRESHOLDS.likely && deterministic.length >= 2) {
    confidence = "likely";
  } else if (score >= CONFIDENCE_THRESHOLDS.possible) {
    confidence = "possible";
  } else if (score >= CONFIDENCE_THRESHOLDS.weak) {
    confidence = "weak";
  }
  return confidence ? { score, confidence, breakdown } : { score, breakdown };
}
