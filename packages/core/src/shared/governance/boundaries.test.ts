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

/** Imports of another feature's internals (not its index.ts). Lower this as features get barrels. */
const CROSS_FEATURE_DEEP_IMPORTS = 390;

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
      return to.split(sep).length > 3 || !/(^|\/)index$/.test(to);
    });
    expect(deep.length).toBeLessThanOrEqual(CROSS_FEATURE_DEEP_IMPORTS);
  });
});
