import { describe, expect, it, vi } from "vitest";

import { createOpenApiRouteHandlers } from "../openapi/handlers/routes.js";
import { callMcpOperation, OPERATIONS, toMcpTools } from "./index.js";
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

describe("HTTP bindings match the hand-written routes", () => {
  it("declares exactly the POST routes the OpenAPI server serves", () => {
    const served = [...createOpenApiRouteHandlers({} as never).keys()]
      .filter((key) => key.startsWith("POST "))
      .toSorted();
    const declared = OPERATIONS.filter((operation) => operation.http?.method === "POST")
      .map((operation) => `POST ${operation.http!.path}`)
      .toSorted();

    expect(declared).toEqual(served);
  });
});
