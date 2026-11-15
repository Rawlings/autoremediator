/** Shared types and the scoring table for silent-fix radar. */

export type RadarCategory = "changelog" | "code" | "metadata" | "model";

export type RadarConfidence = "likely" | "possible" | "weak";

/** One piece of evidence that a release made a security-relevant change. */
export interface RadarFlag {
  category: RadarCategory;
  /** Stable identifier of the signal, e.g. `prototype-guard-added`. */
  signal: string;
  /** The release the signal belongs to (`1.2.3`), or a span (`1.2.0..1.2.4`) when versions were not diffed one by one. */
  release: string;
  /** Points the signal contributed before the category cap. */
  points: number;
  /** Where it was found: `file:line` in the package, `CHANGELOG.md:12`, or a registry field. Sanitized. */
  location: string;
  /** Quoted changelog line or `file:line: source`, sanitized, at most 200 characters. Untrusted text. */
  evidence: string;
  /** How many places in the package showed the signal (evidence is the first). */
  occurrences: number;
}

/**
 * Points each signal is worth. The score of a package is the sum per category, each capped, so one
 * noisy signal cannot dominate. Every number here is published in the report (`scoring`).
 */
export const RADAR_POINTS = {
  changelog: {
    /** A line naming a CVE or GHSA id, or a weakness class (prototype pollution, ReDoS, path traversal, XSS, …). */
    strongTerm: 30,
    /** A line saying "security", "vulnerability", "exploit", "denial of service", … */
    mediumTerm: 18,
    /** A line saying sanitize, escape, unsafe, malicious, … */
    mildTerm: 6,
    /** Each further distinct term on the same line, up to twice. */
    extraTermOnLine: 4,
    /** A bullet under a "Security" heading. */
    securityHeading: 24,
    /** Lines counted per release, best first. */
    linesPerRelease: 3,
  },
  code: {
    "redos-regex-replaced": 20,
    "redos-regex-removed": 12,
    "prototype-guard-added": 18,
    "traversal-check-added": 14,
    "path-containment-added": 12,
    "dangerous-sink-removed": 12,
    "timing-safe-compare-added": 10,
    "sanitizer-added": 8,
    "invalid-input-rejected": 8,
    "own-property-check-added": 6,
    "null-prototype-object-added": 6,
    "length-limit-added": 6,
    "validator-added": 5,
    "regex-changed": 2,
  },
  metadata: {
    "deprecated-for-security": 30,
    "release-burst": 3,
    "quick-follow-up": 2,
  },
  model: {
    /** Points at confidence 1.0; the model can raise a score, never lower it. */
    maxPoints: 15,
  },
} as const;

/** Most points each category can add. */
export const CATEGORY_CAPS: Record<RadarCategory, number> = {
  changelog: 50,
  code: 40,
  metadata: 30,
  model: 15,
};

export const CONFIDENCE_THRESHOLDS = {
  /** At least this, with points from at least two of changelog, code and metadata. */
  likely: 45,
  possible: 25,
  weak: 8,
} as const;

export const SCORING_RULE =
  "The score is the sum of points per category (changelog, code, metadata, model), each capped, at most 100. " +
  "likely: at least 45, with points from at least two of changelog, code and metadata (no single signal " +
  "source is enough). possible: at least 25. weak: at least 8. Below 8 is not reported. The model can only " +
  "add points, at most 15, so on its own it reaches weak at best. Text from packages selects nothing " +
  "except through the fixed keyword and code patterns above.";
