import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { ApiDeps } from "./api-deps.js";
import {
  callMcpOperation,
  mapRequestToInput,
  matchHttpRoute,
  OPERATIONS,
  roleFor,
  toMcpTools,
  toOpenApiPaths,
} from "./index.js";

const byName = (name: string) => OPERATIONS.find((operation) => operation.name === name)!;

let dir: string;
let deps: ApiDeps;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "freshness-catalog-"));
  deps = {
    freshnessReportFn: vi.fn(async () => ({ schemaVersion: "1.0" })),
    planFreshnessStepFn: vi.fn(async () => ({ held: [] })),
  } as unknown as ApiDeps;
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("freshness on every surface", () => {
  it("is an MCP tool, an HTTP route and an OpenAPI path generated from the catalog", () => {
    for (const name of ["freshnessReport", "planFreshnessStep"]) {
      expect(toMcpTools().map((tool) => tool.name)).toContain(name);
      expect(byName(name).http).toBeDefined();
    }
    expect(matchHttpRoute("POST", "/freshness")?.operation.name).toBe("freshnessReport");
    expect(matchHttpRoute("POST", "/freshness/plan")?.operation.name).toBe("planFreshnessStep");
    expect(Object.keys(toOpenApiPaths())).toEqual(
      expect.arrayContaining(["/freshness", "/freshness/plan"]),
    );
  });

  it("reads only in the report, and records but never applies in the plan", () => {
    expect(byName("freshnessReport").annotations).toMatchObject({
      readOnlyHint: true,
      destructiveHint: false,
    });
    // The plan writes a run record (like planRemediation); applying it is applyPlan's job.
    expect(byName("planFreshnessStep").annotations).toMatchObject({
      readOnlyHint: false,
      destructiveHint: false,
    });
    expect(roleFor(byName("freshnessReport"))).not.toBe(roleFor(byName("planFreshnessStep")));
  });

  it("does not offer applying over MCP or HTTP: hosts apply the recorded plan with applyPlan", () => {
    expect(OPERATIONS.map((operation) => operation.name)).not.toContain("applyFreshness");
    expect(matchHttpRoute("POST", "/freshness/apply")).toBeUndefined();
  });

  it("nests every field under options over HTTP, as for the other operations", () => {
    expect(
      mapRequestToInput(byName("freshnessReport"), { options: { assess: true, packages: ["a"] } }),
    ).toEqual({
      ok: true,
      input: { assess: true, packages: ["a"] },
    });
    expect(mapRequestToInput(byName("freshnessReport"), { assess: true })).toMatchObject({
      ok: false,
    });
  });

  it("rejects unknown fields, a package list that is not names and a maxSteps-style field the operations do not take", async () => {
    expect((await callMcpOperation("freshnessReport", { surprise: true }, deps)).isError).toBe(
      true,
    );
    expect((await callMcpOperation("freshnessReport", { packages: [5] }, deps)).isError).toBe(true);
    expect((await callMcpOperation("planFreshnessStep", { maxSteps: 3 }, deps)).isError).toBe(true);
    expect(deps.freshnessReportFn).not.toHaveBeenCalled();
    expect(deps.planFreshnessStepFn).not.toHaveBeenCalled();
  });

  it("confines cwd and policy to the allowed roots and passes the surface as provenance", async () => {
    const env = { AUTOREMEDIATOR_ALLOWED_ROOTS: dir };
    for (const args of [{ cwd: "/etc" }, { cwd: dir, policy: "/etc/policy.yml" }]) {
      const refused = await callMcpOperation("freshnessReport", args, deps, { env });
      expect([refused.isError, refused.content[0]?.text]).toEqual([
        true,
        expect.stringContaining("Path not allowed"),
      ]);
    }
    expect(deps.freshnessReportFn).not.toHaveBeenCalled();

    expect(
      (await callMcpOperation("freshnessReport", { cwd: dir, assess: true }, deps, { env }))
        .isError,
    ).toBeUndefined();
    expect(deps.freshnessReportFn).toHaveBeenCalledWith({ cwd: dir, assess: true });

    await callMcpOperation(
      "planFreshnessStep",
      { cwd: dir, runTests: true, allowHigh: true },
      deps,
      { env },
    );
    expect(deps.planFreshnessStepFn).toHaveBeenCalledWith({
      cwd: dir,
      runTests: true,
      allowHigh: true,
      source: "mcp",
    });
  });
});
