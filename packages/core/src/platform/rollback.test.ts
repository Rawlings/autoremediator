import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  createProjectSnapshot,
  discoverProjectFiles,
  restoreProjectSnapshot,
  withAtomicRollback,
} from "./rollback.js";

describe("rollback", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "autoremediator-rollback-test-"));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("dynamically discovers manifest files in monorepo workspaces", () => {
    mkdirSync(join(dir, "packages", "pkg-a"), { recursive: true });
    mkdirSync(join(dir, "packages", "pkg-b"), { recursive: true });
    writeFileSync(join(dir, "package.json"), "{}");
    writeFileSync(join(dir, "pnpm-lock.yaml"), "");
    writeFileSync(join(dir, "packages", "pkg-a", "package.json"), "{}");
    writeFileSync(join(dir, "packages", "pkg-b", "package.json"), "{}");
    writeFileSync(join(dir, "packages", "pkg-b", "unrelated.txt"), "");

    const files = discoverProjectFiles(dir);
    expect(files.length).toBe(4);
    expect(files.some((f) => f.includes("pkg-a/package.json"))).toBe(true);
    expect(files.some((f) => f.includes("pnpm-lock.yaml"))).toBe(true);
  });

  it("snapshots and restores file states accurately", async () => {
    const pkgPath = join(dir, "package.json");
    writeFileSync(pkgPath, JSON.stringify({ name: "test", version: "1.0.0" }));

    const snapshot = await createProjectSnapshot(dir);

    // Mutate file
    writeFileSync(pkgPath, JSON.stringify({ name: "test", version: "2.0.0" }));
    expect(JSON.parse(readFileSync(pkgPath, "utf8")).version).toBe("2.0.0");

    // Restore
    await restoreProjectSnapshot(snapshot);
    expect(JSON.parse(readFileSync(pkgPath, "utf8")).version).toBe("1.0.0");
  });

  it("removes newly created files on rollback", async () => {
    const lockPath = join(dir, "yarn.lock");
    const snapshot = await createProjectSnapshot(dir, ["yarn.lock"]);

    writeFileSync(lockPath, "some lock content");
    expect(readFileSync(lockPath, "utf8")).toBe("some lock content");

    await restoreProjectSnapshot(snapshot);
    expect(() => readFileSync(lockPath, "utf8")).toThrow();
  });

  it("automatically rolls back when an action throws", async () => {
    const pkgPath = join(dir, "package.json");
    writeFileSync(pkgPath, JSON.stringify({ name: "test", version: "1.0.0" }));

    await expect(
      withAtomicRollback(dir, async () => {
        writeFileSync(pkgPath, JSON.stringify({ name: "test", version: "3.0.0" }));
        throw new Error("Test failure simulation");
      }),
    ).rejects.toThrow("Test failure simulation");

    expect(JSON.parse(readFileSync(pkgPath, "utf8")).version).toBe("1.0.0");
  });

  it("rolls back when shouldRollback predicate evaluates to true", async () => {
    const pkgPath = join(dir, "package.json");
    writeFileSync(pkgPath, JSON.stringify({ name: "test", version: "1.0.0" }));

    const result = await withAtomicRollback(
      dir,
      async () => {
        writeFileSync(pkgPath, JSON.stringify({ name: "test", version: "4.0.0" }));
        return { applied: false, unresolvedReason: "validation-failed" };
      },
      {
        shouldRollback: (res) => !res.applied,
      },
    );

    expect(result.applied).toBe(false);
    expect(JSON.parse(readFileSync(pkgPath, "utf8")).version).toBe("1.0.0");
  });

  it("restores arbitrary source files dynamically tracked via recordFileTouch", async () => {
    const customSourcePath = join(dir, "src", "utils", "helper.ts");
    mkdirSync(join(dir, "src", "utils"), { recursive: true });
    writeFileSync(customSourcePath, "export const a = 1;");

    await expect(
      withAtomicRollback(dir, async () => {
        const { recordFileTouch } = await import("./rollback.js");
        recordFileTouch(customSourcePath);
        writeFileSync(customSourcePath, "export const a = 999;");
        throw new Error("Patch compile failure");
      }),
    ).rejects.toThrow("Patch compile failure");

    expect(readFileSync(customSourcePath, "utf8")).toBe("export const a = 1;");
  });
});
