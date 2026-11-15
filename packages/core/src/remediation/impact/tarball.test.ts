import { gzipSync } from "node:zlib";

import { describe, expect, it } from "vitest";

import { packageTarball, tar, tgz } from "./__tests__/fixtures.js";
import { DEFAULT_TARBALL_LIMITS, normalizeEntryPath, readPackageTarball, TarballError } from "./tarball.js";

const manifest = { name: "x", version: "1.0.0" };

describe("readPackageTarball", () => {
  it("reads source files and the manifest, stripping the package/ prefix", () => {
    const result = readPackageTarball(
      packageTarball({ "index.js": "exports.a = 1;", "lib/b.ts": "export const b = 1;", "README.md": "no" }, manifest),
    );
    expect([...result.files.keys()].toSorted()).toEqual(["index.js", "lib/b.ts"]);
    expect(result.manifest.name).toBe("x");
  });

  it("skips node_modules, minified bundles and non-source files", () => {
    const result = readPackageTarball(
      packageTarball(
        { "node_modules/dep/index.js": "x", "dist/a.min.js": "x", "data.json": "{}", "src/a.js": "ok" },
        manifest,
      ),
    );
    expect([...result.files.keys()]).toEqual(["src/a.js"]);
  });

  it("refuses an entry that escapes the package directory", () => {
    const bytes = tgz([
      { path: "package/package.json", content: JSON.stringify(manifest) },
      { path: "package/../../etc/passwd", content: "root" },
    ]);
    expect(() => readPackageTarball(bytes)).toThrow(/escapes the package directory/);
  });

  it("refuses an absolute path, a drive-letter path and a NUL byte", () => {
    for (const path of ["/etc/passwd", "C:/Windows/x.js", "package/a\0b.js"]) {
      const bytes = tgz([{ path, content: "x" }]);
      expect(() => readPackageTarball(bytes)).toThrow(TarballError);
    }
  });

  it("validates the name of a symlink and counts links as skipped, never following them", () => {
    const hostile = tgz([
      { path: "package/package.json", content: JSON.stringify(manifest) },
      { path: "package/link.js", type: "2", linkname: "/etc/passwd" },
      { path: "package/hard.js", type: "1", linkname: "package/index.js" },
      { path: "package/index.js", content: "ok" },
    ]);
    const result = readPackageTarball(hostile);
    expect(result.stats.skippedLinks).toBe(2);
    expect([...result.files.keys()]).toEqual(["index.js"]);

    const escapingLink = tgz([{ path: "package/../link.js", type: "2", linkname: "x" }]);
    expect(() => readPackageTarball(escapingLink)).toThrow(/escapes/);
  });

  it("rejects a decompression bomb", () => {
    const bomb = gzipSync(Buffer.alloc(8 * 1024 * 1024));
    expect(bomb.length).toBeLessThan(50_000);
    expect(() => readPackageTarball(bomb, { ...DEFAULT_TARBALL_LIMITS, maxUnpackedBytes: 1024 * 1024 })).toThrow(
      /zip bomb/,
    );
  });

  it("rejects too many entries", () => {
    const entries = Array.from({ length: 30 }, (_, index) => ({ path: `package/f${index}.js`, content: "x" }));
    const bytes = tgz([{ path: "package/package.json", content: JSON.stringify(manifest) }, ...entries]);
    expect(() => readPackageTarball(bytes, { ...DEFAULT_TARBALL_LIMITS, maxEntries: 10 })).toThrow(/more than 10 entries/);
  });

  it("skips a file over the size limit and stops retaining past the total budget", () => {
    const big = "x".repeat(2000);
    const bytes = packageTarball({ "a.js": big, "b.js": "ok", "c.js": "ok" }, manifest);
    const result = readPackageTarball(bytes, { ...DEFAULT_TARBALL_LIMITS, maxFileBytes: 1000 });
    expect([...result.files.keys()].toSorted()).toEqual(["b.js", "c.js"]);
    expect(result.stats.skippedLarge).toBe(1);

    const budget = readPackageTarball(bytes, { ...DEFAULT_TARBALL_LIMITS, maxRetainedBytes: 2001 });
    expect([...budget.files.keys()]).toEqual(["a.js"]);
  });

  it("detects a corrupt header and a truncated archive", () => {
    const raw = tar([{ path: "package/package.json", content: JSON.stringify({ ...manifest, pad: "x".repeat(2000) }) }]);
    const corrupt = Buffer.from(raw);
    corrupt[0] = (corrupt[0] ?? 0) ^ 0xff;
    expect(() => readPackageTarball(gzipSync(corrupt))).toThrow(/checksum/);
    expect(() => readPackageTarball(gzipSync(raw.subarray(0, 600)))).toThrow(/truncated/);
  });

  it("requires a valid package.json and valid gzip", () => {
    expect(() => readPackageTarball(tgz([{ path: "package/index.js", content: "x" }]))).toThrow(/no root package.json/);
    expect(() => readPackageTarball(tgz([{ path: "package/package.json", content: "{nope" }]))).toThrow(/not valid JSON/);
    expect(() => readPackageTarball(new Uint8Array([1, 2, 3]))).toThrow(/not a valid gzip/);
  });

  it("honours a pax long path", () => {
    const longName = `package/${"d/".repeat(60)}deep.js`;
    const record = ` path=${longName}\n`;
    let length = record.length + 1;
    while (String(length).length + record.length !== length) length++;
    const pax = `${length}${record}`;
    const bytes = tgz([
      { path: "package/package.json", content: JSON.stringify(manifest) },
      { path: "package/PaxHeader", type: "x", content: pax },
      { path: "package/short.js", content: "deep" },
    ]);
    const result = readPackageTarball(bytes);
    expect([...result.files.keys()]).toEqual([`${"d/".repeat(60)}deep.js`]);
  });
});

describe("normalizeEntryPath", () => {
  it("strips the first segment and refuses traversal", () => {
    expect(normalizeEntryPath("package/lib/a.js")).toBe("lib/a.js");
    expect(normalizeEntryPath("./package/a.js")).toBe("a.js");
    expect(() => normalizeEntryPath("package/../x")).toThrow(TarballError);
    expect(() => normalizeEntryPath(String.raw`package\..\x`)).toThrow(TarballError);
  });
});
