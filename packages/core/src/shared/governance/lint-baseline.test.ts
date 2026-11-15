import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

/**
 * The readability rules in `.oxlintrc.json` (braces, nested ternaries, file and function length)
 * are switched off for the files that predate them, listed in override blocks. That list is a
 * ratchet: it may only shrink. When you fix a file, delete its path there and lower the cap below.
 */
const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "..", "..");

const CAPS: Record<string, number> = {
  "eslint/max-lines": 29,
  "eslint/max-lines-per-function": 94,
  "eslint/no-nested-ternary": 69,
  "eslint/curly": 98,
};

interface Override {
  files: string[];
  rules: Record<string, unknown>;
}

function baselines(): Map<string, string[]> {
  const text = readFileSync(join(root, ".oxlintrc.json"), "utf8").replaceAll(/^\s*\/\/.*$/gm, "");
  const { overrides } = JSON.parse(text) as { overrides: Override[] };
  const found = new Map<string, string[]>();
  for (const override of overrides) {
    const rules = Object.keys(override.rules);
    const [rule] = rules;
    // A baseline block switches off exactly one ratcheted rule for a list of files.
    if (rules.length === 1 && rule !== undefined && rule in CAPS) found.set(rule, override.files);
  }
  return found;
}

describe("readability lint baseline", () => {
  const found = baselines();

  it("has a baseline block for every ratcheted rule", () => {
    expect([...found.keys()].toSorted()).toEqual(Object.keys(CAPS).toSorted());
  });

  it.each(Object.entries(CAPS))("never grows the %s baseline beyond %i files", (rule, cap) => {
    expect(found.get(rule)?.length ?? 0).toBeLessThanOrEqual(cap);
  });

  it("lists only files that still exist (delete a path when its file is moved or removed)", () => {
    const missing = [...found.values()].flat().filter((path) => !existsSync(join(root, path)));
    expect(missing).toEqual([]);
  });
});
