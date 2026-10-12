import { describe, expect, it } from "vitest";
import { resolveInventoryVersion, checkInventoryTool } from "./check-inventory.js";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

describe("resolveInventoryVersion", () => {
  it("resolves exact semver and clean strings", () => {
    expect(resolveInventoryVersion("1.2.3")).toBe("1.2.3");
    expect(resolveInventoryVersion("  1.2.3  ")).toBe("1.2.3");
    expect(resolveInventoryVersion("v1.2.3")).toBe("1.2.3");
  });

  it("resolves caret and tilde ranges to minimum version", () => {
    expect(resolveInventoryVersion("^1.2.3")).toBe("1.2.3");
    expect(resolveInventoryVersion("~2.4.1")).toBe("2.4.1");
  });

  it("resolves comparison ranges and hyphen ranges", () => {
    expect(resolveInventoryVersion(">=1.0.0 <2.0.0")).toBe("1.0.0");
    expect(resolveInventoryVersion("1.0.0 - 2.0.0")).toBe("1.0.0");
    expect(resolveInventoryVersion(">=2.5.0")).toBe("2.5.0");
  });

  it("resolves workspace: protocol specifiers", () => {
    expect(resolveInventoryVersion("workspace:^1.2.3")).toBe("1.2.3");
    expect(resolveInventoryVersion("workspace:~2.0.0")).toBe("2.0.0");
    expect(resolveInventoryVersion("workspace:1.0.0")).toBe("1.0.0");
  });

  it("resolves npm: aliased package specifiers", () => {
    expect(resolveInventoryVersion("npm:lodash@^4.17.21")).toBe("4.17.21");
    expect(resolveInventoryVersion("npm:chalk@5.0.0")).toBe("5.0.0");
  });

  it("resolves wildcards and x-ranges", () => {
    expect(resolveInventoryVersion("*")).toBe("0.0.0");
    expect(resolveInventoryVersion("1.2.x")).toBe("1.2.0");
    expect(resolveInventoryVersion("2.x")).toBe("2.0.0");
  });

  it("gracefully coerces or returns non-standard strings", () => {
    expect(resolveInventoryVersion("1.0.0-alpha.1")).toBe("1.0.0-alpha.1");
    expect(resolveInventoryVersion("git+https://github.com/foo/bar.git")).toBe(
      "git+https://github.com/foo/bar.git",
    );
  });
});

describe("checkInventoryTool fallback behavior", () => {
  it("returns error when package.json does not exist", async () => {
    const tempDir = mkdtempSync(join(tmpdir(), "check-inv-empty-"));
    try {
      const result = await checkInventoryTool.execute({ cwd: tempDir });
      expect(result.packages).toEqual([]);
      expect(result.error).toContain("Could not read package.json");
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it("populates dependencies, devDependencies, and peerDependencies in fallback", async () => {
    const tempDir = mkdtempSync(join(tmpdir(), "check-inv-fb-"));
    try {
      const pkg = {
        dependencies: {
          lodash: "^4.17.20",
          axios: ">=0.21.1 <1.0.0",
        },
        devDependencies: {
          typescript: "~5.2.0",
        },
        peerDependencies: {
          react: ">=18.0.0",
        },
      };
      writeFileSync(join(tempDir, "package.json"), JSON.stringify(pkg, null, 2), "utf8");

      const result = await checkInventoryTool.execute({ cwd: tempDir });
      expect(result.error).toBeUndefined();
      expect(result.packages).toEqual(
        expect.arrayContaining([
          { name: "lodash", version: "4.17.20", type: "direct" },
          { name: "axios", version: "0.21.1", type: "direct" },
          { name: "typescript", version: "5.2.0", type: "direct" },
          { name: "react", version: "18.0.0", type: "direct" },
        ]),
      );
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });
});
