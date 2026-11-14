import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { execa } from "execa";
import { createHash } from "node:crypto";
import { afterEach, describe, expect, it, vi, beforeEach } from "vitest";

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

describe("Feature 12: Adversarial Package Fetcher (Co-located Challenge Suite)", () => {
  beforeEach(() => {
    vi.mocked(execa).mockReset();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  const extractIndexJs = () =>
    vi.mocked(execa).mockImplementation((async (cmd: any, args: any) => {
      if (cmd === "tar") {
        const extractDir = args[3] as string;
        mkdirSync(join(extractDir, "package"), { recursive: true });
        writeFileSync(join(extractDir, "package", "index.js"), "module.exports = {};", "utf8");
      }
      return { stdout: "", stderr: "", exitCode: 0 } as any;
    }) as any);

  it("returns truthful 404 error when the registry has no such version, without running tar", async () => {
    stubRegistry({ metadataStatus: 404 });

    const res = await fetchPackageSourceTool.execute({
      packageName: "package-that-does-not-exist-404",
      version: "1.0.0",
    });

    expect(res.success).toBe(false);
    expect(res.error).toBe(
      "Package package-that-does-not-exist-404@1.0.0 not found on npm registry. It may not exist or the version may be incorrect.",
    );
    expect(vi.mocked(execa)).not.toHaveBeenCalled();
  });

  it("differentiates network failure (non-404) from missing package", async () => {
    stubRegistry({ failWith: new Error("connect ECONNREFUSED 127.0.0.1:443") });

    const res = await fetchPackageSourceTool.execute({
      packageName: "lodash",
      version: "4.17.21",
    });

    expect(res.success).toBe(false);
    expect(res.error).toContain("Failed to fetch and extract package lodash@4.17.21");
    expect(res.error).not.toContain("not found on npm registry");
  });

  it("extracts source files when all code lives under dist/, dist/esm/, or build/ directories", async () => {
    stubRegistry({});
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
    stubRegistry({});
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

  it("resolves scoped packages through the registry metadata endpoint", async () => {
    const calls = stubRegistry({
      tarballUrl: "https://registry.npmjs.org/@my-org/core-utils/-/core-utils-2.1.0.tgz",
    });
    extractIndexJs();

    const res = await fetchPackageSourceTool.execute({
      packageName: "@my-org/core-utils",
      version: "2.1.0",
    });

    expect(res.success).toBe(true);
    expect(calls.map((c) => c.url)).toEqual([
      "https://registry.npmjs.org/@my-org%2Fcore-utils/2.1.0",
      "https://registry.npmjs.org/@my-org/core-utils/-/core-utils-2.1.0.tgz",
    ]);
  });

  it("refuses a tarball whose digest does not match the registry integrity", async () => {
    stubRegistry({ integrity: `sha512-${createHash("sha512").update("other").digest("base64")}` });
    extractIndexJs();

    const res = await fetchPackageSourceTool.execute({ packageName: "pkg", version: "1.0.0" });

    expect(res.success).toBe(false);
    expect(res.error).toContain("failed verification");
    expect(vi.mocked(execa)).not.toHaveBeenCalled();
  });

  it("accepts a tarball whose digest matches the registry integrity", async () => {
    const bytes = new Uint8Array([9, 8, 7]);
    stubRegistry({
      tarballBytes: bytes,
      integrity: `sha512-${createHash("sha512").update(bytes).digest("base64")}`,
    });
    extractIndexJs();

    const res = await fetchPackageSourceTool.execute({ packageName: "pkg", version: "1.0.0" });

    expect(res.success).toBe(true);
  });

  it("uses the project .npmrc registry and sends credentials only to that registry", async () => {
    const dir = mkdtempSync(join(tmpdir(), "fetch-source-npmrc-"));
    try {
      writeFileSync(
        join(dir, ".npmrc"),
        "registry=https://npm.internal.example/\n//npm.internal.example/:_authToken=s3cret\n",
      );
      const calls = stubRegistry({ tarballUrl: "https://cdn.example.net/pkg-1.0.0.tgz" });
      extractIndexJs();

      const res = await fetchPackageSourceTool.execute({
        cwd: dir,
        packageName: "pkg",
        version: "1.0.0",
      });

      expect(res.success).toBe(true);
      expect(calls[0]).toMatchObject({
        url: "https://npm.internal.example/pkg/1.0.0",
        headers: { Authorization: "Bearer s3cret" },
      });
      // The tarball lives on another host: it must not receive the registry token.
      expect(calls[1]?.url).toBe("https://cdn.example.net/pkg-1.0.0.tgz");
      expect(calls[1]?.headers["Authorization"]).toBeUndefined();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
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
