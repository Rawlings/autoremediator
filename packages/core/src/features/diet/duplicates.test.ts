import { cpSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, describe, expect, it } from "vitest";

import { analyzeDependencies } from "./analyze.js";
import { analyzeDuplicates, dependencyDepths } from "./duplicates.js";
import { plainRange, readNpmLockfile, readPnpmLockfile } from "./lockfile.js";
import { installed, makeProject, removeProjects } from "./testing/project.js";

afterEach(removeProjects);

const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), "fixtures");

/**
 * Lockfiles produced by the real npm and pnpm for a project that depends on chalk 4 and, as an
 * alias, chalk 2: ansi-styles, color-convert, color-name, has-flag and supports-color are each
 * installed twice because the two chalks ask for ranges that exclude each other.
 */
function realProject(
  kind: "npm-chalk" | "pnpm-chalk",
  options: { install?: boolean } = {},
): string {
  const dir = makeProject({});
  cpSync(join(FIXTURES, kind), dir, {
    recursive: true,
    filter: (source) => !source.endsWith("store-manifests.json"),
  });
  if (kind === "pnpm-chalk" && options.install !== false) {
    // What `pnpm install` leaves behind: each package's package.json under node_modules/.pnpm.
    const manifests = JSON.parse(
      readFileSync(join(FIXTURES, kind, "store-manifests.json"), "utf8"),
    ) as Record<string, { name: string }>;
    for (const [directory, manifest] of Object.entries(manifests)) {
      const target = join(
        dir,
        "node_modules",
        ".pnpm",
        directory,
        "node_modules",
        manifest.name,
        "package.json",
      );
      mkdirSync(dirname(target), { recursive: true });
      writeFileSync(target, JSON.stringify(manifest));
    }
  }
  return dir;
}

const DUPLICATED = [
  "ansi-styles",
  "chalk",
  "color-convert",
  "color-name",
  "has-flag",
  "supports-color",
];

describe.each(["npm-chalk", "pnpm-chalk"] as const)(
  "duplicates from a real %s lockfile",
  (kind) => {
    it("finds every package installed at two versions", async () => {
      const report = await analyzeDependencies({ cwd: realProject(kind) });
      expect(report.lockfile?.format).toBe(kind === "npm-chalk" ? "npm" : "pnpm");
      expect(report.duplicates.supported).toBe(true);
      expect(report.duplicates.packages.map((entry) => entry.name).toSorted()).toEqual(DUPLICATED);
      expect(report.duplicates.extraCopies).toBe(6);
      expect(report.attackSurface.facts.installedPackages).toBe(13);
    });

    it("says which parent pulls each copy, with the range it asked for", async () => {
      const report = await analyzeDependencies({ cwd: realProject(kind) });
      const ansi = report.duplicates.packages.find((entry) => entry.name === "ansi-styles")!;
      const byVersion = Object.fromEntries(
        ansi.versions.map((version) => [version.version, version.parents]),
      );
      expect(byVersion["4.3.0"]).toEqual([
        { name: "chalk", version: "4.1.2", range: "^4.1.0", direct: false },
      ]);
      expect(byVersion["3.2.1"]).toEqual([
        { name: "chalk", version: "2.4.2", range: "^3.2.1", direct: false },
      ]);
    });

    it("names the project as the parent of a direct dependency installed twice, resolving an npm: alias to its range", async () => {
      const report = await analyzeDependencies({ cwd: realProject(kind) });
      const chalk = report.duplicates.packages.find((entry) => entry.name === "chalk")!;
      const byVersion = Object.fromEntries(
        chalk.versions.map((version) => [version.version, version.parents]),
      );
      const range = (version: string) =>
        byVersion[version]!.map((parent) => [parent.name, parent.range, parent.direct]);
      expect(range("4.1.2")).toEqual([
        [kind === "npm-chalk" ? "(project)" : "(project)", "^4.1.2", true],
      ]);
      expect(range("2.4.2")).toEqual([["(project)", "^2.4.2", true]]);
    });

    it("calls them undedupable: every parent's range excludes the other copy", async () => {
      const report = await analyzeDependencies({ cwd: realProject(kind) });
      for (const entry of report.duplicates.packages) {
        expect(entry.verdict).toBe("needs-override-or-upgrade");
        expect(entry.versions.every((version) => version.movableTo === undefined)).toBe(true);
        expect(entry.unifiedVersion).toBeUndefined();
      }
    });

    it("measures dependency depth and counts the installed packages", async () => {
      const report = await analyzeDependencies({ cwd: realProject(kind) });
      // project -> chalk -> ansi-styles -> color-convert -> color-name
      expect(report.attackSurface.facts.maxDepth).toBe(4);
      expect(report.attackSurface.facts.directDependencies).toBe(2);
    });
  },
);

describe("pnpm without an install: ranges between packages are not in the lockfile", () => {
  it("lists the duplicates and parents but does not judge range", async () => {
    const report = await analyzeDependencies({
      cwd: realProject("pnpm-chalk", { install: false }),
    });
    const ansi = report.duplicates.packages.find((entry) => entry.name === "ansi-styles")!;
    expect(ansi.verdict).toBe("unknown-ranges");
    expect(
      ansi.versions.flatMap((version) => version.parents.map((parent) => parent.range)),
    ).toEqual([undefined, undefined]);
    expect(ansi.summary).toMatch(/not on record/);
  });
});

describe("dedupe within semver range", () => {
  // Hand-written lockfiles (not captured from a package manager): a stale lock that kept an old copy.
  const npmLock = {
    lockfileVersion: 3,
    packages: {
      "": { name: "app", dependencies: { a: "^1.0.0", b: "^1.0.0", c: "^1.0.0", d: "^2.0.0" } },
      "node_modules/a": { version: "1.0.0", dependencies: { shared: "^1.0.0" } },
      "node_modules/b": { version: "1.0.0", dependencies: { shared: "^1.2.0" } },
      "node_modules/shared": { version: "1.2.0" },
      "node_modules/a/node_modules/shared": { version: "1.0.0" },
      // c holds an old copy that d's range excludes.
      "node_modules/c": { version: "1.0.0", dependencies: { held: "^1.0.0" } },
      "node_modules/d": { version: "2.0.0", dependencies: { held: "^2.0.0" } },
      "node_modules/held": { version: "2.0.0" },
      "node_modules/c/node_modules/held": { version: "1.0.0" },
    },
  };

  it("reports a single version every parent accepts", () => {
    const { graph } = readNpmLockfile("/nowhere", JSON.stringify(npmLock));
    const report = analyzeDuplicates(graph!);
    const shared = report.packages.find((entry) => entry.name === "shared")!;
    expect(shared.verdict).toBe("dedupe-within-range");
    expect(shared.unifiedVersion).toBe("1.2.0");
    const old = shared.versions.find((version) => version.version === "1.0.0")!;
    expect(old.movableTo).toBe("1.2.0");
    expect(old.parents).toEqual([{ name: "a", version: "1.0.0", range: "^1.0.0", direct: false }]);
    // The newer copy is wanted by b, whose ^1.2.0 excludes 1.0.0, so it cannot move down.
    expect(
      shared.versions.find((version) => version.version === "1.2.0")!.movableTo,
    ).toBeUndefined();
  });

  it("reports a copy held by a parent whose range excludes the rest", () => {
    const { graph } = readNpmLockfile("/nowhere", JSON.stringify(npmLock));
    const held = analyzeDuplicates(graph!).packages.find((entry) => entry.name === "held")!;
    expect(held.verdict).toBe("needs-override-or-upgrade");
    expect(held.summary).toMatch(/override that leaves a parent's range/);
  });

  it("reports a partial dedupe when only some copies can move", () => {
    const lock = {
      lockfileVersion: 3,
      packages: {
        "": { dependencies: { a: "1", b: "1", c: "1" } },
        "node_modules/a": { version: "1.0.0", dependencies: { x: "^1.0.0" } },
        "node_modules/b": { version: "1.0.0", dependencies: { x: "^1.0.0" } },
        "node_modules/c": { version: "1.0.0", dependencies: { x: "^2.0.0" } },
        "node_modules/x": { version: "2.0.0" },
        "node_modules/a/node_modules/x": { version: "1.1.0" },
        "node_modules/b/node_modules/x": { version: "1.0.5" },
      },
    };
    const { graph } = readNpmLockfile("/nowhere", JSON.stringify(lock));
    const x = analyzeDuplicates(graph!).packages.find((entry) => entry.name === "x")!;
    expect(x.verdict).toBe("partly-dedupable");
    expect(x.versions.find((version) => version.version === "1.0.5")!.movableTo).toBe("1.1.0");
    expect(x.versions.find((version) => version.version === "1.1.0")!.movableTo).toBeUndefined();
  });

  it("reads the same situation from a pnpm lockfile when the installed manifests give the ranges", async () => {
    const lock = [
      "lockfileVersion: '9.0'",
      "importers:",
      "  .:",
      "    dependencies:",
      "      a: { specifier: ^1.0.0, version: 1.0.0 }",
      "      b: { specifier: ^1.0.0, version: 1.0.0 }",
      "packages:",
      "  a@1.0.0: { resolution: { integrity: x } }",
      "  b@1.0.0: { resolution: { integrity: x } }",
      "  shared@1.0.0: { resolution: { integrity: x } }",
      "  shared@1.2.0: { resolution: { integrity: x } }",
      "snapshots:",
      "  a@1.0.0: { dependencies: { shared: 1.0.0 } }",
      "  b@1.0.0: { dependencies: { shared: 1.2.0 } }",
      "  shared@1.0.0: {}",
      "  shared@1.2.0: {}",
      "",
    ].join("\n");
    const dir = makeProject({
      "package.json": { name: "app", dependencies: { a: "^1.0.0", b: "^1.0.0" } },
      "pnpm-lock.yaml": lock,
      "node_modules/.pnpm/a@1.0.0/node_modules/a/package.json": {
        name: "a",
        version: "1.0.0",
        dependencies: { shared: "^1.0.0" },
      },
      "node_modules/.pnpm/b@1.0.0/node_modules/b/package.json": {
        name: "b",
        version: "1.0.0",
        dependencies: { shared: "^1.2.0" },
      },
    });
    const report = await analyzeDependencies({ cwd: dir });
    const shared = report.duplicates.packages.find((entry) => entry.name === "shared")!;
    // b needs ^1.2.0, so 1.0.0 cannot absorb it; a accepts both, so 1.0.0 can move to 1.2.0.
    expect(shared.verdict).toBe("dedupe-within-range");
    expect(shared.unifiedVersion).toBe("1.2.0");
  });
});

describe("pnpm lockfile formats", () => {
  it("reads lockfileVersion 6 (dependencies in packages, leading slash keys)", () => {
    const lock = [
      "lockfileVersion: '6.0'",
      "importers:",
      "  .:",
      "    dependencies:",
      "      a: { specifier: ^1.0.0, version: 1.0.0 }",
      "packages:",
      "  /a@1.0.0:",
      "    resolution: { integrity: x }",
      "    dependencies:",
      "      b: 2.0.0(c@3.0.0)",
      "  /b@2.0.0(c@3.0.0):",
      "    resolution: { integrity: x }",
      "  /b@1.0.0:",
      "    resolution: { integrity: x }",
      "",
    ].join("\n");
    const { graph, unsupported } = readPnpmLockfile("/nowhere", lock);
    expect(unsupported).toBeUndefined();
    expect([...graph!.nodes.keys()].toSorted()).toEqual(["a@1.0.0", "b@1.0.0", "b@2.0.0"]);
    expect(dependencyDepths(graph!)).toEqual({ maxDepth: 2, directDependencies: 1 });
  });

  it("rejects lockfiles older than 6 and non-lockfiles with a reason", () => {
    expect(
      readPnpmLockfile("/nowhere", "lockfileVersion: 5.4\npackages: {}\n").unsupported,
    ).toMatch(/older than 6.0/);
    expect(readPnpmLockfile("/nowhere", "").unsupported).toBeDefined();
  });

  it("picks the project's document when pnpm prepends one for itself", () => {
    const lock = [
      "---",
      "lockfileVersion: '9.0'",
      "importers:",
      "  .:",
      "    packageManagerDependencies:",
      "      pnpm: { specifier: 12.0.0, version: 12.0.0 }",
      "packages:",
      "  pnpm@12.0.0: { resolution: { integrity: x } }",
      "snapshots:",
      "  pnpm@12.0.0: {}",
      "",
      "---",
      "lockfileVersion: '9.0'",
      "importers:",
      "  .:",
      "    dependencies:",
      "      a: { specifier: ^1.0.0, version: 1.0.0 }",
      "      b: { specifier: ^1.0.0, version: 1.0.0 }",
      "packages:",
      "  a@1.0.0: { resolution: { integrity: x } }",
      "  b@1.0.0: { resolution: { integrity: x } }",
      "snapshots:",
      "  a@1.0.0: {}",
      "  b@1.0.0: {}",
      "",
    ].join("\n");
    expect([...readPnpmLockfile("/nowhere", lock).graph!.nodes.keys()].toSorted()).toEqual([
      "a@1.0.0",
      "b@1.0.0",
    ]);
  });
});

describe("npm lockfile formats", () => {
  it("rejects lockfileVersion 1, which has no packages map", () => {
    expect(
      readNpmLockfile("/nowhere", JSON.stringify({ lockfileVersion: 1, dependencies: {} }))
        .unsupported,
    ).toMatch(/lockfileVersion 1/);
  });

  it("resolves nested copies the way Node does, and skips workspace links", () => {
    const lock = {
      lockfileVersion: 3,
      packages: {
        "": { name: "root", workspaces: ["packages/*"] },
        "packages/a": { name: "a", version: "1.0.0", dependencies: { x: "^1.0.0" } },
        "node_modules/a": { resolved: "packages/a", link: true },
        "node_modules/x": { version: "1.0.0" },
      },
    };
    const { graph } = readNpmLockfile("/nowhere", JSON.stringify(lock));
    expect([...graph!.nodes.keys()]).toEqual(["x@1.0.0"]);
    expect(graph!.edges).toEqual([
      { from: "a", fromDirect: true, to: "x@1.0.0", name: "x", range: "^1.0.0" },
    ]);
  });
});

describe("no lockfile, or one that is not read", () => {
  it("says so instead of inventing numbers, and still reports unused dependencies", async () => {
    const dir = makeProject({
      "package.json": { name: "app", dependencies: { ghost: "1" } },
      "index.js": "",
      "bun.lock": "{}",
    });
    installed(dir, { ghost: true });
    const report = await analyzeDependencies({ cwd: dir });
    expect(report.duplicates.supported).toBe(false);
    expect(report.duplicates.note).toMatch(/bun lockfile/);
    expect(report.attackSurface.facts.installedPackages).toBe(0);
    expect(report.attackSurface.limits.join(" ")).toMatch(/lower bound/);
    expect(report.packages[0]!.counts.certainlyUnused).toBe(1);
  });
});

describe("plainRange", () => {
  it("unwraps npm: aliases", () => {
    expect(plainRange("npm:chalk@^2.4.2")).toBe("^2.4.2");
    expect(plainRange("npm:@scope/name@~1.0.0")).toBe("~1.0.0");
    expect(plainRange("^1.0.0")).toBe("^1.0.0");
    expect(plainRange("npm:chalk")).toBeUndefined();
  });
});
