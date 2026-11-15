import { describe, expect, it, vi } from "vitest";

import type { ApiDeps } from "./api-deps.js";
import { callMcpOperation } from "./index.js";

const HOSTILE = ["a/../../-/npm/v1/tokens", "../x", "@scope/../../-/whoami", "a%2Fb", "a?x=1"];

const deps = (): ApiDeps =>
  ({
    evaluatePackageFn: vi.fn(async () => ({})),
    checkReachabilityFn: vi.fn(async () => ({})),
    assessUpgradeFn: vi.fn(async () => ({})),
    findVulnerableSymbolsFn: vi.fn(async () => ({})),
    freshnessReportFn: vi.fn(async () => ({})),
    generateProofOfFixFn: vi.fn(async () => ({})),
    readMaintainerVexFn: vi.fn(async () => ({})),
  }) as unknown as ApiDeps;

describe("package names are validated before they reach the registry or node_modules", () => {
  it.each(HOSTILE)("refuses %s as a package name", async (name) => {
    const api = deps();
    const calls: Array<[string, Record<string, unknown>]> = [
      ["evaluatePackage", { packageName: name }],
      ["checkReachability", { packageName: name }],
      ["assessUpgrade", { packageName: name, from: "1.0.0", to: "1.0.1" }],
      ["findVulnerableSymbols", { packageName: name, from: "1.0.0", to: "1.0.1" }],
      ["freshnessReport", { packages: [name] }],
      ["generateProofOfFix", { cveId: "CVE-2021-23337", package: name }],
      ["readMaintainerVex", { packageName: name }],
    ];
    const accepted: string[] = [];
    for (const [operation, args] of calls) {
      const result = await callMcpOperation(operation, args, api);
      if (!result.isError) accepted.push(operation);
    }
    expect(accepted).toEqual([]);
    for (const fn of Object.values(api)) {
      expect(fn).not.toHaveBeenCalled();
    }
  });

  it("accepts ordinary, scoped and legacy upper-case names", async () => {
    const api = deps();
    const refused: string[] = [];
    for (const name of ["lodash", "@scope/util", "JSONStream", "left-pad", "a.b_c~d"]) {
      const result = await callMcpOperation("evaluatePackage", { packageName: name }, api);
      if (result.isError) refused.push(name);
    }
    expect(refused).toEqual([]);
  });
});
