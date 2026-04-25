import { describe, expect, it } from "vitest";
import { buildSbom } from "./sbom.js";
import type { InventoryPackage, PatchResult } from "../../platform/types.js";

const pkg = (name: string, version: string, type: "direct" | "indirect"): InventoryPackage => ({
  name, version, type,
});

const result = (packageName: string, applied: boolean, strategy: PatchResult["strategy"] = "version-bump"): PatchResult => ({
  packageName,
  vulnerableVersion: "1.0.0",
  strategy,
  applied,
  dryRun: false,
  message: "",
});

describe("buildSbom", () => {
  it("marks patched packages with status patched", () => {
    const packages = [pkg("lodash", "4.17.20", "direct"), pkg("minimist", "1.2.5", "indirect")];
    const vulnerable = new Set(["lodash"]);
    const results: PatchResult[] = [result("lodash", true)];

    const sbom = buildSbom(packages, vulnerable, results);
    expect(sbom).toHaveLength(2);
    const lodash = sbom.find((e) => e.name === "lodash");
    expect(lodash?.status).toBe("patched");
    expect(lodash?.scope).toBe("direct");
    const minimist = sbom.find((e) => e.name === "minimist");
    expect(minimist?.status).toBeUndefined();
    expect(minimist?.scope).toBe("indirect");
  });

  it("marks unpatched packages (not applied, non-none strategy)", () => {
    const packages = [pkg("lodash", "4.17.20", "direct")];
    const vulnerable = new Set(["lodash"]);
    const results: PatchResult[] = [result("lodash", false)];

    const sbom = buildSbom(packages, vulnerable, results);
    expect(sbom[0]?.status).toBe("unpatched");
  });

  it("marks skipped packages (strategy=none, applied=false)", () => {
    const packages = [pkg("lodash", "4.17.20", "direct")];
    const vulnerable = new Set(["lodash"]);
    const results: PatchResult[] = [result("lodash", false, "none")];

    const sbom = buildSbom(packages, vulnerable, results);
    expect(sbom[0]?.status).toBe("skipped");
  });

  it("marks suppressed packages (suppressedBy present)", () => {
    const packages = [pkg("lodash", "4.17.20", "direct")];
    const vulnerable = new Set(["lodash"]);
    const r: PatchResult = { ...result("lodash", false, "none"), suppressedBy: { justification: "not_affected" } };

    const sbom = buildSbom(packages, vulnerable, [r]);
    expect(sbom[0]?.status).toBe("suppressed");
  });

  it("returns empty array for empty inventory", () => {
    const sbom = buildSbom([], new Set(), []);
    expect(sbom).toHaveLength(0);
  });

  it("preserves correct version and scope for all entries", () => {
    const packages = [pkg("express", "4.18.2", "direct"), pkg("qs", "6.11.0", "indirect")];
    const sbom = buildSbom(packages, new Set(), []);
    expect(sbom[0]).toMatchObject({ name: "express", version: "4.18.2", scope: "direct" });
    expect(sbom[1]).toMatchObject({ name: "qs", version: "6.11.0", scope: "indirect" });
  });
});
