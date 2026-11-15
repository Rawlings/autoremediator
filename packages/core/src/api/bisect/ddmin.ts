/** What running the command against one candidate state told us. */
export type Verdict = "pass" | "fail" | "unresolved";

export interface DdminResult<T> {
  /** The smallest failing subset found; every item of it is needed to keep the failure. */
  minimal: T[];
  /** Candidate states actually evaluated (cache hits are free). */
  evaluations: number;
  /**
   * False when the search stopped early (budget, abort) or a candidate could not be evaluated, so
   * `minimal` still fails but may not be minimal.
   */
  complete: boolean;
  /** Why the search stopped early, when it did. */
  stoppedBecause?: "budget" | "stopped";
}

export interface DdminOptions {
  /** Evaluate at most this many distinct candidates; the search then returns what it has. */
  maxEvaluations?: number;
  /** Asked before every evaluation; return true to stop (Ctrl-C). */
  shouldStop?: () => boolean;
}

/**
 * Zeller's delta debugging (ddmin): find a 1-minimal subset of `items` that still makes `test` fail.
 * With a single culprit this is a binary search (the subset halves each round); when two or more
 * items are needed together, no half fails on its own, so it tries the complements and finer
 * partitions until no single item can be dropped.
 *
 * The caller must know that the full set fails and the empty set passes. An `unresolved` verdict
 * (the candidate could not be built or installed) is treated as "not failing" for the reduction, and
 * is reported through `complete: false`, because the result then may not be minimal.
 */
export async function ddmin<T>(
  items: readonly T[],
  key: (item: T) => string,
  test: (subset: readonly T[]) => Promise<Verdict>,
  options: DdminOptions = {},
): Promise<DdminResult<T>> {
  const cache = new Map<string, Verdict>();
  let evaluations = 0;
  let unresolved = false;
  let stoppedBecause: DdminResult<T>["stoppedBecause"];

  const cacheKey = (subset: readonly T[]) =>
    subset
      .map((item) => key(item))
      .toSorted()
      .join("\n");

  /** `undefined` means the search must stop. */
  const evaluate = async (subset: readonly T[]): Promise<Verdict | undefined> => {
    const id = cacheKey(subset);
    const known = cache.get(id);
    if (known) return known;
    if (options.shouldStop?.()) {
      stoppedBecause = "stopped";
      return undefined;
    }
    if (options.maxEvaluations !== undefined && evaluations >= options.maxEvaluations) {
      stoppedBecause = "budget";
      return undefined;
    }
    evaluations++;
    const verdict = await test(subset);
    if (verdict === "unresolved") unresolved = true;
    cache.set(id, verdict);
    return verdict;
  };

  let current = [...items];
  let granularity = 2;

  search: while (current.length >= 2) {
    const subsets = partition(current, granularity);

    for (const subset of subsets) {
      const verdict = await evaluate(subset);
      if (verdict === undefined) break search;
      if (verdict === "fail") {
        current = subset;
        granularity = 2;
        continue search;
      }
    }

    // With two parts a complement is the other part, which was just tried.
    if (granularity > 2) {
      for (const subset of subsets) {
        const complement = current.filter((item) => !subset.includes(item));
        const verdict = await evaluate(complement);
        if (verdict === undefined) break search;
        if (verdict === "fail") {
          current = complement;
          granularity = Math.max(granularity - 1, 2);
          continue search;
        }
      }
    }

    if (granularity >= current.length) break;
    granularity = Math.min(granularity * 2, current.length);
  }

  return {
    minimal: current,
    evaluations,
    complete: stoppedBecause === undefined && !unresolved,
    ...(stoppedBecause ? { stoppedBecause } : {}),
  };
}

/** Split into `parts` contiguous chunks whose sizes differ by at most one. */
function partition<T>(items: readonly T[], parts: number): T[][] {
  const result: T[][] = [];
  let start = 0;
  for (let index = 0; index < parts; index++) {
    const end = start + Math.ceil((items.length - start) / (parts - index));
    result.push(items.slice(start, end));
    start = end;
  }
  return result.filter((chunk) => chunk.length > 0);
}
