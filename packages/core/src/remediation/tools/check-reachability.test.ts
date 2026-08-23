import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  assessPackageReachability,
  loadTsconfigPaths,
  resolveAliasedPath,
} from "./check-reachability.js";

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
    writeFileSync(
      join(dir, "src", "index.ts"),
      `import lodash from 'lodash';\nconsole.log(lodash);`,
    );
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

  it("returns reachable for dynamic imports", () => {
    writeFileSync(
      join(dir, "src", "lazy.ts"),
      `async function load() { const mod = await import('lodash'); }\n`,
    );
    const result = assessPackageReachability(dir, "lodash");
    expect(result.status).toBe("reachable");
    expect(result.evidence?.[0]?.matchType).toBe("dynamic-import");
  });

  it("returns reachable for re-exports", () => {
    writeFileSync(join(dir, "src", "reexport.ts"), `export { template } from 'lodash';\n`);
    const result = assessPackageReachability(dir, "lodash");
    expect(result.status).toBe("reachable");
    expect(result.evidence?.[0]?.matchType).toBe("re-export");
  });

  it("prunes uncalled symbols from call-graph and reports not-reachable with justification", () => {
    // lodash is imported, but only 'escape' is called, 'template' is uninvoked dead code
    writeFileSync(
      join(dir, "src", "index.ts"),
      `import { template, escape } from 'lodash';\nconst safeHtml = escape('<b>hello</b>');\nconsole.log(safeHtml);\n`,
    );

    const reachableSymbol = assessPackageReachability(dir, "lodash", "escape");
    expect(reachableSymbol.status).toBe("reachable");
    expect(reachableSymbol.reachabilityBasis).toBe("call-path-found");

    const uncalledSymbol = assessPackageReachability(dir, "lodash", "template");
    expect(uncalledSymbol.status).toBe("not-reachable");
    expect(uncalledSymbol.reachabilityBasis).toBe("call-graph-uninvoked");
    expect(uncalledSymbol.justification).toBe("code_not_in_execute_path");
  });

  it("detects member expression invocations on default/namespace imports", () => {
    writeFileSync(
      join(dir, "src", "template-user.ts"),
      `import _ from 'lodash';\nconst compiled = _.template('Hello <%= user %>');\ncompiled({ user: 'Alice' });\n`,
    );

    const result = assessPackageReachability(dir, "lodash", "template");
    expect(result.status).toBe("reachable");
    expect(result.reachabilityBasis).toBe("call-path-found");
  });

  it("resolves tsconfig path aliases correctly", () => {
    writeFileSync(
      join(dir, "tsconfig.json"),
      JSON.stringify({
        compilerOptions: {
          baseUrl: ".",
          paths: {
            "@/*": ["src/*"],
          },
        },
      }),
    );

    const config = loadTsconfigPaths(dir);
    expect(config?.paths["@/*"]).toBeDefined();
    expect(resolveAliasedPath("@/components/button", config)).toContain("src/components/button");
  });

  it("parses TSX files with JSX and type annotations", () => {
    writeFileSync(
      join(dir, "src", "Component.tsx"),
      `import React from 'react';\nimport { clsx, type ClassValue } from 'clsx';\nexport const Comp = () => <div className={clsx('a', 'b')} />;\n`,
    );
    const result = assessPackageReachability(dir, "clsx");
    expect(result.status).toBe("reachable");
    expect(result.evidence?.[0]?.importedSymbols).toContain("clsx");
  });

  it("handles package subpath imports correctly", () => {
    writeFileSync(join(dir, "src", "sub.ts"), `import fpMerge from 'lodash/fp/merge';\n`);
    const result = assessPackageReachability(dir, "lodash");
    expect(result.status).toBe("reachable");
  });
});
