import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";

import { describe, expect, it } from "vitest";

/**
 * The dependency rules from `docs/contributing/architecture.md`, enforced by reading imports:
 *
 *   surfaces -> features -> infra -> shared      (`api/`, the public barrel, sits beside surfaces)
 *
 * A folder may import its own layer or a lower one, never a higher one. Inside `features/`, a
 * feature should reach another feature through its `index.ts`; the imports that do not yet are a
 * ratchet (see CROSS_FEATURE_DEEP_IMPORTS) that may only shrink.
 */
const SRC = join(__dirname, "../..");

const ALLOWED: Record<string, string[]> = {
  shared: ["shared"],
  infra: ["shared", "infra"],
  features: ["shared", "infra", "features"],
  api: ["shared", "infra", "features", "api"],
  surfaces: ["shared", "infra", "features", "api", "surfaces"],
};

/**
 * Imports of another feature's internals (not its `index.ts` or `types.ts`). Lower this as the
 * features get barrels. Barrels cannot all be added yet: see FEATURE_CYCLE_SIZE.
 */
const CROSS_FEATURE_DEEP_IMPORTS = 180;

/**
 * Features that depend on each other in a loop (remediate, runs, patch, repair, verify, upgrade and
 * their neighbours). A barrel in a loop makes modules load before their imports have run, so the
 * loop has to be broken first: types and helpers the lower features need move down out of
 * `remediate/`, so only orchestrators (remediate, runs, change-request, incident) import the engine
 * (patch, upgrade, verify, repair), never the other way. This may only shrink.
 */
const FEATURE_CYCLE_SIZE = 14;

interface Import {
  from: string;
  to: string;
}

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return name === "node_modules" ? [] : sourceFiles(path);
    return path.endsWith(".ts") && !path.includes(".test.") ? [path] : [];
  });
}

function importsIn(file: string): Import[] {
  const text = readFileSync(file, "utf8");
  const found: Import[] = [];
  for (const match of text.matchAll(/(?:from|import\()\s*"(\.{1,2}\/[^"]+)"/g)) {
    const specifier = match[1] ?? "";
    const target = resolve(dirname(file), specifier.replace(/\.js$/, ""));
    found.push({ from: relative(SRC, file), to: relative(SRC, target) });
  }
  return found;
}

/** The members of the largest strongly connected component (Tarjan). */
function largestCycle(graph: Map<string, Set<string>>): string[] {
  const index = new Map<string, number>();
  const low = new Map<string, number>();
  const stack: string[] = [];
  const onStack = new Set<string>();
  let largest: string[] = [];
  let counter = 0;
  const visit = (node: string): void => {
    index.set(node, counter);
    low.set(node, counter);
    counter += 1;
    stack.push(node);
    onStack.add(node);
    for (const next of graph.get(node) ?? []) {
      if (!index.has(next)) {
        visit(next);
        low.set(node, Math.min(low.get(node) ?? 0, low.get(next) ?? 0));
      } else if (onStack.has(next)) {
        low.set(node, Math.min(low.get(node) ?? 0, index.get(next) ?? 0));
      }
    }
    if (low.get(node) !== index.get(node)) return;
    const component: string[] = [];
    let member: string | undefined;
    do {
      member = stack.pop();
      if (member === undefined) break;
      onStack.delete(member);
      component.push(member);
    } while (member !== node);
    if (component.length > largest.length) largest = component;
  };
  for (const node of graph.keys()) {
    if (!index.has(node)) visit(node);
  }
  return largest.length > 1 ? largest : [];
}

const imports = sourceFiles(SRC).flatMap((file) => importsIn(file));
const layerOf = (path: string): string => path.split(sep)[0] ?? "";
const featureOf = (path: string): string | undefined => {
  const parts = path.split(sep);
  return parts[0] === "features" ? parts[1] : undefined;
};

describe("module boundaries (see docs/contributing/architecture.md)", () => {
  it("has only the known top-level folders", () => {
    const folders = readdirSync(SRC, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && entry.name !== "node_modules")
      .map((entry) => entry.name)
      .toSorted();
    expect(folders).toEqual(Object.keys(ALLOWED).toSorted());
  });

  for (const [layer, allowed] of Object.entries(ALLOWED)) {
    it(`${layer}/ imports only from ${allowed.join(", ")}`, () => {
      const violations = imports
        .filter(({ from, to }) => layerOf(from) === layer && !allowed.includes(layerOf(to)))
        .map(({ from, to }) => `${from} -> ${to}`);
      expect(violations).toEqual([]);
    });
  }

  it("only ratchets down on imports of another feature's internals", () => {
    const deep = imports.filter(({ from, to }) => {
      const owner = featureOf(from);
      const target = featureOf(to);
      if (!owner || !target || owner === target) return false;
      const file = to.split(sep).slice(2).join("/");
      return file !== "" && file !== "index" && file !== "types";
    });
    expect(deep.length).toBeLessThanOrEqual(CROSS_FEATURE_DEEP_IMPORTS);
  });

  it("keeps the loop between features from growing", () => {
    const graph = new Map<string, Set<string>>();
    for (const { from, to } of imports) {
      const owner = featureOf(from);
      const target = featureOf(to);
      if (!owner || !target || owner === target) continue;
      graph.set(owner, (graph.get(owner) ?? new Set()).add(target));
    }
    expect(largestCycle(graph).length).toBeLessThanOrEqual(FEATURE_CYCLE_SIZE);
  });
});
