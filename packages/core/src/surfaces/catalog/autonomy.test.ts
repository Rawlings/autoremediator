import { describe, expect, it, vi } from "vitest";

import type { ApiDeps } from "./api-deps.js";
import {
  callMcpOperation,
  getOperation,
  httpOperations,
  matchHttpRoute,
  roleFor,
  toMcpTools,
} from "./index.js";

const status = { configured: true, message: "Autonomy L2", level: "L2" };
const fakeDeps = () => ({ getAutonomyFn: vi.fn(() => status) }) as unknown as ApiDeps;

describe("getAutonomy in the operation catalog", () => {
  it("is read-only, available over MCP and HTTP, and needs only a reader role", () => {
    const operation = getOperation("getAutonomy")!;
    expect(operation.annotations).toMatchObject({
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
    });
    expect(operation.mcp).toBe(true);
    expect(roleFor(operation)).toBe("reader");
    expect(toMcpTools().map((tool) => tool.name)).toContain("getAutonomy");
    expect(httpOperations.map((candidate) => candidate.name)).toContain("getAutonomy");
    expect(matchHttpRoute("POST", "/autonomy")?.operation.name).toBe("getAutonomy");
  });

  it("takes only a project directory and a policy path", () => {
    const tool = toMcpTools().find((candidate) => candidate.name === "getAutonomy")!;
    expect(Object.keys(tool.inputSchema.properties).toSorted()).toEqual(["cwd", "policy"]);
  });

  it("passes validated input to the SDK, and cannot be used to set a level", async () => {
    const deps = fakeDeps();
    const result = await callMcpOperation("getAutonomy", { cwd: process.cwd() }, deps);
    expect(result.isError).toBeUndefined();
    expect(deps.getAutonomyFn).toHaveBeenCalledWith({ cwd: process.cwd() });

    const refused = await callMcpOperation(
      "getAutonomy",
      { cwd: process.cwd(), ceiling: "L4" },
      deps,
    );
    expect(refused.isError).toBe(true);
    expect(refused.content[0]?.text).toContain("ceiling");
  });

  it("does not let remediation callers set autonomy: the ceiling lives only in the policy file", async () => {
    const remediate = toMcpTools().find((tool) => tool.name === "remediate")!;
    expect(remediate.inputSchema.properties).not.toHaveProperty("autonomy");
    const deps = { remediateFn: vi.fn() } as unknown as ApiDeps;
    const result = await callMcpOperation(
      "remediate",
      { cveId: "CVE-2021-23337", autonomy: { ceiling: "L4" } },
      deps,
    );
    expect(result.isError).toBe(true);
    expect(deps.remediateFn).not.toHaveBeenCalled();
  });
});
