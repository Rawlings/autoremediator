import { describe, expect, it } from "vitest";
import { isPackageAllowed, type AutoremediatorPolicy } from "./policy.js";

describe("Milestone 4 Challenge: denyPackages Policy Matching Stress Tests", () => {
  it("stress-tests exact match, wildcards, scoped patterns, and prefix patterns", () => {
    const policy = {
      denyPackages: ["exact-blocked-pkg", "@evil-scope/*", "prefix-blocked-*", "standalone-*"],
    } as unknown as AutoremediatorPolicy;

    // 1. Exact match
    expect(isPackageAllowed(policy, "exact-blocked-pkg")).toBe(false);
    expect(isPackageAllowed(policy, "exact-blocked-pkg-2")).toBe(true);
    expect(isPackageAllowed(policy, "not-exact-blocked-pkg")).toBe(true);

    // 2. Scoped wildcard (@evil-scope/*)
    expect(isPackageAllowed(policy, "@evil-scope/core")).toBe(false);
    expect(isPackageAllowed(policy, "@evil-scope/nested-pkg")).toBe(false);
    expect(isPackageAllowed(policy, "@evil-scope-other/core")).toBe(true);
    expect(isPackageAllowed(policy, "@evil-scope")).toBe(true); // not inside scope
    expect(isPackageAllowed(policy, "evil-scope/core")).toBe(true);

    // 3. Prefix wildcard (prefix-blocked-*)
    expect(isPackageAllowed(policy, "prefix-blocked-tool")).toBe(false);
    expect(isPackageAllowed(policy, "prefix-blocked-any-name")).toBe(false);
    expect(isPackageAllowed(policy, "other-prefix-blocked-tool")).toBe(true);
    expect(isPackageAllowed(policy, "prefix-blocked")).toBe(true); // no dash prefix
    expect(isPackageAllowed(policy, "standalone-lib")).toBe(false);

    // 4. Allowed packages
    expect(isPackageAllowed(policy, "safe-package")).toBe(true);
    expect(isPackageAllowed(policy, "@good-scope/core")).toBe(true);
  });

  it("stress-tests allowPackages and denyPackages interaction and precedence", () => {
    const allowOnlyPolicy = {
      allowPackages: ["@approved/*", "lodash", "react"],
      denyPackages: ["@approved/deprecated-subpkg", "lodash"],
    } as unknown as AutoremediatorPolicy;

    // denyPackages takes absolute precedence over allowPackages
    expect(isPackageAllowed(allowOnlyPolicy, "lodash")).toBe(false);
    expect(isPackageAllowed(allowOnlyPolicy, "@approved/deprecated-subpkg")).toBe(false);

    // Allowed packages pass
    expect(isPackageAllowed(allowOnlyPolicy, "react")).toBe(true);
    expect(isPackageAllowed(allowOnlyPolicy, "@approved/valid-pkg")).toBe(true);

    // Packages not in allowPackages are blocked when allowPackages is populated
    expect(isPackageAllowed(allowOnlyPolicy, "express")).toBe(false);
    expect(isPackageAllowed(allowOnlyPolicy, "@other/pkg")).toBe(false);
  });

  it("handles edge cases: undefined, empty lists, nullish values defensively without crashing", () => {
    // Empty policy
    expect(isPackageAllowed({} as unknown as AutoremediatorPolicy, "any-package")).toBe(true);

    // Undefined lists
    expect(
      isPackageAllowed(
        { denyPackages: undefined, allowPackages: undefined } as unknown as AutoremediatorPolicy,
        "pkg",
      ),
    ).toBe(true);

    // Empty lists
    expect(
      isPackageAllowed(
        { denyPackages: [], allowPackages: [] } as unknown as AutoremediatorPolicy,
        "pkg",
      ),
    ).toBe(true);

    // Universal wildcard "*" in denyPackages blocks everything
    const blockAllPolicy = {
      denyPackages: ["*"],
    } as unknown as AutoremediatorPolicy;
    expect(isPackageAllowed(blockAllPolicy, "lodash")).toBe(false);
    expect(isPackageAllowed(blockAllPolicy, "@scope/foo")).toBe(false);

    // Universal wildcard "*" in allowPackages allows everything
    const allowAllPolicy = {
      allowPackages: ["*"],
    } as unknown as AutoremediatorPolicy;
    expect(isPackageAllowed(allowAllPolicy, "lodash")).toBe(true);
    expect(isPackageAllowed(allowAllPolicy, "@scope/foo")).toBe(true);

    // Non-string elements in list (defensive handling)
    const malformedListPolicy = {
      denyPackages: [null, undefined, 123, "blocked"],
    } as unknown as AutoremediatorPolicy;
    expect(() => isPackageAllowed(malformedListPolicy, "blocked")).not.toThrow();
    expect(isPackageAllowed(malformedListPolicy, "blocked")).toBe(false);
    expect(isPackageAllowed(malformedListPolicy, "allowed")).toBe(true);
  });
});
