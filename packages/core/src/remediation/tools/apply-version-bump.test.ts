import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

const { mockSafeExeca } = vi.hoisted(() => ({
  mockSafeExeca: vi.fn(),
}));

vi.mock("../../platform/safe-exec.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../platform/safe-exec.js")>();
  return {
    ...actual,
    safeExeca: mockSafeExeca,
  };
});

vi.mock("../refactor/call-site-finder.js", () => ({
  findPackageCallSites: vi.fn(() => [{ filePath: "/tmp/project/src/app.ts", imports: [] }]),
}));

vi.mock("../refactor/refactor-agent.js", () => ({
  refactorConsumerCallSites: vi.fn(async () => ({
    applied: true,
    refactoredFiles: ["/tmp/project/src/app.ts"],
    snapshots: { "/tmp/project/src/app.ts": "original" },
  })),
  revertRefactorSnapshots: vi.fn(),
}));

import { applyVersionBumpTool } from "./apply-version-bump.js";

describe("applyVersionBumpTool authentic on-disk verification", () => {
  let tempDir: string;

  beforeEach(async () => {
    vi.clearAllMocks();
    tempDir = mkdtempSync(join(tmpdir(), "bump-test-"));

    const safeExecModule = await vi.importActual<typeof import("../../platform/safe-exec.js")>(
      "../../platform/safe-exec.js",
    );

    mockSafeExeca.mockImplementation(
      async (file: string, args: readonly string[], options?: any) => {
        if (file === "node") {
          return safeExecModule.safeExeca(file, args, options);
        }
        return { exitCode: 0, stdout: "ok", stderr: "" } as any;
      },
    );
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  it("updates package.json on disk with the bumped version preserving format", async () => {
    const pkgPath = join(tempDir, "package.json");
    const initial = JSON.stringify({ name: "demo", dependencies: { lodash: "^4.17.0" } }, null, 2);
    writeFileSync(pkgPath, initial);

    const result = await (applyVersionBumpTool as any).execute({
      cwd: tempDir,
      packageManager: "npm",
      packageName: "lodash",
      fromVersion: "4.17.0",
      toVersion: "4.17.21",
      dryRun: false,
      runTests: false,
    });

    expect(result.applied).toBe(true);
    const updatedPkg = JSON.parse(readFileSync(pkgPath, "utf8"));
    expect(updatedPkg.dependencies.lodash).toBe("^4.17.21");
  });

  it("reverts package.json on disk when post-bump typecheck fails", async () => {
    const pkgPath = join(tempDir, "package.json");
    const initialContent = JSON.stringify(
      { name: "demo", dependencies: { lodash: "^4.17.0" } },
      null,
      2,
    );
    writeFileSync(pkgPath, initialContent);
    writeFileSync(join(tempDir, "tsconfig.json"), "{}");

    mockSafeExeca.mockImplementation(async (file: string, args: readonly string[]) => {
      if (file === "npx" || (args && (args.includes("tsc") || args.includes("--noEmit")))) {
        const err = new Error("TS2322: Type 'string' is not assignable to type 'number'");
        (err as any).exitCode = 2;
        (err as any).stderr = "TS2322: Type error";
        throw err;
      }
      return { exitCode: 0, stdout: "ok", stderr: "" } as any;
    });

    const result = await (applyVersionBumpTool as any).execute({
      cwd: tempDir,
      packageManager: "npm",
      packageName: "lodash",
      fromVersion: "4.17.0",
      toVersion: "4.17.21",
      dryRun: false,
      runTests: false,
      typecheck: true,
    });

    expect(result.applied).toBe(false);
    expect(result.unresolvedReason).toBe("validation-failed");
    const restoredPkg = readFileSync(pkgPath, "utf8");
    expect(JSON.parse(restoredPkg).dependencies.lodash).toBe("^4.17.0");
  });

  it("preserves package.json untouched in dryRun mode", async () => {
    const pkgPath = join(tempDir, "package.json");
    const initialContent = JSON.stringify(
      { name: "demo", dependencies: { lodash: "^4.17.0" } },
      null,
      2,
    );
    writeFileSync(pkgPath, initialContent);

    const result = await (applyVersionBumpTool as any).execute({
      cwd: tempDir,
      packageManager: "npm",
      packageName: "lodash",
      fromVersion: "4.17.0",
      toVersion: "4.17.21",
      dryRun: true,
      runTests: false,
    });

    expect(result.applied).toBe(false);
    expect(result.dryRun).toBe(true);
    expect(readFileSync(pkgPath, "utf8")).toBe(initialContent);
  });

  it("creates and releases repo lock directory on disk for mutations", async () => {
    const pkgPath = join(tempDir, "package.json");
    writeFileSync(
      pkgPath,
      JSON.stringify({ name: "demo", dependencies: { lodash: "^4.17.0" } }, null, 2),
    );

    const result = await (applyVersionBumpTool as any).execute({
      cwd: tempDir,
      packageManager: "npm",
      packageName: "lodash",
      fromVersion: "4.17.0",
      toVersion: "4.17.21",
      dryRun: false,
      runTests: false,
    });

    expect(result.applied).toBe(true);
    // Lock file should be cleanly released after completion
    const lockPath = join(tempDir, ".autoremediator", "locks", "remediation.lock");
    expect(existsSync(lockPath)).toBe(false);
  });

  it("refactors consumer call-sites and succeeds with breaking-change-refactor strategy when refactoring resolves error", async () => {
    const pkgPath = join(tempDir, "package.json");
    writeFileSync(
      pkgPath,
      JSON.stringify({ name: "demo", dependencies: { lodash: "^4.17.0" } }, null, 2),
    );
    writeFileSync(join(tempDir, "tsconfig.json"), "{}");

    let typecheckCount = 0;
    mockSafeExeca.mockImplementation(async (file: string, args: readonly string[]) => {
      if (file === "npx" || (args && (args.includes("tsc") || args.includes("--noEmit")))) {
        typecheckCount++;
        if (typecheckCount === 1) {
          const err = new Error("TS2305: Module 'lodash' has no exported member 'default'");
          (err as any).exitCode = 2;
          throw err;
        }
        return { exitCode: 0, stdout: "typecheck passed", stderr: "" } as any;
      }
      return { exitCode: 0, stdout: "ok", stderr: "" } as any;
    });

    const result = await (applyVersionBumpTool as any).execute({
      cwd: tempDir,
      packageManager: "npm",
      packageName: "lodash",
      fromVersion: "4.17.0",
      toVersion: "4.17.21",
      dryRun: false,
      runTests: false,
      typecheck: true,
      breakingChangeRefactor: true,
    });

    expect(result.applied).toBe(true);
    expect(result.strategy).toBe("breaking-change-refactor");
    expect(result.refactoredFiles).toEqual(["/tmp/project/src/app.ts"]);
    expect(result.message).toContain("refactored 1 call-site file(s)");
  });

  it("enforces dual-stage proofOfFix verification with authentic node fixture on disk", async () => {
    const pkgPath = join(tempDir, "package.json");
    writeFileSync(
      pkgPath,
      JSON.stringify({ name: "demo", dependencies: { lodash: "^4.17.0" } }, null, 2),
    );

    const reproPath = join(tempDir, "repro.cjs");
    writeFileSync(
      reproPath,
      `const fs = require("node:fs");
const path = require("node:path");
const pkg = JSON.parse(fs.readFileSync(path.join(process.cwd(), "package.json"), "utf8"));
if (pkg.dependencies && pkg.dependencies.lodash === "^4.17.0") {
  console.error("AssertionError: vulnerable behavior detected in 4.17.0");
  process.exit(1);
}
console.log("mitigated cleanly");
process.exit(0);
`,
    );

    const result = await (applyVersionBumpTool as any).execute({
      cwd: tempDir,
      packageManager: "npm",
      packageName: "lodash",
      fromVersion: "4.17.0",
      toVersion: "4.17.21",
      proofOfFix: reproPath,
      dryRun: false,
      runTests: false,
    });

    expect(result.applied).toBe(true);
    expect(result.proofOfFix).toBeDefined();
    expect(result.proofOfFix?.status).toBe("verified");
    expect(result.proofOfFix?.negativePhase.passed).toBe(true);
    expect(result.proofOfFix?.positivePhase.passed).toBe(true);

    const updatedPkg = JSON.parse(readFileSync(pkgPath, "utf8"));
    expect(updatedPkg.dependencies.lodash).toBe("^4.17.21");
  });

  it("strictly aborts version bump when negative phase fails to reproduce bug", async () => {
    const pkgPath = join(tempDir, "package.json");
    const originalContent = JSON.stringify(
      { name: "demo", dependencies: { lodash: "^4.17.0" } },
      null,
      2,
    );
    writeFileSync(pkgPath, originalContent);

    // Repro script exits 0 even on unpatched version (fails to reproduce bug)
    const reproPath = join(tempDir, "repro.cjs");
    writeFileSync(reproPath, `console.log("unexpected pass"); process.exit(0);`);

    const result = await (applyVersionBumpTool as any).execute({
      cwd: tempDir,
      packageManager: "npm",
      packageName: "lodash",
      fromVersion: "4.17.0",
      toVersion: "4.17.21",
      proofOfFix: reproPath,
      dryRun: false,
      runTests: false,
    });

    expect(result.applied).toBe(false);
    expect(result.unresolvedReason).toBe("proof-of-fix-failed");
    expect(readFileSync(pkgPath, "utf8").trim()).toBe(originalContent.trim());
  });

  it("strictly aborts and rolls back version bump when positive phase fails", async () => {
    const pkgPath = join(tempDir, "package.json");
    const originalContent = JSON.stringify(
      { name: "demo", dependencies: { lodash: "^4.17.0" } },
      null,
      2,
    );
    writeFileSync(pkgPath, originalContent);

    // Repro script always fails assertion (even on patched version)
    const reproPath = join(tempDir, "repro.cjs");
    writeFileSync(
      reproPath,
      `console.error("AssertionError: bug still reproduces on patched version"); process.exit(1);`,
    );

    const result = await (applyVersionBumpTool as any).execute({
      cwd: tempDir,
      packageManager: "npm",
      packageName: "lodash",
      fromVersion: "4.17.0",
      toVersion: "4.17.21",
      proofOfFix: reproPath,
      dryRun: false,
      runTests: false,
    });

    expect(result.applied).toBe(false);
    expect(result.unresolvedReason).toBe("proof-of-fix-failed");
    // Verify rollback on disk
    expect(readFileSync(pkgPath, "utf8").trim()).toBe(originalContent.trim());
  });

  it("returns policy-blocked when reproduction script is missing under requireProofOfFix", async () => {
    const pkgPath = join(tempDir, "package.json");
    writeFileSync(
      pkgPath,
      JSON.stringify({ name: "demo", dependencies: { lodash: "^4.17.0" } }, null, 2),
    );

    const result = await (applyVersionBumpTool as any).execute({
      cwd: tempDir,
      packageManager: "npm",
      packageName: "lodash",
      fromVersion: "4.17.0",
      toVersion: "4.17.21",
      requireProofOfFix: true,
      dryRun: false,
      runTests: false,
    });

    expect(result.applied).toBe(false);
    expect(result.unresolvedReason).toBe("policy-blocked");
    expect(result.message).toContain(
      "Proof-of-fix verification required, but no reproduction test or script was supplied",
    );
  });
});
