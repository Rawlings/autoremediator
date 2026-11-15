import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  findMaintainerVex,
  npmPurl,
  parseNpmPurl,
  parseOpenVex,
  readInstalledMaintainerVex,
  resolveVexField,
} from "../index.js";
import { installFake, vexDocument } from "./fixtures.js";

let cwd: string;
beforeEach(() => {
  cwd = mkdtempSync(join(tmpdir(), "maintainer-vex-"));
});
afterEach(() => {
  rmSync(cwd, { recursive: true, force: true });
});

const CVE = "CVE-2026-1111";
const vulnerable = { name: "bad-dep", version: "1.0.0" };

/** An installed `lib@2.0.0` that depends on `bad-dep` and ships `document`. */
function installLib(document: string, extra: { vex?: unknown; name?: string } = {}): void {
  installFake(cwd, { name: "bad-dep", version: "1.0.0" });
  installFake(cwd, {
    name: extra.name ?? "lib",
    version: "2.0.0",
    dependencies: { "bad-dep": "^1.0.0" },
    vex: extra.vex ?? true,
    files: { "vex.openvex.json": document },
  });
}

const lib = { name: "lib", version: "2.0.0" };

describe("purls", () => {
  it("parses npm purls strictly", () => {
    expect(parseNpmPurl("pkg:npm/lodash@4.17.21")).toEqual({ name: "lodash", version: "4.17.21" });
    expect(parseNpmPurl("pkg:npm/%40scope/name@1.0.0")).toEqual({ name: "@scope/name", version: "1.0.0" });
    expect(parseNpmPurl("pkg:npm/@scope/name")).toEqual({ name: "@scope/name" });
    expect(parseNpmPurl("pkg:npm/lodash@^4.0.0")).toBeUndefined();
    expect(parseNpmPurl("pkg:pypi/lodash@1.0.0")).toBeUndefined();
    expect(parseNpmPurl("pkg:npm/lodash@1.0.0?arch=x")).toBeUndefined();
    expect(parseNpmPurl("pkg:npm/../etc@1.0.0")).toBeUndefined();
    expect(parseNpmPurl(42)).toBeUndefined();
    expect(npmPurl("@scope/name", "1.0.0")).toBe("pkg:npm/%40scope/name@1.0.0");
  });

  it("only accepts a package-relative json path in package.json#vex", () => {
    expect(resolveVexField(true)).toEqual({ path: "vex.openvex.json" });
    expect(resolveVexField("./security/vex.json")).toEqual({ path: "security/vex.json" });
    for (const bad of ["../x.json", "/etc/x.json", "C:/x.json", "https://x.test/v.json", "a/../b.json", "vex.txt", "", 5, false]) {
      expect(resolveVexField(bad)).toHaveProperty("error");
    }
  });
});

describe("reading what installed packages ship", () => {
  it("accepts a valid not_affected statement from a dependent and reports it as evidence", () => {
    installLib(
      vexDocument(lib, [{ vulnerability: CVE, subcomponents: ["pkg:npm/bad-dep"], impact: "We never call it." }]),
    );
    const index = readInstalledMaintainerVex(cwd);
    expect(index.rejected).toEqual([]);
    expect(index.documents).toHaveLength(1);

    const match = findMaintainerVex(index, CVE, vulnerable);
    expect(match.ignored).toEqual([]);
    expect(match.evidence).toEqual([
      expect.objectContaining({
        maintainer: lib,
        file: "vex.openvex.json",
        status: "not_affected",
        justification: "vulnerable_code_not_in_execute_path",
        impactStatement: "We never call it.",
        subcomponent: true,
      }),
    ]);
  });

  it("matches advisory aliases in either direction and any case", () => {
    installLib(vexDocument(lib, [{ vulnerability: "GHSA-aaaa-bbbb-cccc", aliases: [CVE] }]));
    const index = readInstalledMaintainerVex(cwd);
    expect(findMaintainerVex(index, CVE.toLowerCase(), vulnerable).evidence).toHaveLength(1);
    expect(findMaintainerVex(index, "GHSA-AAAA-BBBB-CCCC", vulnerable).evidence).toHaveLength(1);
    expect(findMaintainerVex(index, "CVE-2026-9999", vulnerable).evidence).toEqual([]);
  });

  it("reads scoped packages and the pnpm layout, once per real directory", () => {
    const store = join(cwd, "node_modules", ".pnpm", "@acme+lib@2.0.0", "node_modules");
    installFake(cwd, { name: "bad-dep", version: "1.0.0", at: join(store, "bad-dep") });
    const dir = installFake(cwd, {
      name: "@acme/lib",
      version: "2.0.0",
      dependencies: { "bad-dep": "^1.0.0" },
      vex: "vex/openvex.json",
      at: join(store, "@acme", "lib"),
      files: { "vex/openvex.json": vexDocument({ name: "@acme/lib", version: "2.0.0" }, [{ vulnerability: CVE }]) },
    });
    mkdirSync(join(cwd, "node_modules", "@acme"), { recursive: true });
    symlinkSync(dir, join(cwd, "node_modules", "@acme", "lib"));

    const index = readInstalledMaintainerVex(cwd);
    expect(index.documents.map((entry) => `${entry.package.name}@${entry.package.version}`)).toEqual(["@acme/lib@2.0.0"]);
    expect(findMaintainerVex(index, CVE, vulnerable).evidence).toHaveLength(1);
  });

  it("ignores a document whose products name another version of the package", () => {
    installLib(vexDocument(lib, [{ vulnerability: CVE, product: "pkg:npm/lib@2.0.1" }]));
    const index = readInstalledMaintainerVex(cwd);
    expect(index.documents).toEqual([]);
    expect(index.rejected[0]?.reason).toContain("no statement about lib@2.0.0");
    expect(findMaintainerVex(index, CVE, vulnerable).evidence).toEqual([]);
  });

  it("ignores a document whose products name another package", () => {
    installLib(vexDocument(lib, [{ vulnerability: CVE, product: "pkg:npm/someone-else@2.0.0" }]));
    expect(readInstalledMaintainerVex(cwd).documents).toEqual([]);
  });

  it("ignores a statement whose subcomponent is a different package or version", () => {
    installLib(
      vexDocument(lib, [
        { vulnerability: CVE, subcomponents: ["pkg:npm/other-dep"] },
        { vulnerability: "CVE-2026-2222", subcomponents: ["pkg:npm/bad-dep@9.9.9"] },
      ]),
    );
    const index = readInstalledMaintainerVex(cwd);
    expect(findMaintainerVex(index, CVE, vulnerable).evidence).toEqual([]);
    expect(findMaintainerVex(index, "CVE-2026-2222", vulnerable).evidence).toEqual([]);
  });

  it("accepts a subcomponent pinned to exactly the installed version", () => {
    installLib(vexDocument(lib, [{ vulnerability: CVE, subcomponents: ["pkg:npm/bad-dep@1.0.0"] }]));
    expect(findMaintainerVex(readInstalledMaintainerVex(cwd), CVE, vulnerable).evidence).toHaveLength(1);
  });

  it("rejects a package declaring itself not affected by an advisory about itself", () => {
    installFake(cwd, {
      name: "bad-dep",
      version: "1.0.0",
      vex: true,
      files: { "vex.openvex.json": vexDocument(vulnerable, [{ vulnerability: CVE, impact: "Trust me." }]) },
    });
    const index = readInstalledMaintainerVex(cwd);
    expect(index.documents).toHaveLength(1);
    const match = findMaintainerVex(index, CVE, vulnerable);
    expect(match.evidence).toEqual([]);
    expect(match.ignored).toEqual([
      { maintainer: vulnerable, reason: expect.stringContaining("never accepted") },
    ]);
  });

  it("rejects a self claim even when it is made through a subcomponent of itself", () => {
    installFake(cwd, {
      name: "bad-dep",
      version: "1.0.0",
      vex: true,
      files: {
        "vex.openvex.json": vexDocument(vulnerable, [
          { vulnerability: CVE, subcomponents: ["pkg:npm/bad-dep"] },
        ]),
      },
    });
    expect(findMaintainerVex(readInstalledMaintainerVex(cwd), CVE, vulnerable).evidence).toEqual([]);
  });

  it("ignores a helper bundled inside the vulnerable package, whose claim is not independent", () => {
    installFake(cwd, { name: "bad-dep", version: "1.0.0" });
    installFake(cwd, {
      name: "helper",
      version: "1.0.0",
      dependencies: { "bad-dep": "*" },
      vex: true,
      at: join(cwd, "node_modules", "bad-dep", "node_modules", "helper"),
      files: { "vex.openvex.json": vexDocument({ name: "helper", version: "1.0.0" }, [{ vulnerability: CVE, justification: "vulnerable_code_not_present" }]) },
    });
    const match = findMaintainerVex(readInstalledMaintainerVex(cwd), CVE, vulnerable);
    expect(match.evidence).toEqual([]);
    expect(match.ignored[0]?.reason).toContain("inside bad-dep itself");
  });

  it("acts on nothing when one installed maintainer says not_affected and another says affected", () => {
    installFake(cwd, { name: "bad-dep", version: "1.0.0" });
    for (const [name, status] of [["lib-a", "not_affected"], ["lib-b", "affected"]] as const) {
      installFake(cwd, {
        name,
        version: "1.0.0",
        dependencies: { "bad-dep": "^1.0.0" },
        vex: true,
        files: {
          "vex.openvex.json": vexDocument({ name, version: "1.0.0" }, [
            { vulnerability: CVE, status, ...(status === "not_affected" ? { justification: "vulnerable_code_not_present" } : {}) },
          ]),
        },
      });
    }
    const match = findMaintainerVex(readInstalledMaintainerVex(cwd), CVE, vulnerable);
    expect(match.evidence).toEqual([]);
    expect(match.ignored.some((entry) => entry.reason.includes("neither is acted on"))).toBe(true);
  });

  it("ignores a package that does not depend on the vulnerable one", () => {
    installFake(cwd, { name: "bad-dep", version: "1.0.0" });
    installFake(cwd, {
      name: "unrelated",
      version: "1.0.0",
      vex: true,
      files: { "vex.openvex.json": vexDocument({ name: "unrelated", version: "1.0.0" }, [{ vulnerability: CVE }]) },
    });
    const match = findMaintainerVex(readInstalledMaintainerVex(cwd), CVE, vulnerable);
    expect(match.evidence).toEqual([]);
    expect(match.ignored[0]?.reason).toContain("does not depend on bad-dep");
  });

  it("follows dependencies through other installed packages", () => {
    installFake(cwd, { name: "bad-dep", version: "1.0.0" });
    installFake(cwd, { name: "middle", version: "1.0.0", dependencies: { "bad-dep": "^1.0.0" } });
    installFake(cwd, {
      name: "top",
      version: "1.0.0",
      dependencies: { middle: "^1.0.0" },
      vex: true,
      files: { "vex.openvex.json": vexDocument({ name: "top", version: "1.0.0" }, [{ vulnerability: CVE }]) },
    });
    expect(findMaintainerVex(readInstalledMaintainerVex(cwd), CVE, vulnerable).evidence).toHaveLength(1);
  });

  it("does not take a free-text impact statement as a justification", () => {
    installLib(vexDocument(lib, [{ vulnerability: CVE, justification: null, impact: "It is fine." }]));
    const match = findMaintainerVex(readInstalledMaintainerVex(cwd), CVE, vulnerable);
    expect(match.evidence).toEqual([]);
    expect(match.ignored[0]?.reason).toContain("no OpenVEX justification");
  });

  it("only reports statuses that say not_affected, and the newest statement wins", () => {
    installLib(
      vexDocument(lib, [
        { vulnerability: CVE, timestamp: "2026-01-01T00:00:00Z" },
        { vulnerability: CVE, status: "affected", timestamp: "2026-02-01T00:00:00Z", justification: null },
      ]),
    );
    const match = findMaintainerVex(readInstalledMaintainerVex(cwd), CVE, vulnerable);
    expect(match.evidence).toEqual([]);
    expect(match.ignored[0]?.reason).toContain("says affected");
  });

  it("prefers the statement that is not not_affected when two share a timestamp", () => {
    installLib(
      vexDocument(lib, [
        { vulnerability: CVE, timestamp: "2026-01-01T00:00:00Z" },
        { vulnerability: CVE, status: "under_investigation", timestamp: "2026-01-01T00:00:00Z", justification: null },
      ]),
    );
    expect(findMaintainerVex(readInstalledMaintainerVex(cwd), CVE, vulnerable).evidence).toEqual([]);
  });

  it("ignores statements dated in the future", () => {
    installLib(vexDocument(lib, [{ vulnerability: CVE, timestamp: "2999-01-01T00:00:00Z" }]));
    const match = findMaintainerVex(readInstalledMaintainerVex(cwd), CVE, vulnerable);
    expect(match.evidence).toEqual([]);
    expect(match.ignored[0]?.reason).toContain("future");
  });
});

describe("hostile documents", () => {
  const reasonFor = (): string => readInstalledMaintainerVex(cwd).rejected[0]?.reason ?? "";

  it("rejects a document over the size cap without parsing it", () => {
    installLib(`{"pad":"${"x".repeat(1024 * 1024 + 10)}"}`);
    expect(reasonFor()).toContain("larger than 1024 KiB");
  });

  it("rejects invalid JSON", () => {
    installLib("{ not json");
    expect(reasonFor()).toContain("not valid JSON");
  });

  it("rejects documents that do not match OpenVEX v0.2.0", () => {
    const base = JSON.parse(vexDocument(lib, [{ vulnerability: CVE }])) as Record<string, unknown>;
    const cases: Array<[string, Record<string, unknown>, string]> = [
      ["old context", { ...base, "@context": "https://openvex.dev/ns/v0.1.0" }, "@context"],
      ["no author", { ...base, author: undefined }, "author"],
      ["unknown key", { ...base, surprise: true }, "unknown field"],
      ["statements not a list", { ...base, statements: {} }, "statements"],
      ["bad status", { ...base, statements: [{ ...(base["statements"] as object[])[0], status: "fine" }] }, "status"],
      [
        "bad justification",
        { ...base, statements: [{ ...(base["statements"] as object[])[0], justification: "trust_me" }] },
        "justification",
      ],
      ["bad timestamp", { ...base, timestamp: "yesterday" }, "timestamp"],
      ["version zero", { ...base, version: 0 }, "version"],
    ];
    for (const [label, doc, expected] of cases) {
      rmSync(join(cwd, "node_modules"), { recursive: true, force: true });
      installLib(JSON.stringify(doc));
      const rejected = readInstalledMaintainerVex(cwd).rejected;
      expect({ label, count: rejected.length }).toEqual({ label, count: 1 });
      expect({ label, reason: rejected[0]?.reason }).toEqual({
        label,
        reason: expect.stringContaining(expected),
      });
    }
  });

  it("rejects not_affected with neither a justification nor an impact statement", () => {
    installLib(vexDocument(lib, [{ vulnerability: CVE, justification: null }]));
    expect(reasonFor()).toContain("justification or an impact_statement");
  });

  it("rejects prototype-pollution-shaped keys at any depth, and pollutes nothing", () => {
    const hostile = [
      `{"__proto__":{"polluted":"yes"}}`,
      vexDocument(lib, [{ vulnerability: CVE }]).replace(`"version": 1,`, `"version": 1, "__proto__": {"polluted": "yes"},`),
      vexDocument(lib, [{ vulnerability: CVE }]).replace(
        `"vulnerability": {`,
        `"vulnerability": { "constructor": {"prototype": {"polluted": "yes"}},`,
      ),
    ];
    for (const text of hostile) {
      rmSync(join(cwd, "node_modules"), { recursive: true, force: true });
      installLib(text);
      const index = readInstalledMaintainerVex(cwd);
      expect(index.documents).toEqual([]);
      expect(index.rejected).toHaveLength(1);
    }
    expect(({} as Record<string, unknown>)["polluted"]).toBeUndefined();
    expect(Object.prototype).not.toHaveProperty("polluted");
  });

  it("rejects deeply nested documents without overflowing the stack", () => {
    installLib(`${"[".repeat(50_000)}${"]".repeat(50_000)}`);
    const rejected = readInstalledMaintainerVex(cwd).rejected;
    expect(rejected).toHaveLength(1);
    expect(rejected[0]?.reason).toMatch(/nested deeper|not valid JSON|OpenVEX/);
  });

  it("parseOpenVex reports an error and never throws", () => {
    for (const text of ["", "null", "[]", "42", '"x"', "{}"]) {
      expect(parseOpenVex(text)).toHaveProperty("error");
    }
  });

  it("refuses a vex path that leaves the package", () => {
    for (const vex of ["../escape.json", "/etc/passwd", "a/../../b.json"]) {
      rmSync(join(cwd, "node_modules"), { recursive: true, force: true });
      installLib(vexDocument(lib, [{ vulnerability: CVE }]), { vex });
      expect(readInstalledMaintainerVex(cwd).documents).toEqual([]);
      expect(reasonFor()).toContain('"vex"');
    }
  });

  it("refuses a symlink that points outside the package", () => {
    const outside = join(cwd, "outside.json");
    writeFileSync(outside, vexDocument(lib, [{ vulnerability: CVE }]));
    installFake(cwd, { name: "bad-dep", version: "1.0.0" });
    const dir = installFake(cwd, { name: "lib", version: "2.0.0", dependencies: { "bad-dep": "^1" }, vex: true });
    symlinkSync(outside, join(dir, "vex.openvex.json"));
    const index = readInstalledMaintainerVex(cwd);
    expect(index.documents).toEqual([]);
    expect(index.rejected[0]?.reason).toContain("outside the package");
  });

  it("reports a declared file that is missing, and keeps scanning", () => {
    installFake(cwd, { name: "ghost", version: "1.0.0", vex: true });
    installLib(vexDocument(lib, [{ vulnerability: CVE }]));
    const index = readInstalledMaintainerVex(cwd);
    expect(index.rejected.map((entry) => entry.package)).toEqual(["ghost"]);
    expect(index.documents.map((entry) => entry.package.name)).toEqual(["lib"]);
  });

  it("does not read a document from a package that does not declare one", () => {
    installFake(cwd, { name: "bad-dep", version: "1.0.0" });
    installFake(cwd, {
      name: "lib",
      version: "2.0.0",
      dependencies: { "bad-dep": "^1.0.0" },
      files: { "vex.openvex.json": vexDocument(lib, [{ vulnerability: CVE }]) },
    });
    expect(readInstalledMaintainerVex(cwd).documents).toEqual([]);
  });

  it("says so when there is no node_modules", () => {
    const index = readInstalledMaintainerVex(mkdtempSync(join(tmpdir(), "no-nm-")));
    expect(index.scanned).toBe(0);
    expect(index.notes[0]).toContain("No node_modules");
  });
});
