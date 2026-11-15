import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { checkReachability } from "../reachability/index.js";
import { installFake } from "../../platform/maintainer-vex/__tests__/fixtures.js";
import { readInstalledMaintainerVex, findMaintainerVex } from "../../platform/maintainer-vex/index.js";
import type { RemediationReport } from "../../platform/types.js";
import { TRACE_SCHEMA, type TracePackage, type TraceReport } from "../../trace/types.js";
import { readMaintainerVex } from "../maintainer-vex/index.js";
import { maintainWith, type MaintainDeps } from "./index.js";
import { changesetName, editPackageJson, filesCover, nextVersionOf } from "./package-files.js";
import { mergeVexFile } from "./vex-file.js";

let cwd: string;
const NOW = new Date("2026-03-01T12:00:00.000Z");

function write(path: string, content: string): void {
  mkdirSync(join(cwd, path, ".."), { recursive: true });
  writeFileSync(join(cwd, path), content);
}
const read = (path: string): string => readFileSync(join(cwd, path), "utf8");

function lockfile(): string {
  return JSON.stringify({
    name: "my-lib",
    version: "1.2.0",
    lockfileVersion: 3,
    packages: {
      "": {
        name: "my-lib",
        version: "1.2.0",
        dependencies: { "used-dep": "^1.0.0", "unused-dep": "^1.0.0" },
        devDependencies: { "dev-dep": "^1.0.0" },
      },
      "node_modules/used-dep": { version: "1.0.0" },
      "node_modules/unused-dep": { version: "1.0.0" },
      "node_modules/dev-dep": { version: "1.0.0", dev: true },
    },
  });
}

beforeEach(() => {
  cwd = mkdtempSync(join(tmpdir(), "maintain-"));
  write(
    "package.json",
    `${JSON.stringify(
      {
        name: "my-lib",
        version: "1.2.0",
        author: "Ada <ada@example.test>",
        main: "src/index.js",
        files: ["src"],
        dependencies: { "used-dep": "^1.0.0", "unused-dep": "^1.0.0" },
        devDependencies: { "dev-dep": "^1.0.0" },
      },
      null,
      2,
    )}\n`,
  );
  write("package-lock.json", lockfile());
  write("src/index.js", 'const used = require("used-dep");\nmodule.exports = () => used();\n');
  write(".changeset/config.json", "{}");
});
afterEach(() => {
  rmSync(cwd, { recursive: true, force: true });
});

function report(id: string, packages: string[], fixed = "2.0.0"): RemediationReport {
  const vulnerablePackages = packages.map((name) => ({
    installed: { name, version: "1.0.0", type: "direct" as const },
    affected: { name, ecosystem: "npm" as const, vulnerableRange: "<2.0.0", firstPatchedVersion: fixed, source: "osv" as const },
  }));
  return {
    cveId: id,
    cveDetails: { id, summary: "s", severity: "HIGH", references: [], affectedPackages: [] },
    vulnerablePackages,
    results: packages.map((name) => ({
      packageName: name,
      fromVersion: "1.0.0",
      toVersion: fixed,
      strategy: "version-bump" as const,
      applied: false,
      dryRun: true,
      message: "planned",
    })),
    summary: "planned",
  } as unknown as RemediationReport;
}

function deps(plans: Record<string, string[]>): MaintainDeps & { plan: ReturnType<typeof vi.fn> } {
  return {
    findAdvisories: vi.fn(async () => Object.keys(plans)),
    plan: vi.fn(async (id: string) => ({ ...report(id, plans[id] ?? []), runId: undefined })),
    reachability: checkReachability,
    now: () => NOW,
  } as unknown as MaintainDeps & { plan: ReturnType<typeof vi.fn> };
}

describe("maintain", () => {
  it("reports a diff and writes nothing without yes", async () => {
    const before = read("package.json");
    const result = await maintainWith(deps({ "CVE-2026-0001": ["used-dep"] }), { cwd });

    expect(result.applied).toBe(false);
    expect(result.drift).toBe(true);
    expect(result.advisories[0]).toMatchObject({ id: "CVE-2026-0001", decision: "affected" });
    expect(result.changes.map((change) => change.path).toSorted()).toEqual([
      ".changeset/maintain-cve-2026-0001-" + changesetName(["CVE-2026-0001"]).split("-").at(-1) + ".md",
      "package.json",
      "vex.openvex.json",
    ]);
    expect(result.changes.every((change) => change.diff.startsWith("---"))).toBe(true);
    expect(read("package.json")).toBe(before);
    expect(existsSync(join(cwd, "vex.openvex.json"))).toBe(false);
    expect(existsSync(join(cwd, ".changeset", changesetName(["CVE-2026-0001"]) + ".md"))).toBe(false);
  });

  it("plans with evidence off until approved, then records the plan", async () => {
    const d = deps({ "CVE-2026-0001": ["used-dep"] });
    await maintainWith(d, { cwd });
    expect(d.plan).toHaveBeenLastCalledWith("CVE-2026-0001", expect.objectContaining({ evidence: false }));
    await maintainWith(d, { cwd, yes: true });
    expect(d.plan).toHaveBeenLastCalledWith("CVE-2026-0001", expect.objectContaining({ evidence: true }));
  });

  it("with yes writes the changeset, the OpenVEX file and the package.json wiring, and is idempotent", async () => {
    const d = deps({ "CVE-2026-0001": ["used-dep"], "CVE-2026-0002": ["unused-dep"] });
    const first = await maintainWith(d, { cwd, yes: true });
    expect(first.applied).toBe(true);
    expect(first.nextVersion).toBe("1.2.1");

    const manifest = JSON.parse(read("package.json")) as Record<string, unknown>;
    expect(manifest["vex"]).toBe("vex.openvex.json");
    expect(manifest["files"]).toEqual(["src", "vex.openvex.json"]);
    expect(Object.keys(manifest).indexOf("vex")).toBe(Object.keys(manifest).indexOf("files") + 1);
    expect(manifest["name"]).toBe("my-lib");

    const vex = JSON.parse(read("vex.openvex.json")) as {
      "@context": string;
      author: string;
      statements: Array<Record<string, unknown>>;
    };
    expect(vex["@context"]).toBe("https://openvex.dev/ns/v0.2.0");
    expect(vex.author).toBe("Ada <ada@example.test>");
    expect(vex.statements).toHaveLength(2);
    const byId = Object.fromEntries(vex.statements.map((s) => [(s["vulnerability"] as { name: string }).name, s]));
    expect(byId["CVE-2026-0001"]).toMatchObject({ status: "affected", action_statement: expect.stringContaining("used-dep 2.0.0") });
    expect(byId["CVE-2026-0002"]).toMatchObject({ status: "under_investigation" });
    expect(byId["CVE-2026-0002"]).not.toHaveProperty("justification");
    expect(byId["CVE-2026-0001"]).toMatchObject({
      products: [{ "@id": "pkg:npm/my-lib@1.2.1", subcomponents: [{ "@id": "pkg:npm/used-dep" }] }],
    });

    const changesetPath = first.changes.find((change) => change.path.startsWith(".changeset/"))!.path;
    expect(read(changesetPath)).toBe(
      [
        "---",
        '"my-lib": patch',
        "---",
        "",
        "- Update `used-dep` to 2.0.0 to fix CVE-2026-0001, which this package's code reaches.",
        "- Record in the shipped OpenVEX document that CVE-2026-0002 in `unused-dep` is under investigation.",
        "",
      ].join("\n"),
    );

    const second = await maintainWith(d, { cwd, yes: true });
    expect(second.drift).toBe(false);
    expect(second.applied).toBe(false);
    expect(second.changes.map((change) => change.action)).toEqual(["unchanged", "unchanged", "unchanged"]);
  });

  it("writes not_affected only when the scan finds no use AND --assert-not-affected is given", async () => {
    const d = deps({ "CVE-2026-0002": ["unused-dep"] });

    const cautious = await maintainWith(d, { cwd });
    expect(cautious.advisories[0]).toMatchObject({ decision: "under_investigation" });
    expect(cautious.advisories[0]!.reason).toContain("--assert-not-affected");

    const asserted = await maintainWith(d, { cwd, assertNotAffected: true, yes: true });
    expect(asserted.advisories[0]).toMatchObject({ decision: "not_affected" });
    const vex = JSON.parse(read("vex.openvex.json")) as { statements: Array<Record<string, unknown>> };
    expect(vex.statements[0]).toMatchObject({
      status: "not_affected",
      justification: "vulnerable_code_not_in_execute_path",
    });
    expect(read(asserted.changes.find((c) => c.path.startsWith(".changeset/"))!.path)).toContain(
      "is not affected by CVE-2026-0002",
    );
  });

  it("never writes not_affected for a package the source reaches, even with --assert-not-affected", async () => {
    const result = await maintainWith(deps({ "CVE-2026-0001": ["used-dep"] }), { cwd, assertNotAffected: true });
    expect(result.advisories[0]!.decision).toBe("affected");
  });

  it("is under investigation when reachability is unknown, even with --assert-not-affected", async () => {
    const d = deps({ "CVE-2026-0002": ["unused-dep"] });
    d.reachability = vi.fn(async () => ({ packageName: "unused-dep", status: "unknown" as const, reason: "no source" }));
    const result = await maintainWith(d, { cwd, assertNotAffected: true });
    expect(result.advisories[0]!.decision).toBe("under_investigation");
  });

  it("a trace can only make the verdict more cautious", async () => {
    const d = deps({ "CVE-2026-0002": ["unused-dep"] });
    const trace = join(cwd, "trace.json");
    const traced = (loaded: boolean, calls: Record<string, number> = {}): TraceReport => ({
      schema: TRACE_SCHEMA,
      createdAt: "2026-01-01T00:00:00.000Z",
      processes: 1,
      partialEsm: false,
      callTracing: { enabled: true, packages: ["unused-dep"] },
      skippedLines: 0,
      command: { argv: ["node", "--test"], exitCode: 0 },
      packages: loaded
        ? [
            {
              name: "unused-dep",
              version: "1.0.0",
              entries: ["index.js"],
              dependents: ["(app)"],
              formats: ["cjs"],
              calls,
            } as TracePackage,
          ]
        : [],
    });

    // The static scan finds no use and the traced tests never loaded it: the asserted not_affected stands.
    writeFileSync(trace, JSON.stringify(traced(false)));
    const quiet = await maintainWith(d, { cwd, assertNotAffected: true, traceFile: trace });
    expect(quiet.advisories[0]).toMatchObject({ decision: "not_affected" });
    expect(quiet.advisories[0]!.packages[0]).toMatchObject({ evidenceKind: "both", reachability: "not-reachable" });

    // The tests did call it: runtime evidence turns the static not-reachable into reachable, so it is affected.
    writeFileSync(trace, JSON.stringify(traced(true, { run: 3 })));
    const called = await maintainWith(d, { cwd, assertNotAffected: true, traceFile: trace });
    expect(called.advisories[0]).toMatchObject({ decision: "affected" });
    expect(called.advisories[0]!.packages[0]).toMatchObject({ reachability: "reachable", runtimeVerdict: "called-in-tests" });
  });

  it("ignores development-only dependencies: consumers never install them", async () => {
    const result = await maintainWith(deps({ "CVE-2026-0003": ["dev-dep"] }), { cwd, assertNotAffected: true });
    expect(result.advisories[0]).toMatchObject({ decision: "not-shipped" });
    expect(result.changes).toEqual([]);
    expect(result.drift).toBe(false);
  });

  it("keeps hand-written statements, other versions, and the author's file when nothing changes", async () => {
    const d = deps({ "CVE-2026-0002": ["unused-dep"] });
    await maintainWith(d, { cwd, yes: true });
    const doc = JSON.parse(read("vex.openvex.json")) as { statements: unknown[] } & Record<string, unknown>;
    doc.statements.push({
      vulnerability: { name: "CVE-2025-0009" },
      products: [{ "@id": "pkg:npm/my-lib@1.0.0" }],
      status: "not_affected",
      justification: "component_not_present",
      timestamp: "2025-01-01T00:00:00Z",
    });
    // Hand-formatted with tabs: must come back untouched when there is nothing new to say.
    const handFormatted = `${JSON.stringify(doc, null, "\t")}\n`;
    write("vex.openvex.json", handFormatted);

    const rerun = await maintainWith(d, { cwd, yes: true });
    expect(read("vex.openvex.json")).toBe(handFormatted);
    expect(rerun.changes.find((c) => c.path === "vex.openvex.json")?.action).toBe("unchanged");

    // A new advisory is appended and the document version moves; the old statements stay.
    await maintainWith(deps({ "CVE-2026-0002": ["unused-dep"], "CVE-2026-0001": ["used-dep"] }), { cwd, yes: true });
    const merged = JSON.parse(read("vex.openvex.json")) as { version: number; last_updated: string; statements: Array<{ vulnerability: { name: string } }> };
    expect(merged.statements.map((s) => s.vulnerability.name)).toEqual(["CVE-2026-0002", "CVE-2025-0009", "CVE-2026-0001"]);
    expect(merged.version).toBe(2);
    expect(merged.last_updated).toBe(NOW.toISOString());
  });

  it("leaves a vex file it cannot parse alone and reports a conflict", async () => {
    write("vex.openvex.json", "{ not json");
    const result = await maintainWith(deps({ "CVE-2026-0001": ["used-dep"] }), { cwd, yes: true });
    expect(result.conflicts).toEqual(["vex.openvex.json"]);
    expect(read("vex.openvex.json")).toBe("{ not json");
  });

  it("honours a package.json#vex path the author already chose and ships it", async () => {
    write(
      "package.json",
      JSON.stringify({ name: "my-lib", version: "1.2.0", vex: "security/vex.json", files: ["src"], dependencies: { "used-dep": "^1" } }, null, 2),
    );
    await maintainWith(deps({ "CVE-2026-0001": ["used-dep"] }), { cwd, yes: true });
    expect(existsSync(join(cwd, "security", "vex.json"))).toBe(true);
    expect((JSON.parse(read("package.json")) as { files: string[] }).files).toEqual(["src", "security/vex.json"]);
  });

  it("refuses an unsafe package.json#vex path", async () => {
    write("package.json", JSON.stringify({ name: "my-lib", version: "1.2.0", vex: "../elsewhere.json" }));
    const result = await maintainWith(deps({ "CVE-2026-0001": ["used-dep"] }), { cwd, yes: true });
    expect(result.conflicts).toContain("package.json");
    expect(existsSync(join(cwd, "..", "elsewhere.json"))).toBe(false);
  });

  it("skips the changeset, and says so, when the repository does not use changesets", async () => {
    rmSync(join(cwd, ".changeset"), { recursive: true, force: true });
    const result = await maintainWith(deps({ "CVE-2026-0001": ["used-dep"] }), { cwd, yes: true });
    expect(result.usesChangesets).toBe(false);
    expect(result.changes.map((change) => change.path).toSorted()).toEqual(["package.json", "vex.openvex.json"]);
    expect(result.notes.join("\n")).toContain("does not use changesets");
  });

  it("names the next version from the highest pending changeset bump", async () => {
    write(".changeset/other.md", '---\n"my-lib": minor\n"another": major\n---\n\nSomething.\n');
    const result = await maintainWith(deps({ "CVE-2026-0001": ["used-dep"] }), { cwd });
    expect(result.nextVersion).toBe("1.3.0");
    expect(result.changes.find((c) => c.path === "vex.openvex.json")!.diff).toContain("pkg:npm/my-lib@1.3.0");
  });

  it("takes an explicit nextVersion, and refuses to guess in changesets pre mode", async () => {
    write(".changeset/pre.json", "{}");
    const guessed = await maintainWith(deps({ "CVE-2026-0001": ["used-dep"] }), { cwd });
    expect(guessed.nextVersion).toBeUndefined();
    expect(guessed.changes).toEqual([]);
    expect(guessed.notes.join("\n")).toContain("pre-release mode");

    const given = await maintainWith(deps({ "CVE-2026-0001": ["used-dep"] }), { cwd, nextVersion: "1.3.0-next.1" });
    expect(given.nextVersion).toBe("1.3.0-next.1");
    await expect(
      maintainWith(deps({ "CVE-2026-0001": ["used-dep"] }), { cwd, nextVersion: "v2" }),
    ).rejects.toThrow(/exact semantic version/);
  });

  it("prepares nothing for a private package", async () => {
    write("package.json", JSON.stringify({ name: "my-lib", version: "1.2.0", private: true }));
    const result = await maintainWith(deps({ "CVE-2026-0001": ["used-dep"] }), { cwd, yes: true });
    expect(result.changes).toEqual([]);
    expect(result.notes.join("\n")).toContain("private");
    expect(result.advisories[0]!.decision).toBe("affected");
  });

  it("validates advisory ids and needs a package.json", async () => {
    await expect(maintainWith(deps({}), { cwd, advisories: ["nope"] })).rejects.toThrow(/Not a CVE or GHSA id/);
    await expect(maintainWith(deps({}), { cwd: join(cwd, "missing") })).rejects.toThrow(/package.json/);
  });

  it("does nothing when there are no advisories", async () => {
    const result = await maintainWith(deps({}), { cwd, yes: true });
    expect(result.advisories).toEqual([]);
    expect(result.changes).toEqual([]);
    expect(result.applied).toBe(false);
  });

  it("reports an advisory that could not be looked up without deciding anything", async () => {
    const d = deps({});
    d.plan = vi.fn(async () => ({ cveId: "CVE-2026-0007", cveDetails: null, vulnerablePackages: [], results: [], summary: "not found" })) as never;
    const result = await maintainWith(d, { cwd, advisories: ["CVE-2026-0007"], yes: true });
    expect(result.advisories[0]).toMatchObject({ decision: "unknown", reason: "not found" });
    expect(result.changes).toEqual([]);
  });

  it("ships a file a consumer accepts: the output round-trips through the consumer's reader", async () => {
    const d = deps({ "CVE-2026-0002": ["unused-dep"] });
    await maintainWith(d, { cwd, assertNotAffected: true, yes: true });
    // Pretend my-lib 1.2.1 was released and installed in a consumer next to unused-dep.
    const consumer = mkdtempSync(join(tmpdir(), "consumer-"));
    try {
      installFake(consumer, { name: "unused-dep", version: "1.0.0" });
      installFake(consumer, {
        name: "my-lib",
        version: "1.2.1",
        dependencies: { "unused-dep": "^1.0.0" },
        vex: JSON.parse(read("package.json")).vex,
        files: { "vex.openvex.json": read("vex.openvex.json") },
      });
      const index = readInstalledMaintainerVex(consumer);
      expect(index.rejected).toEqual([]);
      const match = findMaintainerVex(index, "CVE-2026-0002", { name: "unused-dep", version: "1.0.0" });
      expect(match.evidence).toEqual([
        expect.objectContaining({
          maintainer: { name: "my-lib", version: "1.2.1" },
          justification: "vulnerable_code_not_in_execute_path",
          author: "Ada <ada@example.test>",
        }),
      ]);
      expect(readMaintainerVex({ cwd: consumer }).packages[0]?.statements[0]).toMatchObject({
        vulnerability: "CVE-2026-0002",
        status: "not_affected",
        subcomponents: ["unused-dep"],
      });
    } finally {
      rmSync(consumer, { recursive: true, force: true });
    }
  });

  it("vex show reports this project's own file and warns when it names the wrong version", async () => {
    const d = deps({ "CVE-2026-0002": ["unused-dep"] });
    await maintainWith(d, { cwd, yes: true });
    const own = readMaintainerVex({ cwd }).own;
    expect(own).toMatchObject({ declared: true, file: "vex.openvex.json", status: "valid", statements: 1 });
    // The document names 1.2.1 but package.json is still 1.2.0 until release: that is reported.
    expect(own.reason).toContain("1.2.0");
  });
});

describe("package.json editing", () => {
  it("keeps key order and indentation, adds vex after files, and never duplicates", () => {
    const text = '{\n\t"name": "x",\n\t"files": ["dist"],\n\t"license": "MIT"\n}\n';
    const edited = editPackageJson(text);
    expect(edited).toEqual({
      vexPath: "vex.openvex.json",
      content: '{\n\t"name": "x",\n\t"files": [\n\t\t"dist",\n\t\t"vex.openvex.json"\n\t],\n\t"vex": "vex.openvex.json",\n\t"license": "MIT"\n}\n',
    });
    const again = editPackageJson((edited as { content: string }).content);
    expect(again).toMatchObject({ content: (edited as { content: string }).content });
  });

  it("does not touch files when there is no list, and conflicts on bad shapes", () => {
    expect(editPackageJson('{"name":"x"}')).toMatchObject({
      content: '{\n  "name": "x",\n  "vex": "vex.openvex.json"\n}',
    });
    expect(editPackageJson("[]")).toHaveProperty("conflict");
    expect(editPackageJson("nope")).toHaveProperty("conflict");
    expect(editPackageJson('{"files":"dist"}')).toHaveProperty("conflict");
  });

  it("understands which files npm would include", () => {
    expect(filesCover(["dist", "vex.openvex.json"], "vex.openvex.json")).toBe(true);
    expect(filesCover(["security/"], "security/vex.json")).toBe(true);
    expect(filesCover(["*.json"], "vex.openvex.json")).toBe(true);
    expect(filesCover(["dist"], "vex.openvex.json")).toBe(false);
    expect(filesCover(["!vex.openvex.json"], "vex.openvex.json")).toBe(false);
  });

  it("derives a deterministic changeset name and the next version", () => {
    expect(changesetName(["CVE-2026-0002", "CVE-2026-0001"])).toBe(changesetName(["CVE-2026-0001", "CVE-2026-0002"]));
    expect(changesetName(["CVE-2026-0001"])).toMatch(/^maintain-cve-2026-0001-[0-9a-f]{6}$/);
    expect(nextVersionOf(cwd, "my-lib", "1.2.0", undefined, false).version).toBe("1.2.1");
    expect(nextVersionOf(cwd, "my-lib", "1.2.0", "2.0.0", true).version).toBe("2.0.0");
  });
});

describe("vex file merge", () => {
  const input = {
    packageName: "@scope/pkg",
    version: "1.0.1",
    author: "Ada",
    tooling: "autoremediator",
    now: NOW,
  };
  it("builds a v0.2.0 document with the product purl encoded", () => {
    const result = mergeVexFile({
      ...input,
      existing: undefined,
      statements: [{ advisory: "GHSA-aaaa-bbbb-cccc", status: "under_investigation", subcomponents: ["dep"], statusNotes: "n" }],
    });
    const doc = JSON.parse((result as { content: string }).content) as Record<string, unknown>;
    expect(doc["@context"]).toBe("https://openvex.dev/ns/v0.2.0");
    expect(JSON.stringify(doc)).toContain("pkg:npm/%40scope/pkg@1.0.1");
  });

  it("replaces a statement only when its substance changed, bumping its version", () => {
    const first = mergeVexFile({
      ...input,
      existing: undefined,
      statements: [{ advisory: "CVE-2026-0001", status: "under_investigation", subcomponents: ["dep"], statusNotes: "a" }],
    }) as { content: string };
    const later = { ...input, now: new Date("2026-04-01T00:00:00Z") };
    const same = mergeVexFile({
      ...later,
      existing: first.content,
      statements: [{ advisory: "CVE-2026-0001", status: "under_investigation", subcomponents: ["dep"], statusNotes: "a" }],
    }) as { content: string };
    expect(same.content).toBe(first.content);
    const changed = mergeVexFile({
      ...later,
      existing: first.content,
      statements: [{ advisory: "CVE-2026-0001", status: "not_affected", subcomponents: ["dep"], statusNotes: "b" }],
    }) as { content: string };
    const doc = JSON.parse(changed.content) as { version: number; statements: Array<{ version: number; status: string; timestamp: string }> };
    expect(doc.version).toBe(2);
    expect(doc.statements).toHaveLength(1);
    expect(doc.statements[0]).toMatchObject({ version: 2, status: "not_affected", timestamp: "2026-04-01T00:00:00.000Z" });
  });
});
