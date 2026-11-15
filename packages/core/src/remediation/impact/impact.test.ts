import { afterEach, describe, expect, it } from "vitest";

import { cleanupProjects, pkg, project } from "./__tests__/fixtures.js";
import { assessUpgrade, findVulnerableSymbolsInUpgrade, type ImpactDeps } from "./assess.js";
import {
  analyzeUpgrade,
  IMPACT_POINTS,
  MEDIUM_THRESHOLD,
  rate,
  type FindingEvidence,
  type ImpactFinding,
} from "./impact.js";
import type { PackageSource } from "./types.js";
import { buildUsageIndex, sitesForExport } from "./usage-index.js";

afterEach(cleanupProjects);

describe("usage index", () => {
  it("follows named imports, default+member access, require destructuring and namespaces", () => {
    const cwd = project({
      "src/a.ts": [
        `import { render, Widget } from "fixture-pkg";`,
        `import lib from "fixture-pkg";`,
        `import * as ns from "fixture-pkg";`,
        `render("a", 1);`,
        `new Widget(1, 2).draw();`,
        `lib.helper(1);`,
        `lib.other;`,
        `ns.third(1, 2, 3);`,
        `const x: Widget = new Widget();`,
      ].join("\n"),
      "src/b.js": [
        `const { alpha, beta: b } = require("fixture-pkg");`,
        `const mod = require("fixture-pkg");`,
        `const gamma = require("fixture-pkg").gamma;`,
        `alpha(1); b(); mod.delta(); gamma();`,
        `require("fixture-pkg")(1, 2);`,
      ].join("\n"),
    });
    const usage = buildUsageIndex(cwd, "fixture-pkg");
    const lines = (name: string): string[] =>
      sitesForExport(usage, "fixture-pkg", name).map(
        (site) => `${site.file}:${site.line}:${site.kind}`,
      );

    expect(lines("render")).toEqual(["src/a.ts:1:import", "src/a.ts:4:call"]);
    expect(lines("Widget")).toEqual(
      expect.arrayContaining(["src/a.ts:5:new", "src/a.ts:9:type-reference"]),
    );
    expect(lines("helper")).toEqual(["src/a.ts:6:call"]);
    expect(lines("third")).toEqual(["src/a.ts:8:call"]);
    expect(lines("alpha")).toContain("src/b.js:4:call");
    expect(lines("beta")).toContain("src/b.js:4:call");
    expect(lines("delta")).toEqual(["src/b.js:4:call"]);
    expect(lines("gamma")).toContain("src/b.js:4:call");
    expect(
      sitesForExport(usage, "fixture-pkg", "default").some((site) => site.argCount === 2),
    ).toBe(true);
    expect(sitesForExport(usage, "fixture-pkg", "third")[0]?.argCount).toBe(3);
    expect(usage.filesUsingPackage).toBe(2);
  });

  it("records subpath imports under their own specifier and tracks static members", () => {
    const cwd = project({
      "a.js": `import { Thing } from "fixture-pkg/lib/thing.js";\nThing.create(1);\nimport "fixture-pkg/side";`,
    });
    const usage = buildUsageIndex(cwd, "fixture-pkg");
    expect([...usage.specifiers].toSorted()).toEqual(["fixture-pkg/lib/thing", "fixture-pkg/side"]);
    expect(
      usage.staticMemberUses.get("fixture-pkg/lib/thing")?.get("Thing")?.get("create")?.[0]?.line,
    ).toBe(2);
  });

  it("marks the module object as opaque when it escapes or is read by computed name", () => {
    const cwd = project({
      "a.js": `const lib = require("fixture-pkg");\nregister(lib);\nconst k = "x";\nlib[k]();\n`,
    });
    const usage = buildUsageIndex(cwd, "fixture-pkg");
    expect(usage.opaque.get("fixture-pkg")?.map((site) => site.line)).toEqual([2, 4]);
  });

  it("ignores files that only mention the name in a string and skips node_modules", () => {
    const cwd = project({
      "a.js": `console.log("fixture-pkg is great");`,
      "node_modules/x/index.js": `require("fixture-pkg").f();`,
    });
    const usage = buildUsageIndex(cwd, "fixture-pkg");
    expect(usage.filesUsingPackage).toBe(0);
    expect(usage.specifiers.size).toBe(0);
  });
});

describe("scoring table", () => {
  const finding = (
    evidence: FindingEvidence,
    severity: ImpactFinding["severity"],
  ): Pick<ImpactFinding, "evidence" | "severity" | "points"> => ({
    evidence,
    severity,
    points: IMPACT_POINTS[evidence][severity],
  });

  it("has the documented points", () => {
    expect(IMPACT_POINTS).toEqual({
      "project-usage": { breaking: 50, "possibly-breaking": 20 },
      "name-match": { breaking: 20, "possibly-breaking": 8 },
      "project-conflict": { breaking: 50, "possibly-breaking": 50 },
      "opaque-usage": { breaking: 15, "possibly-breaking": 15 },
      unresolved: { breaking: 15, "possibly-breaking": 15 },
    });
    expect(MEDIUM_THRESHOLD).toBe(15);
  });

  it.each([
    ["nothing", [], "Low", 0],
    ["a possibly-breaking name match", [finding("name-match", "possibly-breaking")], "Low", 8],
    ["a breaking name match", [finding("name-match", "breaking")], "Medium", 20],
    [
      "an unresolved package-level change",
      [finding("unresolved", "possibly-breaking")],
      "Medium",
      15,
    ],
    ["opaque usage", [finding("opaque-usage", "possibly-breaking")], "Medium", 15],
    [
      "a possibly-breaking change reached by project code",
      [finding("project-usage", "possibly-breaking")],
      "Medium",
      20,
    ],
    [
      "a breaking change reached by project code",
      [finding("project-usage", "breaking")],
      "High",
      50,
    ],
    ["a provable manifest conflict", [finding("project-conflict", "breaking")], "High", 50],
    [
      "many soft findings never reach High",
      [
        finding("project-usage", "possibly-breaking"),
        finding("project-usage", "possibly-breaking"),
        finding("project-usage", "possibly-breaking"),
        finding("unresolved", "breaking"),
      ],
      "Medium",
      75,
    ],
    [
      "one hard finding among soft ones",
      [finding("name-match", "possibly-breaking"), finding("project-usage", "breaking")],
      "High",
      58,
    ],
  ] as const)("rates %s", (_label, findings, breakability, score) => {
    expect(rate([...findings])).toEqual({ score, breakability });
  });
});

describe("analyzeUpgrade", () => {
  const typed = (
    version: string,
    dts: string,
    manifest: Record<string, unknown> = {},
  ): PackageSource =>
    pkg(
      version,
      { "index.d.ts": dts, "index.js": "module.exports = {};" },
      { main: "index.js", types: "index.d.ts", ...manifest },
    );

  it("rates High and lists file:line when the project uses a removed export", () => {
    const cwd = project({
      "src/app.ts": `import { gone, kept } from "fixture-pkg";\nkept();\ngone();\n`,
    });
    const impact = analyzeUpgrade({
      before: typed(
        "1.0.0",
        `export declare function gone(): void;\nexport declare function kept(): void;`,
      ),
      after: typed("2.0.0", `export declare function kept(): void;`),
      usage: buildUsageIndex(cwd, "fixture-pkg"),
    });
    expect(impact.breakability).toBe("High");
    const [finding] = impact.findings;
    expect(finding).toMatchObject({
      category: "removed-export",
      symbol: "gone",
      evidence: "project-usage",
      points: 50,
    });
    expect(finding?.affectedCallSites.map((site) => `${site.file}:${site.line}`)).toEqual([
      "src/app.ts:1",
      "src/app.ts:3",
    ]);
    expect(impact.summary).toMatch(/^High:/);
  });

  it("rates Low when the breaking change is in code the project does not use, and counts it", () => {
    const cwd = project({ "src/app.ts": `import { kept } from "fixture-pkg";\nkept();\n` });
    const impact = analyzeUpgrade({
      before: typed(
        "1.0.0",
        `export declare function gone(): void;\nexport declare function kept(): void;`,
      ),
      after: typed("2.0.0", `export declare function kept(): void;`),
      usage: buildUsageIndex(cwd, "fixture-pkg"),
    });
    expect(impact).toMatchObject({
      breakability: "Low",
      score: 0,
      findings: [],
      unreachedChanges: { breaking: 1, possiblyBreaking: 0 },
    });
  });

  it("checks call arity against the new signature instead of flagging every caller", () => {
    const before = typed("1.0.0", `export declare function f(a: string): void;`);
    const after = typed("2.0.0", `export declare function f(a: string, b: number): void;`);
    const compatible = analyzeUpgrade({
      before,
      after,
      usage: buildUsageIndex(
        project({ "a.js": `import { f } from "fixture-pkg";\nf("x", 1);\n` }),
        "fixture-pkg",
      ),
    });
    expect(compatible.breakability).toBe("Low");

    const broken = analyzeUpgrade({
      before,
      after,
      usage: buildUsageIndex(
        project({ "a.js": `import { f } from "fixture-pkg";\nf("x");\nf("y", 2);\n` }),
        "fixture-pkg",
      ),
    });
    expect(broken.breakability).toBe("High");
    expect(broken.findings[0]?.affectedCallSites.map((site) => site.line)).toEqual([2]);
    expect(broken.findings[0]?.reason).toMatch(/at least 2 arguments/);
  });

  it("matches class instance members by name only and rates them softer", () => {
    const before = typed("1.0.0", `export declare class C { run(): void; stop(): void }`);
    const after = typed("2.0.0", `export declare class C { run(): void }`);
    const cwd = project({
      "a.ts": `import { C } from "fixture-pkg";\nconst c = new C();\nc.stop();\n`,
    });
    const impact = analyzeUpgrade({ before, after, usage: buildUsageIndex(cwd, "fixture-pkg") });
    expect(impact.findings).toHaveLength(1);
    expect(impact.findings[0]).toMatchObject({
      evidence: "name-match",
      points: 20,
      member: "stop",
    });
    expect(impact.findings[0]?.affectedCallSites[0]).toMatchObject({
      line: 3,
      confidence: "name-match",
    });
    expect(impact.breakability).toBe("Medium");

    const unused = analyzeUpgrade({
      before,
      after,
      usage: buildUsageIndex(
        project({ "a.ts": `import { C } from "fixture-pkg";\nnew C().run();\n` }),
        "fixture-pkg",
      ),
    });
    expect(unused.breakability).toBe("Low");
  });

  it("reports dynamic use of the module object as Medium when the package has breaking changes", () => {
    const cwd = project({ "a.js": `const lib = require("fixture-pkg");\nexpose(lib);\n` });
    const impact = analyzeUpgrade({
      before: typed("1.0.0", `export declare function gone(): void;`),
      after: typed("2.0.0", `export declare function other(a: string, b: string): void;`),
      usage: buildUsageIndex(cwd, "fixture-pkg"),
    });
    expect(impact.findings.map((finding) => finding.category)).toEqual(["opaque-usage"]);
    expect(impact.breakability).toBe("Medium");
  });

  it("flags require() of a package that became ESM-only, and removed deep imports", () => {
    const cwd = project({
      "a.js": `const x = require("fixture-pkg");\nconst y = require("fixture-pkg/lib/old");\n`,
    });
    const before = pkg(
      "1.0.0",
      { "index.js": "module.exports = 1;", "lib/old.js": "module.exports = 1;" },
      { main: "index.js" },
    );
    const after = pkg(
      "2.0.0",
      { "index.js": "export default 1;" },
      { type: "module", exports: { ".": "./index.js" } },
    );
    const impact = analyzeUpgrade({ before, after, usage: buildUsageIndex(cwd, "fixture-pkg") });
    const categories = impact.findings
      .map((finding) => `${finding.category}:${finding.severity}`)
      .toSorted();
    expect(categories).toEqual(["exports-map:breaking", "module-format:possibly-breaking"]);
    expect(impact.breakability).toBe("High");
    expect(
      impact.findings.find((finding) => finding.category === "exports-map")?.affectedCallSites[0]
        ?.line,
    ).toBe(2);
  });

  it("uses the project's engines and peer ranges to prove a conflict", () => {
    const cwd = project({ "a.js": `require("fixture-pkg");\n` });
    const impact = analyzeUpgrade({
      before: pkg("1.0.0", { "index.js": "" }, { engines: { node: ">=14" } }),
      after: pkg(
        "2.0.0",
        { "index.js": "" },
        { engines: { node: ">=20" }, peerDependencies: { react: "^19.0.0" } },
      ),
      usage: buildUsageIndex(cwd, "fixture-pkg"),
      projectManifest: { engines: { node: ">=16" }, dependencies: { react: "^18.0.0" } },
    });
    expect(
      impact.findings.map((finding) => `${finding.category}:${finding.evidence}`).toSorted(),
    ).toEqual(["engines:project-conflict", "peer-dependency:project-conflict"]);
    expect(impact.breakability).toBe("High");
  });

  it("says so when the project does not import the package directly", () => {
    const impact = analyzeUpgrade({
      before: typed("1.0.0", `export declare function a(): void;`),
      after: typed("2.0.0", `export declare function b(): void;`),
      usage: buildUsageIndex(project({ "a.js": `console.log(1);` }), "fixture-pkg"),
    });
    expect(impact.breakability).toBe("Low");
    expect(impact.limitations.join(" ")).toMatch(/No source file in the project imports/);
  });

  it("is deterministic and explains its scoring", () => {
    const cwd = project({ "a.ts": `import { gone } from "fixture-pkg";\ngone();\n` });
    const run = () =>
      analyzeUpgrade({
        before: typed("1.0.0", `export declare function gone(): void;`),
        after: typed("2.0.0", `export declare function other(): void;`),
        usage: buildUsageIndex(cwd, "fixture-pkg"),
      });
    expect(run()).toEqual(run());
    expect(run().scoring.rule).toMatch(/High if any finding/);
  });
});

describe("orchestration with injected registry", () => {
  const versions: Record<string, PackageSource> = {
    "1.0.0": pkg(
      "1.0.0",
      {
        "index.js": `exports.render = function (s) { return s.replace(/(a+)+/, ""); };\nexports.keep = function () { return 1; };`,
      },
      { main: "index.js" },
    ),
    "1.0.1": pkg(
      "1.0.1",
      {
        "index.js": `exports.render = function (s) { return s.replace(/a+/, ""); };\nexports.keep = function () { return 1; };`,
      },
      { main: "index.js" },
    ),
  };
  const deps: ImpactDeps = {
    async loadPackage(_name, version) {
      const found = versions[version];
      if (!found) throw new Error(`${version} was not found on the registry`);
      return found;
    },
  };

  it("assessUpgrade needs exact, distinct versions", async () => {
    await expect(assessUpgrade("fixture-pkg", "1.0", "1.0.1", {}, deps)).rejects.toThrow(
      /exact semver/,
    );
    await expect(assessUpgrade("fixture-pkg", "1.0.0", "1.0.0", {}, deps)).rejects.toThrow(/same/);
    await expect(assessUpgrade("fixture-pkg", "1.0.0", "9.9.9", {}, deps)).rejects.toThrow(
      /not found/,
    );
  });

  it("assessUpgrade reports a patch upgrade the project survives", async () => {
    const cwd = project({ "a.js": `const { render } = require("fixture-pkg");\nrender("x");\n` });
    const result = await assessUpgrade("fixture-pkg", "1.0.0", "1.0.1", { cwd }, deps);
    expect(result).toMatchObject({
      breakability: "Low",
      upgradeLevel: "patch",
      fromVersion: "1.0.0",
      toVersion: "1.0.1",
    });
  });

  it("findVulnerableSymbols runs the existing reachability check for each candidate", async () => {
    const cwd = project({ "a.js": `const { render } = require("fixture-pkg");\nrender("x");\n` });
    const direct = project({ "b.js": `import { render } from "fixture-pkg";\nrender("x");\n` });
    const result = await findVulnerableSymbolsInUpgrade(
      "fixture-pkg",
      "1.0.0",
      "1.0.1",
      { cwd: direct, cwes: ["CWE-1333"] },
      deps,
    );
    expect(result.candidates.map((candidate) => candidate.symbol)).toEqual(["render"]);
    expect(result.candidates[0]?.reasons.join(" ")).toMatch(/CWE 1333|regular expression/);
    expect(result.candidates[0]?.reachability).toMatchObject({
      status: "reachable",
      invokedIn: [expect.stringMatching(/b\.js$/)],
    });
    expect(result.reachableCount).toBe(1);

    const unused = project({ "c.js": `import { keep } from "fixture-pkg";\nkeep();\n` });
    const notReached = await findVulnerableSymbolsInUpgrade(
      "fixture-pkg",
      "1.0.0",
      "1.0.1",
      { cwd: unused },
      deps,
    );
    expect(notReached.candidates[0]?.reachability?.status).toBe("not-reachable");
    expect(notReached.reachableCount).toBe(0);
    void cwd;

    const skipped = await findVulnerableSymbolsInUpgrade(
      "fixture-pkg",
      "1.0.0",
      "1.0.1",
      { cwd: unused, checkReachability: false },
      deps,
    );
    expect(skipped.candidates[0]?.reachability).toBeUndefined();
  });
});
