import { describe, expect, it, vi } from "vitest";

import {
  callMcpOperation,
  httpOperations,
  mapRequestToInput,
  matchHttpRoute,
  OPERATIONS,
  roleFor,
  routeKey,
  toMcpTools,
  toOpenApiPaths,
} from "./index.js";
import type { ApiDeps } from "./api-deps.js";

function fakeDeps(overrides: Partial<ApiDeps> = {}): ApiDeps {
  return {
    remediateFn: vi.fn(async () => ({ summary: "ok" })),
    planRemediationFn: vi.fn(async () => ({ summary: "planned" })),
    ...overrides,
  } as unknown as ApiDeps;
}

describe("operation catalog", () => {
  it("has unique, described operations with annotations", () => {
    const names = OPERATIONS.map((operation) => operation.name);
    expect(new Set(names).size).toBe(names.length);
    for (const operation of OPERATIONS) {
      expect(operation.description.length).toBeGreaterThan(20);
      expect(operation.title).toBeTruthy();
      expect(operation.annotations).toBeDefined();
    }
  });

  it("annotates read-only and mutating operations accurately", () => {
    const byName = new Map(OPERATIONS.map((operation) => [operation.name, operation.annotations]));
    for (const name of ["listPatchArtifacts", "checkReachability", "toVex", "pollJob", "health"]) {
      expect(byName.get(name)).toMatchObject({ readOnlyHint: true, destructiveHint: false });
    }
    for (const name of ["remediate", "remediateFromScan", "updateOutdated", "submitRemediateJob"]) {
      expect(byName.get(name)).toMatchObject({ readOnlyHint: false, destructiveHint: true });
    }
    // A preview only writes its own evidence record: not read-only, but not destructive either.
    expect(byName.get("planRemediation")).toMatchObject({
      readOnlyHint: false,
      destructiveHint: false,
    });
  });
});

describe("MCP tools generated from the catalog", () => {
  const tools = toMcpTools();
  const properties = (name: string) =>
    tools.find((tool) => tool.name === name)!.inputSchema.properties;

  it("exposes every MCP operation with annotations and a required list", () => {
    expect(tools.map((tool) => tool.name)).toEqual(
      OPERATIONS.filter((operation) => operation.mcp).map((operation) => operation.name),
    );
    expect(tools.find((tool) => tool.name === "remediate")?.inputSchema.required).toEqual([
      "cveId",
    ]);
    expect(tools.find((tool) => tool.name === "remediate")?.annotations.destructiveHint).toBe(true);
  });

  it("advertises the options the SDK really honours, and none it ignores", () => {
    const remediate = properties("remediate");
    for (const real of [
      "exploitSignalOverride",
      "typecheck",
      "supplyChainPolicy",
      "reproductionTest",
      "dispositionPolicy",
    ]) {
      expect(remediate).toHaveProperty(real);
    }
    // These were advertised over MCP/HTTP but only the CLI ever mapped them.
    expect(remediate).not.toHaveProperty("kevMandatory");
    expect(remediate).not.toHaveProperty("epssThreshold");
  });

  it("keeps plan options free of dryRun/preview and updateOutdated free of simulationMode", () => {
    expect(properties("planRemediation")).not.toHaveProperty("dryRun");
    expect(properties("planRemediation")).not.toHaveProperty("preview");
    expect(properties("updateOutdated")).not.toHaveProperty("simulationMode");
    expect(properties("updateOutdated")).toHaveProperty("includeTransitive");
  });

  it("lets agents drive the options that used to be missing from portfolio targets", () => {
    const targets = properties("remediatePortfolio")["targets"] as {
      items: { properties: Record<string, unknown> };
    };
    expect(Object.keys(targets.items.properties)).toEqual(
      expect.arrayContaining(["cwd", "cveId", "inputPath", "format", "audit", "riskHint"]),
    );
  });
});

describe("calling operations over MCP", () => {
  it("passes validated input to the SDK with mcp provenance", async () => {
    const deps = fakeDeps();
    const result = await callMcpOperation("remediate", { cveId: "CVE-2021-23337", dryRun: true }, deps);

    expect(result.isError).toBeUndefined();
    expect(deps.remediateFn).toHaveBeenCalledWith("CVE-2021-23337", {
      dryRun: true,
      source: "mcp",
    });
  });

  it("keeps a caller-supplied provenance source", async () => {
    const deps = fakeDeps();
    await callMcpOperation("planRemediation", { cveId: "CVE-2021-23337", source: "sdk" }, deps);
    expect(deps.planRemediationFn).toHaveBeenCalledWith("CVE-2021-23337", { source: "sdk" });
  });

  it("rejects unknown options instead of silently ignoring them", async () => {
    const deps = fakeDeps();
    const result = await callMcpOperation(
      "remediate",
      { cveId: "CVE-2021-23337", kevMandatory: true },
      deps,
    );

    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toContain("kevMandatory");
    expect(deps.remediateFn).not.toHaveBeenCalled();
  });

  it("rejects wrong types and unknown nested fields with the field path", async () => {
    const deps = fakeDeps();
    const badType = await callMcpOperation(
      "remediate",
      { cveId: "CVE-2021-23337", dryRun: "yes" },
      deps,
    );
    expect(badType.isError).toBe(true);
    expect(badType.content[0]?.text).toContain("dryRun");

    const badNested = await callMcpOperation(
      "remediate",
      { cveId: "CVE-2021-23337", constraints: { installMode: "turbo" } },
      deps,
    );
    expect(badNested.isError).toBe(true);
    expect(badNested.content[0]?.text).toContain("constraints.installMode");
  });

  it("refuses caller-supplied change-request credentials rather than passing them through", async () => {
    const deps = fakeDeps();
    for (const secret of [{ tokenEnvVar: "GITHUB_TOKEN" }, { token: "ghp_x" }, { githubApiUrl: "https://evil.test" }]) {
      const result = await callMcpOperation(
        "remediate",
        { cveId: "CVE-2021-23337", changeRequest: { provider: "github", ...secret } },
        deps,
      );
      expect(result.isError).toBe(true);
    }
    expect(deps.remediateFn).not.toHaveBeenCalled();
  });

  it("reports missing required arguments with a readable message", async () => {
    const missing = await callMcpOperation("remediate", {}, fakeDeps());
    expect(missing.isError).toBe(true);
    expect(missing.content[0]?.text).toContain("cveId is required");
  });

  it("reports unknown tools and handler failures as error results", async () => {
    expect((await callMcpOperation("nope", {}, fakeDeps())).content[0]?.text).toContain(
      "Unknown tool: nope",
    );

    const failing = fakeDeps({
      remediateFn: vi.fn(async () => {
        throw new Error("boom");
      }) as unknown as ApiDeps["remediateFn"],
    });
    const result = await callMcpOperation("remediate", { cveId: "CVE-2021-23337" }, failing);
    expect(result).toMatchObject({ isError: true, content: [{ text: "boom" }] });
  });
});

describe("HTTP adapter", () => {
  const op = (name: string) => OPERATIONS.find((operation) => operation.name === name)!;

  it("gives every HTTP operation a unique route", () => {
    const keys = httpOperations.map((operation) => `${operation.http!.method} ${operation.http!.path}`);
    expect(new Set(keys).size).toBe(keys.length);
    // The unauthenticated probe and spec endpoints are not operations.
    expect(keys).not.toContain("GET /health");
  });

  it("matches static and parametric routes", () => {
    expect(matchHttpRoute("POST", "/remediate")?.operation.name).toBe("remediate");
    expect(matchHttpRoute("POST", "/patches/reconcile")?.operation.name).toBe(
      "reconcilePatchArtifacts",
    );
    expect(matchHttpRoute("GET", "/jobs/abc%20d")).toMatchObject({
      operation: { name: "pollJob" },
      params: { jobId: "abc d" },
    });
    expect(matchHttpRoute("GET", "/jobs/")).toBeUndefined();
    expect(matchHttpRoute("GET", "/jobs/a/b")).toBeUndefined();
    expect(matchHttpRoute("GET", "/remediate")).toBeUndefined();
    expect(matchHttpRoute("POST", "/nope")).toBeUndefined();
  });

  it("lifts positional fields and flattens options", () => {
    expect(
      mapRequestToInput(op("remediate"), { cveId: "CVE-1", options: { dryRun: true } }),
    ).toEqual({ ok: true, input: { cveId: "CVE-1", dryRun: true } });
    expect(mapRequestToInput(op("listPatchArtifacts"), {})).toEqual({ ok: true, input: {} });
    expect(mapRequestToInput(op("toVex"), { report: { a: 1 }, options: { toolVersion: "1" } })).toEqual({
      ok: true,
      input: { toolVersion: "1", report: { a: 1 } },
    });
    expect(mapRequestToInput(op("pollJob"), undefined, { jobId: "j1" })).toEqual({
      ok: true,
      input: { jobId: "j1" },
    });
  });

  it("rejects stray top-level fields, bad options and fields in both places", () => {
    expect(mapRequestToInput(op("remediate"), { cveId: "CVE-1", dryRun: true })).toMatchObject({
      ok: false,
      error: expect.stringContaining('"dryRun"'),
    });
    expect(mapRequestToInput(op("remediate"), { cveId: "x", options: "no" })).toMatchObject({
      ok: false,
    });
    expect(
      mapRequestToInput(op("remediate"), { cveId: "x", options: { cveId: "y" } }),
    ).toMatchObject({ ok: false, error: expect.stringContaining('"cveId"') });
    expect(mapRequestToInput(op("remediate"), [])).toMatchObject({ ok: false });
  });

  it("derives roles from annotations", () => {
    expect(roleFor(op("toVex"))).toBe("reader");
    expect(roleFor(op("checkReachability"))).toBe("reader");
    expect(roleFor(op("planRemediation"))).toBe("operator");
    expect(roleFor(op("remediate"))).toBe("admin");
    expect(roleFor(op("submitScanJob"))).toBe("admin");
    expect(roleFor(op("reconcilePatchArtifacts"))).toBe("admin");
    expect(routeKey(op("pollJob"))).toBe("GET /jobs");
  });
});

describe("generated OpenAPI paths", () => {
  const paths = toOpenApiPaths() as Record<string, any>;

  it("describes every HTTP operation plus the probe and spec endpoints", () => {
    for (const operation of httpOperations) {
      const path = operation.http!.path.replaceAll(/:([^/]+)/g, "{$1}");
      expect(paths[path]?.[operation.http!.method.toLowerCase()]?.operationId).toBe(operation.name);
    }
    expect(paths["/health"]).toBeDefined();
    expect(paths["/openapi.json"]).toBeDefined();
  });

  it("nests option fields under options and keeps positional fields at the top", () => {
    const body = paths["/remediate"].post.requestBody.content["application/json"].schema;
    expect(body.required).toEqual(["cveId"]);
    expect(body.properties.cveId).toBeDefined();
    expect(body.properties.options.properties.dryRun).toBeDefined();
    expect(body.properties.options.properties.cveId).toBeUndefined();
    expect(body.additionalProperties).toBe(false);
  });

  it("marks path arguments so clients can see them", () => {
    const options =
      paths["/remediate"].post.requestBody.content["application/json"].schema.properties.options
        .properties;
    expect(options.cwd["x-path"]).toBe(true);
    expect(options.patchesDir["x-path"]).toBe(true);
    expect(options.dryRun["x-path"]).toBeUndefined();
  });

  it("uses the declared success status and documents errors", () => {
    expect(paths["/jobs/remediate"].post.responses["202"]).toBeDefined();
    expect(paths["/remediate"].post.responses["200"]).toBeDefined();
    expect(paths["/remediate"].post.responses["403"]).toBeDefined();
    expect(paths["/jobs/{jobId}"].get.parameters[0]).toMatchObject({ name: "jobId", in: "path" });
    expect(paths["/jobs/{jobId}"].get.responses["404"]).toBeDefined();
  });

  it("exposes the operations that previously had no HTTP route", () => {
    for (const path of ["/reachability", "/packages/evaluate", "/delta-scan", "/patches/reconcile"]) {
      expect(paths[path]?.post).toBeDefined();
    }
  });
});
