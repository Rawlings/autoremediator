import { describe, expect, it } from "vitest";

import { isValidPackageName } from "./package-name.js";

describe("isValidPackageName", () => {
  it("accepts ordinary, scoped and legacy upper-case names", () => {
    for (const name of ["lodash", "@types/node", "JSONStream", "left-pad", "a.b_c-d", "~tilde"]) {
      expect(isValidPackageName(name)).toBe(true);
    }
  });

  it("refuses a name a package manager would read as an option", () => {
    for (const name of ["--registry", "-g", "--ignore-scripts", "@-scope/pkg", "-x"]) {
      expect(isValidPackageName(name)).toBe(false);
    }
  });

  it("refuses anything that could change a path or a URL", () => {
    for (const name of ["../x", "a/b", "a b", "a%2Fb", "a?b", ".hidden", "_private", ""]) {
      expect(isValidPackageName(name)).toBe(false);
    }
  });
});
