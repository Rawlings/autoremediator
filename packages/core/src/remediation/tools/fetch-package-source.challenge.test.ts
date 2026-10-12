import { describe, expect, it, vi, beforeEach } from "vitest";
import { fetchPackageSourceTool } from "./fetch-package-source.js";
import { execa } from "execa";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

vi.mock("execa", () => ({
  execa: vi.fn(),
}));

describe("Feature 12: Adversarial Package Fetcher (Co-located Challenge Suite)", () => {
  beforeEach(() => {
    vi.mocked(execa).mockReset();
  });

  it("returns truthful 404 error when curl fails with exit code 22 without running tar", async () => {
    const error = new Error("curl: (22) The requested URL returned error: 404");
    (error as unknown as { exitCode: number }).exitCode = 22;
    vi.mocked(execa).mockRejectedValueOnce(error);

    const res = await fetchPackageSourceTool.execute({
      packageName: "package-that-does-not-exist-404",
      version: "1.0.0",
    });

    expect(res.success).toBe(false);
    expect(res.error).toBe(
      "Package package-that-does-not-exist-404@1.0.0 not found on npm registry. It may not exist or the version may be incorrect.",
    );
    expect(vi.mocked(execa)).toHaveBeenCalledTimes(1);
    expect(vi.mocked(execa).mock.calls[0]![0]).toBe("curl");
  });

  it("differentiates network failure (non-404) from missing package", async () => {
    const networkError = new Error("curl: (7) Failed to connect to host: Connection refused");
    (networkError as unknown as { exitCode: number }).exitCode = 7;
    vi.mocked(execa).mockRejectedValueOnce(networkError);

    const res = await fetchPackageSourceTool.execute({
      packageName: "lodash",
      version: "4.17.21",
    });

    expect(res.success).toBe(false);
    expect(res.error).toContain("Failed to fetch and extract package lodash@4.17.21");
    expect(res.error).not.toContain("not found on npm registry");
  });

  it("extracts source files when all code lives under dist/, dist/esm/, or build/ directories", async () => {
    vi.mocked(execa).mockImplementation((async (cmd: any, args: any) => {
      if (cmd === "tar") {
        const extractDir = args[3] as string;
        const packageDir = join(extractDir, "package");
        const distDir = join(packageDir, "dist");
        const distEsmDir = join(distDir, "esm");
        const buildDir = join(packageDir, "build");
        const nodeModulesDir = join(packageDir, "node_modules");

        mkdirSync(distEsmDir, { recursive: true });
        mkdirSync(buildDir, { recursive: true });
        mkdirSync(nodeModulesDir, { recursive: true });

        writeFileSync(join(distDir, "index.js"), "export const a = 1;", "utf8");
        writeFileSync(join(distEsmDir, "sub.js"), "export const b = 2;", "utf8");
        writeFileSync(join(buildDir, "main.js"), "console.log('built');", "utf8");
        writeFileSync(join(nodeModulesDir, "evil.js"), "ignore me", "utf8");
      }
      return { stdout: "", stderr: "", exitCode: 0 } as any;
    }) as any);

    const res = await fetchPackageSourceTool.execute({
      packageName: "dist-only-pkg",
      version: "3.2.1",
      filePatterns: ["*.js"],
    });

    expect(res.success).toBe(true);
    expect(res.sourceFiles).toBeDefined();
    expect(res.sourceFiles!["dist/index.js"]).toBe("export const a = 1;");
    expect(res.sourceFiles!["dist/esm/sub.js"]).toBe("export const b = 2;");
    expect(res.sourceFiles!["build/main.js"]).toBe("console.log('built');");
    // node_modules excluded
    expect(res.sourceFiles!["node_modules/evil.js"]).toBeUndefined();
  });

  it("handles package tarballs that extract directly into root without package/ subfolder", async () => {
    vi.mocked(execa).mockImplementation((async (cmd: any, args: any) => {
      if (cmd === "tar") {
        const extractDir = args[3] as string;
        mkdirSync(join(extractDir, "dist"), { recursive: true });
        writeFileSync(join(extractDir, "dist", "flat.js"), "const flat = true;", "utf8");
      }
      return { stdout: "", stderr: "", exitCode: 0 } as any;
    }) as any);

    const res = await fetchPackageSourceTool.execute({
      packageName: "flat-pkg",
      version: "1.0.0",
    });

    expect(res.success).toBe(true);
    expect(res.sourceFiles!["dist/flat.js"]).toBe("const flat = true;");
  });

  it("correctly constructs npm registry URL for scoped packages (@scope/name)", async () => {
    let requestedUrl = "";
    vi.mocked(execa).mockImplementation((async (cmd: any, args: any) => {
      if (cmd === "curl") {
        requestedUrl = args[6] as string;
        const tarballPath = args[5] as string;
        writeFileSync(tarballPath, "fake tarball");
      } else if (cmd === "tar") {
        const extractDir = args[3] as string;
        mkdirSync(join(extractDir, "package"), { recursive: true });
        writeFileSync(join(extractDir, "package", "index.js"), "module.exports = {};", "utf8");
      }
      return { stdout: "", stderr: "", exitCode: 0 } as any;
    }) as any);

    const res = await fetchPackageSourceTool.execute({
      packageName: "@my-org/core-utils",
      version: "2.1.0",
    });

    expect(res.success).toBe(true);
    expect(requestedUrl).toBe(
      "https://registry.npmjs.org/@my-org/core-utils/-/core-utils-2.1.0.tgz",
    );
  });

  it("rejects path traversal and illegal characters in package names", async () => {
    const illegalNames = [
      "../bad-pkg",
      "../../etc/passwd",
      "pkg/with/too/many/slashes",
      "pkg;rm -rf /",
      "invalid character!",
    ];

    for (const name of illegalNames) {
      const res = await fetchPackageSourceTool.execute({
        packageName: name,
        version: "1.0.0",
      });
      expect(res.success).toBe(false);
      expect(res.error).toContain("Invalid package name");
    }
  });
});
