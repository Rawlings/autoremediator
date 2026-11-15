import { describe, expect, it } from "vitest";

import { ddmin, type Verdict } from "./ddmin.js";

const names = (count: number): string[] => Array.from({ length: count }, (_, index) => `p${index}`);

/** An oracle that fails when `needed` are all present, and counts how often it is asked. */
function oracle(needed: string[]) {
  const calls: string[][] = [];
  return {
    calls,
    test: async (subset: readonly string[]): Promise<Verdict> => {
      calls.push([...subset]);
      return needed.every((name) => subset.includes(name)) ? "fail" : "pass";
    },
  };
}

const id = (value: string) => value;

describe("ddmin", () => {
  it("finds a single culprit in about 2*log2(n) evaluations", async () => {
    const items = names(64);
    const { test, calls } = oracle(["p37"]);
    const result = await ddmin(items, id, test);
    expect(result.minimal).toEqual(["p37"]);
    expect(result.complete).toBe(true);
    expect(calls.length).toBeLessThanOrEqual(12);
    expect(result.evaluations).toBe(calls.length);
  });

  it("finds every position of a single culprit", async () => {
    const items = names(11);
    for (const culprit of items) {
      const { test } = oracle([culprit]);
      const result = await ddmin(items, id, test);
      expect(result.minimal).toEqual([culprit]);
    }
  });

  it("returns the whole set when everything is needed", async () => {
    const items = names(3);
    const { test } = oracle(items);
    const result = await ddmin(items, id, test);
    expect(result.minimal).toEqual(items);
    expect(result.complete).toBe(true);
  });

  it("finds an interaction of two packages that fail only together", async () => {
    const items = names(16);
    const { test } = oracle(["p3", "p12"]);
    const result = await ddmin(items, id, test);
    expect(result.minimal.toSorted()).toEqual(["p12", "p3"]);
    expect(result.complete).toBe(true);
  });

  it("finds an interaction of three packages spread across partitions", async () => {
    const items = names(20);
    const { test } = oracle(["p0", "p9", "p19"]);
    const result = await ddmin(items, id, test);
    expect(result.minimal.toSorted()).toEqual(["p0", "p19", "p9"]);
  });

  it("prefers a failing subset that needs fewer packages when failures overlap", async () => {
    // Fails with a alone or with b and c together: either is a valid answer, but it must be minimal.
    const items = names(8);
    const test = async (subset: readonly string[]): Promise<Verdict> =>
      subset.includes("p1") || (subset.includes("p4") && subset.includes("p6")) ? "fail" : "pass";
    const result = await ddmin(items, id, test);
    const minimal = result.minimal.toSorted();
    expect([["p1"], ["p4", "p6"]]).toContainEqual(minimal);
  });

  it("never evaluates the same subset twice", async () => {
    const seen = new Set<string>();
    const test = async (subset: readonly string[]): Promise<Verdict> => {
      const key = subset.toSorted().join(",");
      expect(seen.has(key)).toBe(false);
      seen.add(key);
      return ["p2", "p5", "p6"].every((name) => subset.includes(name)) ? "fail" : "pass";
    };
    await ddmin(names(9), id, test);
  });

  it("stops at the evaluation budget and says the result may not be minimal", async () => {
    const { test, calls } = oracle(["p20"]);
    const result = await ddmin(names(64), id, test, { maxEvaluations: 3 });
    expect(calls).toHaveLength(3);
    expect(result.complete).toBe(false);
    expect(result.stoppedBecause).toBe("budget");
    // It still fails: the best set so far always contains the culprit.
    expect(result.minimal).toContain("p20");
    expect(result.minimal.length).toBeLessThan(64);
  });

  it("stops when asked to", async () => {
    const { test, calls } = oracle(["p1"]);
    let asked = 0;
    const result = await ddmin(names(16), id, test, { shouldStop: () => ++asked > 2 });
    expect(calls).toHaveLength(2);
    expect(result.stoppedBecause).toBe("stopped");
    expect(result.complete).toBe(false);
  });

  it("treats an unresolved candidate as not failing and reports the result as incomplete", async () => {
    const items = names(4);
    // p0 alone cannot be built, so the search cannot narrow below the half that contains it.
    const test = async (subset: readonly string[]): Promise<Verdict> => {
      if (subset.length === 1 && subset[0] === "p0") return "unresolved";
      return subset.includes("p0") ? "fail" : "pass";
    };
    const result = await ddmin(items, id, test);
    expect(result.complete).toBe(false);
    expect(result.minimal).toContain("p0");
    expect(result.stoppedBecause).toBeUndefined();
  });

  it("returns a single item without evaluating anything", async () => {
    const { test, calls } = oracle(["p0"]);
    const result = await ddmin(["p0"], id, test);
    expect(result.minimal).toEqual(["p0"]);
    expect(calls).toHaveLength(0);
  });
});
