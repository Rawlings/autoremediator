import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { assessPackageReachability } from "./check-reachability.js";

function makeTmp(): string {
  return mkdtempSync(join(tmpdir(), "autoremediator-reach-test-"));
}

describe("assessPackageReachability", () => {
  let dir: string;

  beforeEach(() => {
    dir = makeTmp();
    mkdirSync(join(dir, "src"), { recursive: true });
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("returns reachable when package is imported via ESM import", () => {
    writeFileSync(join(dir, "src", "index.ts"), `import lodash from 'lodash';\nconsole.log(lodash);`);
    const result = assessPackageReachability(dir, "lodash");
    expect(result.status).toBe("reachable");
    expect(result.evidence?.length).toBeGreaterThan(0);
    expect(result.evidence?.[0]?.filePath).toContain("index.ts");
  });

  it("returns reachable when package is required via CommonJS", () => {
    writeFileSync(join(dir, "src", "util.js"), `const path = require('lodash/merge');\n`);
    const result = assessPackageReachability(dir, "lodash");
    expect(result.status).toBe("reachable");
  });

  it("returns not-reachable when package is not found in any source file", () => {
    writeFileSync(join(dir, "src", "app.ts"), `import express from 'express';\n`);
    const result = assessPackageReachability(dir, "lodash");
    expect(result.status).toBe("not-reachable");
    expect(result.reason).toContain("lodash");
  });

  it("returns unknown when no source files exist in the directory", () => {
    const empty = makeTmp();
    try {
      const result = assessPackageReachability(empty, "lodash");
      expect(result.status).toBe("unknown");
    } finally {
      rmSync(empty, { recursive: true, force: true });
    }
  });

  it("returns reachable for scoped package names", () => {
    writeFileSync(join(dir, "src", "index.ts"), `import { parse } from '@babel/core';\n`);
    const result = assessPackageReachability(dir, "@babel/core");
    expect(result.status).toBe("reachable");
  });

  it("skips node_modules during scan", () => {
    mkdirSync(join(dir, "node_modules", "lodash"), { recursive: true });
    writeFileSync(join(dir, "node_modules", "lodash", "index.js"), `require('lodash');`);
    writeFileSync(join(dir, "src", "clean.ts"), `export const x = 1;`);
    const result = assessPackageReachability(dir, "lodash");
    expect(result.status).toBe("not-reachable");
  });
});
