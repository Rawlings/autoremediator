import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, writeFile, readFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { findPackageCallSites } from "./call-site-finder.js";
import {
  parseCompilerDiagnostics,
  transformCallArguments,
  refactorConsumerCallSites,
  revertRefactorSnapshots,
} from "./refactor-agent.js";

describe("AST Refactor Engine Adversarial White-Box Challenges", () => {
  let testDir: string;

  beforeEach(async () => {
    testDir = await mkdtemp(join(tmpdir(), "refactor-challenge-"));
  });

  afterEach(async () => {
    await rm(testDir, { recursive: true, force: true });
  });

  describe("call-site-finder AST parsing & false positive avoidance", () => {
    it("distinguishes genuine AST imports/calls from comments and strings", async () => {
      const code = `
// import lodash from "lodash";
/* const _ = require("lodash"); */
const fakeString = "import lodash from 'lodash';";
const fakeTemplate = \`lodash.map() is mentioned here\`;

import lodash from "lodash";
import { get, set as customSet } from "lodash";
const cjsLodash = require("lodash");
const { has } = require("lodash");

function test() {
  lodash.map([1, 2], (x) => x * 2);
  get({ a: 1 }, "a");
  customSet({}, "b", 2);
  cjsLodash.filter([1], Boolean);
  has({ c: 3 }, "c");
}
`;
      await writeFile(join(testDir, "app.ts"), code, "utf8");

      const callSites = findPackageCallSites(testDir, "lodash");
      expect(callSites.length).toBe(1);

      const site = callSites[0]!;
      expect(site.importSources).toContain("lodash");
      expect(site.imports.map((i) => i.localName)).toEqual(
        expect.arrayContaining(["lodash", "get", "customSet", "cjsLodash", "has"]),
      );

      // Verify AST call sites discovered genuine references
      const calls = site.callSites ?? [];
      const calledSymbols = calls.map((c) => c.localSymbol);
      expect(calledSymbols).toContain("lodash");
      expect(calledSymbols).toContain("get");
      expect(calledSymbols).toContain("customSet");
      expect(calledSymbols).toContain("cjsLodash");
      expect(calledSymbols).toContain("has");
    });

    it("detects subpath imports such as 'uuid/v4'", async () => {
      const code = `
import v4 from "uuid/v4";
const id = v4();
`;
      await writeFile(join(testDir, "service.ts"), code, "utf8");

      const callSites = findPackageCallSites(testDir, "uuid");
      expect(callSites.length).toBe(1);
      expect(callSites[0]?.importSources).toContain("uuid/v4");
      expect(callSites[0]?.imports[0]?.localName).toBe("v4");
    });

    it("ignores non-source directories like node_modules and dist", async () => {
      await mkdir(join(testDir, "node_modules", "pkg"), { recursive: true });
      await writeFile(
        join(testDir, "node_modules", "pkg", "index.ts"),
        'import axios from "axios"; axios.get("/");',
        "utf8",
      );

      await mkdir(join(testDir, "dist"), { recursive: true });
      await writeFile(
        join(testDir, "dist", "bundle.js"),
        'import axios from "axios"; axios.get("/");',
        "utf8",
      );

      const callSites = findPackageCallSites(testDir, "axios");
      expect(callSites.length).toBe(0);
    });
  });

  describe("parseCompilerDiagnostics compiler feedback parser", () => {
    it("parses standard TypeScript diagnostic formats with line and column", () => {
      const output = `
src/app.ts(12,5): error TS2614: Module '"lodash"' has no exported member 'default'. Did you mean 'lodash'?
src/index.ts:45:10 - error TS2551: Property 'oldMethod' does not exist on type 'Service'. Did you mean 'newMethod'?
`;
      const diagnostics = parseCompilerDiagnostics(output);
      expect(diagnostics.length).toBe(2);

      const d1 = diagnostics[0]!;
      expect(d1.filePath).toBe("src/app.ts");
      expect(d1.line).toBe(12);
      expect(d1.column).toBe(5);
      expect(d1.code).toBe("TS2614");
      expect(d1.suggestedSymbol).toBe("lodash");
      expect(d1.missingMember).toBe("default");

      const d2 = diagnostics[1]!;
      expect(d2.filePath).toBe("src/index.ts");
      expect(d2.line).toBe(45);
      expect(d2.column).toBe(10);
      expect(d2.code).toBe("TS2551");
      expect(d2.suggestedSymbol).toBe("newMethod");
      expect(d2.missingMember).toBe("oldMethod");
    });
  });

  describe("transformCallArguments parameter dropping & reordering", () => {
    it("drops sole parameter cleanly: fn(a) -> fn()", () => {
      const code = "client.fetch(url);";
      const result = transformCallArguments(code, {
        callee: "fetch",
        dropIndex: 0,
      });

      expect(result.modified).toBe(true);
      expect(result.newContent).toBe("client.fetch();");
    });

    it("drops first parameter among multiple: fn(a, b, c) -> fn(b, c)", () => {
      const code = "doWork(first, second, third);";
      const result = transformCallArguments(code, {
        callee: "doWork",
        dropIndex: 0,
      });

      expect(result.modified).toBe(true);
      expect(result.newContent).toBe("doWork(second, third);");
    });

    it("drops middle parameter among multiple: fn(a, b, c) -> fn(a, c)", () => {
      const code = "doWork(first, second, third);";
      const result = transformCallArguments(code, {
        callee: "doWork",
        dropIndex: 1,
      });

      expect(result.modified).toBe(true);
      expect(result.newContent).toBe("doWork(first, third);");
    });

    it("drops last parameter: fn(a, b, c) -> fn(a, b)", () => {
      const code = "doWork(first, second, third);";
      const result = transformCallArguments(code, {
        callee: "doWork",
        dropIndex: 2,
      });

      expect(result.modified).toBe(true);
      expect(result.newContent).toBe("doWork(first, second);");
    });

    it("reorders arguments: fn(a, b) -> fn(b, a)", () => {
      const code = "transform(input, options);";
      const result = transformCallArguments(code, {
        callee: "transform",
        reorder: [0, 1],
      });

      expect(result.modified).toBe(true);
      expect(result.newContent).toBe("transform(options, input);");
    });
  });

  describe("refactorConsumerCallSites end-to-end breaking change codemods", () => {
    it("migrates deprecated subpath import 'uuid/v4' to named import from 'uuid'", async () => {
      const code = `
import v4 from "uuid/v4";
export const id = v4();
`;
      const filePath = join(testDir, "id.ts");
      await writeFile(filePath, code, "utf8");

      const callSites = findPackageCallSites(testDir, "uuid");
      const diag =
        "error TS2307: Cannot find module 'uuid/v4' or its corresponding type declarations.";

      const res = await refactorConsumerCallSites({
        cwd: testDir,
        packageName: "uuid",
        fromVersion: "3.4.0",
        toVersion: "9.0.0",
        diagnosticError: diag,
        callSites,
      });

      expect(res.applied).toBe(true);
      expect(res.refactoredFiles).toContain(filePath);

      const modified = await readFile(filePath, "utf8");
      expect(modified).toContain('import { v4 as v4 } from "uuid";');
      expect(modified).toContain("export const id = v4();");
    });

    it("migrates rimraf.sync(...) to rimrafSync(...) with named import", async () => {
      const code = `
import rimraf from "rimraf";
export function clean(dir: string) {
  rimraf.sync(dir);
}
`;
      const filePath = join(testDir, "clean.ts");
      await writeFile(filePath, code, "utf8");

      const callSites = findPackageCallSites(testDir, "rimraf");
      const diag =
        "error TS2339: Property 'sync' does not exist on type 'typeof import(\"rimraf\")'. Did you mean 'rimrafSync'?";

      const res = await refactorConsumerCallSites({
        cwd: testDir,
        packageName: "rimraf",
        fromVersion: "3.0.2",
        toVersion: "5.0.5",
        diagnosticError: diag,
        callSites,
      });

      expect(res.applied).toBe(true);
      const modified = await readFile(filePath, "utf8");
      expect(modified).toContain('import { rimrafSync } from "rimraf";');
      expect(modified).toContain("rimrafSync(dir);");
      expect(modified).not.toContain("rimraf.sync(");
    });

    it("migrates glob.sync(...) to globSync(...) with named import", async () => {
      const code = `
import glob from "glob";
export const files = glob.sync("**/*.ts");
`;
      const filePath = join(testDir, "glob.ts");
      await writeFile(filePath, code, "utf8");

      const callSites = findPackageCallSites(testDir, "glob");
      const diag =
        "error TS2339: Property 'sync' does not exist on type 'typeof import(\"glob\")'. Did you mean 'globSync'?";

      const res = await refactorConsumerCallSites({
        cwd: testDir,
        packageName: "glob",
        fromVersion: "7.2.0",
        toVersion: "10.3.10",
        diagnosticError: diag,
        callSites,
      });

      expect(res.applied).toBe(true);
      const modified = await readFile(filePath, "utf8");
      expect(modified).toContain('import { globSync } from "glob";');
      expect(modified).toContain('globSync("**/*.ts");');
    });

    it("migrates default import to namespace import when default export is removed (TS2614/TS1192)", async () => {
      const code = `
import chalk from "chalk";
console.log(chalk.red("error"));
`;
      const filePath = join(testDir, "log.ts");
      await writeFile(filePath, code, "utf8");

      const callSites = findPackageCallSites(testDir, "chalk");
      const diag = "error TS2614: Module '\"chalk\"' has no exported member 'default'.";

      const res = await refactorConsumerCallSites({
        cwd: testDir,
        packageName: "chalk",
        fromVersion: "4.1.2",
        toVersion: "5.3.0",
        diagnosticError: diag,
        callSites,
      });

      expect(res.applied).toBe(true);
      const modified = await readFile(filePath, "utf8");
      expect(modified).toContain('import * as chalk from "chalk";');
    });

    it("migrates namespace import to default import when TS1259 is reported", async () => {
      const code = `
import * as express from "express";
const app = express();
`;
      const filePath = join(testDir, "server.ts");
      await writeFile(filePath, code, "utf8");

      const callSites = findPackageCallSites(testDir, "express");
      const diag =
        "error TS1259: Module '\"express\"' can only be used with a default import when 'allowSyntheticDefaultImports' is true.";

      const res = await refactorConsumerCallSites({
        cwd: testDir,
        packageName: "express",
        fromVersion: "4.18.2",
        toVersion: "5.0.0",
        diagnosticError: diag,
        callSites,
      });

      expect(res.applied).toBe(true);
      const modified = await readFile(filePath, "utf8");
      expect(modified).toContain('import express from "express";');
    });

    it("auto-replaces renamed symbols suggested by compiler feedback ('Did you mean XYZ?')", async () => {
      const code = `
import { oldMethod } from "api-lib";
export function run() {
  return oldMethod();
}
`;
      const filePath = join(testDir, "api.ts");
      await writeFile(filePath, code, "utf8");

      const callSites = findPackageCallSites(testDir, "api-lib");
      const diag = `${filePath}(2,10): error TS2614: Module '"api-lib"' has no exported member 'oldMethod'. Did you mean 'newMethod'?`;

      const res = await refactorConsumerCallSites({
        cwd: testDir,
        packageName: "api-lib",
        fromVersion: "1.0.0",
        toVersion: "2.0.0",
        diagnosticError: diag,
        callSites,
      });

      expect(res.applied).toBe(true);
      const modified = await readFile(filePath, "utf8");
      expect(modified).toContain("newMethod");
    });

    it("reverts snapshots cleanly upon emergency rollback", async () => {
      const originalCode = "const original = true;\n";
      const filePath = join(testDir, "broken.ts");
      await writeFile(filePath, originalCode, "utf8");

      const snapshots = {
        [filePath]: originalCode,
      };

      // Mutate file
      await writeFile(filePath, "const corrupted = true;\n", "utf8");
      revertRefactorSnapshots(snapshots);

      const restored = await readFile(filePath, "utf8");
      expect(restored).toBe(originalCode);
    });
  });
});
