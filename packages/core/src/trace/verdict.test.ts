import { describe, expect, it } from "vitest";

import { TRACE_SCHEMA, type TracePackage, type TraceReport } from "./types.js";
import { assessRuntimeReachability } from "./verdict.js";

function report(packages: Partial<TracePackage>[], over: Partial<TraceReport> = {}): TraceReport {
  return {
    schema: TRACE_SCHEMA,
    createdAt: "2026-01-01T00:00:00.000Z",
    processes: 1,
    partialEsm: false,
    callTracing: { enabled: false, packages: [] },
    skippedLines: 0,
    command: { argv: ["node", "--test"], exitCode: 0 },
    packages: packages.map((pkg) => ({
      name: "lodash",
      version: "4.17.20",
      entries: ["lodash.js"],
      dependents: ["(app)"],
      formats: ["cjs"],
      ...pkg,
    })),
    ...over,
  };
}

const traced = { callTracing: { enabled: true, packages: ["lodash"] } };

describe("assessRuntimeReachability", () => {
  it("is not-loaded-in-tests for a package that never loaded, and says that is not proof", () => {
    const result = assessRuntimeReachability(report([{ name: "other" }]), "lodash", "template");
    expect(result.verdict).toBe("not-loaded-in-tests");
    expect(result.caveat).toMatch(/not proof/);
    expect(result.caveat).toMatch(/did not exercise/);
  });

  it("explains a failed run next to a not-loaded verdict", () => {
    const result = assessRuntimeReachability(
      report([], { command: { argv: ["npm", "test"], exitCode: 1 } }),
      "lodash",
    );
    expect(result.verdict).toBe("not-loaded-in-tests");
    expect(result.reason).toMatch(/exited 1/);
    expect(result.exitCode).toBe(1);
  });

  it("makes no claim when no process reported", () => {
    const result = assessRuntimeReachability(report([], { processes: 0 }), "lodash");
    expect(result.verdict).toBe("no-trace-data");
  });

  it("is loaded-in-tests when calls were not counted, and says how to count them", () => {
    const result = assessRuntimeReachability(report([{}]), "lodash", "template");
    expect(result.verdict).toBe("loaded-in-tests");
    expect(result.versions).toEqual(["4.17.20"]);
    expect(result.loadedBy).toEqual(["(app)"]);
    expect(result.reason).toMatch(/--packages lodash --calls/);
  });

  it("is loaded-in-tests for a package-level question when it loaded", () => {
    expect(assessRuntimeReachability(report([{}]), "lodash").verdict).toBe("loaded-in-tests");
  });

  it("is called-in-tests when the symbol has calls", () => {
    const result = assessRuntimeReachability(
      report([{ calls: { template: 3, merge: 0 } }], traced),
      "lodash",
      "template",
    );
    expect(result.verdict).toBe("called-in-tests");
    expect(result.calls).toEqual({ symbol: "template", count: 3 });
  });

  it("sums calls across versions of the package", () => {
    const result = assessRuntimeReachability(
      report([{ calls: { template: 1 } }, { version: "3.0.0", calls: { template: 2 } }], traced),
      "lodash",
      "template",
    );
    expect(result.calls?.count).toBe(3);
    expect(result.versions).toEqual(["3.0.0", "4.17.20"]);
  });

  it("counts a function-as-module entry (lodash/template) for the symbol named by the file", () => {
    const result = assessRuntimeReachability(
      report([{ entries: ["template.js"], calls: { default: 2 } }], traced),
      "lodash",
      "template",
    );
    expect(result.verdict).toBe("called-in-tests");
    expect(result.calls?.count).toBe(2);
    // ...but not for an unrelated symbol.
    expect(
      assessRuntimeReachability(
        report([{ entries: ["template.js"], calls: { default: 2 } }], traced),
        "lodash",
        "merge",
      ).verdict,
    ).toBe("loaded-not-called-in-tests");
  });

  it("is loaded-not-called-in-tests when counting ran and the symbol has no calls", () => {
    const result = assessRuntimeReachability(
      report([{ calls: { merge: 4 } }], traced),
      "lodash",
      "template",
    );
    expect(result.verdict).toBe("loaded-not-called-in-tests");
    expect(result.calls).toEqual({ symbol: "template", count: 0 });
    expect(result.caveat).toMatch(/not proof/);
  });

  it("does not claim 'not called' for a symbol that could not be counted", () => {
    const result = assessRuntimeReachability(
      report([{ calls: {}, unwrapped: { Parser: "class-or-constructor-function" } }], traced),
      "lodash",
      "Parser",
    );
    expect(result.verdict).toBe("loaded-in-tests");
    expect(result.reason).toMatch(/could not be counted/);
  });

  it("does not claim counting for a package that was not on the watch list", () => {
    const result = assessRuntimeReachability(
      report([{}], { callTracing: { enabled: true, packages: ["other"] } }),
      "lodash",
      "template",
    );
    expect(result.verdict).toBe("loaded-in-tests");
  });

  it("answers a package-level question from any counted call", () => {
    expect(
      assessRuntimeReachability(report([{ calls: { a: 0, b: 2 } }], traced), "lodash").verdict,
    ).toBe("called-in-tests");
    expect(assessRuntimeReachability(report([{ calls: { a: 0 } }], traced), "lodash").verdict).toBe(
      "loaded-not-called-in-tests",
    );
  });

  it("notes that some processes could not see ES module imports", () => {
    const result = assessRuntimeReachability(report([], { partialEsm: true }), "lodash");
    expect(result.reason).toMatch(/could not observe ES module imports/);
  });
});
