import { describe, expect, it } from "vitest";

import { parsePnpmLock } from "./lock-graph/pnpm.js";
import { parseLockfileDependencies } from "./lockfile-diff.js";
import { parsePnpmLockDocument } from "./pnpm-lock-document.js";

const SINGLE = `lockfileVersion: '9.0'

importers:
  .:
    dependencies:
      left-pad:
        specifier: ^1.3.0
        version: 1.3.0

packages:
  left-pad@1.3.0:
    resolution: {integrity: sha512-x}

snapshots:
  left-pad@1.3.0: {}
`;

const MULTI = `---
lockfileVersion: '9.0'

importers:
  .:
    configDependencies: {}
    packageManagerDependencies:
      pnpm:
        specifier: 12.18.0
        version: 12.18.0

packages:
  '@pnpm/exe@12.18.0':
    resolution: {integrity: sha512-y}

snapshots:
  '@pnpm/exe@12.18.0': {}

---
${SINGLE}`;

describe("parsePnpmLockDocument", () => {
  it("returns a single-document lockfile unchanged", () => {
    expect(parsePnpmLockDocument(SINGLE)).toMatchObject({ lockfileVersion: "9.0" });
  });

  it("uses the project document of a two-document lockfile, not the one for pnpm itself", () => {
    const data = parsePnpmLockDocument(MULTI) as { packages: Record<string, unknown> };
    expect(Object.keys(data.packages)).toEqual(["left-pad@1.3.0"]);
  });

  it("makes both lockfile parsers work on the pnpm 12 shape", () => {
    expect([...(parseLockfileDependencies("pnpm-lock.yaml", MULTI).get("left-pad") ?? [])]).toEqual(
      ["1.3.0"],
    );
    expect(
      [...parsePnpmLock(MULTI).nodes.values()].map((node) => `${node.name}@${node.version}`),
    ).toEqual(["left-pad@1.3.0"]);
  });

  it("does not throw on garbage", () => {
    expect(() => parsePnpmLockDocument(": : :\n\t-")).not.toThrow();
  });
});
