import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { execa } from "execa";
import { afterEach, describe, expect, it, vi } from "vitest";

import { fetchPackageSourceTool } from "./fetch-package-source.js";

vi.mock("execa", () => ({
  execa: vi.fn(),
}));

interface RegistryStubCall {
  url: string;
  headers: Record<string, string>;
}

/** Stub global fetch: version metadata answers at `.../<version>`, any other URL serves the tarball. */
function stubRegistry(options: {
  metadataStatus?: number;
  tarballUrl?: string;
  integrity?: string;
  tarballBytes?: Uint8Array;
  failWith?: Error;
}): RegistryStubCall[] {
  const calls: RegistryStubCall[] = [];
  const tarballUrl = options.tarballUrl ?? "https://registry.npmjs.org/pkg/-/pkg-1.0.0.tgz";
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string | URL, init?: RequestInit) => {
      const target = String(url);
      calls.push({ url: target, headers: { ...(init?.headers as Record<string, string>) } });
      if (options.failWith) throw options.failWith;
      if (target === tarballUrl) {
        return new Response(options.tarballBytes ?? new Uint8Array([1, 2, 3]), { status: 200 });
      }
      if ((options.metadataStatus ?? 200) !== 200) {
        return new Response("not found", { status: options.metadataStatus });
      }
      return new Response(
        JSON.stringify({ dist: { tarball: tarballUrl, integrity: options.integrity } }),
        { status: 200 },
      );
    }),
  );
  return calls;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

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

  it("returns truthful not-found error when the registry has no such version", async () => {
    stubRegistry({ metadataStatus: 404 });

    const res = await fetchPackageSourceTool.execute({
      packageName: "nonexistent-pkg-xyz",
      version: "9.9.9",
    });

    expect(res.success).toBe(false);
    expect(res.error).toContain("not found on npm registry");
    expect(res.error).toContain("nonexistent-pkg-xyz@9.9.9");
  });

  it("extracts and includes files in dist/ and build/ directories", async () => {
    stubRegistry({});
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
