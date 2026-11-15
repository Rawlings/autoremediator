import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

const HERE = dirname(fileURLToPath(import.meta.url));

/** Everything the hook loads into a traced process, starting from register.ts. */
const HOOK_FILES = [
  "register.ts",
  "runtime.ts",
  "wrap.ts",
  "esm-instrument.ts",
  "locate.ts",
  "types.ts",
];

describe("the trace hook stays small", () => {
  it("imports only Node.js built-ins and its own files, never the rest of autoremediator", () => {
    const problems: string[] = [];
    for (const file of HOOK_FILES) {
      const source = readFileSync(join(HERE, file), "utf8");
      const statement =
        /^(?:import|export)\s+(?:type\s+)?(?:[\w*]+(?:\s+as\s+\w+)?\s*,?\s*)?(?:\{[^}]*\}\s*)?(?:from\s*)?["']([^"']+)["']/gm;
      const specifiers = [...source.matchAll(statement)].map((match) => match[1] ?? "");
      // Guards the pattern itself: a file that imports something must have it found.
      if (["register.ts", "runtime.ts"].includes(file) && specifiers.length === 0) {
        problems.push(`${file}: no imports found`);
      }
      for (const specifier of specifiers) {
        const own = /^\.\/[a-z-]+\.js$/.test(specifier);
        const known = own && HOOK_FILES.includes(specifier.replace("./", "").replace(".js", ".ts"));
        if (!specifier.startsWith("node:") && !known) problems.push(`${file} imports ${specifier}`);
      }
    }
    expect(problems).toEqual([]);
  });

  it("never writes to stdout or stderr", () => {
    const writers = HOOK_FILES.filter((file) =>
      /console\.|process\.(stdout|stderr)/.test(readFileSync(join(HERE, file), "utf8")),
    );
    expect(writers).toEqual([]);
  });
});
