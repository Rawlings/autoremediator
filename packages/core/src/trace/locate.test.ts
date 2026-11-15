import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { locatePackageFile, rootPackageName } from "./locate.js";

let dir: string;

function pkg(path: string, manifest: object | undefined): void {
  const full = join(dir, path);
  mkdirSync(full, { recursive: true });
  if (manifest) writeFileSync(join(full, "package.json"), JSON.stringify(manifest));
}

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "ar-locate-"));
  pkg("node_modules/lodash", { name: "lodash", version: "4.17.21" });
  pkg("node_modules/@babel/core", { name: "@babel/core", version: "7.0.0" });
  pkg("node_modules/a/node_modules/b", { name: "b", version: "2.0.0" });
  pkg("node_modules/.pnpm/c@3.0.0/node_modules/c", { name: "c", version: "3.0.0" });
  pkg("node_modules/alias", { name: "real-name", version: "1.0.0" });
  pkg("node_modules/broken", undefined);
});

afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("locatePackageFile", () => {
  it("finds a package, its version and the file within it", () => {
    expect(locatePackageFile(join(dir, "node_modules/lodash/fp/map.js"))).toEqual({
      root: join(dir, "node_modules/lodash"),
      name: "lodash",
      version: "4.17.21",
      file: "fp/map.js",
    });
  });

  it("handles scoped packages", () => {
    expect(locatePackageFile(join(dir, "node_modules/@babel/core/lib/index.js"))).toMatchObject({
      name: "@babel/core",
      version: "7.0.0",
      file: "lib/index.js",
    });
  });

  it("uses the innermost node_modules, including pnpm's virtual store", () => {
    expect(locatePackageFile(join(dir, "node_modules/a/node_modules/b/x.js"))).toMatchObject({
      name: "b",
      file: "x.js",
    });
    expect(
      locatePackageFile(join(dir, "node_modules/.pnpm/c@3.0.0/node_modules/c/index.js")),
    ).toMatchObject({ name: "c", version: "3.0.0" });
  });

  it("reports the package's own name for an aliased install", () => {
    expect(locatePackageFile(join(dir, "node_modules/alias/index.js"))?.name).toBe("real-name");
  });

  it("falls back to the directory name when the manifest is unreadable", () => {
    expect(locatePackageFile(join(dir, "node_modules/broken/index.js"))).toMatchObject({
      name: "broken",
      version: "unknown",
    });
  });

  it("returns undefined for the project's own files and for a bare node_modules path", () => {
    expect(locatePackageFile(join(dir, "src/index.js"))).toBeUndefined();
    expect(locatePackageFile(join(dir, "node_modules/lodash"))).toBeUndefined();
  });
});

describe("rootPackageName", () => {
  it("strips subpaths", () => {
    expect(rootPackageName("lodash/fp")).toBe("lodash");
    expect(rootPackageName("@scope/pkg/deep/file")).toBe("@scope/pkg");
    expect(rootPackageName("plain")).toBe("plain");
  });
});
