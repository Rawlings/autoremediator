import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, describe, expect, it } from "vitest";

import { TRACE_SCHEMA, type TracePackage, type TraceReport } from "../trace/types.js";
import { checkReachability } from "./index.js";

const __dirname = fileURLToPath(new URL(".", import.meta.url));
const fixtureDir = join(__dirname, "../../../");

describe("checkReachability public SDK", () => {
  it("traces reachability for existing package in core", async () => {
    const result = await checkReachability({
      cwd: fixtureDir,
      packageName: "semver",
    });

    expect(result.packageName).toBe("semver");
    expect(result.status).toBe("reachable");
    expect(result.evidence?.length).toBeGreaterThan(0);
  });

  it("reports not-reachable for unreferenced package", async () => {
    const result = await checkReachability({
      cwd: fixtureDir,
      packageName: "definitely-non-existent-pkg-xyz",
    });

    expect(result.packageName).toBe("definitely-non-existent-pkg-xyz");
    expect(result.status).toBe("not-reachable");
    expect(result.justification).toBe("code_not_in_execute_path");
  });
});

describe("checkReachability with a runtime trace", () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  function project(
    source: string,
    packages: Partial<TracePackage>[],
    over: Partial<TraceReport> = {},
  ): string {
    const dir = mkdtempSync(join(tmpdir(), "ar-reach-"));
    dirs.push(dir);
    writeFileSync(join(dir, "index.js"), source);
    const report: TraceReport = {
      schema: TRACE_SCHEMA,
      createdAt: "2026-01-01T00:00:00.000Z",
      processes: 1,
      partialEsm: false,
      callTracing: { enabled: true, packages: ["dep"] },
      skippedLines: 0,
      command: { argv: ["node", "--test"], exitCode: 0 },
      packages: packages.map((pkg) => ({
        name: "dep",
        version: "1.0.0",
        entries: ["index.js"],
        dependents: ["(app)"],
        formats: ["cjs"],
        ...pkg,
      })),
      ...over,
    };
    writeFileSync(join(dir, "trace.json"), JSON.stringify(report));
    return dir;
  }

  it("names its evidence as static and adds nothing else when no trace is supplied", async () => {
    const dir = project(`import { run } from "dep"; run();`, []);
    const result = await checkReachability({ cwd: dir, packageName: "dep" });
    expect(result.evidenceKind).toBe("static");
    expect(result.runtime).toBeUndefined();
  });

  it("adds the runtime verdict next to an unchanged static status", async () => {
    const dir = project(`import { run } from "dep"; run();`, [{ calls: { run: 2 } }]);
    const result = await checkReachability({
      cwd: dir,
      packageName: "dep",
      symbol: "run",
      traceFile: "trace.json",
    });
    expect(result.evidenceKind).toBe("both");
    expect(result.status).toBe("reachable");
    expect(result.runtime).toMatchObject({ verdict: "called-in-tests", calls: { count: 2 } });
    expect(result.staticStatus).toBeUndefined();
  });

  it("upgrades a static not-reachable when the symbol was observed being called", async () => {
    const dir = project(`import { other } from "dep"; other();`, [{ calls: { run: 1 } }]);
    const staticOnly = await checkReachability({ cwd: dir, packageName: "dep", symbol: "run" });
    expect(staticOnly.status).toBe("not-reachable");
    const result = await checkReachability({
      cwd: dir,
      packageName: "dep",
      symbol: "run",
      traceFile: join(dir, "trace.json"),
    });
    expect(result).toMatchObject({
      status: "reachable",
      staticStatus: "not-reachable",
      reachabilityBasis: "runtime-call-observed",
    });
    expect(result.justification).toBeUndefined();
    expect(result.reason).toContain("static scan reported");
  });

  it("does not call a package unreachable because the tests never loaded it", async () => {
    const dir = project(`import { run } from "dep"; run();`, []);
    const result = await checkReachability({
      cwd: dir,
      packageName: "dep",
      symbol: "run",
      traceFile: "trace.json",
    });
    expect(result.status).toBe("reachable");
    expect(result.runtime?.verdict).toBe("not-loaded-in-tests");
    expect(result.runtime?.caveat).toMatch(/not proof/);
  });

  it("leaves static not-reachable alone when the trace only shows the package loaded", async () => {
    const dir = project(`import { other } from "dep"; other();`, [{ calls: { other: 1 } }]);
    const result = await checkReachability({
      cwd: dir,
      packageName: "dep",
      symbol: "run",
      traceFile: "trace.json",
    });
    expect(result.status).toBe("not-reachable");
    expect(result.runtime?.verdict).toBe("loaded-not-called-in-tests");
    expect(result.evidenceKind).toBe("both");
  });

  it("uses runtime evidence alone when the static scan found nothing to scan", async () => {
    const empty = mkdtempSync(join(tmpdir(), "ar-reach-empty-"));
    dirs.push(empty);
    const traceDir = project(`1`, [{}]);
    const result = await checkReachability({
      cwd: empty,
      packageName: "dep",
      traceFile: join(traceDir, "trace.json"),
    });
    expect(result.evidenceKind).toBe("runtime");
    expect(result.status).toBe("reachable");
    expect(result.reachabilityBasis).toBe("runtime-load-observed");
  });

  it("fails loudly on a trace file that does not exist", async () => {
    const dir = project(`1`, []);
    await expect(
      checkReachability({ cwd: dir, packageName: "dep", traceFile: "missing.json" }),
    ).rejects.toThrow(/Cannot read trace file/);
  });
});
