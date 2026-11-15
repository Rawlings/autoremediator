import { describe, expect, it, vi } from "vitest";

import type { ApiDeps } from "./api-deps.js";
import {
  callMcpOperation,
  getOperation,
  mapRequestToInput,
  matchHttpRoute,
  roleFor,
  toMcpTools,
  toOpenApiPaths,
} from "./index.js";

const deps = (): ApiDeps =>
  ({
    assessUpgradeFn: vi.fn(async () => ({ breakability: "Low" })),
    findVulnerableSymbolsFn: vi.fn(async () => ({ candidates: [] })),
  }) as unknown as ApiDeps;

describe("assessUpgrade and findVulnerableSymbols operations", () => {
  it("are read-only network operations exposed over MCP and HTTP", () => {
    for (const name of ["assessUpgrade", "findVulnerableSymbols"]) {
      const operation = getOperation(name);
      expect(operation?.annotations).toMatchObject({
        readOnlyHint: true,
        destructiveHint: false,
        openWorldHint: true,
      });
      expect(operation?.mcp).toBe(true);
      expect(toMcpTools().some((tool) => tool.name === name)).toBe(true);
      expect(roleFor(operation!)).toBe("reader");
    }
    expect(getOperation("assessUpgrade")?.http).toMatchObject({
      method: "POST",
      path: "/packages/assess-upgrade",
    });
    expect(getOperation("findVulnerableSymbols")?.http).toMatchObject({
      method: "POST",
      path: "/packages/vulnerable-symbols",
    });
    expect(Object.keys(toOpenApiPaths())).toEqual(
      expect.arrayContaining(["/packages/assess-upgrade", "/packages/vulnerable-symbols"]),
    );
    expect(matchHttpRoute("POST", "/packages/assess-upgrade")?.operation.name).toBe(
      "assessUpgrade",
    );
  });

  it("validates versions and passes input to the SDK", async () => {
    const api = deps();
    const bad = await callMcpOperation(
      "assessUpgrade",
      { packageName: "lodash", from: "4", to: "4.17.21" },
      api,
    );
    expect(bad.isError).toBe(true);
    expect(api.assessUpgradeFn).not.toHaveBeenCalled();

    const ok = await callMcpOperation(
      "assessUpgrade",
      { packageName: "lodash", from: "4.17.20", to: "4.17.21" },
      api,
    );
    expect(ok.isError).toBeUndefined();
    expect(api.assessUpgradeFn).toHaveBeenCalledWith({
      packageName: "lodash",
      from: "4.17.20",
      to: "4.17.21",
    });

    await callMcpOperation(
      "findVulnerableSymbols",
      { packageName: "lodash", from: "4.17.20", to: "4.17.21", cwes: ["CWE-94"], limit: 5 },
      api,
    );
    expect(api.findVulnerableSymbolsFn).toHaveBeenCalledWith({
      packageName: "lodash",
      from: "4.17.20",
      to: "4.17.21",
      cwes: ["CWE-94"],
      limit: 5,
    });
  });

  it("maps an HTTP body with positional package and versions", () => {
    const operation = getOperation("assessUpgrade");
    expect(
      mapRequestToInput(operation!, {
        packageName: "lodash",
        from: "4.17.20",
        to: "4.17.21",
        options: { cwd: "/tmp/x" },
      }),
    ).toEqual({
      ok: true,
      input: { packageName: "lodash", from: "4.17.20", to: "4.17.21", cwd: "/tmp/x" },
    });
  });
});
