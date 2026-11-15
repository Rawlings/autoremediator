import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { assertNoEscapingLinks, assertRegistryOnlyDependencies } from "./install.js";

describe("assertRegistryOnlyDependencies", () => {
  it("accepts registry ranges and tags", () => {
    expect(() =>
      assertRegistryOnlyDependencies(
        { dependencies: { a: "^1.2.3", b: "latest", c: "npm:d@1", e: ">=1 <2" } },
        "p@1",
      ),
    ).not.toThrow();
  });

  it("refuses paths, URLs, git and workspace references", () => {
    for (const spec of [
      "file:/etc",
      "link:../x",
      "git+https://x/y.git",
      "github:o/r",
      "o/r",
      "https://x/y.tgz",
      "../x",
      "/abs",
      "workspace:*",
    ]) {
      expect(() => assertRegistryOnlyDependencies({ dependencies: { evil: spec } }, "p@1")).toThrow(
        /not a registry version/,
      );
    }
    expect(() =>
      assertRegistryOnlyDependencies({ peerDependencies: { evil: "file:/x" } }, "p@1"),
    ).toThrow();
    expect(() => assertRegistryOnlyDependencies({ dependencies: { evil: 5 } }, "p@1")).toThrow();
  });
});

describe("assertNoEscapingLinks", () => {
  let dir: string;
  let outside: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "prove-links-"));
    outside = mkdtempSync(join(tmpdir(), "prove-secret-"));
    writeFileSync(join(outside, "s.txt"), "secret");
    mkdirSync(join(dir, "node_modules", ".bin"), { recursive: true });
    writeFileSync(join(dir, "node_modules", "real.js"), "x");
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
    rmSync(outside, { recursive: true, force: true });
  });

  it("allows a plain tree and bin links that stay inside it", () => {
    symlinkSync("../real.js", join(dir, "node_modules", ".bin", "tool"));
    expect(() => assertNoEscapingLinks(dir)).not.toThrow();
  });

  it("refuses a link out of the directory, which the sandbox's read permission would follow", () => {
    symlinkSync(outside, join(dir, "node_modules", "sec"));
    expect(() => assertNoEscapingLinks(dir)).toThrow(/symbolic link/);
  });

  it("refuses an in-tree link outside node_modules/.bin, and a bin link that leaves", () => {
    symlinkSync("real.js", join(dir, "node_modules", "alias.js"));
    expect(() => assertNoEscapingLinks(dir)).toThrow();
    rmSync(join(dir, "node_modules", "alias.js"));
    symlinkSync(outside, join(dir, "node_modules", ".bin", "evil"));
    expect(() => assertNoEscapingLinks(dir)).toThrow();
  });
});
