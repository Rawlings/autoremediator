import { describe, expect, it } from "vitest";

import { roleFor } from "./adapters/http.js";
import { OPERATIONS } from "./index.js";

/**
 * Operations that run the project's or a dependency's code (installs, tests, a reproduction script)
 * or that edit files which then get run. That code sees every secret the server holds, so a caller
 * with a lower role could use it to read an admin token or the JWT secret.
 */
const RUNS_PROJECT_CODE = [
  "verifyRun",
  "startAttempt",
  "proposePatch",
  "verifyAttempt",
  "applyRecipe",
];

describe("roles", () => {
  it.each(RUNS_PROJECT_CODE)("%s needs the admin role", (name) => {
    const operation = OPERATIONS.find((candidate) => candidate.name === name);
    expect(operation).toBeDefined();
    expect(operation?.runsProjectCode).toBe(true);
    expect(roleFor(operation!)).toBe("admin");
  });

  it("gives the operator role only to operations that run nothing of the project's", () => {
    const operators = OPERATIONS.filter((operation) => roleFor(operation) === "operator").map(
      (operation) => operation.name,
    );
    // Adding to this list is a decision: say why the operation cannot run project or dependency code.
    expect(operators.toSorted()).toEqual(
      [
        "abandonAttempt",
        "compilePolicy",
        "generateProofOfFix",
        "incident",
        "installHooks",
        "init",
        "planFreshnessStep",
        "planRemediation",
        "premortem",
        "radar",
        "bisectLockfile",
        "maintain",
        "addMemory",
        "acceptMemory",
      ].toSorted(),
    );
  });

  it("never lets a read-only operation run project code", () => {
    const below = OPERATIONS.filter(
      (operation) => operation.runsProjectCode && roleFor(operation) !== "admin",
    ).map((operation) => operation.name);
    expect(below).toEqual([]);
  });
});
