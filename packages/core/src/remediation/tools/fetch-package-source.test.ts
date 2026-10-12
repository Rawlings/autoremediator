import { describe, expect, it, vi } from "vitest";
import { fetchPackageSourceTool } from "./fetch-package-source.js";
import { execa } from "execa";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

vi.mock("execa", () => ({
  execa: vi.fn(),
}));

describe("fetchPackageSourceTool", () => {
  it("rejects malicious or invalid package names", async () => {
    const res = await fetchPackageSourceTool.execute({
      packageName: "../../../etc/passwd",
      version: "1.0.0",
    });
    expect(res.success).toBe(false);
    expect(res.error).toContain("Invalid package name");
  });

  it("rejects invalid glob patterns to prevent ReDoS", async () => {
    const res = await fetchPackageSourceTool.execute({
      packageName: "lodash",
      version: "4.17.21",
      filePatterns: ["$(rm -rf /)"],
    });
    expect(res.success).toBe(false);
    expect(res.error).toContain("No valid file patterns");
  });

  it("returns truthful 404 error when curl fails with exit code 22", async () => {
    const error = new Error("curl: (22) The requested URL returned error: 404");
    (error as unknown as { exitCode: number }).exitCode = 22;
    vi.mocked(execa).mockRejectedValueOnce(error);

    const res = await fetchPackageSourceTool.execute({
      packageName: "nonexistent-pkg-xyz",
      version: "9.9.9",
    });

    expect(res.success).toBe(false);
    expect(res.error).toContain("not found on npm registry");
    expect(res.error).toContain("nonexistent-pkg-xyz@9.9.9");
  });

  it("extracts and includes files in dist/ and build/ directories", async () => {
    vi.mocked(execa).mockImplementation((async (cmd: any, args: any) => {
      if (cmd === "tar") {
        // args: ["-xzf", tarballPath, "-C", extractDir]
        const extractDir = args[3] as string;
        const packageDir = join(extractDir, "package");
        const distDir = join(packageDir, "dist");
        const buildDir = join(packageDir, "build");
        const nodeModulesDir = join(packageDir, "node_modules");

        await mkdir(distDir, { recursive: true });
        await mkdir(buildDir, { recursive: true });
        await mkdir(nodeModulesDir, { recursive: true });

        await writeFile(join(distDir, "index.js"), "module.exports = 'from dist';", "utf8");
        await writeFile(join(buildDir, "bundle.js"), "console.log('from build');", "utf8");
        await writeFile(
          join(nodeModulesDir, "dep.js"),
          "console.log('should be skipped');",
          "utf8",
        );
      }
      return { stdout: "", stderr: "", exitCode: 0 } as any;
    }) as any);

    const res = await fetchPackageSourceTool.execute({
      packageName: "compiled-only-pkg",
      version: "1.0.0",
      filePatterns: ["*.js"],
    });

    expect(res.success).toBe(true);
    expect(res.sourceFiles).toBeDefined();
    // Files in dist and build must be extracted
    expect(res.sourceFiles!["dist/index.js"]).toBe("module.exports = 'from dist';");
    expect(res.sourceFiles!["build/bundle.js"]).toBe("console.log('from build');");
    // node_modules must remain excluded
    expect(res.sourceFiles!["node_modules/dep.js"]).toBeUndefined();
  });
});
